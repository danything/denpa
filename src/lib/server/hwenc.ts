import { existsSync } from 'node:fs';
import { config } from './config';

/**
 * **GPU でエンコードできるか、起動時に ffmpeg に確かめさせる。**
 *
 * 像には Intel の GPU 向けのもの (QSV と VA-API) が入れてある (Dockerfile) が、
 * 実際に使えるかは動かす機械しだい — GPU が無い、Pod に `/dev/dri` を
 * 渡していない、世代が古くて libmfx-gen が初期化できない、のどれでも
 * `h264_qsv` は落ちる。**`ffmpeg -encoders` に載っているかでは分からない**
 * (あれは「組み込んであるか」で「動くか」ではない)。
 *
 * なので、**実際に1コマ焼かせてみる。** 道 (QSV / VA-API) × コーデック
 * (H.264 / AV1) の4通りを `nullsrc` で通し、exit 0 なら使える。世代でも違う
 * (Arc より前は AV1 のエンコードが無い) ので、コーデック別に持つ。
 *
 * 結果は設定画面 (「映像コーデック」の下) に出し、**使えるものには自動で
 * 印が付く** (`settings().hwQsv` / `hwVaapi` と突き合わせるのは `hwChain`)。
 * 差し直したときは画面の「確かめ直す」で `probe()` をもう一度回す。
 *
 * **QSV と VA-API の両方を持つ理由。** Linux では QSV の下に必ず VA-API が
 * 居る (libvpl → libmfx-gen → libva → /dev/dri) ので、同じ GPU なら速さは変わらない。
 * QSV のほうがレート制御が豊富で Intel が手入れしているので**QSV を先に**使い、
 * QSV が初期化できない世代 (libmfx-gen の対応外) の逃げ道として VA-API を残す
 */

export type HwCodec = 'av1' | 'h264';

/** GPU で焼く道。並びがそのまま試す順 (encoder.ts の runJob) */
export const HW_KINDS = ['qsv', 'vaapi'] as const;
export type HwKind = (typeof HW_KINDS)[number];

export interface HwEncode {
    /** 一度でも確かめ終わったか。起動直後は false のまま画面に「確認中」を出す */
    probed: boolean;
    /** 見に行ったデバイス (`HW_DEVICE`) */
    device: string;
    /** QSV で焼けたコーデック */
    qsv: HwCodec[];
    /** VA-API で焼けたコーデック */
    vaapi: HwCodec[];
    /** 画面に出す一言。何が使えて、使えないなら何が理由か */
    message: string;
}

let state: HwEncode = {
    probed: false,
    device: config.hwDevice,
    qsv: [],
    vaapi: [],
    message: '確認中…',
};
let running: Promise<HwEncode> | null = null;

/** いまの見立て。`probe()` が終わるまでは `probed: false` */
export function hwEncode(): HwEncode {
    return state;
}

/**
 * **このコーデックを GPU で焼くときに試す道、順に。** 使える (試し焼きが通った)
 * かつ設定で外していない (`allowed[kind]`) もの。空ならソフトウェアだけ。
 * 設定の既定は「使えるものは全部」なので、GPU が見つかれば黙って使う
 */
export function hwChain(codec: HwCodec, allowed: Record<HwKind, readonly HwCodec[]>): HwKind[] {
    return HW_KINDS.filter((kind) => state[kind].includes(codec) && allowed[kind].includes(codec));
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
    kind: HwKind,
    codec: HwCodec,
): { device: string[]; filter: string[]; encoder: string[] } {
    const device = config.hwDevice;
    if (kind === 'qsv') {
        return {
            device: ['-init_hw_device', `qsv=hw:hw,child_device=${device}`],
            filter: ['format=nv12'],
            encoder: [`${codec}_qsv`, '-preset', 'medium', '-global_quality', '24'],
        };
    }
    return {
        device: ['-init_hw_device', `vaapi=va:${device}`, '-filter_hw_device', 'va'],
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

/**
 * 探し直す。同時に2回押されても ffmpeg は1組しか走らせない
 */
export function probe(): Promise<HwEncode> {
    if (running !== null) return running;
    // 終わったら手を離す。**中で null にしない** — 待たずに終わる道 (デバイスが無い) では
    // 代入より先に走り終えてしまい、済んだ promise を握ったままになる
    running = probeOnce().finally(() => {
        running = null;
    });
    return running;
}

async function probeOnce(): Promise<HwEncode> {
    const device = config.hwDevice;
    const next: HwEncode = { probed: true, device, qsv: [], vaapi: [], message: '' };
    if (!existsSync(device)) {
        next.message = `GPU が見えません (${device} がありません)。ソフトウェアで焼きます`;
    } else {
        for (const kind of HW_KINDS) {
            for (const codec of ['h264', 'av1'] as const) {
                const hw = hwArgs(kind, codec);
                const ok = await tryEncode([
                    ...hw.device,
                    ...SOURCE,
                    '-vf',
                    hw.filter.join(','),
                    '-c:v',
                    ...hw.encoder,
                ]);
                if (ok) next[kind].push(codec);
            }
        }
        next.message = describe(next);
    }
    state = next;
    console.log(`[hwenc] ${next.message}`);
    return next;
}

const NAME: Record<HwCodec, string> = { h264: 'H.264', av1: 'AV1' };

function describe(hw: HwEncode): string {
    const list = (codecs: HwCodec[]) => codecs.map((c) => NAME[c]).join(' / ');
    if (hw.qsv.length > 0 || hw.vaapi.length > 0) {
        const parts: string[] = [];
        if (hw.qsv.length > 0) parts.push(`Intel QSV (${list(hw.qsv)})`);
        if (hw.vaapi.length > 0) parts.push(`VA-API (${list(hw.vaapi)})`);
        const missing = (['h264', 'av1'] as const).filter(
            (c) => !hw.qsv.includes(c) && !hw.vaapi.includes(c),
        );
        return (
            `GPU で焼けます: ${parts.join('、')}` +
            (missing.length > 0 ? `。${list(missing)} はこの GPU では焼けません` : '')
        );
    }
    return `${hw.device} はありますが GPU で焼けません (ドライバが合っていないか、権限がありません)。ソフトウェアで焼きます`;
}
