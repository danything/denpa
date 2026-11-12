/**
 * 4K の放送 (MMT/TLV) の映像・音声・字幕を取り出す (ISO/IEC 23008-1、ARIB STD-B60)。TS の `pes.ts` に当たる。
 *
 * MMT では、映像・音声・字幕は MPU (頭出しできる所から次の頭出しできる所まで) に分けて送られる。
 * MPU の中身はアクセスユニット (映像の 1 コマ、音声の 1 フレーム) の並びで、データユニットを
 * MMTP のパケットに分割したり、小さいものを 1 つに集約したりして運ぶ (`mmtp.ts` の `parseMpu`)。
 *
 * **時刻はパケットには無く、MPT の記述子にある。** MPU タイムスタンプ記述子が MPU の最初の提示時刻を、
 * MPU 拡張タイムスタンプ記述子がアクセスユニットごとのずれを、これから来る MPU のぶんまで並べる
 * (実機のケーブルの BS4K で確かめた。映像は 1 MPU に 32 コマ、音声は 4 フレーム)。
 * 時刻は NTP の 64 ビットで来るので、ここで **90 kHz** に直す (TS の PTS と同じ物差し。一周はしない)。
 *
 * 中身の形式は次のとおり。実機の録りは映像・音声がスクランブルされていて中身を読めないので、どれも推定。
 *
 * - 映像 (`hev1`): データユニット 1 つが、長さ (4 バイト) を前に付けた NAL ユニット。MPU は ISO BMFF の形式なので、
 *   サンプルの中身も MP4 と同じ形と見ている。同じ sample_number のデータユニットが 1 つのコマ
 * - 音声 (`mp4a`): データユニット 1 つが LATM の AudioMuxElement (LOAS の同期のヘッダーは付かない)。
 *   MPT の音声コンポーネント記述子の stream_type は 0x11 (LATM/LOAS) だった (確かめた)
 * - 字幕 (`stpp`): MPU 1 つが TTML の文書 1 つ (`ttml.ts` で読む)。文書の中の画像 (PNG) は扱わない
 *
 * スクランブルされたパケットは数えて捨てる (`scrambled`)。復号はエージェントの仕事
 */

import { BitReader } from "./bits.js";
import { concatBytes, u16, u32 } from "./bytes.js";
import { mmtDescriptors, type Mpt, parseMpt, TABLE_MPT } from "./mmt-si.js";
import {
  MESSAGE_PA,
  messageTables,
  parseMessage,
  parseMmtp,
  parseMpu,
  PAYLOAD_MPU,
  PAYLOAD_SIGNALING,
  SignalingAssembler,
} from "./mmtp.js";
import { ADTS_RATES, CLOCK } from "./pes.js";
import { TlvIpReader } from "./tlv-ip.js";
import { TLV_COMPRESSED_IP, TlvStream } from "./tlv.js";

/** 放送の時刻の物差し (TS の PTS と同じ。`pes.ts` の `CLOCK`) */
export { CLOCK };

const DESC_MPU_TIMESTAMP = 0x0001;
const DESC_MPU_EXTENDED_TIMESTAMP = 0x8026;

/** MPU のペイロードヘッダーの fragment_type。2 は MFU (中身)。0・1 はメタデータで、放送では使わない */
const FRAGMENT_MFU = 2;
/** 時刻のあるデータユニットのヘッダー (movie_fragment_sequence_number・sample_number・offset・priority・dependency_counter) */
const TIMED_HEADER = 14;
/** 時刻の無いデータユニットのヘッダー (item_id) */
const ITEM_HEADER = 4;

const WHOLE = 0;
const FIRST = 1;
const LAST = 3;

/** 取っておく MPU の時刻の数 (アセットごと)。実機の MPT は、これから来る 3〜15 MPU ぶんを並べていた */
const TIMINGS_MOST = 64;
/** 組み立て中のアクセスユニットの大きさの上限。4K の I ピクチャでも数 MB */
const UNIT_MOST = 16 * 1024 * 1024;

/** NTP の 64 ビットの時刻 (上位 32 ビットが秒、下位 32 ビットが端数) を 90 kHz に */
export function ntpToClock(data: Uint8Array, at: number): number {
  return Math.round(
    u32(data, at) * CLOCK + (u32(data, at + 4) * CLOCK) / 2 ** 32,
  );
}

