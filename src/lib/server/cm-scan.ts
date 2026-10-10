import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Range } from '../ts/cm-decide';
import { framer } from '../ts/logo-detect';
import { config } from './config';
import { run } from './stream';

/**
 * **CM 検出の材料を、1回だけ復号して取る。**
 *
 * 取るのは3つ。どれもコマの時刻 (ffmpeg の時刻) にそろえて返す。
 *
 * - **場面の切れ目** — `scdet` の点をコマごとに。`metadata` で一時ファイルへ (1コマ2行)
 * - **局ロゴの枠** — 枠だけ切り出した白黒のコマを標準出力へ。点を付けるのは呼ぶ側 (`logo-own.ts`)
 * - **無音** — 主音声に `silencedetect`。`ametadata` で一時ファイルへ
 *
 * ふだんは**エンコードと同じ ffmpeg に相乗りする** (`scanReader` の `outputs` を焼く出口のあとに足す。
 * `encoder.ts`)。ここの `scan` が自分で ffmpeg を起こすのは、ロゴを覚え直して枠だけ読み直すときと、
 * CM 検出だけやり直すとき。
 *
 * **材料は標準エラーに出させない。** ffmpeg はログを書けなければ黙って捨てるので、エンコードに相乗りさせると
 * 行が落ちる (実測 30分で 54712 行のうち 1 行)。ファイルへ書かせれば落ちない。標準エラーから読むのは入れ物の尺 (`Duration:`) だけ。
 */

/** 無音とみなす音の大きさ。16ビットで ±50 */
const SILENCE_NOISE = 50 / 32768;
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

/** 何を読むか */
export interface ScanWant {
    /** 絵を見るか (場面の切れ目とロゴ)。音だけ読み直すとき (絵の読み込みが落ちたとき) は要らない */
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

const DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;

/** 標準エラーの1行から入れ物の尺 (`Duration:`) を秒で。それ以外は null */
export function scanLine(line: string): { duration: number } | null {
    const length = DURATION.exec(line);
    if (length === null) return null;
    return { duration: Number(length[1]) * 3600 + Number(length[2]) * 60 + Number(length[3]) };
}

const FRAME_TIME = /pts_time:\s*(-?[\d.]+)/;

/**
 * `metadata=mode=print` の書き出しから、コマごとの時刻と `scdet` の点を拾う。1コマ2行:
 *
 *     frame:0    pts:58316   pts_time:0.647956
 *     lavfi.scd.score=0.000
 */
export function parseCuts(text: string): { times: number[]; cuts: number[] } {
    const times: number[] = [];
    const cuts: number[] = [];
    let at = Number.NaN;
    for (const line of text.split('\n')) {
        const frame = FRAME_TIME.exec(line);
        if (frame !== null) {
            at = Number(frame[1]);
            continue;
        }
        if (line.startsWith('lavfi.scd.score=') && Number.isFinite(at)) {
            times.push(at);
            cuts.push(Number(line.slice('lavfi.scd.score='.length)));
            at = Number.NaN;
        }
    }
    return { times, cuts };
}

/**
 * `ametadata=mode=print` の書き出しから無音を拾う (`silencedetect` が付けた印。始まりと終わりは別のコマ)。
 * 終わりまで続いた無音は `end` で閉じる (分からなければ捨てる)
 */
export function parseSilences(text: string, end: number): Range[] {
    const out: Range[] = [];
    let pending: number | null = null;
    for (const line of text.split('\n')) {
        if (line.startsWith('lavfi.silence_start=')) {
            pending = Math.max(0, Number(line.slice('lavfi.silence_start='.length)));
        } else if (line.startsWith('lavfi.silence_end=') && pending !== null) {
            out.push({
                start: pending,
                end: Math.max(pending, Number(line.slice('lavfi.silence_end='.length))),
            });
            pending = null;
        }
    }
    if (pending !== null && Number.isFinite(end)) out.push({ start: pending, end });
    return out;
}

/**
 * 材料を取る出口 (ffmpeg の引数の、入力より後ろ)。絵と音で2つに分ける。`files` は書き出し先。
 * **エンコードの出口のあとに足しても同じに動く** — `-map` は出口ごとなので、絵の出口は
 * ffmpeg の自動の選び方 (いちばん大きい絵) のまま
 */
export function scanOutputs(want: ScanWant, files: { cuts: string; silences: string }): string[] {
    const args: string[] = [];
    if (want.video) {
        /*
         * 絵は ffmpeg に選ばせる (いちばん大きいもの)。1本の TS に局が何本も乗っていても (TOKYO MX)、
         * 中身のある絵を拾う。**コマは間引かない・増やさない** — `times` とロゴの枠を順番で突き合わせる。
         * `scdet` は点を全部のコマに付ける。閾値を上げておくのはログを出させないため (キーフレームを置く
         * `scdet@key` と名前で分ける)
         */
        const filters = [
            'scdet@cm=threshold=100',
            `metadata=mode=print:key=lavfi.scd.score:file=${files.cuts}`,
        ];
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
            `silencedetect=noise=${SILENCE_NOISE}:d=${SILENCE_MIN},ametadata=mode=print:file=${files.silences}`,
            '-f',
            'null',
            '-',
        );
    }
    return args;
}

