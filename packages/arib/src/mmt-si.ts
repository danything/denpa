/**
 * 4K の放送 (MMT/TLV) の信号の表を読む (ARIB STD-B60、TLV-SI は ARIB STD-B32 第 3 部)。
 * TS の `psi.ts` に当たる。
 *
 * 表は 2 か所から来る。
 *
 * - TLV-SI (TLV の種類 0xFE) … TLV-NIT。TS の NIT と同じ形式のセクションで、記述子も TS と同じ (タグ 1 バイト)
 * - MMTP の信号メッセージ (`mmtp.ts`) … PA メッセージの PLT・MPT と、M2 セクションメッセージの MH-SDT・MH-EIT・MH-TOT・ECM。
 *   記述子のタグは 2 バイトで、**タグが 0xF000 未満なら長さは 1 バイト、0xF000 以上なら 2 バイト**
 *
 * 局名や番組名の文字は UTF-8 (TS の ARIB の 8 単位符号ではない)。
 * 実機のケーブルの BS4K では、PLT・MPT・MH-SDT[other]・MH-EIT・TLV-NIT を読めた。どれもスクランブルされていない。
 */

import { ascii, u16 } from "./bytes.js";
import { parseMjdTime } from "./eit.js";
import {
  MESSAGE_M2_SECTION,
  MESSAGE_PA,
  messageTables,
  parseMessage,
  parseMmtp,
  PAYLOAD_SIGNALING,
  SignalingAssembler,
} from "./mmtp.js";
import {
  crc32,
  descriptors,
  type FoundService,
  type Service,
  SERVICE_TYPES,
} from "./psi.js";
import { ipv6Text, TlvIpReader } from "./tlv-ip.js";
import { TLV_COMPRESSED_IP, TLV_SIGNALING, TlvStream } from "./tlv.js";

export const TABLE_MPT = 0x20;
export const TABLE_PLT = 0x80;
const TABLE_TLV_NIT_ACTUAL = 0x40;
const TABLE_TLV_NIT_OTHER = 0x41;
const TABLE_MH_SDT_ACTUAL = 0x9f;
const TABLE_MH_SDT_OTHER = 0xa0;
const TABLE_MH_TOT = 0xa1;

const DESC_NETWORK_NAME = 0x40;
const DESC_SERVICE_LIST = 0x41;
/** アクセス制御記述子。CA_system_id と、ECM の在りか */
const DESC_ACCESS_CONTROL = 0x8004;
const DESC_MH_SERVICE = 0x8019;
/** MH-ストリーム識別記述子。アセットの component_tag */
const DESC_STREAM_IDENTIFIER = 0x8011;

const utf8 = new TextDecoder();

/** 局名・番組名の文字 (UTF-8)。壊れた並びは U+FFFD になる */
export function mmtText(data: Uint8Array): string {
  return utf8.decode(data);
}

/** MMT の記述子の並びを (タグ, 中身) に切り分ける。タグが 0xF000 以上なら長さは 2 バイト */
export function* mmtDescriptors(
  data: Uint8Array,
): Generator<[number, Uint8Array]> {
  let at = 0;
  while (at + 3 <= data.length) {
    const tag = u16(data, at);
    const wide = tag >= 0xf000;
    if (wide && at + 4 > data.length) return;
    const length = wide ? u16(data, at + 2) : data[at + 2]!;
    const bodyAt = at + (wide ? 4 : 3);
    const body = data.subarray(bodyAt, bodyAt + length);
    if (body.length < length) return;
    yield [tag, body];
    at = bodyAt + length;
  }
}

/**
 * セクションの長さが合い、`crc` なら末尾の CRC32 も合っているか。
 * TLV-SI と M2 セクションはいつも CRC32 を持つ (MH-TOT のように section_syntax_indicator が 0 の表も)。
 * M2 短セクションは持たない
 */
function sectionIntact(section: Uint8Array, crc: boolean): boolean {
  if (section.length < 3) return false;
  if (3 + (u16(section, 1) & 0x0fff) !== section.length) return false;
  return !crc || (section.length >= 7 && crc32(section) === 0);
}

