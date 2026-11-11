/**
 * 試験用の TLV のバイト列 (TLV・IP・MMTP・MMT-SI) を組み立てる。TS の `synth.ts` と同じ役で、
 * 読む側 (`tlv.ts`・`tlv-ip.ts`・`mmtp.ts`・`mmt-si.ts`・`mh-eit.ts`・`mmt-service-filter.ts`・`mmt-media.ts`) と対になる書く側。
 *
 * スクランブルは印 (ヘッダー拡張) だけを付け、中身は暗号にしない。
 */

import { concatBytes } from "./bytes.js";
import type { Scrambling } from "./mmtp.js";
import { withCrc } from "./psi.js";
import { bcdDuration, mjdTime } from "./synth.js";
import { TLV_COMPRESSED_IP, TLV_IPV6, TLV_SIGNALING } from "./tlv.js";

const be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number) => [...be(value >>> 16), ...be(value & 0xffff)];
const utf8 = (text: string) => [...new TextEncoder().encode(text)];
const JPN = [0x6a, 0x70, 0x6e];

/** TLV のパケット 1 つ */
export function tlvPacket(
  type: number,
  payload: Uint8Array | number[],
): Uint8Array {
  const body = Uint8Array.from(payload);
  return Uint8Array.from([0x7f, type, ...be(body.length), ...body]);
}

/** IPv6 のアドレスを 16 バイトに (`ff3e::a000:1000` のような縮めた形も読む) */
function ipv6Bytes(text: string): number[] {
  const [head = "", tail] = text.split("::");
  const groups = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const zeros = new Array(8 - front.length - back.length).fill(0);
  return [...front, ...zeros, ...back].flatMap(be);
}

/** 宛先と送り元。実機の BS4K と同じ値を既定にする */
export interface SynthAddress {
  source?: string;
  destination?: string;
  sourcePort?: number;
  destinationPort?: number;
}

/**
 * ヘッダー圧縮した IP の TLV パケット。`address` を渡せば全部のヘッダー (圧縮の種類 0x60)、
 * 渡さなければヘッダー無し (0x61)
 */
export function compressedIp(
  cid: number,
  payload: Uint8Array,
  address?: SynthAddress,
  sequence = 0,
): Uint8Array {
  const head = [(cid >> 4) & 0xff, ((cid & 0x0f) << 4) | (sequence & 0x0f)];
  if (address === undefined)
    return tlvPacket(TLV_COMPRESSED_IP, [...head, 0x61, ...payload]);
  const ip = [
    0x60,
    0x00,
    0x00,
    0x00, // version・traffic class・flow label
    17, // next header (UDP)
    0x40, // hop limit
    ...ipv6Bytes(address.source ?? "2401:dbc0:1003::b111"),
    ...ipv6Bytes(address.destination ?? "ff3e::a000:1000"),
    ...be(address.sourcePort ?? 50000),
    ...be(address.destinationPort ?? 51216),
  ];
  return tlvPacket(TLV_COMPRESSED_IP, [...head, 0x60, ...ip, ...payload]);
}

/** 素の IPv6 の UDP の TLV パケット (NTP など) */
export function ipv6Udp(
  destination: string,
  destinationPort: number,
  payload: Uint8Array,
): Uint8Array {
  const udp = [
    ...be(destinationPort),
    ...be(destinationPort),
    ...be(8 + payload.length),
    0x00,
    0x00,
    ...payload,
  ];
  return tlvPacket(TLV_IPV6, [
    0x60,
    0x00,
    0x00,
    0x00,
    ...be(udp.length),
    17,
    0x01,
    ...ipv6Bytes("fe80::1"),
    ...ipv6Bytes(destination),
    ...udp,
  ]);
}

/** TLV-SI の TLV パケット。セクションを並べ、残りは詰めない */
export function tlvSi(...sections: Uint8Array[]): Uint8Array {
  return tlvPacket(TLV_SIGNALING, concatBytes(sections));
}

