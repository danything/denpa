/**
 * チャンネル丸ごとの TLV のバイト列から、1 つの局のぶんだけを抜き出す。TS の `service-filter.ts` に当たり、
 * 出力も TLV のバイト列のまま (TLV のパケットを 1 バイトも変えずに、残すものだけを並べる)。
 *
 * 局を見分けるのは MPT (MMT_package_id が service_id)。MPT は IP の並び (`tlv-ip.ts` の `flow`) の中を
 * 運ばれ、MMTP の packet_id はその並びの中でだけ決まっているので、残すかどうかは並びと packet_id の組で決める。
 *
 * - 残す … TLV-SI (TLV-NIT など)、IP のヘッダーを圧縮していない IP (NTP)、その局の MPT が載った並びの信号
 *   (PLT・MPT・番組表・ECM)、その局の MPT が挙げるアセット (映像・音声・字幕) の MPU
 * - 落とす … 詰め物、ほかの局の MPT とそのアセット、PLT がほかの局だけを挙げている並び
 *
 * 実機のケーブルの BS4K は、1 つの TLV のストリームに局が 1 つ (IP の並びも 1 つ) だったので、たいていは
 * 詰め物のほかは全部残る。AMT (局ごとの IP の宛先) は 0.8 秒の間に来なかったので使わない。
 * MPT は 0.1 秒おきに来ていた
 */

import { concatBytes } from "./bytes.js";
import {
  type Mpt,
  parseMpt,
  parsePlt,
  TABLE_MPT,
  TABLE_PLT,
} from "./mmt-si.js";
import {
  MESSAGE_PA,
  messageTables,
  parseMessage,
  parseMmtp,
  PAYLOAD_SIGNALING,
  SignalingAssembler,
} from "./mmtp.js";
import { TlvIpReader } from "./tlv-ip.js";
import { TLV_COMPRESSED_IP, TLV_NULL, TlvStream } from "./tlv.js";

/**
 * MPT を読むまで取っておく TLV のパケットの数の上限。**選局したての先頭を捨てない** (`ServiceFilter` と同じ)。
 * MPT は 0.1 秒おきに来るので、38 Mbps でもふつうは 400 個ほどで足りる
 */
const HOLD_MOST = 8192;

/** IP の並び 1 つぶんの、分かったこと */
interface Flow {
  /** PLT が挙げた、ほかの局の MPT の packet_id */
  foreignMpt: Set<number>;
  /** PLT がこの局を挙げずに、ほかの局だけを挙げた */
  foreign: boolean;
  /** この局の MPT が挙げたアセットと ECM の packet_id。MPT を読むまでは null */
  own: Set<number> | null;
}

interface Held {
  flow: string;
  packetId: number;
  bytes: Uint8Array;
}

/**
 * 1 つの局に絞る。
 *
 * その局の MPT を読むまでは、MPU (映像・音声) を出さずに取っておき、読んだら MPT の後ろに出す
 * (並びは届いた順のまま)。信号は待たずに出す
 */
export class MmtServiceFilter {
  private readonly tlv = new TlvStream();
  private readonly ip = new TlvIpReader();
  private readonly signaling = new SignalingAssembler();
  private readonly flows = new Map<string, Flow>();
  private held: Held[] = [];
  private mptNow: Mpt | null = null;

  /** @param serviceId 残す局 (MPT の MMT_package_id) */
  constructor(private readonly serviceId: number) {}

  /** その局の MPT を読めたか。読めるまで映像と音声は 1 バイトも出ない (届いたものは取っておく) */
  get ready(): boolean {
    return this.mptNow !== null;
  }

  /** 最後に読んだ、その局の MPT。読むまでは null */
  get mpt(): Mpt | null {
    return this.mptNow;
  }

