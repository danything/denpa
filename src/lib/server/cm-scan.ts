import type { Range } from '../ts/cm-decide';
import { framer } from '../ts/logo-detect';
import { config } from './config';
import { run } from './stream';

/**
 * **CM 検出の材料を、1回だけ復号して取る。**
 *
 * 取るのは3つ。どれもコマの時刻 (ffmpeg の時刻。入れ物の頭から数えた秒) にそろえて返す。
 *
 * - **場面の切れ目** — `scdet` の点をコマごとに (標準エラーに1コマ1行)
 * - **局ロゴの枠** — 枠だけ切り出した白黒のコマを標準出力へ。点を付けるのは呼ぶ側 (`logo-own.ts`)
 * - **無音** — 主音声に `silencedetect` (標準エラー)
 *
 * ふだんは**エンコードと同じ ffmpeg に相乗りする** (`scanOutputs` を焼く出口のあとに足し、
 * 標準エラーと標準出力を `scanReader` で読む。`encoder.ts`)。ここの `scan` が自分で ffmpeg を
 * 起こすのは、ロゴを覚え直して枠だけ読み直すとき (`logo-own.ts`) だけ。
 *
 * 以前は chapter_exe (dtvindex で TS を読み直す) と自前のロゴ判定 (もう一度 ffmpeg で復号する) が
 * 別々に TS を読んでいた。時刻も1つの物差しになる — chapter_exe は「コマ番号 ÷ fps」で秒に直していたので、
 * 24コマの絵を 30コマで流す録画 (RFF) ではずれていった。
 */

/** 無音とみなす音の大きさ。16ビットで ±50 (chapter_exe の既定と同じ) */
export const SILENCE_NOISE = 50 / 32768;
/** 拾う無音の最短 (秒)。短いものは判定 (`cm-decide`) で捨てる */
export const SILENCE_MIN = 0.15;

/**
 * 切れ目を測るフィルタの名前。**エンコードに相乗りするときは別の `scdet` も居る**
 * (キーフレームを切れ目に置くためのもの。`encoder.ts`) ので、名前で見分ける
 */
const SCDET = 'scdet@cm';

export interface ScanLogo {
    /** 枠を切り出すフィルタ (`crop=…`)。白黒にするのはこちらで足す */
    filter: string;
    /** 1コマのバイト数 (枠の幅 × 高さ) */
    size: number;
    /** 1コマ届くたびに呼ぶ。`index` は `times` と同じ並び */
    onFrame: (frame: Uint8Array, index: number) => void;
}

/** 何を読むか */
export interface ScanWant {
    /** 絵を見るか (場面の切れ目とロゴ) */
    video: boolean;
    /** ロゴの枠。無ければ切れ目だけ */
    logo?: ScanLogo | null;
    /** 無音を測るか */
    audio: boolean;
}

export interface ScanOptions extends ScanWant {
    signal?: AbortSignal | undefined;
    timeoutMs: number;
    /** 入力の前に置く引数。エンコードと同じだけ頭を捨てる (`-ss`) ときに */
    before?: string[];
}

export interface Scan {
    /** 0 で読み切れた */
    code: number;
    /** 標準エラーの末尾 (落ちた理由) */
    stderr: string;
    /** コマごとの時刻 (秒) */
    times: number[];
    /** コマごとの場面の変わり方 (`scdet`。0〜100) */
    cuts: number[];
    silences: Range[];
    /** 届いたロゴの枠の数。`times` と食い違えば読み落としがある */
    logoFrames: number;
    /** ffmpeg が言ってきた入れ物の尺 (秒)。ffprobe で測れなかったときの代わり。無ければ NaN */
    duration: number;
}

const CUT = new RegExp(
    `^\\[${SCDET} @ [^\\]]*\\] lavfi\\.scd\\.score:\\s*([\\d.]+),\\s*lavfi\\.scd\\.time:\\s*(-?[\\d.]+)`,
);
const SILENCE_START = /silence_start:\s*(-?[\d.]+)/;
const SILENCE_END = /silence_end:\s*(-?[\d.]+)/;
const DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;

/**
 * 標準エラーの1行を読む。`scdet` は1コマ1行、`silencedetect` は始まりと終わりで1行ずつ、
 * 入れ物の尺 (`Duration:`) は秒で。それ以外 (復号の警告・進み具合など) は null
 */
export function scanLine(
    line: string,
):
    | { cut: number; time: number }
    | { silenceStart: number }
    | { silenceEnd: number }
    | { duration: number }
    | null {
    const cut = CUT.exec(line);
    if (cut !== null) return { cut: Number(cut[1]), time: Number(cut[2]) };
    const start = SILENCE_START.exec(line);
    if (start !== null) return { silenceStart: Math.max(0, Number(start[1])) };
    const end = SILENCE_END.exec(line);
    if (end !== null) return { silenceEnd: Number(end[1]) };
    const length = DURATION.exec(line);
    if (length !== null)
        return { duration: Number(length[1]) * 3600 + Number(length[2]) * 60 + Number(length[3]) };
    return null;
}