/** TLV-SI の中身を、セクションに切り分ける。詰め物 (0xFF) から先は無い。壊れたセクションは落とす */
export function tlvSiSections(payload: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at + 3 <= payload.length && payload[at] !== 0xff) {
    const end = at + 3 + (u16(payload, at + 1) & 0x0fff);
    if (end > payload.length) break;
    const section = payload.subarray(at, end);
    if (sectionIntact(section, true)) out.push(section);
    at = end;
  }
  return out;
}

/**
 * MMT のパケットの在りか (MMT_general_location_info)。
 * 0 は同じ IP の並びの packet_id、1 と 2 はほかの IPv4・IPv6 の並びの packet_id、5 は URL
 */
export interface MmtLocation {
  type: number;
  /** 0・1・2 のとき */
  packetId: number | null;
  /** 1・2 のときの宛先 */
  destination: string | null;
  destinationPort: number | null;
}

/** 在りかを読む。読めない種類 (3・4 は確かめていない) なら null で、そこから先は読めない */
function readLocation(
  data: Uint8Array,
  at: number,
): [MmtLocation, number] | null {
  const type = data[at];
  const none = { packetId: null, destination: null, destinationPort: null };
  switch (type) {
    case 0x00:
      if (at + 3 > data.length) return null;
      return [{ ...none, type, packetId: u16(data, at + 1) }, at + 3];
    case 0x01: {
      // 送り元 (4)・宛先 (4)・宛先のポート (2)・packet_id (2)
      if (at + 13 > data.length) return null;
      const destination = [5, 6, 7, 8].map((i) => data[at + i]!).join(".");
      const location = {
        type,
        packetId: u16(data, at + 11),
        destination,
        destinationPort: u16(data, at + 9),
      };
      return [location, at + 13];
    }
    case 0x02: {
      // 送り元 (16)・宛先 (16)・宛先のポート (2)・packet_id (2)
      if (at + 37 > data.length) return null;
      const location = {
        type,
        packetId: u16(data, at + 35),
        destination: ipv6Text(data, at + 17),
        destinationPort: u16(data, at + 33),
      };
      return [location, at + 37];
    }
    case 0x05: {
      if (at + 2 > data.length) return null;
      const end = at + 2 + data[at + 1]!;
      return end > data.length ? null : [{ ...none, type }, end];
    }
    default:
      return null;
  }
}

/** 番号のバイト列を整数に (package_id と asset_id。放送では 2 バイト) */
function idNumber(data: Uint8Array): number {
  let value = 0;
  for (const byte of data) value = value * 256 + byte;
  return value;
}

export interface PltPackage {
  /** MMT_package_id。放送では service_id と同じ値 */
  packageId: number;
  /** その package の MPT の在りか */
  location: MmtLocation;
}

export interface Plt {
  version: number;
  packages: PltPackage[];
}

/**
 * PLT (package list table)。**どの package の MPT がどの packet_id で来るか**を持つ。
 * IP で運ぶもの (IP_delivery) の並びは読まない
 */
export function parsePlt(table: Uint8Array): Plt | null {
  if (table[0] !== TABLE_PLT || table.length < 5) return null;
  const end = Math.min(table.length, 4 + u16(table, 2));
  const count = table[4]!;
  const packages: PltPackage[] = [];
  let at = 5;
  for (let i = 0; i < count && at < end; i++) {
    const idEnd = at + 1 + table[at]!;
    const location = readLocation(table.subarray(0, end), idEnd);
    if (location === null) break;
    packages.push({
      packageId: idNumber(table.subarray(at + 1, idEnd)),
      location: location[0],
    });
    at = location[1];
  }
  return { version: table[1]!, packages };
}

/** スクランブルの方式と、ECM の在りか (アクセス制御記述子) */
export interface AccessControl {
  /** CA_system_id。B-CAS と同じ 0x0005 でも、4K の放送の ECM は B-CAS のカードでは読めない */
  caSystemId: number;
  location: MmtLocation;
}

export interface MptAsset {
  /** asset_type。映像 `hev1`、音声 `mp4a`、字幕 `stpp` など */
  type: string;
  assetId: Uint8Array;
  locations: MmtLocation[];
  /** MH-ストリーム識別記述子の component_tag。無ければ null */
  componentTag: number | null;
  /** そのアセットにだけ掛かるアクセス制御記述子 */
  access: AccessControl[];
  /** アセットの記述子の並び (`mmtDescriptors` で読む) */
  descriptors: Uint8Array;
}

