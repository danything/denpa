import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
    CODEC_LABEL,
    HW_CODECS,
    HW_KIND_LABEL,
    HW_KINDS,
    type HwAllow,
    type HwCodec,
    type HwKind,
    hwAllowed,
} from '../hw';
import { config } from './config';
import { run } from './stream';

/**
 * **GPU でエンコードできるか、起動時に ffmpeg に確かめさせる。**
 *
 * `ffmpeg -encoders` に載っているかでは「動くか」は分からないので、`HW_DEVICES`
 * (既定 `/dev/dri/renderD*`) に当たる口を全部拾い、**口ごとに** 道 (QSV / VA-API) ×
 * コーデックの4通りを `nullsrc` で実際に1コマ焼いて確かめる。結果は設定画面の
 * 「GPU」カードに口ごとに出て、使えるものには自動で印が付く (`settings().hwAllow` と
 * 突き合わせるのは `hwChain`)。**QSV を先に、VA-API は逃げ道** — 同じ GPU なら速さは
 * 変わらないが、QSV のほうがレート制御が豊富で Intel が手入れしている。
 *
 * **ライブも同じ印で GPU に載る** (`liveHw`)。設定項目は増やさず、印を外せば CPU に戻る。
 * 全体の話は docs/encode.md「GPU で焼く」
 */

/** 1つの口 (GPU) で何が焼けるか */
export interface HwDevice {
    /** `/dev/dri/renderD128` のような口 */
    path: string;
    /** 画面に出す名前。`renderD128 (Intel)` のように、口の名前と作り手 */
    label: string;
    /** QSV で焼けたコーデック */
    qsv: HwCodec[];
    /** VA-API で焼けたコーデック */
    vaapi: HwCodec[];
    /**
     * VA-API のうち、**ICQ が通らず CQP でだけ焼けた**コーデック。
     * i965 (Gemini Lake などの古いドライバ) は ICQ を持たない (`hwArgs`)
     */
    cqp: HwCodec[];
    /**
     * VA-API のうち、**放送の MPEG-2 を GPU で解いて、GPU でインタレ解除して焼ける**と
     * 確かめられたコーデック (`probeFull`)。ライブはこれなら CPU に絵を降ろさない (`liveHwArgs`)
     */
    full: HwCodec[];
}

export interface HwEncode {
    /** 一度でも確かめ終わったか。false のうちは画面が `probe()` を待つ (settings/+page.server.ts) */
    probed: boolean;
    /** 見つかった口、`HW_DEVICES` に当たった順。空なら GPU が見えていない */
    devices: HwDevice[];
    /** 画面に出す一言。何が使えて、使えないなら何が理由か */
    message: string;
}

/** 焼く1回ぶんの道。どの口を、どちらの道で */
export interface HwWay {
    device: string;
    kind: HwKind;
    /** VA-API を ICQ ではなく CQP で頼む (`HwDevice.cqp`)。試し焼きの結果から `hwChain` が付ける */
    cqp?: true;
}

let state: HwEncode = { probed: false, devices: [], message: '' };
let running: Promise<HwEncode> | null = null;

/** いまの見立て。`probe()` が終わるまでは `probed: false` */
export function hwEncode(): HwEncode {
    return state;
}

/**
 * **このコーデックを GPU で焼くときに試す道、順に。** 使える (試し焼きが通った)
 * かつ設定で外していない (`allow`) もの。空ならソフトウェアだけ。
 *
 * **口は `turn` で回す。** グラボが2枚あって両方が同じコーデックを焼けるなら、
 * ジョブごとに先頭を入れ替えて、2本並べて焼くとき片方に寄らないようにする。
 * 同じ口の中では QSV → VA-API
 */