  /** 任意の長さの TLV のバイト列を渡すと、残すぶんを返す */
  filter(chunk: Uint8Array): Uint8Array {
    const out: Uint8Array[] = [];
    for (const packet of this.tlv.feed(chunk)) {
      if (packet.type === TLV_NULL) continue;
      // MMTP は圧縮した IP で来る。TLV-SI と、圧縮していない IP (NTP) はそのまま残す
      if (packet.type !== TLV_COMPRESSED_IP) {
        out.push(packet.bytes);
        continue;
      }
      const datagram = this.ip.read(packet);
      const mmtp = datagram === null ? null : parseMmtp(datagram.payload);
      if (datagram === null || mmtp === null) continue;
      const flow = this.flow(datagram.flow);
      const packetId = mmtp.packetId;

      // ほかの局だけの並びでも信号は読み続ける (後の PLT がこの局を挙げたら出し始める)。出すかは読んだあとで決める
      if (mmtp.payloadType === PAYLOAD_SIGNALING) {
        const before = flow.own;
        for (const raw of this.signaling.feed(datagram.flow, mmtp))
          this.readSignaling(flow, raw);
        if (flow.foreign || flow.foreignMpt.has(packetId)) continue;
        out.push(packet.bytes);
        // MPT を読んだ (読み直した)。取っておいたもののうち、この局のぶんを出す
        if (flow.own !== null && flow.own !== before) this.release(out);
        continue;
      }
      if (flow.foreign) continue;
      if (flow.own === null) this.hold(datagram.flow, packetId, packet.bytes);
      else if (flow.own.has(packetId)) out.push(packet.bytes);
    }
    return concatBytes(out);
  }

  private flow(key: string): Flow {
    let flow = this.flows.get(key);
    if (flow === undefined) {
      flow = { foreignMpt: new Set(), foreign: false, own: null };
      this.flows.set(key, flow);
    }
    return flow;
  }

  private readSignaling(flow: Flow, raw: Uint8Array): void {
    const message = parseMessage(raw);
    if (message === null || message.messageId !== MESSAGE_PA) return;
    for (const table of messageTables(message)) {
      if (table[0] === TABLE_PLT) {
        const plt = parsePlt(table);
        if (plt === null) continue;
        flow.foreignMpt.clear();
        let mine = false;
        for (const { packageId, location } of plt.packages) {
          if (packageId === this.serviceId) mine = true;
          else if (location.type === 0 && location.packetId !== null)
            flow.foreignMpt.add(location.packetId);
        }
        flow.foreign = !mine && plt.packages.length > 0;
      } else if (table[0] === TABLE_MPT) {
        // 持ち続けるのでコピーする (表は届いたチャンクの一部を指す。`TlvStream`)
        const mpt = parseMpt(table.slice());
        if (mpt === null || mpt.packageId !== this.serviceId) continue;
        this.mptNow = mpt;
        flow.own = ownPacketIds(mpt);
      }
    }
  }

  /** MPT を読む前のパケットを取っておく。**コピーする** (パケットは届いたチャンクの一部を指す。`TlvStream`) */
  private hold(flow: string, packetId: number, bytes: Uint8Array): void {
    this.held.push({ flow, packetId, bytes: bytes.slice() });
    // 溢れたら古い半分を捨てる (`ServiceFilter` と同じ)
    if (this.held.length > HOLD_MOST)
      this.held = this.held.slice(this.held.length - HOLD_MOST / 2);
  }

  private release(out: Uint8Array[]): void {
    const rest: Held[] = [];
    for (const held of this.held) {
      const flow = this.flows.get(held.flow);
      // ほかの局だけの並びと分かったものは捨てる。まだ分からない並びのものは取っておく
      if (flow === undefined || flow.foreign) continue;
      if (flow.own === null) rest.push(held);
      else if (flow.own.has(held.packetId)) out.push(held.bytes);
    }
    this.held = rest;
  }
}

/** MPT が挙げる、同じ IP の並びの packet_id (アセットと ECM) */
function ownPacketIds(mpt: Mpt): Set<number> {
  const ids = new Set<number>();
  const add = (location: { type: number; packetId: number | null }) => {
    if (location.type === 0 && location.packetId !== null)
      ids.add(location.packetId);
  };
  for (const access of mpt.access) add(access.location);
  for (const asset of mpt.assets) {
    for (const location of asset.locations) add(location);
    for (const access of asset.access) add(access.location);
  }
  return ids;
}