export interface Mpt {
  version: number;
  /** MMT_package_id。放送では service_id と同じ値 */
  packageId: number;
  /** package 全体に掛かるアクセス制御記述子 */
  access: AccessControl[];
  /** package 全体の記述子の並び */
  descriptors: Uint8Array;
  assets: MptAsset[];
}

/** 記述子の並びから、アクセス制御記述子を読む */
function accessControls(body: Uint8Array): AccessControl[] {
  const out: AccessControl[] = [];
  for (const [tag, data] of mmtDescriptors(body)) {
    if (tag !== DESC_ACCESS_CONTROL || data.length < 3) continue;
    const location = readLocation(data, 2);
    if (location !== null)
      out.push({ caSystemId: u16(data, 0), location: location[0] });
  }
  return out;
}

function componentTagOf(body: Uint8Array): number | null {
  for (const [tag, data] of mmtDescriptors(body))
    if (tag === DESC_STREAM_IDENTIFIER && data.length >= 2) return u16(data, 0);
  return null;
}

/**
 * MPT (MMT package table)。**局の中身の一覧**で、TS の PMT に当たる。
 * アセット (映像・音声・字幕) ごとに、型と packet_id と記述子を持つ。読めない在りかの種類が来たら、
 * そこまでに読めたアセットを返す
 */
export function parseMpt(table: Uint8Array): Mpt | null {
  if (table[0] !== TABLE_MPT || table.length < 7) return null;
  const end = Math.min(table.length, 4 + u16(table, 2));
  const data = table.subarray(0, end);
  let at = 5;
  const idEnd = at + 1 + data[at]!;
  if (idEnd + 2 > end) return null;
  const packageId = idNumber(data.subarray(at + 1, idEnd));
  const descriptorsEnd = idEnd + 2 + u16(data, idEnd);
  if (descriptorsEnd + 1 > end) return null;
  const descriptors = data.subarray(idEnd + 2, descriptorsEnd);
  const count = data[descriptorsEnd]!;
  at = descriptorsEnd + 1;

  const assets: MptAsset[] = [];
  for (let i = 0; i < count; i++) {
    // identifier_type (1)・asset_id_scheme (4)・asset_id_length (1)
    if (at + 6 > end) break;
    const assetIdEnd = at + 6 + data[at + 5]!;
    if (assetIdEnd + 6 > end) break;
    const assetId = data.subarray(at + 6, assetIdEnd);
    const type = ascii(data, assetIdEnd, 4);
    at = assetIdEnd + 5;
    // asset_clock_relation_flag があれば、clock_relation_id (1) と timescale のフラグ (1)・timescale (4)
    if (data[assetIdEnd + 4]! & 0x01) {
      if (at + 2 > end) break;
      at += 2 + (data[at + 1]! & 0x01 ? 4 : 0);
    }
    if (at >= end) break;
    const locationCount = data[at]!;
    at++;
    const locations: MmtLocation[] = [];
    for (let j = 0; j < locationCount && at > 0; j++) {
      const location = readLocation(data, at);
      // 読めない種類なら長さが分からず、そこから先は読めない
      at = location?.[1] ?? -1;
      if (location !== null) locations.push(location[0]);
    }
    if (at < 0 || at + 2 > end) break;
    const body = data.subarray(at + 2, at + 2 + u16(data, at));
    at += 2 + body.length;
    assets.push({
      type,
      assetId,
      locations,
      componentTag: componentTagOf(body),
      access: accessControls(body),
      descriptors: body,
    });
  }
  return {
    version: data[1]!,
    packageId,
    access: accessControls(descriptors),
    descriptors,
    assets,
  };
}

export interface MhService extends Service {
  /** 事業者名 (MH-サービス記述子) */
  providerName: string;
  /**
   * free_CA_mode が 0 か。**復号が要るかの判断には使えない。** 実機の BS4K は 0 なのに、映像と音声は
   * スクランブルされていた。スクランブルされているかは MPT のアクセス制御記述子と、MMTP の印で見る
   */
  isFree: boolean;
  eitSchedule: boolean;
  eitPresentFollowing: boolean;
}

