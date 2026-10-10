import { framer } from '../ts/logo-detect';
import type { Range } from './cm';
import { config } from './config';
import { run } from './stream';

/**
 * **CM 検出の材料を、1本の ffmpeg で1回だけ復号して取る。**
 *
 * 取るのは3つ。どれもコマの時刻 (ffmpeg の時刻。入れ物の頭から数えた秒) にそろえて返す。
 *
 * - **場面の切れ目** — `scdet` の点をコマごとに (標準エラーに1コマ1行)
 * - **局ロゴの枠** — 枠だけ切り出した白黒のコマを標準出力へ。点を付けるのは呼ぶ側 (`logo-own.ts`)
 * - **無音** — 主音声に `silencedetect` (標準エラー)
 *
 * 以前は chapter_exe (dtvindex で TS を読み直す) と自前のロゴ判定 (もう一度 ffmpeg で復号する) が
 * 別々に全コマを復号していた。時間のほとんどは MPEG-2 の復号なので、1回にまとめるだけで半分になる。
 * 時刻も1つの物差しになる — chapter_exe は「コマ番号 ÷ fps」で秒に直していたので、
 * 24コマの絵を 30コマで流す録画 (RFF) ではずれていった。
 */

/** 無音とみなす音の大きさ。16ビットで ±50 (chapter_exe の既定と同じ) */
export const SILENCE_NOISE = 50 / 32768;
/** 拾う無音の最短 (秒)。短いものは判定 (`cm-decide`) で捨てる */
export const SILENCE_MIN = 0.15;

export interface ScanLogo {
    /** 枠を切り出すフィルタ (`crop=…`)。白黒にするのはこちらで足す */
    filter: string;
    /** 1コマのバイト数 (枠の幅 × 高さ) */
    size: number;
    /** 1コマ届くたびに呼ぶ。`index` は `times` と同じ並び */
    onFrame: (frame: Uint8Array, index: number) => void;
}

export interface ScanOptions {
    signal?: AbortSignal | undefined;
    timeoutMs: number;
    /** 絵を見るか (場面の切れ目とロゴ)。無音だけで決めるときは要らない */
    video: boolean;
    /** ロゴの枠。無ければ切れ目だけ */
    logo?: ScanLogo | null;
    /** 無音を測るか */
    audio: boolean;
    /** 進み具合 (0〜1)。`duration` で割る */
    onProgress?: (fraction: number) => void;
    duration?: number;
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
}

const SCDET = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*(-?[\d.]+)/;
const SILENCE_START = /silence_start:\s*(-?[\d.]+)/;
const SILENCE_END = /silence_end:\s*(-?[\d.]+)/;
const PROGRESS = /^out_time_us=(\d+)$/;

/**
 * 標準エラーの1行を読む。`scdet` は1コマ1行、`silencedetect` は始まりと終わりで1行ずつ、
 * 読んだ所 (`-progress`) は秒で。それ以外 (復号の警告など) は捨てる
 */
export function scanLine(
    line: string,
):
    | { cut: number; time: number }
    | { silenceStart: number }
    | { silenceEnd: number }
    | { progress: number }
    | null {
    const cut = SCDET.exec(line);
    if (cut !== null) return { cut: Number(cut[1]), time: Number(cut[2]) };
    const start = SILENCE_START.exec(line);
    if (start !== null) return { silenceStart: Math.max(0, Number(start[1])) };
    const end = SILENCE_END.exec(line);
    if (end !== null) return { silenceEnd: Number(end[1]) };
    const progress = PROGRESS.exec(line);
    if (progress !== null) return { progress: Number(progress[1]) / 1e6 };
    return null;
}

/** ffmpeg に渡す引数 (入力のあと)。出口は絵と音で2つに分ける */
export function scanArgs(input: string, options: Pick<ScanOptions, 'video' | 'logo' | 'audio'>): string[] {
    // 読んだ所は標準エラーへ (`-progress`)。音だけ読むときも進み具合が出る
    const args = [
        config.ffmpeg,
        '-hide_banner',
        '-nostats',
        '-v',
        'info',
        '-progress',
        'pipe:2',
        '-i',
        input,
    ];
    if (options.video) {
        /*
         * 絵は ffmpeg に選ばせる (いちばん大きいもの)。1本の TS に局が何本も乗っていても (TOKYO MX)、
         * 中身のある絵を拾う。**コマは間引かない・増やさない** — `times` とロゴの枠を順番で突き合わせる
         */
        const filters = ['scdet=threshold=0'];
        if (options.logo) filters.push(options.logo.filter, 'format=gray');
        args.push('-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-vf', filters.join(','));
        args.push(...(options.logo ? ['-f', 'rawvideo', 'pipe:1'] : ['-f', 'null', '-']));
    }
    if (options.audio) {
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

/** 録画を1回だけ復号して、CM 検出の材料を取る */
export async function scan(input: string, options: ScanOptions): Promise<Scan> {
    const times: number[] = [];
    const cuts: number[] = [];
    const silences: Range[] = [];
    let pending: number | null = null;
    let logoFrames = 0;
    const other: string[] = [];
    const { logo, onProgress, duration = Number.NaN } = options;

    // チャンクの境目はコマの境目と揃わない
    const onStdout = logo ? framer(logo.size, (bytes) => logo.onFrame(bytes, logoFrames++)) : undefined;

    const result = await run(scanArgs(input, options), {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        ...(onStdout ? { onStdout } : {}),
        onStderrLine: (line) => {
            const read = scanLine(line);
            if (read === null) {
                // 落ちた理由を読むために、材料でない行 (警告・エラー) の末尾だけ残す
                if (line !== '' && !line.includes('=')) other.push(line);
                if (other.length > 5) other.shift();
                return;
            }
            if ('cut' in read) {
                times.push(read.time);
                cuts.push(read.cut);
            } else if ('progress' in read) {
                if (onProgress && Number.isFinite(duration) && duration > 0) {
                    onProgress(Math.min(1, read.progress / duration));
                }
            } else if ('silenceStart' in read) {
                pending = read.silenceStart;
            } else if (pending !== null) {
                silences.push({ start: pending, end: Math.max(pending, read.silenceEnd) });
                pending = null;
            }
        },
    });
    // 終わりまで続いた無音は閉じる (尺が分かるときだけ)
    if (pending !== null && Number.isFinite(duration)) silences.push({ start: pending, end: duration });
    return { code: result.code, stderr: other.join('\n'), times, cuts, silences, logoFrames };
}