/** ffmpeg の出力を読んで材料にする。エンコードに相乗りするときも、自分で読むときも同じもの */
export interface ScanReader {
    /** ffmpeg に足す出口 (`scanOutputs`) */
    outputs: string[];
    /** 標準出力 (ロゴの枠) の塊。ロゴを読まないときは無い */
    onStdout: ((chunk: Uint8Array) => void) | undefined;
    /** 標準エラーの1行。材料だったら true (落ちた理由として残さなくてよい) */
    line(line: string): boolean;
    /**
     * 読み終えたら。書き出しを読んで片付ける。`duration` (ffprobe で測った尺。読んだものの物差しで) は
     * 終わりまで続いた無音を閉じるのに使う
     */
    result(code: number, stderr: string, duration?: number): Scan;
}

/**
 * 書き出しの置き場。読み手ごとに一時フォルダを1つ作る (名前は他と重ならない)。
 * **パスはフィルタの引数に入る**ので、`:` `,` などを含まない一時フォルダの下に固定の名前で置く
 */
function scratch(): { dir: string; cuts: string; silences: string } {
    const dir = mkdtempSync(join(tmpdir(), 'denpa-scan-'));
    return { dir, cuts: join(dir, 'cuts'), silences: join(dir, 'silences') };
}

function read(path: string): string {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

export function scanReader(want: ScanWant): ScanReader {
    const files = scratch();
    const { logo } = want;
    let logoFrames = 0;
    let told = Number.NaN;
    return {
        outputs: scanOutputs(want, files),
        // チャンクの境目はコマの境目と揃わない
        onStdout: logo ? framer(logo.size, (bytes) => logo.onFrame(bytes, logoFrames++)) : undefined,
        line(line) {
            const read = scanLine(line);
            if (read === null) return false;
            if (Number.isNaN(told)) told = read.duration;
            return true;
        },
        result(code, stderr, duration) {
            const end = duration !== undefined && Number.isFinite(duration) ? duration : told;
            const { times, cuts } = parseCuts(read(files.cuts));
            const silences = parseSilences(read(files.silences), end);
            rmSync(files.dir, { recursive: true, force: true });
            return { code, stderr, times, cuts, silences, logoFrames, duration: told };
        },
    };
}

/** 自分で ffmpeg を起こして読むときの引数 (`before` は入力の前に置く) */
function scanArgs(input: string, outputs: string[], before: string[] = []): string[] {
    // 読んだ所は標準エラーへ (`-progress`)。CM 検出だけやり直すときの進み具合 (`onTime`)
    return [
        config.ffmpeg,
        '-hide_banner',
        '-nostats',
        '-v',
        'info',
        '-progress',
        'pipe:2',
        ...before,
        '-i',
        input,
        ...outputs,
    ];
}

const PROGRESS = /^out_time_us=(\d+)$/;

/** 録画を1回だけ復号して、CM 検出の材料を取る (エンコードに相乗りしないとき) */
export async function scan(
    input: string,
    options: ScanOptions & { onTime?: (seconds: number) => void },
): Promise<Scan> {
    const reader = scanReader(options);
    const other: string[] = [];
    const result = await run(scanArgs(input, reader.outputs, options.before), {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        ...(reader.onStdout ? { onStdout: reader.onStdout } : {}),
        onStderrLine: (line) => {
            if (reader.line(line)) return;
            const progress = PROGRESS.exec(line);
            if (progress !== null) {
                options.onTime?.(Number(progress[1]) / 1e6);
                return;
            }
            // 落ちた理由を読むために、材料でない行 (警告・エラー) の末尾だけ残す
            if (line !== '' && !line.includes('=')) other.push(line);
            if (other.length > 5) other.shift();
        },
    });
    return reader.result(result.code, other.join('\n'));
}