/**
 * 材料を取る出口 (ffmpeg の引数の、入力より後ろ)。絵と音で2つに分ける。
 * **エンコードの出口のあとに足しても同じに動く** — `-map` は出口ごとなので、絵の出口は
 * ffmpeg の自動の選び方 (いちばん大きい絵) のまま
 */
export function scanOutputs(want: ScanWant): string[] {
    const args: string[] = [];
    if (want.video) {
        /*
         * 絵は ffmpeg に選ばせる (いちばん大きいもの)。1本の TS に局が何本も乗っていても (TOKYO MX)、
         * 中身のある絵を拾う。**コマは間引かない・増やさない** — `times` とロゴの枠を順番で突き合わせる
         */
        const filters = [`${SCDET}=threshold=0`];
        if (want.logo) filters.push(want.logo.filter, 'format=gray');
        args.push('-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-vf', filters.join(','));
        args.push(...(want.logo ? ['-f', 'rawvideo', 'pipe:1'] : ['-f', 'null', '-']));
    }
    if (want.audio) {
        // 主音声だけ。録画の尻にだけ現れる副音声を拾わないように (cm.probeLiveAudio)
        args.push(
            '-map',
            '0:a:0',
            '-af',
            `silencedetect=noise=${SILENCE_NOISE}:d=${SILENCE_MIN}`,
            '-f',
            'null',
            '-',
        );
    }
    return args;
}

/** 自分で ffmpeg を起こして読むときの引数 */
export function scanArgs(input: string, options: ScanWant & { before?: string[] }): string[] {
    return [
        config.ffmpeg,
        '-hide_banner',
        '-nostats',
        '-v',
        'info',
        ...(options.before ?? []),
        '-i',
        input,
        ...scanOutputs(options),
    ];
}

/** ffmpeg の出力を読んで材料にする。エンコードに相乗りするときも、自分で読むときも同じもの */
export interface ScanReader {
    /** 標準出力 (ロゴの枠) の塊。ロゴを読まないときは無い */
    onStdout: ((chunk: Uint8Array) => void) | undefined;
    /** 標準エラーの1行。材料だったら true (落ちた理由として残さなくてよい) */
    line(line: string): boolean;
    /** 読み終えたら。`duration` (ffprobe で測った尺) は終わりまで続いた無音を閉じるのに使う */
    result(code: number, stderr: string, duration?: number): Scan;
}

export function scanReader(logo: ScanLogo | null | undefined): ScanReader {
    const times: number[] = [];
    const cuts: number[] = [];
    const silences: Range[] = [];
    let pending: number | null = null;
    let logoFrames = 0;
    let told = Number.NaN;
    return {
        // チャンクの境目はコマの境目と揃わない
        onStdout: logo ? framer(logo.size, (bytes) => logo.onFrame(bytes, logoFrames++)) : undefined,
        line(line) {
            const read = scanLine(line);
            if (read === null) return false;
            if ('cut' in read) {
                times.push(read.time);
                cuts.push(read.cut);
            } else if ('duration' in read) {
                if (Number.isNaN(told)) told = read.duration;
            } else if ('silenceStart' in read) {
                pending = read.silenceStart;
            } else if (pending !== null) {
                silences.push({ start: pending, end: Math.max(pending, read.silenceEnd) });
                pending = null;
            }
            return true;
        },
        result(code, stderr, duration) {
            // 終わりまで続いた無音は閉じる (尺が分かるときだけ)
            const end = duration !== undefined && Number.isFinite(duration) ? duration : told;
            if (pending !== null && Number.isFinite(end)) silences.push({ start: pending, end });
            return { code, stderr, times, cuts, silences, logoFrames, duration: told };
        },
    };
}

/** 録画を1回だけ復号して、CM 検出の材料を取る (エンコードに相乗りしないとき) */
export async function scan(input: string, options: ScanOptions): Promise<Scan> {
    const reader = scanReader(options.logo);
    const other: string[] = [];
    const result = await run(scanArgs(input, options), {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        ...(reader.onStdout ? { onStdout: reader.onStdout } : {}),
        onStderrLine: (line) => {
            if (reader.line(line)) return;
            // 落ちた理由を読むために、材料でない行 (警告・エラー) の末尾だけ残す
            if (line !== '' && !line.includes('=')) other.push(line);
            if (other.length > 5) other.shift();
        },
    });
    return reader.result(result.code, other.join('\n'));
}
