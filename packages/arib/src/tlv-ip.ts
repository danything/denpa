/**
 * TLV パケットに入った IP を読み、UDP の中身 (MMTP・NTP) を返す (ARIB STD-B32 第 3 部)。
 *
 * 4K の放送の映像・音声・信号は、IPv6 の UDP で運ぶ MMTP に入っている。帯域を節約するため、
 * ほとんどのパケットは IP と UDP のヘッダーを省いた「ヘッダー圧縮した IP」(TLV の種類 0x03) で来る。
 * 同じ宛先の並びには CID (context_id) が振られ、ときどき来る全部のヘッダー (圧縮の種類 0x60) で
 * 宛先を知らせ、あいだは CID だけ (0x61) になる。
 *
 * 実機 (ケーブルで受けた BS4K) で来たのは、0x60 と 0x61 のほかは NTP を運ぶ素の IPv6 だけだった。
 * IPv4 の圧縮 (0x20・0x21) は来ていないので読まない。
 */

import { u16 } from "./bytes.js";
import {
  TLV_COMPRESSED_IP,
  TLV_IPV4,
  TLV_IPV6,
  type TlvPacket,
} from "./tlv.js";

/** 0x60: IPv6 のヘッダー (payload_length を除いた 38 バイト) と UDP のヘッダー (length と checksum を除いた 4 バイト) */
const COMPRESSED_IPV6_UDP = 0x60;
/** 0x61: ヘッダー無し。宛先は同じ CID の 0x60 で知らせたもの */
const COMPRESSED_NONE = 0x61;

const COMPRESSED_HEAD = 3;
const PARTIAL_IPV6 = 38;
const PARTIAL_UDP = 4;
const IPV6_HEADER = 40;
const UDP_HEADER = 8;
const PROTOCOL_UDP = 17;

/** UDP の宛先と送り元 */
export interface UdpAddress {
  source: string;
  destination: string;
  sourcePort: number;
  destinationPort: number;
}

export interface UdpDatagram {
  /**
   * 同じ宛先の並びを見分ける鍵。圧縮したものは `cid:<CID>`、圧縮していないものは宛先のアドレスとポート。
   * MMTP の packet_id はこの並びの中でだけ決まっている
   */
  flow: string;
  /** 宛先と送り元。0x61 の CID の 0x60 をまだ受けていなければ null */
  address: UdpAddress | null;
  payload: Uint8Array;
}

/** IPv6 のアドレス 16 バイトを文字列に (0 の続く所は縮めず、各グループの先頭の 0 だけ落とす) */
export function ipv6Text(data: Uint8Array, at: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(u16(data, at + i).toString(16));
  return groups.join(":");
}

function ipv4Text(data: Uint8Array, at: number): string {
  return [0, 1, 2, 3].map((i) => data[at + i]!).join(".");
}

/**
 * TLV パケットから UDP を取り出す。**CID ごとの宛先を覚える**ので、1 つの TLV のストリームに 1 つ使う。
 *
 * 圧縮したものは、CID の宛先をまだ知らなくても中身を返す (`address` が null)。
 * 圧縮できるのは UDP だけなので中身は UDP の中身と決まっていて、MMTP は宛先を知らなくても読める。
 * 全部のヘッダーは 1 秒に 10 回ほどしか来ないので、待つと選局したての 0.1 秒ぶんを捨てることになる
 */
export class TlvIpReader {
  private readonly contexts = new Map<number, UdpAddress>();

  /** IP を運ぶ TLV パケットでなければ・UDP でなければ null */
  read(packet: TlvPacket): UdpDatagram | null {
    const data = packet.payload;
    switch (packet.type) {
      case TLV_COMPRESSED_IP:
        return this.compressed(data);
      case TLV_IPV6:
        return ipv6(data);
      case TLV_IPV4:
        return ipv4(data);
      default:
        return null;
    }
  }

  private compressed(data: Uint8Array): UdpDatagram | null {
    if (data.length < COMPRESSED_HEAD) return null;
    // CID (12 ビット) と sequence number (4 ビット)、圧縮の種類
    const cid = u16(data, 0) >> 4;
    const flow = `cid:${cid}`;
    switch (data[2]) {
      case COMPRESSED_IPV6_UDP: {
        const at = COMPRESSED_HEAD;
        const payloadAt = at + PARTIAL_IPV6 + PARTIAL_UDP;
        if (data.length < payloadAt) return null;
        // 38 バイトの並びは version・traffic class・flow label (4)、next header (1)、hop limit (1)、送り元 (16)、宛先 (16)
        const address: UdpAddress = {
          source: ipv6Text(data, at + 6),
          destination: ipv6Text(data, at + 22),
          sourcePort: u16(data, at + PARTIAL_IPV6),
          destinationPort: u16(data, at + PARTIAL_IPV6 + 2),
        };
        this.contexts.set(cid, address);
        return { flow, address, payload: data.subarray(payloadAt) };
      }
      case COMPRESSED_NONE:
        return {
          flow,
          address: this.contexts.get(cid) ?? null,
          payload: data.subarray(COMPRESSED_HEAD),
        };
      default:
        return null;
    }
  }
}

/** 素の IPv6 の UDP。拡張ヘッダーの付いたものは読まない (来ていない) */
function ipv6(data: Uint8Array): UdpDatagram | null {
  if (data.length < IPV6_HEADER + UDP_HEADER || data[6] !== PROTOCOL_UDP)
    return null;
  const end = Math.min(data.length, IPV6_HEADER + u16(data, 4));
  return udp(data, ipv6Text(data, 8), ipv6Text(data, 24), IPV6_HEADER, end);
}

function ipv4(data: Uint8Array): UdpDatagram | null {
  if (data.length < 20 || data[9] !== PROTOCOL_UDP) return null;
  const header = (data[0]! & 0x0f) * 4;
  const end = Math.min(data.length, u16(data, 2));
  return udp(data, ipv4Text(data, 12), ipv4Text(data, 16), header, end);
}

function udp(
  data: Uint8Array,
  source: string,
  destination: string,
  at: number,
  end: number,
): UdpDatagram | null {
  if (at + UDP_HEADER > end) return null;
  const address: UdpAddress = {
    source,
    destination,
    sourcePort: u16(data, at),
    destinationPort: u16(data, at + 2),
  };
  return {
    flow: `${destination}:${address.destinationPort}`,
    address,
    payload: data.subarray(
      at + UDP_HEADER,
      Math.min(end, at + u16(data, at + 4)),
    ),
  };
}
