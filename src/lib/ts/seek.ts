/**
 * **録画の TS の中で、時刻からバイトの位置を引く** (`/api/recordings/<id>/stream` の TS が元の道)。
 *
 * TS には索引が無い。位置を当てるには中を読むしかないが、頭から読むと 1 時間の BS で 7GB になる。
 * そこで**決まった位置の PES の PTS を見て二分探索する** (1 回に読むのは数百KB、30 回ほどで当たる)。
 * 追っかけの当て方 (`chase.ts` の `chasePlan`。バイト比例) より正確で、録り終えた録画なら尻まで使える。
 *
 * ## 時刻の物差し
 *
 * **頭 (`head`) は入れ物の始まり** — ffmpeg (ffprobe) が `start_time` と呼ぶもの。映像と音声の
 * 最初の PTS のうち早いほうで、CM の区間 (`recordings.cm_ranges`) もエンコードしたときに捨てた頭
 * (`encode_skip`) もこれから数えている (`server/cm.ts` の `probeVideo` の `formatStart`)。
 * 同じものを ffprobe 無しで出す (`tsHead`)。
 *
 * PTS は 33 ビットで 26.5 時間ごとに 0 へ戻る。**頭から数えた差を一周の中で取る** (`sinceHead`) — 録画は
 * 26.5 時間より短いので、一周をまたいでも差は増え続ける。頭より少し前 (B フレームの並べ替え、
 * 音声と映像の頭のずれ) は負の小さな数にする
 *
 * DOM もファイルも触らない (読む口は受け取る) ので、合成した TS で確かめられる (`seek.test.ts`)
 */

import { CLOCK, readStamp, WRAP } from './pes';
import { PACKET, SYNC } from './psi';

/** PES の頭の印 (stream_id)。映像 0xE0〜0xEF、音声 0xC0〜0xDF、字幕などは private_stream_1 (0xBD) */
const isVideo = (id: number) => id >= 0xe0 && id <= 0xef;
const isAudio = (id: number) => id >= 0xc0 && id <= 0xdf;
const PRIVATE_1 = 0xbd;

/** 頭より前とみなす幅 (秒)。これより手前に見えるものは、一周したのではなく頭の少し前 */
const BEFORE_HEAD = 600;

/** 見つけた PES の頭 */
export interface PesMark {
    /** stream_id */
    id: number;
    /** 90kHz。一周の中 */
    pts: number;
    /** その PES が始まる TS パケットの位置 (渡したバイト列の頭から) */
    at: number;
}

/** パケットの切れ目を探す。3 つ続けて 0x47 が並ぶところ。無ければ -1 */
function findSync(bytes: Uint8Array, from = 0): number {
    for (let i = from; i + PACKET * 2 < bytes.length; i++) {
        if (bytes[i] === SYNC && bytes[i + PACKET] === SYNC && bytes[i + PACKET * 2] === SYNC) return i;
    }
    return -1;
}

/**
 * PTS の付いた PES の頭を順に出す。**誤りの印・スクランブルの残るパケットは読まない**。
 * 切れ目が見つからなければ何も出さない
 */
export function* pesMarks(bytes: Uint8Array): Generator<PesMark> {
    const start = findSync(bytes);
    if (start < 0) return;
    for (let at = start; at + PACKET <= bytes.length; at += PACKET) {
        if (bytes[at] !== SYNC) {
            // 切れ目を見失った (途中が欠けている)。探し直す
            const next = findSync(bytes, at + 1);
            if (next < 0) return;
            at = next - PACKET;
            continue;
        }
        const b1 = bytes[at + 1]!;
        const b3 = bytes[at + 3]!;
        // 頭 (payload_unit_start) だけ。誤り・スクランブルは読まない
        if (!(b1 & 0x40) || b1 & 0x80 || b3 & 0xc0) continue;
        const control = (b3 >> 4) & 0x03;
        if (!(control & 0x01)) continue;
        const offset = at + 4 + (control & 0x02 ? 1 + bytes[at + 4]! : 0);
        // 頭の 9 バイト + PTS の 5 バイトがパケットの中に収まっていること
        if (offset + 14 > at + PACKET) continue;
        if (bytes[offset] !== 0 || bytes[offset + 1] !== 0 || bytes[offset + 2] !== 1) continue;
        const id = bytes[offset + 3]!;
        if (!(bytes[offset + 7]! & 0x80)) continue;
        yield { id, pts: readStamp(bytes, offset + 9), at };
    }
}

/** 一周の中の差 `a - b` を、-半周〜+半周に置き直す (90kHz) */
function delta(a: number, b: number): number {
    const d = (((a - b) % WRAP) + WRAP) % WRAP;
    return d >= WRAP / 2 ? d - WRAP : d;
}