export interface SynthMmtp {
  packetId: number;
  /** 0 は MPU、2 は信号メッセージ */
  payloadType: number;
  sequenceNumber?: number;
  rap?: boolean;
  /** 付ければスクランブルの印のヘッダー拡張を付ける (中身は暗号にしない) */
  scrambling?: Scrambling;
  payload: Uint8Array | number[];
}

const SCRAMBLING_BITS: Record<Scrambling, number> = {
  none: 0,
  even: 2,
  odd: 3,
};

/** MMTP のパケット 1 つ (UDP の中身) */
export function mmtpPacket(packet: SynthMmtp): Uint8Array {
  const extension =
    packet.scrambling === undefined
      ? []
      : [
          // 種類がいくつも入る拡張 (0x0000) の中に、スクランブルの印 (種類 0x0001・長さ 1。上位 1 ビットは「これで終わり」)
          ...be(0x0000),
          ...be(5),
          ...be(0x8001),
          ...be(1),
          (SCRAMBLING_BITS[packet.scrambling] << 6) | 0x3f,
        ];
  return Uint8Array.from([
    // version 0、packet_counter_flag 0、FEC 0、extension_flag、RAP_flag
    (extension.length > 0 ? 0x02 : 0) | (packet.rap === true ? 0x01 : 0),
    packet.payloadType & 0x3f,
    ...be(packet.packetId),
    ...be32(0), // delivery_timestamp
    ...be32(packet.sequenceNumber ?? 0),
    ...extension,
    ...packet.payload,
  ]);
}

/** MPU のパケットの中身 (ペイロードヘッダー 8 バイトと、その後ろ) */
export function mpuPayload(
  data: Uint8Array | number[],
  mpuSequenceNumber = 0,
): Uint8Array {
  const body = [
    0x28, // fragment_type 2 (MFU)、timed、分割なし、集約なし
    0x00,
    ...be32(mpuSequenceNumber),
    ...data,
  ];
  return Uint8Array.from([...be(body.length), ...body]);
}

/** MFU のデータユニット 1 つ。同じ `sample` のものが 1 つのアクセスユニット */
export interface SynthDataUnit {
  sample: number;
  data: Uint8Array | number[];
}

/** MFU の運び方 */
export interface SynthMfuOptions {
  /** 最初のパケットの packet_sequence_number */
  sequenceNumber?: number;
  /** データユニットを 1 つのパケットに集約する */
  aggregate?: boolean;
  /** データユニットを分割するときの、1 つのパケットに載せる中身の上限 (バイト)。省くと分割しない */
  fragment?: number;
  /** 最初のパケットに RAP_flag を立てる */
  rap?: boolean;
}

/** 時刻のあるデータユニットのヘッダー (14 バイト。offset はサンプルの中の位置) */
function timedHeader(sample: number, offset: number): number[] {
  return [...be32(0), ...be32(sample), ...be32(offset), 0x00, 0x00];
}

/**
 * MPU の中身 (MFU) を運ぶ MMTP のパケットの並び。データユニットは時刻のあるもの (映像・音声・字幕)。
 * 分割したデータユニットは、断片ごとにヘッダーを付ける
 */
export function mfuPackets(
  packetId: number,
  mpuSequenceNumber: number,
  units: SynthDataUnit[],
  options: SynthMfuOptions = {},
): Uint8Array[] {
  const start = options.sequenceNumber ?? 0;
  let sequenceNumber = start;
  const packet = (indicator: number, aggregated: boolean, body: number[]) => {
    const payload = [
      // fragment_type 2 (MFU)、timed、分割の印、集約の印
      0x28 | (indicator << 1) | (aggregated ? 0x01 : 0),
      0x00,
      ...be32(mpuSequenceNumber),
      ...body,
    ];
    return mmtpPacket({
      packetId,
      payloadType: 0,
      rap: sequenceNumber === start && options.rap === true,
      sequenceNumber: sequenceNumber++,
      payload: [...be(payload.length), ...payload],
    });
  };
  if (options.aggregate === true) {
    const body = units.flatMap((unit) => {
      const du = [...timedHeader(unit.sample, 0), ...unit.data];
      return [...be(du.length), ...du];
    });
    return [packet(0, true, body)];
  }
  const out: Uint8Array[] = [];
  for (const unit of units) {
    const data = [...unit.data];
    const size = options.fragment ?? data.length;
    if (data.length <= size) {
      out.push(packet(0, false, [...timedHeader(unit.sample, 0), ...data]));
      continue;
    }
    for (let at = 0; at < data.length; at += size) {
      const indicator = at === 0 ? 1 : at + size >= data.length ? 3 : 2;
      out.push(
        packet(indicator, false, [
          ...timedHeader(unit.sample, at),
          ...data.slice(at, at + size),
        ]),
      );
    }
  }
  return out;
}

