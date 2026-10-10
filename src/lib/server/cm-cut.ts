import type { Range } from '../ts/cm-decide';
import { config } from './config';
import { run } from './stream';

/**
 * **焼いたもの (mkv) から CM を切る。** 切るのはキーフレームの所だけで、焼き直さない (`-c copy`)。
 *
 * CM は焼きながら探す (`encoder.ts`) ので、焼く時点では境目が分からない。そこで切るときは
 * **場面の切れ目ごとにキーフレームを置いて焼く** (`KEY_SCDET`)。CM の境目はほぼ必ず場面の切れ目なので
 * (`cm-decide`)、焼き終えて境目が決まったら、そこにあるキーフレームで切ればコマ単位で合う。
 *
 * 境目の近くにキーフレームが無ければ (無音の真ん中に置いた境目など)、CM 側へ `config.cmCutMargin` 秒まで
 * 寄せる (本編を削るより CM が少し残るほうがまし)。それも無ければ、境目の時刻を指して焼き直す (`encoder.ts`)。
 */

/**
 * キーフレームを置く場面の切れ目の強さ (`scdet`。0〜100)。CM の境目に選ぶ切れ目と同じ 8 以上
 * (`cm-decide` の `CUT_MIN`)。CM 検出と同じコマ (インタレ解除の前) で測るので、点も同じになる。
 * 実測は docs/encode.md「CM を切るときは場面の切れ目にキーフレームを置く」
 */
export const KEY_SCENE = 8;

/**
 * 焼く鎖の頭に足すフィルタ。印 (`lavfi.scd.time`) の付いたコマを `-force_key_frames scd_metadata` が
 * キーフレームにする。CM 検出の `scdet@cm` と名前で分ける (どちらも標準エラーに行を出す)
 */
export const KEY_SCDET = `scdet@key=threshold=${KEY_SCENE}`;

export interface Keyframe {
    /** 見せる時刻 (秒) */
    pts: number;
    /** 解く時刻 (秒)。B フレームがあると pts より前 (x264 で 2コマ) */
    dts: number;
}

/**
 * ffprobe のパケット一覧 (`pts,dts,flags`) から、キーフレームと最初のコマの時刻を拾う。
 * **パケットを読むだけで解かない**ので、30分の録画でも数秒で済む
 */
export function parseKeyframes(csv: string): { keys: Keyframe[]; first: number } {
    const keys: Keyframe[] = [];
    let first = Number.POSITIVE_INFINITY;
    for (const line of csv.split('\n')) {
        const [pts, dts, flags] = line.trim().split(',');
        const at = Number(pts);
        if (pts === undefined || pts === '' || !Number.isFinite(at)) continue;
        first = Math.min(first, at);
        if (flags?.startsWith('K')) {
            const decode = Number(dts);
            keys.push({ pts: at, dts: Number.isFinite(decode) ? decode : at });
        }
    }
    keys.sort((a, b) => a.pts - b.pts);
    return { keys, first: Number.isFinite(first) ? first : Number.NaN };
}

/** 焼いたもののキーフレーム。読めなければ null */
export async function listKeyframes(file: string): Promise<{ keys: Keyframe[]; first: number } | null> {
    const result = await run(
        [
            config.ffprobe,
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'packet=pts_time,dts_time,flags',
            '-of',
            'csv=p=0',
            file,
        ],
        { stdout: true },
    );
    if (result.code !== 0) return null;
    const found = parseKeyframes(new TextDecoder().decode(result.stdout));
    return found.keys.length > 0 ? found : null;
}

/** 残す1切れ (焼いたものの時刻) */
export interface Piece {
    /** 頭のキーフレームの pts */
    start: number;
    /** 尻 (次の CM の頭のキーフレームの pts)。null は終わりまで */
    end: number | null;
    /** 尻のキーフレームの dts。**ここで読むのをやめる** (concat の `outpoint` は dts で見る) */
    outpoint: number | null;
}

export interface CutPlan {
    pieces: Piece[];
    /** 境目ごとの、切った所 − 決めた所 (秒)。CM 側へ寄せたぶんも入る */
    errors: number[];
}

export interface CutLimits {
    /** 焼いたものの時刻 − 境目の物差しの時刻 (秒)。muxer が頭を数ミリ秒ずらす */
    offset: number;
    /** 同じ境目とみなすずれ (秒)。1コマ半 */
    tolerance: number;
    /** CM 側へ寄せてよい長さ (秒) */
    margin: number;
    /** 尺 (境目の物差しで) */
    duration: number;
}