/**
 * **入れ物の始まり (90kHz)。** 録画の頭のバイト列から。読めなければ null。
 *
 * ffmpeg の `start_time` と同じ決め方にする (libavformat の `update_stream_timings`):
 * 映像と音声の最初の PTS のうち早いほう。字幕などの PTS は、それより 1 秒以内に早いときだけ使う
 * (`start_time - start_time_text < AV_TIME_BASE`)。映像は B フレームのぶん後の PES に
 * 早い PTS があるので、見えた中でいちばん早いものを採る
 */
export function tsHead(bytes: Uint8Array): number | null {
    let ref: number | null = null;
    let av: number | null = null;
    let text: number | null = null;
    for (const mark of pesMarks(bytes)) {
        ref ??= mark.pts;
        const d = delta(mark.pts, ref);
        if (isVideo(mark.id) || isAudio(mark.id)) av = av === null ? d : Math.min(av, d);
        else if (mark.id === PRIVATE_1) text = text === null ? d : Math.min(text, d);
    }
    if (ref === null || av === null) return null;
    const first = text !== null && text < av && av - text < CLOCK ? text : av;
    return (((ref + first) % WRAP) + WRAP) % WRAP;
}

/** 頭から数えた秒。一周をまたいでも増え続ける (録画は一周より短い)。頭の少し前は負 */
export function sinceHead(pts: number, head: number): number {
    const d = (((pts - head) % WRAP) + WRAP) % WRAP;
    return (d > WRAP - BEFORE_HEAD * CLOCK ? d - WRAP : d) / CLOCK;
}

/** 映像の PES の、いちばん後ろの PTS。録画の尻のバイト列から尺を出すのに使う。無ければ null */
export function lastVideoPts(bytes: Uint8Array): number | null {
    let last: number | null = null;
    for (const mark of pesMarks(bytes)) if (isVideo(mark.id)) last = mark.pts;
    return last;
}

/** ファイルを少しずつ読む口。`length` より短く返ってよい (尻) */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

/** 1 回に読む量。放送の 1 秒ぶん (地上波 17Mbps ≒ 2MB) より短い間に映像の PES は何度も来る */
const WINDOW = 256 * 1024;
/** 映像の PES を探して読み進める上限。これだけ読んで無ければ、その位置には無いことにする */
const SEARCH = 4 * 1024 * 1024;
/** これより狭くなったら二分探索をやめる。数十ms ぶん */
const NARROW = PACKET * 256;

/**
 * `offset` から先で最初の映像の PES。`at` はファイルの頭からの位置。無ければ null
 */
async function videoAt(read: ReadAt, offset: number): Promise<PesMark | null> {
    for (let from = offset; from < offset + SEARCH; from += WINDOW - PACKET * 3) {
        const bytes = await read(from, WINDOW);
        for (const mark of pesMarks(bytes)) {
            if (isVideo(mark.id)) return { ...mark, at: from + mark.at };
        }
        if (bytes.length < WINDOW) return null;
    }
    return null;
}

/**
 * **頭から `target` 秒のところを読みはじめる位置。** その時刻より前で、いちばん近い映像の PES の頭。
 *
 * 決まった位置を読み、そこから先で最初に来る映像の PES の PTS で比べる二分探索。時刻は映像の
 * PES でしか見ない (音声は映像より 0.数秒ずれて多重化されている)。頭より前を頼まれたら頭から。
 * 映像の PES が 1 つも無ければ null
 *
 * @param size ファイルの大きさ (バイト)
 * @param head 入れ物の始まり (`tsHead`)
 */
export async function seekTs(
    read: ReadAt,
    size: number,
    head: number,
    target: number,
): Promise<PesMark | null> {
    const first = await videoAt(read, 0);
    if (first === null) return null;
    if (target <= sinceHead(first.pts, head)) return first;
    let best = first;
    let lo = first.at;
    let hi = size;
    while (hi - lo > NARROW) {
        const mid = lo + Math.floor((hi - lo) / 2 / PACKET) * PACKET;
        const mark = await videoAt(read, mid);
        if (mark === null || mark.at >= hi) {
            hi = mid;
            continue;
        }
        if (sinceHead(mark.pts, head) <= target) {
            best = mark;
            lo = mark.at + PACKET;
        } else {
            hi = mid;
        }
    }
    // 狭めた残りは順に読んで、いちばん近い映像の PES まで詰める
    const base = best.at;
    for (const mark of pesMarks(await read(base, hi - base + WINDOW))) {
        if (!isVideo(mark.id)) continue;
        if (sinceHead(mark.pts, head) > target) break;
        best = { ...mark, at: base + mark.at };
    }
    return best;
}