/** MPU タイムスタンプ記述子を読む。`[mpu_sequence_number, 最初の提示時刻 (90 kHz)]` の並び */
export function parseMpuTimestamps(body: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  for (let at = 0; at + 12 <= body.length; at += 12)
    out.push([u32(body, at), ntpToClock(body, at + 4)]);
  return out;
}

/** MPU 拡張タイムスタンプ記述子の、MPU 1 つぶん。時間は `timescale` の単位 */
export interface MpuExtendedTimestamp {
  mpuSequenceNumber: number;
  timescale: number;
  /** mpu_decoding_time_offset。最初のアクセスユニットの DTS が、最初の提示時刻より前にずれる長さ */
  decodingOffset: number;
  /** アクセスユニットごとの、DTS から PTS までのずれ (デコードの順) */
  dtsPtsOffsets: number[];
  /** アクセスユニットごとの、次のアクセスユニットの DTS までの長さ (pts_offset) */
  durations: number[];
}

/**
 * MPU 拡張タイムスタンプ記述子を読む。次のものは DTS を進められないので、空を返す (その MPU は時刻が分からないものとして捨てる)
 *
 * - timescale を持たないもの (MPU のメタデータの mdhd を見る、の意味)。放送ではメタデータを送らない
 * - pts_offset を持たないもの (pts_offset_type 0)。コマの長さが分からない
 */
export function parseMpuExtendedTimestamps(
  body: Uint8Array,
): MpuExtendedTimestamp[] {
  if (body.length < 5 || (body[0]! & 0x01) === 0) return [];
  const offsetType = (body[0]! >> 1) & 0x03;
  if (offsetType === 0) return [];
  const timescale = u32(body, 1);
  let at = 5;
  let fixed = 0;
  if (offsetType === 1) {
    if (at + 2 > body.length) return [];
    fixed = u16(body, at);
    at += 2;
  }
  const step = offsetType === 2 ? 4 : 2;
  const out: MpuExtendedTimestamp[] = [];
  while (at + 8 <= body.length && timescale > 0) {
    const mpuSequenceNumber = u32(body, at);
    // leap_indicator (2)・予約 (6) は飛ばす
    const decodingOffset = u16(body, at + 5);
    const count = body[at + 7]!;
    at += 8;
    if (at + count * step > body.length) break;
    const dtsPtsOffsets: number[] = [];
    const durations: number[] = [];
    for (let i = 0; i < count; i++, at += step) {
      dtsPtsOffsets.push(u16(body, at));
      durations.push(offsetType === 2 ? u16(body, at + 2) : fixed);
    }
    out.push({
      mpuSequenceNumber,
      timescale,
      decodingOffset,
      dtsPtsOffsets,
      durations,
    });
  }
  return out;
}

/** アクセスユニットの時刻 (90 kHz) */
export interface UnitTime {
  pts: number;
  dts: number;
  /** 次のアクセスユニットの DTS まで */
  duration: number;
}

/**
 * MPU の `index` 番目 (デコードの順、0 から) のアクセスユニットの時刻。
 * DTS は最初の提示時刻から decodingOffset だけ戻った所に始まり、durations を足して進む。
 * PTS は DTS に dtsPtsOffsets を足したもの。記述子に無い番目なら null
 */
export function unitTime(
  presentation: number,
  extended: MpuExtendedTimestamp,
  index: number,
): UnitTime | null {
  const offset = extended.dtsPtsOffsets[index];
  const length = extended.durations[index];
  if (offset === undefined || length === undefined) return null;
  let decoding = -extended.decodingOffset;
  for (let i = 0; i < index; i++) decoding += extended.durations[i]!;
  // timescale の単位で足してから直す (1 つずつ直すと、59.94 コマの 1501.5 の端数が積もる)
  const at = (ticks: number) =>
    presentation + Math.round((ticks * CLOCK) / extended.timescale);
  const dts = at(decoding);
  return {
    dts,
    pts: at(decoding + offset),
    duration: at(decoding + length) - dts,
  };
}

/** AAC の設定 (LATM の StreamMuxConfig にある AudioSpecificConfig) */
export interface AacConfig {
  /** AudioSpecificConfig のバイト列 (MP4 の esds にそのまま入れる) */
  audioSpecificConfig: Uint8Array;
  /** audioObjectType (2 は AAC LC) */
  objectType: number;
  sampleRate: number;
  /** チャンネルの数 (channelConfiguration 7 は 8) */
  channels: number;
}

/** GASpecificConfig を持つ audioObjectType */
const GA_OBJECT_TYPES = new Set([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23]);
/** channelConfiguration → チャンネルの数 */
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