/** NTP の 64 ビットの時刻 `[秒, 端数 (1/2^32 秒)]` */
export type SynthNtp = [number, number];

/** MPU タイムスタンプ記述子。MPU ごとに `[mpu_sequence_number, 最初の提示時刻]` */
export function mpuTimestampDescriptor(mpus: [number, SynthNtp][]): number[] {
  return mmtDescriptor(
    0x0001,
    mpus.flatMap(([sequence, [seconds, fraction]]) => [
      ...be32(sequence),
      ...be32(seconds),
      ...be32(fraction),
    ]),
  );
}

export interface SynthExtendedMpu {
  sequence: number;
  /** mpu_decoding_time_offset */
  decodingOffset: number;
  /** アクセスユニットごとの dts_pts_offset (デコードの順) */
  dtsPtsOffsets: number[];
  /** アクセスユニットごとの pts_offset。`duration` を渡さないときに書く (種類 2) */
  durations?: number[];
}

/**
 * MPU 拡張タイムスタンプ記述子。`duration` を渡せば pts_offset をどれも同じ値で書き (種類 1。実機の BS4K はこれ)、
 * 渡さなければアクセスユニットごとに書く (種類 2)
 */
export function mpuExtendedTimestampDescriptor(
  timescale: number,
  mpus: SynthExtendedMpu[],
  duration?: number,
): number[] {
  const type = duration === undefined ? 2 : 1;
  return mmtDescriptor(0x8026, [
    0xf8 | (type << 1) | 0x01,
    ...be32(timescale),
    ...(duration === undefined ? [] : be(duration)),
    ...mpus.flatMap((mpu) => [
      ...be32(mpu.sequence),
      0x3f,
      ...be(mpu.decodingOffset),
      mpu.dtsPtsOffsets.length,
      ...mpu.dtsPtsOffsets.flatMap((offset, i) => [
        ...be(offset),
        ...(type === 2 ? be(mpu.durations?.[i] ?? 0) : []),
      ]),
    ]),
  ]);
}

/** ビットを詰めていく (LATM を書くため) */
class BitWriter {
  private readonly bytes: number[] = [];
  private at = 0;

  put(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i--) {
      if (this.at % 8 === 0) this.bytes.push(0);
      if (Math.floor(value / 2 ** i) % 2)
        this.bytes[this.bytes.length - 1]! |= 0x80 >> (this.at % 8);
      this.at++;
    }
    return this;
  }

  get done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * LATM の AudioMuxElement (muxConfigPresent = 1。LOAS の同期のヘッダーは付けない)。
 * `audioSpecificConfig` を渡せば StreamMuxConfig を書き、渡さなければ「前と同じ」にする。
 * AudioSpecificConfig は、長さがバイトの区切りに揃うもの (AAC LC の 2 バイトなど) を渡す
 */
export function latmElement(
  frame: Uint8Array | number[],
  audioSpecificConfig?: Uint8Array | number[],
): Uint8Array {
  const bits = new BitWriter();
  bits.put(audioSpecificConfig === undefined ? 1 : 0, 1);
  if (audioSpecificConfig !== undefined) {
    // audioMuxVersion 0、allStreamsSameTimeFraming 1、サブフレーム・番組・層は 1 つずつ
    bits.put(0, 1).put(1, 1).put(0, 6).put(0, 4).put(0, 3);
    for (const byte of audioSpecificConfig) bits.put(byte, 8);
    // frameLengthType 0、latmBufferFullness 0xFF、otherData なし、CRC なし
    bits.put(0, 3).put(0xff, 8).put(0, 1).put(0, 1);
  }
  let left = frame.length;
  for (; left >= 255; left -= 255) bits.put(255, 8);
  bits.put(left, 8);
  for (const byte of frame) bits.put(byte, 8);
  return bits.done;
}