export interface MhSdt {
  /** MH-SDT[other] (ほかの TLV のストリームのもの) なら true */
  other: boolean;
  tlvStreamId: number;
  originalNetworkId: number;
  version: number;
  sectionNumber: number;
  lastSectionNumber: number;
  services: MhService[];
}

/** MH-SDT。局名と種類。TS の SDT と同じ並びで、記述子と文字が MMT のもの */
export function parseMhSdt(section: Uint8Array): MhSdt | null {
  const tableId = section[0];
  if (tableId !== TABLE_MH_SDT_ACTUAL && tableId !== TABLE_MH_SDT_OTHER)
    return null;
  if (section.length < 15) return null;
  const services: MhService[] = [];
  const end = section.length - 4;
  let at = 11;
  while (at + 5 <= end) {
    const loop = u16(section, at + 3) & 0x0fff;
    const body = section.subarray(at + 5, at + 5 + loop);
    let service: MhService | null = null;
    for (const [tag, data] of mmtDescriptors(body)) {
      if (tag !== DESC_MH_SERVICE || data.length < 2) continue;
      // 種類 → 事業者名 → サービス名 (長さはどれも 1 バイト)
      const nameAt = 2 + data[1]!;
      service = {
        serviceId: u16(section, at),
        serviceType: data[0]!,
        name: mmtText(
          data.subarray(nameAt + 1, nameAt + 1 + (data[nameAt] ?? 0)),
        ),
        providerName: mmtText(data.subarray(2, nameAt)),
        isFree: (section[at + 3]! & 0x10) === 0,
        eitSchedule: (section[at + 2]! & 0x02) !== 0,
        eitPresentFollowing: (section[at + 2]! & 0x01) !== 0,
      };
      break;
    }
    if (service !== null) services.push(service);
    at += 5 + loop;
  }
  return {
    other: tableId === TABLE_MH_SDT_OTHER,
    tlvStreamId: u16(section, 3),
    originalNetworkId: u16(section, 8),
    version: (section[5]! >> 1) & 0x1f,
    sectionNumber: section[6]!,
    lastSectionNumber: section[7]!,
    services,
  };
}

/** TLV-NIT の TLV のストリームの 1 件 */
export interface TlvNetworkStream {
  tlvStreamId: number;
  originalNetworkId: number;
  /** サービスリスト記述子の局 (service_id と種類) */
  services: { serviceId: number; serviceType: number }[];
  /** 記述子の並び (TS と同じタグ 1 バイトのもの。`psi.descriptors` で読む) */
  descriptors: Uint8Array;
}

export interface TlvNetwork {
  /** TLV-NIT[other] なら true */
  other: boolean;
  networkId: number;
  version: number;
  sectionNumber: number;
  lastSectionNumber: number;
  /** ネットワーク名 (UTF-8)。「高度ＢＳデジタル放送」 */
  name: string;
  streams: TlvNetworkStream[];
}

/** TLV-NIT。TS の NIT と同じ並びで、TS の代わりに TLV のストリームが並ぶ */
export function parseTlvNit(section: Uint8Array): TlvNetwork | null {
  const tableId = section[0];
  if (tableId !== TABLE_TLV_NIT_ACTUAL && tableId !== TABLE_TLV_NIT_OTHER)
    return null;
  if (section.length < 16) return null;
  const end = section.length - 4;
  const networkEnd = 10 + (u16(section, 8) & 0x0fff);
  if (networkEnd + 2 > end) return null;
  let name = "";
  for (const [tag, data] of descriptors(section.subarray(10, networkEnd)))
    if (tag === DESC_NETWORK_NAME) name = mmtText(data);

  const streams: TlvNetworkStream[] = [];
  const loopEnd = Math.min(
    end,
    networkEnd + 2 + (u16(section, networkEnd) & 0x0fff),
  );
  let at = networkEnd + 2;
  while (at + 6 <= loopEnd) {
    const length = u16(section, at + 4) & 0x0fff;
    const body = section.subarray(at + 6, at + 6 + length);
    const services: TlvNetworkStream["services"] = [];
    for (const [tag, data] of descriptors(body)) {
      if (tag !== DESC_SERVICE_LIST) continue;
      for (let i = 0; i + 3 <= data.length; i += 3)
        services.push({ serviceId: u16(data, i), serviceType: data[i + 2]! });
    }
    streams.push({
      tlvStreamId: u16(section, at),
      originalNetworkId: u16(section, at + 2),
      services,
      descriptors: body,
    });
    at += 6 + length;
  }
  return {
    other: tableId === TABLE_TLV_NIT_OTHER,
    networkId: u16(section, 3),
    version: (section[5]! >> 1) & 0x1f,
    sectionNumber: section[6]!,
    lastSectionNumber: section[7]!,
    name,
    streams,
  };
}