function objectType(bits: BitReader): number {
  const value = bits.bits(5);
  return value === 31 ? 32 + bits.bits(6) : value;
}

function sampleRate(bits: BitReader): number {
  const index = bits.bits(4);
  return index === 15 ? bits.bits(24) : (ADTS_RATES[index] ?? 0);
}

/** AudioSpecificConfig を読む。program_config_element が要るもの (channelConfiguration 0) は読まない */
function readAudioSpecificConfig(
  bits: BitReader,
): Omit<AacConfig, "audioSpecificConfig"> | null {
  let type = objectType(bits);
  const rate = sampleRate(bits);
  const channelConfiguration = bits.bits(4);
  // SBR・PS を明示したもの (5・29) は、拡張の周波数のあとに元の audioObjectType が来る
  if (type === 5 || type === 29) {
    sampleRate(bits);
    type = objectType(bits);
  }
  if (!GA_OBJECT_TYPES.has(type) || channelConfiguration === 0) return null;
  bits.skip(1); // frameLengthFlag
  if (bits.bit()) bits.skip(14); // dependsOnCoreCoder → coreCoderDelay
  const extension = bits.bit();
  if (type === 6 || type === 20) bits.skip(3);
  if (extension) {
    if (type === 22) bits.skip(16);
    if (type === 17 || type === 19 || type === 20 || type === 23) bits.skip(3);
    bits.skip(1);
  }
  return {
    objectType: type,
    sampleRate: rate,
    channels: CHANNELS[channelConfiguration] ?? 0,
  };
}

/** LatmGetValue (ISO/IEC 14496-3) */
function latmValue(bits: BitReader): number {
  const count = bits.bits(2);
  let value = 0;
  for (let i = 0; i <= count; i++) value = value * 256 + bits.bits(8);
  return value;
}

/**
 * LATM の AudioMuxElement (muxConfigPresent = 1) から、AAC のフレームを取り出す。
 * **設定 (StreamMuxConfig) は来たときだけ書いてあり、あいだは「前と同じ」になる** ので、前の設定を覚えておく。
 *
 * 読むのは放送で使う形 (番組 1・層 1・サブフレーム 1・frameLengthType 0) だけ。ほかの形は null を返す
 */
export class LatmReader {
  private config: AacConfig | null = null;

  read(element: Uint8Array): { config: AacConfig; frame: Uint8Array } | null {
    const bits = new BitReader(element);
    // useSameStreamMux
    if (!bits.bit()) this.config = this.readStreamMuxConfig(bits);
    const config = this.config;
    if (config === null) return null;
    // PayloadLengthInfo: 255 が続くあいだ足す
    let length = 0;
    for (;;) {
      const part = bits.bits(8);
      length += part;
      if (part !== 255 || bits.overrun) break;
    }
    if (bits.overrun || bits.left < length * 8) return null;
    // PayloadMux はバイトの区切りに揃っていない
    return { config, frame: bits.slice(bits.at, length * 8) };
  }

  private readStreamMuxConfig(bits: BitReader): AacConfig | null {
    const version = bits.bit();
    if (version && bits.bit()) return null; // audioMuxVersionA は 0 だけ
    if (version) latmValue(bits); // taraBufferFullness
    bits.skip(1); // allStreamsSameTimeFraming
    const subFrames = bits.bits(6);
    const programs = bits.bits(4);
    const layers = bits.bits(3);
    if (subFrames !== 0 || programs !== 0 || layers !== 0) return null;
    // audioMuxVersion 1 は AudioSpecificConfig の長さが前に付く。0 は読んで長さを知る
    const declared = version ? latmValue(bits) : null;
    const start = bits.at;
    const fields = readAudioSpecificConfig(bits);
    if (fields === null) return null;
    if (declared !== null) bits.at = start + declared;
    const audioSpecificConfig = bits.slice(start, bits.at - start);
    if (bits.bits(3) !== 0) return null; // frameLengthType は 0 だけ
    bits.skip(8); // latmBufferFullness
    if (bits.bit()) {
      // otherDataPresent
      if (version) latmValue(bits);
      else
        for (let more = 1; more && !bits.overrun;) {
          more = bits.bit();
          bits.skip(8);
        }
    }
    if (bits.bit()) bits.skip(8); // crcCheckPresent
    return bits.overrun ? null : { ...fields, audioSpecificConfig };
  }
}

export type MediaKind = "video" | "audio" | "caption";

