/**
 * MMTP のパケット (ISO/IEC 23008-1、ARIB STD-B60) を読み、信号メッセージを組み立てる。
 *
 * MMTP のパケットは UDP 1 つに 1 つ入っている (`tlv-ip.ts`)。中身は 2 種類で、
 * 映像・音声・字幕を運ぶ MPU (payload_type 0) と、局の中身の一覧や番組表を運ぶ信号メッセージ (2)。
 * どちらかは packet_id ごとに決まっている。
 *
 * **4K の放送では映像と音声がスクランブルされ、信号はされていない** (実機のケーブルの BS4K で確かめた)。
 * スクランブルの印はヘッダー拡張にあり (ARIB STD-B61)、MPU のペイロードヘッダー (8 バイト) までは読める。
 * 復号はエージェントの仕事 (まだ扱わない)。
 */

import { concatBytes, u16, u32 } from "./bytes.js";

export const PAYLOAD_MPU = 0x00;
export const PAYLOAD_SIGNALING = 0x02;

/** 種類がいくつも入るヘッダー拡張 (B61)。中に種類と長さの組が並ぶ */
const EXTENSION_MULTI = 0x0000;
/** ヘッダー拡張の中の、スクランブルの印の種類 */
const EXTENSION_SCRAMBLE = 0x0001;

/** スクランブルの印 (上位 2 ビット)。01 は予約 */
export type Scrambling = "none" | "even" | "odd";
const SCRAMBLING: Record<number, Scrambling | undefined> = {
  0: "none",
  2: "even",
  3: "odd",
};

export interface MmtpPacket {
  /** 頭出しできる所か (RAP_flag)。映像なら IRAP のピクチャを含む MPU の始まり */
  rap: boolean;
  payloadType: number;
  packetId: number;
  /** 送り出した時刻 (NTP の短い形式。上位 16 ビットが秒、下位 16 ビットが端数) */
  deliveryTimestamp: number;
  /** packet_id ごとの通し番号 */
  sequenceNumber: number;
  /** スクランブルの印。ヘッダー拡張に無ければ null (スクランブルしていない) */
  scrambling: Scrambling | null;
  /** ヘッダーとヘッダー拡張を除いた中身 */
  payload: Uint8Array;
}

/** MMTP のパケットを 1 つ読む。短すぎれば null */
export function parseMmtp(data: Uint8Array): MmtpPacket | null {
  if (data.length < 12) return null;
  const flags = data[0]!;
  let at = 12;
  // packet_counter_flag
  if (flags & 0x20) at += 4;
  let scrambling: Scrambling | null = null;
  // extension_flag
  if (flags & 0x02) {
    if (at + 4 > data.length) return null;
    const type = u16(data, at) & 0x7fff;
    const length = u16(data, at + 2);
    const body = data.subarray(at + 4, at + 4 + length);
    if (body.length < length) return null;
    if (type === EXTENSION_MULTI) scrambling = scramblingOf(body);
    at += 4 + length;
  }
  return {
    rap: (flags & 0x01) !== 0,
    payloadType: data[1]! & 0x3f,
    packetId: u16(data, 2),
    deliveryTimestamp: u32(data, 4),
    sequenceNumber: u32(data, 8),
    scrambling,
    payload: data.subarray(at),
  };
}

/** 種類がいくつも入るヘッダー拡張から、スクランブルの印を探す。種類の上位 1 ビットは「これで終わり」 */
function scramblingOf(body: Uint8Array): Scrambling | null {
  let at = 0;
  while (at + 4 <= body.length) {
    const type = u16(body, at);
    const length = u16(body, at + 2);
    if ((type & 0x7fff) === EXTENSION_SCRAMBLE && length >= 1)
      return SCRAMBLING[body[at + 4]! >> 6] ?? null;
    at += 4 + length;
    if (type & 0x8000) break;
  }
  return null;
}

/** 分割の印 (fragmentation_indicator)。0 は分割していない、1 は先頭、2 は途中、3 は最後 */
const WHOLE = 0;
const FIRST = 1;
const LAST = 3;

/** MPU のペイロードヘッダー (MPU の中身の手前の 8 バイト)。スクランブルされていても読める */
export interface MpuHeader {
  /** 0 は MPU のメタデータ、1 はムービーフラグメントのメタデータ、2 は MFU */
  fragmentType: number;
  timed: boolean;
  fragmentation: number;
  aggregated: boolean;
  fragmentCounter: number;
  mpuSequenceNumber: number;
  /** ペイロードヘッダーより後ろ。スクランブルされていれば、ここから先が暗号 */
  data: Uint8Array;
}

export function parseMpu(payload: Uint8Array): MpuHeader | null {
  if (payload.length < 8) return null;
  const flags = payload[2]!;
  return {
    fragmentType: flags >> 4,
    timed: (flags & 0x08) !== 0,
    fragmentation: (flags >> 1) & 0x03,
    aggregated: (flags & 0x01) !== 0,
    fragmentCounter: payload[3]!,
    mpuSequenceNumber: u32(payload, 4),
    data: payload.subarray(8, Math.min(payload.length, 2 + u16(payload, 0))),
  };
}

export const MESSAGE_PA = 0x0000;
export const MESSAGE_M2_SECTION = 0x8000;
export const MESSAGE_CA = 0x8001;
export const MESSAGE_M2_SHORT_SECTION = 0x8002;