export function hwChain(codec: HwCodec, allow: HwAllow, turn = 0, devices = state.devices): HwWay[] {
    const perDevice = devices
        .map((device) =>
            HW_KINDS.filter(
                (kind) => device[kind].includes(codec) && hwAllowed(allow, device.path, kind, codec),
            ).map(
                (kind): HwWay =>
                    kind === 'vaapi' && device.cqp.includes(codec)
                        ? { device: device.path, kind, cqp: true }
                        : { device: device.path, kind },
            ),
        )
        .filter((ways) => ways.length > 0);
    if (perDevice.length === 0) return [];
    const start = turn % perDevice.length;
    return [...perDevice.slice(start), ...perDevice.slice(0, start)].flat();
}

/**
 * **ffmpeg に渡す、道ごとの引数** (hwenc と encoder.buildArgs で同じものを使う)。
 *
 * - `device` … 入力より前に置く。GPU の口を開ける
 * - `filter` … 映像フィルタの最後に足す。どちらも CPU で作った絵を渡すので nv12 に
 *   揃える。VA-API は自分では上げてくれないので `hwupload` まで
 * - `encoder` … `-c:v` に続くもの
 *
 * QSV は実装を hw に固定 (ソフトウェア実装へは倒さない) して、子デバイスに
 * VA-API の口を渡す。**画質は ICQ (`-global_quality`)** — ビットレートを決めずに
 * 「この画質」を頼む、x264 の crf に相当するもの。**QSV も VA-API も 1〜51 の
 * 同じ物差し**で、コーデックが違っても同じ値で同じ見た目になる (AV1 はそのぶん
 * 小さくなる) — ソフトウェアで H.264 crf 23 と AV1 crf 35 を揃えたのと同じ考え。
 * 値は **24** (H.264 の crf と同じ軸)。**手元に GPU が無いので実測はまだ** —
 * ソフトウェア側の 23 も持ってきていない (あちらは実測で決めた値で、こちらは
 * 1つの値で両コーデックを賄う別の建て付け。測らずに写すと二重に当てずっぽうになる)。
 * ソフトウェアで焼いたものと大きさが違って見えたら、ここを動かす。
 * QSV の `-preset medium` は7段 (veryfast〜veryslow) の真ん中。
 *
 * ## ICQ を持たないドライバには CQP で頼む
 *
 * **i965 (Gemini Lake などの VA-API ドライバ) は ICQ を持たない** — 試し焼きが落ちて
 * 「焼けない」に見えていた (issue #417)。ICQ が落ちたら CQP (`-qp`、量子化の幅を固定)
 * でも試し (`probeOnce`)、通ればそちらで焼く (`HwWay.cqp`)。値は ICQ と同じ 24 —
 * H.264 の qp は 0〜51 で ICQ と同じ軸。AV1 の qp は 0〜255 なので、比で写して 120。
 * **どちらも実測はまだ** (ICQ と同じく当てずっぽう。CQP は場面に応じて量を
 * 変えないので、動きの多い場面で ICQ より大きく、静かな場面で小さくなるはず)
 */
export function hwArgs(
    way: HwWay,
    codec: HwCodec,
): { device: string[]; filter: string[]; encoder: string[] } {
    if (way.kind === 'qsv') {
        return {
            device: ['-init_hw_device', `qsv=hw:hw,child_device=${way.device}`],
            filter: ['format=nv12'],
            encoder: [`${codec}_qsv`, '-preset', 'medium', '-global_quality', '24'],
        };
    }
    return {
        device: ['-init_hw_device', `vaapi=va:${way.device}`, '-filter_hw_device', 'va'],
        filter: ['format=nv12', 'hwupload'],
        encoder: [`${codec}_vaapi`, ...vaapiQuality(way, codec)],
    };
}

/** VA-API の画質の頼み方。ICQ を持たないドライバには CQP (`hwArgs` の説明) */
function vaapiQuality(way: HwWay, codec: HwCodec): string[] {
    if (way.cqp === true) return ['-rc_mode', 'CQP', '-qp', codec === 'av1' ? '120' : '24'];
    return ['-rc_mode', 'ICQ', '-global_quality', '24'];
}