/** PA メッセージ。表 (MPT・PLT) を並べる */
export function paMessage(...tables: Uint8Array[]): Uint8Array {
  const body = [
    tables.length,
    ...tables.flatMap((table) => [table[0]!, table[1]!, table[2]!, table[3]!]),
    ...tables.flatMap((table) => [...table]),
  ];
  return Uint8Array.from([...be(0x0000), 0x00, ...be32(body.length), ...body]);
}

/** M2 セクションメッセージ。セクション (MH-EIT・MH-SDT・ECM など) を 1 つ運ぶ */
export function m2SectionMessage(section: Uint8Array): Uint8Array {
  return Uint8Array.from([
    ...be(0x8000),
    0x00,
    ...be(section.length),
    ...section,
  ]);
}

/** 信号メッセージを MMTP のパケットに載せる仕方 */
export interface SignalingOptions {
  /** 最初のパケットの packet_sequence_number */
  sequenceNumber?: number;
  /** 1 つのパケットに長さを付けて集約する。`long` なら長さを 32 ビットで書く */
  aggregate?: "short" | "long";
  /** 分割するときの、1 つのパケットに載せる中身の上限 (バイト)。省くと分割しない */
  fragment?: number;
}

/**
 * 信号メッセージを運ぶ MMTP のパケットの並び。集約するときは全部を 1 つに、分割するときは 1 つのメッセージを
 * いくつものパケットに分ける。fragment_counter は実機と同じく 0 のまま
 */
export function signalingPackets(
  packetId: number,
  messages: Uint8Array[],
  options: SignalingOptions = {},
): Uint8Array[] {
  let sequenceNumber = options.sequenceNumber ?? 0;
  const packet = (indicator: number, flags: number, body: number[]) =>
    mmtpPacket({
      packetId,
      payloadType: 2,
      sequenceNumber: sequenceNumber++,
      payload: [(indicator << 6) | flags, 0x00, ...body],
    });

  if (options.aggregate !== undefined) {
    const long = options.aggregate === "long";
    const body = messages.flatMap((message) => [
      ...(long ? be32(message.length) : be(message.length)),
      ...message,
    ]);
    return [packet(0, (long ? 0x02 : 0) | 0x01, body)];
  }
  const out: Uint8Array[] = [];
  for (const message of messages) {
    const size = options.fragment ?? message.length;
    if (message.length <= size) {
      out.push(packet(0, 0, [...message]));
      continue;
    }
    for (let at = 0; at < message.length; at += size) {
      const last = at + size >= message.length;
      const indicator = at === 0 ? 1 : last ? 3 : 2;
      out.push(packet(indicator, 0, [...message.subarray(at, at + size)]));
    }
  }
  return out;
}

/** PLT。package ごとに `[package_id, MPT の packet_id]` */
export function pltTable(
  packages: [number, number][],
  version = 0,
): Uint8Array {
  const body = [
    packages.length,
    ...packages.flatMap(([packageId, packetId]) => [
      2,
      ...be(packageId),
      0x00,
      ...be(packetId),
    ]),
    0x00, // IP_delivery の数
  ];
  return Uint8Array.from([0x80, version, ...be(body.length), ...body]);
}

/** MMT の記述子。タグが 0xF000 以上なら長さは 2 バイト */
export function mmtDescriptor(tag: number, body: number[]): number[] {
  return tag >= 0xf000
    ? [...be(tag), ...be(body.length), ...body]
    : [...be(tag), body.length, ...body];
}

export interface SynthAsset {
  /** `hev1`・`mp4a`・`stpp` など */
  type: string;
  packetId: number;
  componentTag?: number;
  /** ほかに載せる記述子 (`mpuTimestampDescriptor` など) */
  descriptors?: number[];
}