/**
 * 残す区間 (`keep`) を、焼いたもののキーフレームで切る段取り。**どこか1つでも切れなければ null**
 * (呼ぶ側が境目を指して焼き直す)。
 *
 * - 境目から `tolerance` 以内のキーフレームがあれば、そこ (切れ目に置いたもの)
 * - 無ければ CM 側へ `margin` まで — 頭は前へ、尻は後ろへ (本編を削らない)
 * - 録画の頭と尻は切らない (最初のキーフレームから・終わりまで)
 */
export function planCut(keep: Range[], keys: Keyframe[], limits: CutLimits): CutPlan | null {
    const { offset, tolerance, margin, duration } = limits;
    if (keys.length === 0) return null;
    const errors: number[] = [];
    const nearest = (at: number) => {
        let best: Keyframe | null = null;
        for (const key of keys) {
            if (
                Math.abs(key.pts - at) <= tolerance &&
                (best === null || Math.abs(key.pts - at) < Math.abs(best.pts - at))
            )
                best = key;
        }
        return best;
    };
    /** 境目 `at` (境目の物差し) のキーフレーム。`way` は CM のある側 (-1 前 / 1 後ろ) */
    const snap = (at: number, way: -1 | 1): Keyframe | null => {
        const t = at + offset;
        const hit =
            nearest(t) ??
            (way < 0
                ? keys.filter((k) => k.pts <= t && k.pts >= t - margin).at(-1)
                : keys.find((k) => k.pts >= t && k.pts <= t + margin)) ??
            null;
        if (hit !== null) errors.push(hit.pts - t);
        return hit;
    };
    const pieces: Piece[] = [];
    for (const range of [...keep].sort((a, b) => a.start - b.start)) {
        const head = range.start <= tolerance ? keys[0]! : snap(range.start, -1);
        if (head === null) return null;
        let tail: Keyframe | null = null;
        if (range.end < duration - tolerance) {
            tail = snap(range.end, 1);
            if (tail === null) return null;
        }
        const previous = pieces.at(-1);
        // 寄せた結果 前の切れと重なれば1つに
        if (previous !== undefined && previous.end !== null && head.pts <= previous.end) {
            previous.end = tail?.pts ?? null;
            previous.outpoint = tail?.dts ?? null;
            continue;
        }
        if (tail !== null && tail.pts <= head.pts) continue;
        pieces.push({ start: head.pts, end: tail?.pts ?? null, outpoint: tail?.dts ?? null });
    }
    return pieces.length > 0 ? { pieces, errors } : null;
}

/** パスを concat の一覧に書くときの形。' はエスケープが要る */
const quote = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;

/**
 * concat デマクサに渡す一覧。同じファイルを切れの数だけ並べ、`inpoint` / `outpoint` で切る。
 *
 * **`duration` は pts で書く** (`end - start`)。書かないと concat は `outpoint - inpoint` を
 * 長さにするが、`outpoint` は dts なので x264 (B フレームあり) では 2コマ短くなり、
 * 切れ目ごとに後ろが詰まってずれていく
 */
export function cutList(file: string, pieces: Piece[]): string {
    const lines = ['ffconcat version 1.0'];
    for (const piece of pieces) {
        lines.push(`file ${quote(file)}`, `inpoint ${piece.start.toFixed(3)}`);
        if (piece.end !== null && piece.outpoint !== null) {
            lines.push(
                `outpoint ${piece.outpoint.toFixed(3)}`,
                `duration ${(piece.end - piece.start).toFixed(3)}`,
            );
        }
    }
    return `${lines.join('\n')}\n`;
}

/** 一覧のとおりに繋ぐ。焼き直さない */
export function cutArgs(list: string, output: string): string[] {
    return [
        config.ffmpeg,
        '-y',
        '-v',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'matroska',
        output,
    ];
}

/** チャプターだけ足して書き直す。焼き直さない */
export function chapterArgs(input: string, chapters: string, output: string): string[] {
    return [
        config.ffmpeg,
        '-y',
        '-v',
        'error',
        '-i',
        input,
        '-i',
        chapters,
        '-map',
        '0',
        '-map_chapters',
        '1',
        '-c',
        'copy',
        '-f',
        'matroska',
        output,
    ];
}

/** 境目の時刻 (キーフレームを置く所)。残す区間の頭と尻。録画の頭と尻は除く */
export function cutPoints(keep: Range[], duration: number): number[] {
    const out: number[] = [];
    for (const range of keep) {
        if (range.start > 0.5) out.push(range.start);
        if (range.end < duration - 0.5) out.push(range.end);
    }
    return out.sort((a, b) => a - b);
}