/** ライブで GPU を使うときの道。`full` なら復号とインタレ解除まで GPU (`liveHwArgs`) */
export interface LiveHw {
    way: HwWay;
    full: boolean;
}

/**
 * **ライブをどの GPU で焼くか。** 無ければ null (ソフトウェア)。
 *
 * 録画と同じ `hwChain` — 設定の印をそのまま使う (項目は増やさない)。そのうえで
 * **復号から GPU で通せる道 (`HwDevice.full`) があれば先に採る。** 焼くところだけ GPU に
 * 移しても、CPU に残る復号・bwdif・nv12 への変換で非力な機材は3本目が間に合わない
 * (issue #417 の実測: Celeron J4125 で3本同時、焼くだけ GPU 0.76x / 全部 GPU 1.2x)。
 * 同じ口の QSV より VA-API の全部 GPU を上に置くのはそのため
 */
export function liveHw(codec: HwCodec, allow: HwAllow, turn = 0, devices = state.devices): LiveHw | null {
    const chain = hwChain(codec, allow, turn, devices);
    const full = chain.find(
        (way) => way.kind === 'vaapi' && devices.some((d) => d.path === way.device && d.full.includes(codec)),
    );
    if (full !== undefined) return { way: full, full: true };
    const first = chain[0];
    return first === undefined ? null : { way: first, full: false };
}

/**
 * **ライブで GPU に焼かせる引数。** 録画の `hwArgs` との違いは遅れを作らないこと:
 *
 * - `-bf 0` … B フレームを作らない。作ると必ず1枚以上待つ (x264 の `zerolatency` と同じ狙い)
 * - `-async_depth 1` … GPU に先積みしない。既定 (VA-API 2・QSV 4) のぶんだけ絵が遅れて出る
 * - QSV は `-preset veryfast`。先読み (`look_ahead`) は既定で切れているので触らない —
 *   書いて名前が変わると、焼けずにソフトウェアへ落ちるだけになる
 * - 画質は録画と同じ ICQ 24 (CQP なら同じ値の qp)。x264 ultrafast の既定 (crf 23) と
 *   同じ軸のつもりだが、**手元に GPU が無いので見比べていない**
 *
 * `-g` はライブの側 (`live.ts` の `videoArgs`) が足す。
 *
 * ## `full` — 復号とインタレ解除も GPU (VA-API だけ)
 *
 * `-hwaccel vaapi -hwaccel_output_format vaapi` で放送の MPEG-2 を GPU で解き、絵を GPU に
 * 置いたまま `deinterlace_vaapi=rate=field` (フィールドごとに1コマ。bwdif の既定と同じ
 * 59.94p) に通して、そのまま焼く。**CPU のフィルタは1つも挟めない** — 挟むなら
 * `hwdownload` が要り、降ろしたぶんだけ遅くなる。ライブの映像の鎖はインタレ解除だけ
 * なので挟むものは無い (`-fpsmax` はコマを間引くだけでフィルタではなく、字幕と音声は
 * 別の流れ)。インタレ解除の絵は bwdif と変わる — **まだ見比べていない**。
 *
 * `filter` は「復号のあとに通すもの全部」。`full` でなければインタレ解除は含まないので、
 * 呼ぶ側が CPU の bwdif を前に足す
 */
export function liveHwArgs(
    hw: LiveHw,
    codec: HwCodec,
): { input: string[]; filter: string[]; encoder: string[] } {
    const { way } = hw;
    if (way.kind === 'qsv') {
        const base = hwArgs(way, codec);
        return {
            input: base.device,
            filter: base.filter,
            encoder: [
                `${codec}_qsv`,
                '-preset',
                'veryfast',
                '-global_quality',
                '24',
                '-bf',
                '0',
                '-async_depth',
                '1',
            ],
        };
    }
    const encoder = [`${codec}_vaapi`, ...vaapiQuality(way, codec), '-bf', '0', '-async_depth', '1'];
    if (!hw.full) {
        const base = hwArgs(way, codec);
        return { input: base.device, filter: base.filter, encoder };
    }
    return {
        input: [
            '-init_hw_device',
            `vaapi=va:${way.device}`,
            '-hwaccel',
            'vaapi',
            '-hwaccel_output_format',
            'vaapi',
            '-hwaccel_device',
            'va',
        ],
        filter: ['deinterlace_vaapi=rate=field'],
        encoder,
    };
}

