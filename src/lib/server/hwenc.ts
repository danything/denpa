import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
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

/**
 * **GPU でエンコードできるか、起動時に ffmpeg に確かめさせる。**
 *
 * `ffmpeg -encoders` に載っているかでは「動くか」は分からないので、`HW_DEVICES`
 * (既定 `/dev/dri/renderD*`) に当たる口を全部拾い、**口ごとに** 道 (QSV / VA-API) ×
 * コーデックの4通りを `nullsrc` で実際に1コマ焼いて確かめる。結果は設定画面の
 * 「GPU」カードに口ごとに出て、使えるものには自動で印が付く (`settings().hwAllow` と
 * 突き合わせるのは `hwChain`)。**QSV を先に、VA-API は逃げ道** — 同じ GPU なら速さは
 * 変わらないが、QSV のほうがレート制御が豊富で Intel が手入れしている。
 * 全体の話は docs/encode.md「GPU で焼く」
 */

export { HW_CODECS, HW_KINDS, type HwAllow, type HwCodec, type HwKind, hwAllowed };

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
            ).map((kind) => ({ device: device.path, kind })),
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
 * 小さくなる) — ソフトウェアで H.264 crf 24 と AV1 crf 35 を揃えたのと同じ考え。
 * 値は **24** (H.264 の crf と同じ軸)。**手元に GPU が無いので実測はまだ** —
 * ソフトウェアで焼いたものと大きさが違って見えたら、ここを動かす。
 * QSV の `-preset medium` は7段 (veryfast〜veryslow) の真ん中
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
        encoder: [`${codec}_vaapi`, '-rc_mode', 'ICQ', '-global_quality', '24'],
    };
}

/**
 * 1本だけ試し焼きする。**時間で切る** — ドライバが固まって返ってこないとき
 * (実機で見たことはないが) に起動が止まらないように
 */
async function tryEncode(args: string[]): Promise<boolean> {
    try {
        const proc = Bun.spawn([config.ffmpeg, '-v', 'error', '-nostdin', ...args, '-f', 'null', '-'], {
            stdout: 'ignore',
            stderr: 'pipe',
            signal: AbortSignal.timeout(config.hwProbeTimeout),
        });
        const code = await proc.exited;
        return code === 0;
    } catch {
        return false;
    }
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
        const device: HwDevice = { path, label: labelOf(path), qsv: [], vaapi: [] };
        for (const kind of HW_KINDS) {
            for (const codec of HW_CODECS) {
                const hw = hwArgs({ device: path, kind }, codec);
                const ok = await tryEncode([
                    ...hw.device,
                    ...SOURCE,
                    '-vf',
                    hw.filter.join(','),
                    '-c:v',
                    ...hw.encoder,
                ]);
                if (ok) device[kind].push(codec);
            }
        }
        devices.push(device);
    }
    const next: HwEncode = { probed: true, devices, message: describe(devices) };
    state = next;
    console.log(`[hwenc] ${next.message}`);
    return next;
}

/** 口ごとの一言。「QSV: H.264 / AV1、VA-API: H.264」か「焼けません」 */
export function describeDevice(device: HwDevice): string {
    const parts = HW_KINDS.filter((kind) => device[kind].length > 0).map(
        (kind) => `${HW_KIND_LABEL[kind]}: ${device[kind].map((c) => CODEC_LABEL[c]).join(' / ')}`,
    );
    return parts.length > 0
        ? parts.join('、')
        : 'GPU で焼けません (ドライバが合っていないか、権限がありません)';
}

function describe(devices: HwDevice[]): string {
    if (devices.length === 0) {
        return `GPU が見えません (${config.hwDevices} に当たる口がありません)。ソフトウェアで焼きます`;
    }
    const usable = devices.filter((d) => d.qsv.length > 0 || d.vaapi.length > 0).length;
    if (usable === 0)
        return `${devices.length} 口見つかりましたが、どれも GPU で焼けません。ソフトウェアで焼きます`;
    return `${devices.length} 口見つかり、${usable} 口で GPU で焼けます`;
}
