/**
 * **放送の字幕 (ARIB STD-B24) を組み立てる** (試験用)。読む側は [b24caption.ts](b24caption.ts)。
 *
 * 出来るのは字幕の PES の中身 (データ識別 0x80 から) で、ffmpeg が `-c:s copy` で
 * Matroska に入れたコマと同じ形。TS に載せるなら `synth-av.ts` の `pes(0xbd, …)` で包む。
 */

import { encodeAribText } from './synth';
import { packetizePes, pes } from './synth-av';

export { encodeAribText };

/** CRC-16 (ITU-T。データグループの末尾) */
function crc16(data: number[]): number {
    let crc = 0;
    for (const byte of data) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** データユニット。0x20 本文・0x30 1バイト DRCS・0x31 2バイト DRCS */
export function unit(parameter: number, data: number[]): number[] {
    return [0x1f, parameter, ...u24(data.length), ...data];
}

/** データグループで包んで PES の中身にする。`id` は 0 (管理) / 1 (第1言語)、`group` は 0 (A) / 1 (B) */
function dataGroup(id: number, group: number, body: number[]): Uint8Array {
    const groupId = (group << 5) | id;
    const head = [groupId << 2, 0x00, 0x00, (body.length >> 8) & 0xff, body.length & 0xff, ...body];
    const crc = crc16(head);
    // データ識別 0x80 / 私的ストリーム識別 0xFF / PES データパケットヘッダ長 0 (上位は予約で 1)
    return Uint8Array.from([0x80, 0xff, 0xf0, ...head, crc >> 8, crc & 0xff]);
}

/**
 * 字幕管理データ。日本語1つ・書式は `format` (SWF+1。既定 8 = 960x540 横書き)
 */
export function management(options: { format?: number; group?: number; units?: number[] } = {}): Uint8Array {
    const { format = 8, group = 0, units = [] } = options;
    const body = [
        0x3f, // TMD 00 (自由)
        1, // 言語の数
        0x00 | 0x10, // 言語タグ 0 / DMF 0000 (予約ビット 1)
        ...[0x6a, 0x70, 0x6e], // "jpn"
        (format << 4) | 0x00, // 書式 / TCS 0 (8単位符号) / ロールアップ無し
        ...u24(units.length),
        ...units,
    ];
    return dataGroup(0, group, body);
}

/** 字幕文 (第1言語)。`units` はデータユニットを並べたもの。本文だけなら `text(...)` を使う */
export function statement(units: number[]): Uint8Array {
    return dataGroup(1, 0, [0x3f, ...u24(units.length), ...units]);
}

/** 本文1つだけの字幕文 */
export function text(body: number[]): Uint8Array {
    return statement(unit(0x20, body));
}

/**
 * 1バイト DRCS (DRCS-1 の面) の定義。`rows` は '#' を点にした絵 (白黒)
 *
 * @param code 符号 (0x21〜0x7E)。呼び出すときは `ESC ( 0x20 0x41` で G0 に載せて、この符号を書く
 */
export function drcsUnit(code: number, rows: string[]): number[] {
    const height = rows.length;
    const width = rows[0]?.length ?? 0;
    const bits: number[] = [];
    for (const row of rows) for (const cell of row) bits.push(cell === '#' ? 1 : 0);
    const bytes: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i + b] ?? 0);
        bytes.push(byte);
    }
    return unit(0x30, [
        1, // 符号の数
        0x41, // DRCS-1 の面 (上位) と
        code, // 符号
        1, // 字体の数
        0x00, // 字体番号 0 / 方式 0000 (2階調)
        0, // 階調 - 2
        width,
        height,
        ...bytes,
    ]);
}

/** 字幕を載せた TS の PID と、PMT の記述子 (部品タグ 0x30・字幕の符号化方式 0x0008) */
export const CAPTION_PID = 0x130;
export const CAPTION_DESCRIPTORS = [0x52, 0x01, 0x30, 0xfd, 0x03, 0x00, 0x08, 0x3d];

/** PMT に並べる字幕の ES (種別 0x06) */
export function captionStream(): [number, number, number[]] {
    return [0x06, CAPTION_PID, CAPTION_DESCRIPTORS];
}

/** 字幕の PES の中身を、時刻を付けて TS パケットにする (私的ストリーム 1 = 0xBD) */
export function captionPackets(
    data: Uint8Array,
    pts: number,
    counter: number,
): { packets: Uint8Array; counter: number } {
    return packetizePes(CAPTION_PID, pes(0xbd, pts, data), counter);
}