/**
 * 1本だけ試し焼きする。**時間で切る** — ドライバが固まって返ってこないとき
 * (実機で見たことはないが) に起動が止まらないように
 */
async function tryEncode(args: string[]): Promise<boolean> {
    const result = await run([config.ffmpeg, '-v', 'error', '-nostdin', ...args, '-f', 'null', '-'], {
        timeoutMs: config.hwProbeTimeout,
    });
    return result.code === 0;
}

/** 試し焼きの素材。小さく短く — 何が使えるかを見るだけで、速さは測らない */
const SOURCE = ['-f', 'lavfi', '-i', 'nullsrc=s=256x256:r=30:d=0.2'];

/** PCI の作り手の番号 → 名前。sysfs から読めたときだけ添える */
const VENDOR: Record<string, string> = { '0x8086': 'Intel', '0x1002': 'AMD', '0x10de': 'NVIDIA' };

/** 口の名前。`renderD128 (Intel)` — 作り手は `/sys/class/drm/<口>/device/vendor` から */
function labelOf(path: string): string {
    const name = basename(path);
    try {
        const vendor = readFileSync(`/sys/class/drm/${name}/device/vendor`, 'utf8').trim();
        return `${name} (${VENDOR[vendor] ?? vendor})`;
    } catch {
        return name;
    }
}

/**
 * `HW_DEVICES` に当たる口。名前順 (renderD128, renderD129, …)。
 * 印は最後の段の `*` だけ (デバイスの名前は決まっている)。**readdir で拾う** —
 * デバイスは普通のファイルでもフォルダでもないので、glob の道具に頼らない
 */
export function findDevices(pattern = config.hwDevices): string[] {
    const dir = dirname(pattern);
    const name = new RegExp(`^${basename(pattern).split('*').map(escapeRegExp).join('.*')}$`);
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }
    return entries
        .filter((entry) => name.test(entry))
        .sort()
        .map((entry) => `${dir}/${entry}`);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 探し直す。同時に2回押されても ffmpeg は1組しか走らせない
 */
export function probe(): Promise<HwEncode> {
    if (running !== null) return running;
    // 終わったら手を離す。**中で null にしない** — 待たずに終わる道 (口が無い) では
    // 代入より先に走り終えてしまい、済んだ promise を握ったままになる
    running = probeOnce().finally(() => {
        running = null;
    });
    return running;
}

async function probeOnce(): Promise<HwEncode> {
    const devices: HwDevice[] = [];
    for (const path of findDevices()) {
        const device: HwDevice = { path, label: labelOf(path), qsv: [], vaapi: [], cqp: [], full: [] };
        for (const kind of HW_KINDS) {
            for (const codec of HW_CODECS) {
                if (await tryWay({ device: path, kind }, codec)) {
                    device[kind].push(codec);
                } else if (kind === 'vaapi' && (await tryWay({ device: path, kind, cqp: true }, codec))) {
                    // ICQ を持たないドライバ (i965)。CQP で焼く (`hwArgs` の説明)
                    device[kind].push(codec);
                    device.cqp.push(codec);
                }
            }
        }
        devices.push(device);
    }
    await probeFull(devices);
    const next: HwEncode = { probed: true, devices, message: describe(devices) };
    state = next;
    console.log(`[hwenc] ${next.message}`);
    return next;
}

/** 録画と同じ引数で1コマ焼いてみる */
function tryWay(way: HwWay, codec: HwCodec): Promise<boolean> {
    const hw = hwArgs(way, codec);
    return tryEncode([...hw.device, ...SOURCE, '-vf', hw.filter.join(','), '-c:v', ...hw.encoder]);
}

