/**
 * Matroska から、コマとその時刻だけを取り出す。**字幕の絵を運ぶ器として使う。**
 *
 * ライブ視聴では ffmpeg 1本で映像と字幕の両方を焼く ([stream.md](../../../docs/stream.md) §5.2)。
 * 映像は fMP4、字幕は**この器**で受ける。器が要るのは、**時刻を絵と一緒に
 * 運ばせるため** — 生の PNG を並べただけ (`image2pipe`) では時刻が乗らず、
 * 別の口 (`showinfo`) に喋らせると**行と絵の数が合わずにずれる**
 * (実機で PNG 77枚に対し 79行。一度ずれたら戻らない)。
 *
 * Matroska を選んだのは、**必要なところだけなら小さいから**。NUT はコマの
 * 見出しを組み立てるのに表を復元する必要があり、mp4 は PNG を入れられない。
 * ここが読むのは4つだけ:
 *
 *     Segment > Info > TimestampScale   時刻の刻み (既定 1ms)
 *     Segment > Cluster > Timestamp     その塊の頭の時刻
 *     Segment > Cluster > SimpleBlock   コマ本体 (頭からの差 + 中身)
 *
 * EBML は `[ID][大きさ][中身]` の入れ子。**中身に入るものと飛ばすものを
 * 決めておけば、知らない要素は大きさぶん飛ばせる**ので、全部を知らなくてよい。
 */

/** 中に入る (入れ子の親として扱う) もの */
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const CLUSTER = 0x1f43b675;
const BLOCK_GROUP = 0xa0;
const DESCEND = new Set([SEGMENT, INFO, CLUSTER, BLOCK_GROUP]);

/** 中身を読むもの */
const TIMESTAMP_SCALE = 0x2ad7b1;
const TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK = 0xa1;

/** 大きさが「不明」の印 (全部 1)。頭だけ書いて流し始める器で出てくる */
const UNKNOWN = -1;

/** 時刻の刻みの既定 (ナノ秒)。1ms */
const DEFAULT_SCALE = 1_000_000;

/** 取り出した1コマ */
export interface MkvFrame {
    /** そのコマの時刻 (ミリ秒)。**映像の mp4 と同じ物差し** (stream.md §5.4) */
    at: number;
    /** 中身そのまま。字幕なら PNG 1枚 */
    data: Uint8Array;
}

/** 読めた見出し。`body` は中身の先頭位置 */
interface Header {
    id: number;
    size: number;
    body: number;
}

/**
 * EBML の可変長整数。
 *
 * 先頭バイトの**最初に立っているビットの位置**が長さ (1〜8バイト)。
 * ID はその印も含めた並びをそのまま値とし (慣例)、大きさは印を落とした値を採る。
 *
 * @returns 読めなければ null (まだ足りない)
 */
function vint(buffer: Uint8Array, at: number, keepMarker: boolean): { value: number; next: number } | null {
    if (at >= buffer.length) return null;
    const first = buffer[at];
    if (first === 0) return null;
    let length = 1;
    while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++;
    if (length > 8 || at + length > buffer.length) return null;

    const mask = length >= 8 ? 0 : 0xff >> length;
    let value = keepMarker ? first : first & mask;
    // 印を落とした桁が全部 1 なら「大きさは不明」。頭だけ書いて流す器で出てくる
    let allOnes = (first & mask) === mask;
    for (let i = 1; i < length; i++) {
        value = value * 256 + buffer[at + i];
        if (buffer[at + i] !== 0xff) allOnes = false;
    }
    if (!keepMarker && allOnes) return { value: UNKNOWN, next: at + length };
    return { value, next: at + length };
}

/** 符号なし整数 (ビッグエンディアン、長さは中身のぶんだけ) */
function uint(body: Uint8Array): number {
    let value = 0;
    for (const byte of body) value = value * 256 + byte;
    return value;
}

/**
 * 繋がったバイト列から、コマを1つずつ取り出す。
 *
 * **足りないところで止めて、続きを待つ。** 流れてくるものなので、要素の
 * 途中で切れているのが普通
 */
export class MkvSplitter {
    private buffer = new Uint8Array(0);
    /** 時刻の刻み (ナノ秒)。Info に書いてあれば差し替える */
    private scale = DEFAULT_SCALE;
    /** いま居る塊の頭の時刻 (刻みの単位) */
    private base = 0;

    feed(chunk: Uint8Array): MkvFrame[] {
        const joined = new Uint8Array(this.buffer.length + chunk.length);
        joined.set(this.buffer);
        joined.set(chunk, this.buffer.length);
        this.buffer = joined;

        const out: MkvFrame[] = [];
        let at = 0;
        for (;;) {
            const head = this.head(at);
            if (head === null) break;
            // 中に入るものは、見出しだけ食べて先へ進む
            if (DESCEND.has(head.id) || head.size === UNKNOWN) {
                at = head.body;
                continue;
            }
            const end = head.body + head.size;
            if (end > this.buffer.length) break;
            const body = this.buffer.subarray(head.body, end);
            if (head.id === TIMESTAMP_SCALE) this.scale = uint(body) || DEFAULT_SCALE;
            else if (head.id === TIMESTAMP) this.base = uint(body);
            else if (head.id === SIMPLE_BLOCK || head.id === BLOCK) {
                const frame = this.block(body);
                if (frame !== null) out.push(frame);
            }
            at = end;
        }
        this.buffer = this.buffer.slice(at);
        return out;
    }

    private head(at: number): Header | null {
        const id = vint(this.buffer, at, true);
        if (id === null) return null;
        const size = vint(this.buffer, id.next, false);
        if (size === null) return null;
        return { id: id.value, size: size.value, body: size.next };
    }

    /**
     * コマ1つ。`[軌道の番号(可変長)][頭からの差(2バイト、符号あり)][旗][中身…]`
     *
     * **束ね (lacing) は来ない。** 1つの塊に複数のコマを詰める書き方だが、
     * ffmpeg は映像では使わない。万一来たら、その塊は捨てる — 変に読むより
     * 1枚落とすほうが安い (字幕は次が来る)
     */
    private block(body: Uint8Array): MkvFrame | null {
        const track = vint(body, 0, false);
        if (track === null || track.next + 3 > body.length) return null;
        const view = new DataView(body.buffer, body.byteOffset);
        const offset = view.getInt16(track.next);
        const flags = body[track.next + 2];
        if ((flags & 0x06) !== 0) return null;
        return {
            at: ((this.base + offset) * this.scale) / 1_000_000,
            data: body.slice(track.next + 3),
        };
    }
}
