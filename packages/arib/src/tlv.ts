/**
 * TLV パケット (ARIB STD-B32 第 3 部) を切り出す。4K の放送 (MMT/TLV) の土台で、TS の `PacketStream` と同じ役。
 *
 * TLV パケットは `0x7F`・種類 (1 バイト)・長さ (2 バイト) のヘッダーと、長さぶんの中身でできている。
 * 長さが毎回違うので、TS のように決まった間隔で同期のバイトを探すことはできない。
 * エージェントはケーブルの分割 TLV を組み立て直した TLV のバイト列を流す
 * ([agent.md](https://github.com/danything/denpa/blob/main/docs/agent.md))。
 */

import { concatBytes, u16 } from "./bytes.js";

/** TLV パケットの先頭のバイト (上位 2 ビットが 01、残りは予約で 1) */
const TLV_SYNC = 0x7f;
const HEADER = 4;

export const TLV_IPV4 = 0x01;
export const TLV_IPV6 = 0x02;
/** ヘッダー圧縮した IP (`tlv-ip.ts`) */
export const TLV_COMPRESSED_IP = 0x03;
/** 伝送制御信号 (TLV-SI。TLV-NIT・AMT のセクションが並ぶ) */
export const TLV_SIGNALING = 0xfe;
export const TLV_NULL = 0xff;

const TYPES = new Set([
  TLV_IPV4,
  TLV_IPV6,
  TLV_COMPRESSED_IP,
  TLV_SIGNALING,
  TLV_NULL,
]);

export interface TlvPacket {
  type: number;
  /** ヘッダーを除いた中身 */
  payload: Uint8Array;
  /** ヘッダーを含めたパケット全体。1 局に絞るとき (`mmt-service-filter.ts`) はこれをそのまま出す */
  bytes: Uint8Array;
}

/** `at` が TLV パケットの先頭に見えるか (先頭のバイトと種類) */
function looksLikeHead(data: Uint8Array, at: number): boolean {
  return data[at] === TLV_SYNC && TYPES.has(data[at + 1]!);
}

/** 同期を探した結果。`wait` は、次のパケットの先頭がまだ届いていない候補 */
type Found = { at: number; wait: boolean } | null;

/**
 * 任意の長さで届く TLV のバイト列を TLV パケットに切り分ける。
 *
 * **先頭がパケットの先頭とは限らない。** 共有に途中から入った利用者は、TLV パケットの途中から受け取る
 * ([agent.md](https://github.com/danything/denpa/blob/main/docs/agent.md))。そこで、同期が取れていないときは
 * 先頭のバイトと種類が合い、**長さの先にある次のパケットの先頭も合う**位置を探して合わせる。
 * 1 か所だけで決めると、中身にたまたまある `7F 03` を先頭と取り違える。そのため、同期を取る最初のパケットは次のパケットの先頭が届くまで出さない。
 * 同期が取れたあとは、先頭が合わなくなるまでヘッダーの長さのとおりに進む。
 *
 * 出すパケットの中身は、渡されたチャンクか前の残りの一部を指す (コピーしない)。
 * **次の `feed` より後まで持つならコピーすること** (`PacketStream` と同じ)
 */
export class TlvStream {
  private rest = new Uint8Array(0);
  private synced = false;
  /** 合わせるために読み飛ばしたバイトの合計 */
  skipped = 0;
  /** 同期を失って合わせ直した回数 */
  resyncs = 0;

  *feed(chunk: Uint8Array): Generator<TlvPacket> {
    let data = chunk;
    if (this.rest.length > 0) {
      /*
       * 前の残りが同期の取れたパケットの途中なら、そのパケットだけをチャンクの先頭と繋ぐ。
       * **チャンクの全体は写さない** (38 Mbps を毎回写すことになる)
       */
      const head = concatBytes([this.rest, chunk.subarray(0, HEADER)]);
      if (this.synced && head.length >= HEADER && looksLikeHead(head, 0)) {
        const used = HEADER + u16(head, 2) - this.rest.length;
        if (used > chunk.length) {
          this.rest = concatBytes([this.rest, chunk]);
          return;
        }
        const packet = concatBytes([this.rest, chunk.subarray(0, used)]);
        yield {
          type: packet[1]!,
          payload: packet.subarray(HEADER),
          bytes: packet,
        };
        data = chunk.subarray(used);
      } else data = concatBytes([this.rest, chunk]);
    }
    let at = 0;
    for (;;) {
      if (!this.synced) {
        const found = findHead(data, at);
        // 見つからなければ、次のチャンクと繋げて探せるよう末尾の 3 バイトだけを残す
        const next = found?.at ?? Math.max(at, data.length - (HEADER - 1));
        this.skipped += next - at;
        at = next;
        if (found === null || found.wait) break;
        this.synced = true;
      }
      if (at + HEADER > data.length) break;
      if (!looksLikeHead(data, at)) {
        this.synced = false;
        this.resyncs++;
        continue;
      }
      const end = at + HEADER + u16(data, at + 2);
      if (end > data.length) break;
      yield {
        type: data[at + 1]!,
        payload: data.subarray(at + HEADER, end),
        bytes: data.subarray(at, end),
      };
      at = end;
    }
    this.rest = data.slice(at);
  }
}

/** `from` から、先頭と次のパケットの先頭がどちらも合う位置を探す */
function findHead(data: Uint8Array, from: number): Found {
  for (let at = from; at + HEADER <= data.length; at++) {
    if (!looksLikeHead(data, at)) continue;
    const next = at + HEADER + u16(data, at + 2);
    if (next + 2 > data.length) return { at, wait: true };
    if (looksLikeHead(data, next)) return { at, wait: false };
  }
  return null;
}