/** 取り出すアセット (MPT のアセットのうち、映像・音声・字幕のそれぞれ最初のもの) */
export interface MediaAsset {
  kind: MediaKind;
  /** asset_type (`hev1`・`mp4a`・`stpp`) */
  type: string;
  packetId: number;
  /** MH-ストリーム識別記述子の component_tag。無ければ null */
  componentTag: number | null;
}

const KINDS: Record<string, MediaKind | undefined> = {
  hev1: "video",
  hvc1: "video",
  mp4a: "audio",
  stpp: "caption",
};

interface UnitBase extends UnitTime {
  asset: MediaAsset;
  mpuSequenceNumber: number;
}

/** 映像の 1 コマ */
export interface VideoUnit extends UnitBase {
  kind: "video";
  /** NAL ユニットの並び (長さの前置きを外したもの) */
  nals: Uint8Array[];
  /** IRAP (IDR・CRA・BLA) のピクチャを含む */
  keyframe: boolean;
}

/** 音声の 1 フレーム */
export interface AudioUnit extends UnitBase {
  kind: "audio";
  /** AAC のフレーム (LATM を外したもの。ADTS のヘッダーも無い) */
  frame: Uint8Array;
  config: AacConfig;
}

/** 字幕の文書 1 つ。時刻は MPU の最初の提示時刻 */
export interface CaptionUnit extends UnitBase {
  kind: "caption";
  /** TTML の文書 (UTF-8 を読んだもの) */
  document: string;
}

export type MediaUnit = VideoUnit | AudioUnit | CaptionUnit;

/**
 * `MmtMediaReader.feed` が返すもの。選んだアセットが変わったら (番組が替わったときなど)、
 * 先に `assets` が来る。受け側は組み立て中のもの (fMP4 の初期化セグメント) を作り直す
 */
export type MediaEvent = { kind: "assets"; assets: MediaAsset[] } | MediaUnit;

/** アセットごとの組み立て */
interface Track {
  asset: MediaAsset;
  /** MPU の番号 → 最初の提示時刻 (90 kHz) */
  presentations: Map<number, number>;
  extended: Map<number, MpuExtendedTimestamp>;
  /** 組み立て中の MPU の番号 */
  mpu: number | null;
  /** 組み立て中のアクセスユニットが、MPU の何番目か */
  index: number;
  /** 組み立て中のアクセスユニットの sample_number */
  sample: number | null;
  /** 組み立て中のアクセスユニットの、そろったデータユニット */
  units: Uint8Array[];
  size: number;
  /** 分割されたデータユニットの組み立て中のもの */
  fragment: Uint8Array[] | null;
  /** 最後に受けた packet_sequence_number */
  sequence: number | null;
  /** 組み立て中のアクセスユニットのパケットが欠けた */
  broken: boolean;
  latm: LatmReader;
}

function newTrack(asset: MediaAsset): Track {
  return {
    asset,
    presentations: new Map(),
    extended: new Map(),
    mpu: null,
    index: 0,
    sample: null,
    units: [],
    size: 0,
    fragment: null,
    sequence: null,
    broken: false,
    latm: new LatmReader(),
  };
}

/** 覚える数を超えたら、古いものから捨てる */
function remember<T>(map: Map<number, T>, key: number, value: T): void {
  map.delete(key);
  map.set(key, value);
  for (const old of map.keys()) {
    if (map.size <= TIMINGS_MOST) break;
    map.delete(old);
  }
}

/** 長さ (4 バイト) を前に付けた NAL ユニットの並びを切り分ける。長さが合わなければ null */
function lengthPrefixed(data: Uint8Array): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at + 4 <= data.length) {
    const end = at + 4 + u32(data, at);
    if (end > data.length) return null;
    out.push(data.subarray(at + 4, end));
    at = end;
  }
  return at === data.length && out.length > 0 ? out : null;
}

/** NAL ユニットの種類が IRAP (16〜23) */
function irap(nal: Uint8Array): boolean {
  const type = (nal[0]! >> 1) & 0x3f;
  return type >= 16 && type <= 23;
}

const utf8 = new TextDecoder();