/** MH-TOT から放送の現在時刻 (epoch ms) を読む。TS の TOT と同じく、table_id のあとに MJD + BCD の 5 バイト */
export function parseMhTot(section: Uint8Array): number | null {
  if (section[0] !== TABLE_MH_TOT || section.length < 8) return null;
  return parseMjdTime(section, 3);
}

/** 信号の表 1 つと、どこから来たか */
export interface MmtTable {
  /** IP の並び (`tlv-ip.ts` の `flow`)。TLV-SI なら null */
  flow: string | null;
  /** 運んだ MMTP の packet_id。TLV-SI なら null */
  packetId: number | null;
  /** 表の先頭 (table_id) から。M2 セクションと TLV-SI は CRC32 を確かめてある */
  table: Uint8Array;
}

/**
 * TLV のバイト列から、信号の表を全部取り出す。番組表 (`mh-eit.ts`) や局の一覧を読むところの入口で、
 * TS で `PacketStream` と `SectionAssembler` を並べるのに当たる。
 *
 * MPU (映像・音声) の MMTP は、ヘッダーだけ読んで読み飛ばす
 */
export class MmtTableStream {
  private readonly tlv = new TlvStream();
  private readonly ip = new TlvIpReader();
  private readonly signaling = new SignalingAssembler();

  *feed(chunk: Uint8Array): Generator<MmtTable> {
    for (const packet of this.tlv.feed(chunk)) {
      if (packet.type === TLV_SIGNALING) {
        for (const table of tlvSiSections(packet.payload))
          yield { flow: null, packetId: null, table };
        continue;
      }
      // MMTP はヘッダー圧縮した IP で来る。圧縮していない IP (NTP) を MMTP として読まない
      if (packet.type !== TLV_COMPRESSED_IP) continue;
      const datagram = this.ip.read(packet);
      if (datagram === null) continue;
      const mmtp = parseMmtp(datagram.payload);
      if (mmtp === null || mmtp.payloadType !== PAYLOAD_SIGNALING) continue;
      for (const raw of this.signaling.feed(datagram.flow, mmtp)) {
        const message = parseMessage(raw);
        if (message === null) continue;
        for (const table of messageTables(message)) {
          // PA メッセージの表 (MPT・PLT) はセクションの形式ではなく、CRC32 も無い
          if (
            message.messageId !== MESSAGE_PA &&
            !sectionIntact(table, message.messageId === MESSAGE_M2_SECTION)
          )
            continue;
          yield { flow: datagram.flow, packetId: mmtp.packetId, table };
        }
      }
    }
  }
}

/**
 * 流れてくる TLV を読んで、局の一覧を作る。**TS の `ServiceReader` に当たる** (チャンネルスキャンで使う)。
 *
 * TLV-NIT[actual] と MH-SDT[actual] が両方来たら揃ったとみなす。局は MH-SDT[actual] のもので、
 * 局の元の放送は MH-SDT の original_network_id (ケーブルで受けた BS4K なら 0x000B)、TSID の代わりに tlv_stream_id を入れる。
 * TLV にはリモコン番号が無い (TLV-NIT に見当たらない) ので null。
 *
 * 局ごとの CA_system_id は、PLT から package (= service_id) の MPT を引き、そのアクセス制御記述子から読む (`caSystemIdsOf`)。
 * free_CA_mode は使わない。実機の BS4K は 0 なのに、映像と音声はスクランブルされていた。
 *
 * MH-SDT[actual] が来なくても、自分の TLV ストリームは TLV-NIT と PLT で分かる (`ownStream`)。
 * 実機のケーブルの BS4K (QC26) の 0.9 秒には、MH-SDT[other] はあったが MH-SDT[actual] は無かった。何秒おきに来るかは確かめていない
 */