/**
 * **復号から GPU で通せるか** (`HwDevice.full`)。VA-API で焼けたコーデックだけ確かめる。
 *
 * 素材は放送と同じ **インタレの MPEG-2** を、その場で CPU で作る (`nullsrc` を
 * `mpeg2video` で。一時ファイルに置くのは、`run` が標準入力を渡さないため)。
 * それをライブと同じ引数 (`liveHwArgs` の `full`) で解いて、解除して、焼く。
 *
 * **GPU で解けなかったら必ず落ちる。** ffmpeg は `-hwaccel` が使えないと黙って CPU で
 * 解くが、その絵は GPU に無いので `deinterlace_vaapi` が受け取れずに降りる。
 * 「通った = GPU で解けた」と読んでよい
 */
async function probeFull(devices: HwDevice[]): Promise<void> {
    if (!devices.some((d) => d.vaapi.length > 0)) return;
    const dir = mkdtempSync(join(tmpdir(), 'denpa-hw-'));
    try {
        const sample = join(dir, 'mpeg2.ts');
        const made = await run(
            [
                config.ffmpeg,
                '-v',
                'error',
                '-nostdin',
                '-f',
                'lavfi',
                '-i',
                'nullsrc=s=320x240:r=30000/1001:d=0.3',
                '-c:v',
                'mpeg2video',
                '-flags',
                '+ilme+ildct',
                '-f',
                'mpegts',
                sample,
            ],
            { timeoutMs: config.hwProbeTimeout },
        );
        if (made.code !== 0) {
            console.warn('[hwenc] MPEG-2 の試し素材を作れなかったので、復号から GPU で通す道は使いません');
            return;
        }
        for (const device of devices) {
            for (const codec of device.vaapi) {
                const way: HwWay = device.cqp.includes(codec)
                    ? { device: device.path, kind: 'vaapi', cqp: true }
                    : { device: device.path, kind: 'vaapi' };
                const hw = liveHwArgs({ way, full: true }, codec);
                const ok = await tryEncode([
                    ...hw.input,
                    '-i',
                    sample,
                    '-vf',
                    hw.filter.join(','),
                    '-c:v',
                    ...hw.encoder,
                ]);
                if (ok) device.full.push(codec);
            }
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * 口ごとの一言。「QSV: H.264 / AV1、VA-API: H.264 (CQP)」か「焼けません」。
 * ICQ を持たないドライバで CQP に落としたものには (CQP) を添え、復号から GPU で
 * 通せるもの (ライブで使う) は最後に分けて書く
 */
export function describeDevice(device: HwDevice): string {
    const parts = HW_KINDS.filter((kind) => device[kind].length > 0).map(
        (kind) =>
            `${HW_KIND_LABEL[kind]}: ${device[kind]
                .map((c) =>
                    kind === 'vaapi' && device.cqp.includes(c) ? `${CODEC_LABEL[c]} (CQP)` : CODEC_LABEL[c],
                )
                .join(' / ')}`,
    );
    if (device.full.length > 0) {
        parts.push(`ライブは復号から GPU: ${device.full.map((c) => CODEC_LABEL[c]).join(' / ')}`);
    }
    return parts.length > 0
        ? parts.join('、')
        : 'GPU でエンコードできません (ドライバが合っていないか、権限がありません)';
}

function describe(devices: HwDevice[]): string {
    if (devices.length === 0) {
        return `GPU が見つかりません (${config.hwDevices} に該当するデバイスがありません)。ソフトウェアでエンコードします`;
    }
    const usable = devices.filter((d) => d.qsv.length > 0 || d.vaapi.length > 0).length;
    if (usable === 0)
        return `デバイスが ${devices.length} 個見つかりましたが、どれも GPU でエンコードできません。ソフトウェアでエンコードします`;
    return `デバイスが ${devices.length} 個見つかり、${usable} 個で GPU エンコードできます`;
}