export interface SynthMpt {
  /** = service_id */
  packageId: number;
  version?: number;
  /** 付ければアクセス制御記述子を載せる */
  access?: { caSystemId: number; ecmPacketId: number };
  assets: SynthAsset[];
}

/** MPT。アセットはどれも同じ IP の並びの packet_id (在りかの種類 0) に置く */
export function mptTable(mpt: SynthMpt): Uint8Array {
  const descriptors =
    mpt.access === undefined
      ? []
      : mmtDescriptor(0x8004, [
          ...be(mpt.access.caSystemId),
          0x00,
          ...be(mpt.access.ecmPacketId),
        ]);
  const assets = mpt.assets.flatMap((asset) => {
    const assetDescriptors = [
      ...(asset.componentTag === undefined
        ? []
        : mmtDescriptor(0x8011, be(asset.componentTag))),
      ...(asset.descriptors ?? []),
    ];
    return [
      0x00, // identifier_type
      ...be32(0), // asset_id_scheme
      2,
      ...be(asset.packetId), // asset_id
      ...[...asset.type].map((c) => c.charCodeAt(0)),
      0xfe, // asset_clock_relation_flag 0
      1, // location_count
      0x00,
      ...be(asset.packetId),
      ...be(assetDescriptors.length),
      ...assetDescriptors,
    ];
  });
  const body = [
    0xfc, // MPT_mode 0
    2,
    ...be(mpt.packageId),
    ...be(descriptors.length),
    ...descriptors,
    mpt.assets.length,
    ...assets,
  ];
  return Uint8Array.from([0x20, mpt.version ?? 0, ...be(body.length), ...body]);
}

/** MMT の表のセクションの頭 (table_id・長さ・拡張・バージョン・セクション番号)。長さは `withCrc` が埋める */
function head(tableId: number, extension: number, version = 0): number[] {
  return [tableId, 0x00, 0x00, ...be(extension), 0xc1 | (version << 1), 0, 0];
}

export interface SynthMhService {
  serviceId: number;
  serviceType?: number;
  name: string;
  providerName?: string;
}

/** MH-SDT。`other` なら MH-SDT[other] (0xA0) */
export function mhSdtSection(
  tlvStreamId: number,
  originalNetworkId: number,
  services: SynthMhService[],
  other = false,
): Uint8Array {
  const body = [
    ...head(other ? 0xa0 : 0x9f, tlvStreamId),
    ...be(originalNetworkId),
    0xff,
  ];
  for (const service of services) {
    const provider = utf8(service.providerName ?? "");
    const name = utf8(service.name);
    const descriptor = mmtDescriptor(0x8019, [
      service.serviceType ?? 0x01,
      provider.length,
      ...provider,
      name.length,
      ...name,
    ]);
    body.push(
      ...be(service.serviceId),
      0xe3, // EIT の予定と p/f がある
      0x80 | ((descriptor.length >> 8) & 0x0f), // running_status 4、free_CA_mode 0
      descriptor.length & 0xff,
      ...descriptor,
    );
  }
  return withCrc(body);
}

/** TLV-NIT。TLV のストリームごとに `[tlv_stream_id, original_network_id, [service_id, 種類][]]` */
export function tlvNitSection(
  networkId: number,
  name: string,
  streams: [number, number, [number, number][]][],
): Uint8Array {
  const nameBytes = utf8(name);
  const network = [0x40, nameBytes.length, ...nameBytes];
  const loop = streams.flatMap(([tlvStreamId, onid, services]) => {
    const list = services.flatMap(([serviceId, type]) => [
      ...be(serviceId),
      type,
    ]);
    const descriptors = [0x41, list.length, ...list];
    return [
      ...be(tlvStreamId),
      ...be(onid),
      ...be(0xf000 | descriptors.length),
      ...descriptors,
    ];
  });
  return withCrc([
    ...head(0x40, networkId),
    ...be(0xf000 | network.length),
    ...network,
    ...be(0xf000 | loop.length),
    ...loop,
  ]);
}