export interface SignalingMessage {
  messageId: number;
  version: number;
  /** 長さまでのヘッダーを除いた中身 */
  body: Uint8Array;
}

/** PA メッセージは長さが 32 ビット、ほかの信号メッセージは 16 ビット */
function lengthBytes(messageId: number): number {
  return messageId === MESSAGE_PA ? 4 : 2;
}

/** 信号メッセージを 1 つ読む。長さが合わなければ null */
export function parseMessage(data: Uint8Array): SignalingMessage | null {
  if (data.length < 3) return null;
  const messageId = u16(data, 0);
  const width = lengthBytes(messageId);
  const at = 3 + width;
  if (data.length < at) return null;
  const length = width === 4 ? u32(data, 3) : u16(data, 3);
  if (data.length < at + length) return null;
  return {
    messageId,
    version: data[2]!,
    body: data.subarray(at, at + length),
  };
}

/**
 * 信号メッセージに入った表を返す。
 *
 * - PA メッセージは表の数と、表ごとの (table_id・バージョン・長さ) を先に並べ、そのあとに表を並べる。
 *   表の頭は table_id・バージョン・長さ (16 ビット) で、MPT と PLT はこの形式
 * - M2 セクションメッセージ・M2 短セクションメッセージ・CA メッセージは、表を 1 つだけ運ぶ。
 *   M2 セクションは TS のセクションと同じ形式で、末尾に CRC32 が付く (確かめるのは `mmt-si.ts`)
 */
export function messageTables(message: SignalingMessage): Uint8Array[] {
  const body = message.body;
  switch (message.messageId) {
    case MESSAGE_PA: {
      if (body.length < 1) return [];
      const tables: Uint8Array[] = [];
      let at = 1 + body[0]! * 4;
      while (at + 4 <= body.length) {
        const end = at + 4 + u16(body, at + 2);
        if (end > body.length) break;
        tables.push(body.subarray(at, end));
        at = end;
      }
      return tables;
    }
    case MESSAGE_M2_SECTION:
    case MESSAGE_M2_SHORT_SECTION:
    case MESSAGE_CA:
      return body.length > 0 ? [body] : [];
    default:
      return [];
  }
}

/** 組み立て中の、分割された信号メッセージ */
interface Pending {
  parts: Uint8Array[];
  /** 最後に受けた断片の packet_sequence_number */
  sequence: number;
}

/**
 * MMTP の信号メッセージを組み立てる。**分割と集約の両方を戻す。**
 *
 * - 長いメッセージ (番組表の MH-EIT や大きな MPT) は、いくつもの MMTP のパケットに分割して送られる。
 *   欠けは packet_sequence_number (packet_id ごとに 1 ずつ増える) で見る。続いていなければ、組み立て中のものを
 *   捨てて次の先頭を待つ。**fragment_counter は当てにしない。** 実機のケーブルの BS4K は分割したものでも
 *   いつも 0 を入れていた
 * - 短いメッセージは、1 つの MMTP のパケットに長さを前に付けて集約される (aggregation_flag)。
 *   長さは length_extension_flag が立っていれば 32 ビット、立っていなければ 16 ビット
 *
 * 組み立て中のものは、並び (`flow`) と packet_id の組ごとに持つ
 */
export class SignalingAssembler {
  private readonly pending = new Map<string, Pending>();
  /** 欠けて捨てた、組み立て中のメッセージの数 */
  dropped = 0;

  /** 信号メッセージを運ぶ MMTP のパケットを 1 つ渡す。そろったメッセージを返す */
  feed(flow: string, packet: MmtpPacket): Uint8Array[] {
    const payload = packet.payload;
    if (packet.payloadType !== PAYLOAD_SIGNALING || payload.length < 2)
      return [];
    const fragmentation = payload[0]! >> 6;
    const longLength = (payload[0]! & 0x02) !== 0;
    const aggregated = (payload[0]! & 0x01) !== 0;
    const body = payload.subarray(2);
    const key = `${flow}/${packet.packetId}`;

    let whole: Uint8Array | null = null;
    if (fragmentation === WHOLE) {
      if (this.pending.delete(key)) this.dropped++;
      whole = body;
    } else if (fragmentation === FIRST) {
      if (this.pending.delete(key)) this.dropped++;
      // 断片を持ち越すのでコピーする (中身は届いたチャンクの一部を指す。`TlvStream`)
      this.pending.set(key, {
        parts: [body.slice()],
        sequence: packet.sequenceNumber,
      });
    } else {
      const held = this.pending.get(key);
      if (held === undefined) return [];
      if (packet.sequenceNumber !== (held.sequence + 1) >>> 0) {
        this.pending.delete(key);
        this.dropped++;
        return [];
      }
      held.parts.push(body.slice());
      held.sequence = packet.sequenceNumber;
      if (fragmentation === LAST) {
        this.pending.delete(key);
        whole = concatBytes(held.parts);
      }
    }
    if (whole === null) return [];
    return aggregated ? splitAggregated(whole, longLength) : [whole];
  }
}

/** 集約されたメッセージを、前に付いた長さで切り分ける */
function splitAggregated(data: Uint8Array, longLength: boolean): Uint8Array[] {
  const width = longLength ? 4 : 2;
  const out: Uint8Array[] = [];
  let at = 0;
  while (at + width <= data.length) {
    const length = longLength ? u32(data, at) : u16(data, at);
    const end = at + width + length;
    if (end > data.length) break;
    out.push(data.subarray(at + width, end));
    at = end;
  }
  return out;
}