/**
 * 1 局に絞った TLV のバイト列 (`mmt-service-filter.ts`) から、映像・音声・字幕のアクセスユニットを時刻つきで取り出す。
 *
 * - 局 (`serviceId` = MMT_package_id) の MPT を読んで、映像・音声・字幕のそれぞれ最初のアセットを選ぶ。
 *   アセットは MPT と同じ IP の並びのもの (在りかの種類 0) だけを読む
 * - 時刻は MPT の記述子から引く。時刻がまだ分からない MPU (最初の MPT より先に来たもの) は数えて捨てる (`untimed`)
 * - パケットが欠けた (packet_sequence_number が続かない) アクセスユニットは捨てる (`dropped`)
 * - アクセスユニットは、次のアクセスユニット (か次の MPU) の始まりが来たときに返す。最後のものは `end` で返す
 */
export class MmtMediaReader {
  private readonly tlv = new TlvStream();
  private readonly ip = new TlvIpReader();
  private readonly signaling = new SignalingAssembler();
  /** `並び/packet_id` → 組み立て */
  private tracks = new Map<string, Track>();
  /** 選んだアセットの並び (変わったかを見る) */
  private selection = "";
  /** スクランブルされていて読めなかった MMTP のパケットの数 */
  scrambled = 0;
  /** 時刻が分からずに捨てたアクセスユニットの数 */
  untimed = 0;
  /** パケットが欠けたか、中身を読めずに捨てたアクセスユニットの数 */
  dropped = 0;

  constructor(private readonly serviceId: number) {}

  /** 選んでいるアセット */
  get assets(): MediaAsset[] {
    return [...this.tracks.values()].map((t) => t.asset);
  }

  *feed(chunk: Uint8Array): Generator<MediaEvent> {
    for (const packet of this.tlv.feed(chunk)) {
      if (packet.type !== TLV_COMPRESSED_IP) continue;
      const datagram = this.ip.read(packet);
      if (datagram === null) continue;
      const mmtp = parseMmtp(datagram.payload);
      if (mmtp === null) continue;
      if (mmtp.payloadType === PAYLOAD_SIGNALING) {
        for (const raw of this.signaling.feed(datagram.flow, mmtp)) {
          const message = parseMessage(raw);
          if (message?.messageId !== MESSAGE_PA) continue;
          for (const table of messageTables(message)) {
            if (table[0] !== TABLE_MPT) continue;
            const mpt = parseMpt(table);
            if (mpt?.packageId === this.serviceId)
              yield* this.readMpt(datagram.flow, mpt);
          }
        }
        continue;
      }
      if (mmtp.payloadType !== PAYLOAD_MPU) continue;
      const track = this.tracks.get(`${datagram.flow}/${mmtp.packetId}`);
      if (track === undefined) continue;
      // パケットが欠けたら、組み立て中のアクセスユニットはもう組めない
      if (
        track.sequence !== null &&
        mmtp.sequenceNumber !== (track.sequence + 1) >>> 0
      ) {
        track.broken = true;
        track.fragment = null;
      }
      track.sequence = mmtp.sequenceNumber;
      if (mmtp.scrambling === "odd" || mmtp.scrambling === "even") {
        this.scrambled++;
        track.broken = true;
        track.fragment = null;
        continue;
      }
      yield* this.readMpu(track, mmtp.payload);
    }
  }

  /** 終わりまで読んだとき、組み立て中のアクセスユニットを閉じて返す (録画のファイルの最後など) */
  *end(): Generator<MediaUnit> {
    for (const track of this.tracks.values()) {
      track.fragment = null;
      yield* this.finish(track);
    }
  }

  /** MPT から、アセットを選び直して時刻を覚える */
  private *readMpt(flow: string, mpt: Mpt): Generator<MediaEvent> {
    const chosen = new Map<MediaKind, MediaAsset>();
    for (const asset of mpt.assets) {
      const kind = KINDS[asset.type];
      const location = asset.locations[0];
      if (kind === undefined || chosen.has(kind)) continue;
      if (location?.type !== 0 || location.packetId === null) continue;
      chosen.set(kind, {
        kind,
        type: asset.type,
        packetId: location.packetId,
        componentTag: asset.componentTag,
      });
    }
    const selection = JSON.stringify([flow, ...chosen.values()]);
    if (selection !== this.selection) {
      this.selection = selection;
      this.tracks = new Map(
        [...chosen.values()].map((asset) => [
          `${flow}/${asset.packetId}`,
          newTrack(asset),
        ]),
      );
      yield { kind: "assets", assets: this.assets };
    }
    for (const asset of mpt.assets) {
      const location = asset.locations[0];
      const track = this.tracks.get(`${flow}/${location?.packetId}`);
      if (track === undefined || track.asset.type !== asset.type) continue;
      for (const [tag, body] of mmtDescriptors(asset.descriptors)) {
        if (tag === DESC_MPU_TIMESTAMP)
          for (const [sequence, time] of parseMpuTimestamps(body))
            remember(track.presentations, sequence, time);
        if (tag === DESC_MPU_EXTENDED_TIMESTAMP)
          for (const entry of parseMpuExtendedTimestamps(body))
            remember(track.extended, entry.mpuSequenceNumber, entry);
      }
    }
  }