export class TlvServiceReader {
  private readonly tables = new MmtTableStream();
  private plt: Plt | null = null;
  /** TLV-NIT[actual] の全部のセクションにあった TLV ストリーム (tlv_stream_id → ストリーム) */
  private readonly streams = new Map<number, TlvNetworkStream>();
  /** package_id (= service_id) → MPT */
  private readonly mpts = new Map<number, Mpt>();

  network: TlvNetwork | null = null;
  transport: MhSdt | null = null;

  get complete(): boolean {
    return this.network !== null && this.transport !== null;
  }

  /** PLT が来て、そこにある package の MPT が全部 1 回は来たか。スキャンで、局ごとの CA_system_id が分かるまで少し長く読むのに使う */
  get mptsKnown(): boolean {
    return (
      this.plt !== null &&
      this.plt.packages.every((entry) => this.mpts.has(entry.packageId))
    );
  }

  /** 任意の長さのバイト列を渡す。揃ったら true */
  feed(chunk: Uint8Array): boolean {
    for (const { table } of this.tables.feed(chunk)) {
      const tableId = table[0];
      if (tableId === TABLE_PLT) this.plt = parsePlt(table) ?? this.plt;
      else if (tableId === TABLE_MPT) {
        const mpt = parseMpt(table);
        if (mpt !== null) this.mpts.set(mpt.packageId, mpt);
      } else if (tableId === TABLE_TLV_NIT_ACTUAL) {
        const network = parseTlvNit(table);
        if (network === null) continue;
        this.network ??= network;
        for (const stream of network.streams)
          this.streams.set(stream.tlvStreamId, stream);
      } else if (tableId === TABLE_MH_SDT_ACTUAL && this.transport === null)
        this.transport = parseMhSdt(table);
    }
    return this.complete;
  }

  /**
   * 自分の TLV ストリーム。TLV-NIT[actual] のストリームのうち、PLT にある package (= service_id) をサービスリスト記述子に持つ最初の 1 つ
   * (実機では 1 つに決まる。同じ service_id を持つストリームが 2 つあれば、TLV-NIT で先に来たほう)。
   * TLV-NIT と PLT のどちらかが来ていない・当てはまるストリームが無ければ null
   */
  get ownStream(): TlvNetworkStream | null {
    const packages = new Set(
      (this.plt?.packages ?? []).map((entry) => entry.packageId),
    );
    if (packages.size === 0) return null;
    for (const stream of this.streams.values())
      if (stream.services.some((service) => packages.has(service.serviceId)))
        return stream;
    return null;
  }

  /** 録画の対象になる種類の局だけ (`psi.SERVICE_TYPES`)。揃うまでは空 */
  services(): FoundService[] {
    const transport = this.transport;
    if (this.network === null || transport === null) return [];
    return transport.services
      .filter((service) => SERVICE_TYPES.has(service.serviceType))
      .map((service) => ({
        serviceId: service.serviceId,
        serviceType: service.serviceType,
        name: service.name,
        networkId: transport.originalNetworkId,
        transportStreamId: transport.tlvStreamId,
        remoteControlKeyId: null,
      }));
  }

  /** その局の MPT のアクセス制御記述子 (package 全体とアセットのもの)。MPT が来なかった局は空 */
  accessOf(serviceId: number): AccessControl[] {
    const mpt = this.mpts.get(serviceId);
    if (mpt === undefined) return [];
    return [...mpt.access, ...mpt.assets.flatMap((asset) => asset.access)];
  }

  /** その局の CA_system_id (重なりなし・小さい順)。アクセス制御記述子が無い・MPT が来なかった局は空 */
  caSystemIdsOf(serviceId: number): number[] {
    return [
      ...new Set(this.accessOf(serviceId).map((entry) => entry.caSystemId)),
    ].sort((a, b) => a - b);
  }
}