/** MH-TOT。放送の現在時刻 */
export function mhTotSection(unixMs: number): Uint8Array {
  return withCrc([0xa1, 0x00, 0x00, ...mjdTime(unixMs), 0xf0, 0x00]);
}

export interface SynthMhEvent {
  eventId: number;
  /** epoch ms */
  startAt: number;
  /** ms */
  duration: number;
  name: string;
  description?: string;
  /**
   * 見出しと本文の組。本文を `split` バイトごとに区切り、2 つ目からは見出しを空にして続きとして書く
   * (UTF-8 の 1 文字の途中で区切れることもある)。記述子は組ごとに 1 つ
   */
  extended?: [string, string][];
  split?: number;
  genres?: [number, number][];
  /** 映像コンポーネント記述子の video_resolution (6 は 2160) */
  resolution?: number;
  /** コンテンツコピー制御記述子の digital_recording_control_data (3 はコピー禁止) */
  copyControl?: number;
  isFree?: boolean;
}

function eventDescriptors(event: SynthMhEvent): number[] {
  const name = utf8(event.name);
  const text = utf8(event.description ?? "");
  const out = mmtDescriptor(0xf001, [
    ...JPN,
    name.length,
    ...name,
    ...be(text.length),
    ...text,
  ]);

  for (const [heading, body] of event.extended ?? []) {
    const bytes = utf8(body);
    const size = event.split ?? bytes.length;
    const items: number[] = [];
    for (let at = 0; at < bytes.length; at += size) {
      const title = at === 0 ? utf8(heading) : [];
      const part = bytes.slice(at, at + size);
      items.push(title.length, ...title, ...be(part.length), ...part);
    }
    out.push(
      ...mmtDescriptor(0xf002, [
        0x00,
        ...JPN,
        ...be(items.length),
        ...items,
        0x00,
        0x00,
      ]),
    );
  }

  if (event.genres !== undefined)
    out.push(
      ...mmtDescriptor(
        0x8012,
        event.genres.flatMap(([lv1, lv2]) => [(lv1 << 4) | lv2, 0xff]),
      ),
    );
  if (event.resolution !== undefined)
    // 16:9、プログレッシブ、59.94 コマ、component_tag 0、言語
    out.push(
      ...mmtDescriptor(0x8010, [
        (event.resolution << 4) | 0x03,
        0xe8,
        0x00,
        0x00,
        0x5f,
        ...JPN,
      ]),
    );
  if (event.copyControl !== undefined)
    out.push(...mmtDescriptor(0x8038, [(event.copyControl << 6) | 0x0f, 0xff]));
  return out;
}

export interface SynthMhEit {
  /** 0x8B は p/f、0x8C〜 は予定の基本、0x94〜 は詳細 */
  tableId: number;
  serviceId: number;
  tlvStreamId: number;
  originalNetworkId: number;
  version?: number;
  sectionNumber?: number;
  lastSectionNumber?: number;
  lastTableId?: number;
  /** 4 は放送中 */
  runningStatus?: number;
  events: SynthMhEvent[];
}

/** MH-EIT */
export function mhEitSection(options: SynthMhEit): Uint8Array {
  const body = [
    options.tableId,
    0x00,
    0x00,
    ...be(options.serviceId),
    0xc1 | ((options.version ?? 0) << 1),
    options.sectionNumber ?? 0,
    options.lastSectionNumber ?? 0,
    ...be(options.tlvStreamId),
    ...be(options.originalNetworkId),
    options.lastSectionNumber ?? 0,
    options.lastTableId ?? options.tableId,
  ];
  for (const event of options.events) {
    const descriptors = eventDescriptors(event);
    body.push(
      ...be(event.eventId),
      ...mjdTime(event.startAt),
      ...bcdDuration(event.duration),
      ((options.runningStatus ?? 0) << 5) |
        (event.isFree === false ? 0x10 : 0) |
        ((descriptors.length >> 8) & 0x0f),
      descriptors.length & 0xff,
      ...descriptors,
    );
  }
  return withCrc(body);
}