  /** MPU のパケットの中身を 1 つ読む */
  private *readMpu(track: Track, payload: Uint8Array): Generator<MediaUnit> {
    const mpu = parseMpu(payload);
    if (mpu === null || mpu.fragmentType !== FRAGMENT_MFU) return;
    if (mpu.mpuSequenceNumber !== track.mpu) {
      yield* this.finish(track);
      track.mpu = mpu.mpuSequenceNumber;
      track.index = 0;
      track.sample = null;
    }
    const header = mpu.timed ? TIMED_HEADER : ITEM_HEADER;
    const data = mpu.data;
    if (mpu.aggregated) {
      // データユニットごとに長さ (ヘッダーを含む) が前に付く
      let at = 0;
      while (at + 2 <= data.length) {
        const end = at + 2 + u16(data, at);
        if (end > data.length || end - at - 2 < header) break;
        yield* this.dataUnit(
          track,
          mpu.timed,
          data.subarray(at + 2, end),
          WHOLE,
        );
        at = end;
      }
      return;
    }
    if (data.length < header) return;
    yield* this.dataUnit(track, mpu.timed, data, mpu.fragmentation);
  }

  /** データユニット (分割したものはその断片) を 1 つ受ける。ヘッダーは断片ごとに付いている */
  private *dataUnit(
    track: Track,
    timed: boolean,
    unit: Uint8Array,
    fragmentation: number,
  ): Generator<MediaUnit> {
    // 時刻の無いもの (MPU 全体で 1 つ) は sample_number が無いので 0 とする
    const sample = timed ? u32(unit, 4) : 0;
    const body = unit.subarray(timed ? TIMED_HEADER : ITEM_HEADER);
    if (fragmentation === WHOLE || fragmentation === FIRST) {
      if (track.sample !== null && sample !== track.sample)
        yield* this.finish(track);
      track.sample = sample;
    }
    // 中身は届いたチャンクの一部を指すので、持ち越すものはコピーする (`TlvStream`)
    if (fragmentation === WHOLE) {
      this.keep(track, body.slice());
      return;
    }
    if (fragmentation === FIRST) {
      track.fragment = [body.slice()];
      return;
    }
    if (track.fragment === null) {
      track.broken = true;
      return;
    }
    track.fragment.push(body.slice());
    if (fragmentation === LAST) {
      this.keep(track, concatBytes(track.fragment));
      track.fragment = null;
    }
  }

  private keep(track: Track, unit: Uint8Array): void {
    track.size += unit.length;
    if (track.size > UNIT_MOST) track.broken = true;
    else track.units.push(unit);
  }

  /** 組み立て中のアクセスユニットを閉じて返す */
  private *finish(track: Track): Generator<MediaUnit> {
    const { units, broken, index, mpu } = track;
    track.units = [];
    track.size = 0;
    track.broken = false;
    if ((units.length === 0 && !broken) || mpu === null) return;
    track.index++;
    if (broken) {
      this.dropped++;
      return;
    }
    const presentation = track.presentations.get(mpu);
    const extended = track.extended.get(mpu);
    const time =
      presentation === undefined || extended === undefined
        ? null
        : unitTime(presentation, extended, index);
    if (time === null) {
      this.untimed++;
      return;
    }
    const base = { ...time, asset: track.asset, mpuSequenceNumber: mpu };
    switch (track.asset.kind) {
      case "video": {
        const nals = lengthPrefixed(concatBytes(units));
        if (nals === null) break;
        yield { ...base, kind: "video", nals, keyframe: nals.some(irap) };
        return;
      }
      case "audio": {
        // データユニット 1 つが 1 フレーム。設定を覚えるために全部読み、最後のものを返す (放送では 1 つ)
        const read = units.map((u) => track.latm.read(u)).at(-1) ?? null;
        if (read === null) break;
        yield { ...base, kind: "audio", ...read };
        return;
      }
      case "caption":
        yield {
          ...base,
          kind: "caption",
          document: utf8.decode(concatBytes(units)),
        };
        return;
    }
    this.dropped++;
  }
}
