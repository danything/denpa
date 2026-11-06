/**
 * TS の土台 (パケットの切り出し・セクションの組み立て・PAT/PMT) と、局の一覧。
 * 局の一覧はチャンネルスキャンで「この物理チャンネルに何が入っているか」を知るために使い、
 * 読むのは NIT と SDT の 2 つ。
 *
 * - NIT (PID 0x0010) … ネットワーク ID と、地上波ならリモコン番号。衛星はネットワークの全部の TS
 *   (TSID・周波数・サービスの一覧) が載っている (`NitReader`)
 * - SDT (PID 0x0011) … その TS に入っているサービスの ID と種別。衛星はほかの TS のぶん
 *   (SDT[other]) も流れている (`SdtReader`)
 *
 * 局名も SDT から読む。ARIB の文字符号は独自だが、番組表を自分で集めるなら
 * どのみち要るので [aribtext.ts](aribtext.ts) に寄せてある。
 */

import { decodeAribText } from "./aribtext.js";
import { concatBytes, u16 } from "./bytes.js";

export const PACKET = 188;
export const SYNC = 0x47;

/** TS パケットの PID */
export function packetPid(packet: Uint8Array): number {
  return ((packet[1]! & 0x1f) << 8) | packet[2]!;
}

/** PAT。どの PID に PMT があるかを持つ。**入口はいつもここ** */
export const PID_PAT = 0x0000;
export const PID_CAT = 0x0001;
export const PID_NIT = 0x0010;
export const PID_SDT = 0x0011;

export const TABLE_PAT = 0x00;
export const TABLE_CAT = 0x01;
export const TABLE_PMT = 0x02;
export const TABLE_NIT_ACTUAL = 0x40;
export const TABLE_NIT_OTHER = 0x41;
export const TABLE_SDT_ACTUAL = 0x42;
export const TABLE_SDT_OTHER = 0x46;
export const TABLE_EMM_S = 0x84;
export const TABLE_EMM_M = 0x85;

export const DESC_CONDITIONAL_ACCESS = 0x09;
export const CA_SYSTEM_BCAS = 0x0005;

const DESC_SERVICE_LIST = 0x41;
const DESC_SATELLITE_DELIVERY = 0x43;
const DESC_TERRESTRIAL_DELIVERY = 0xfa;
const DESC_SERVICE = 0x48;
const DESC_TS_INFORMATION = 0xcd;

/**
 * スキャンで残すサービス種別。Mirakurun のスキャンが通しているものと同じで、
 * ラジオ (0x02) とデータ (0xc0) も入る。映像の無いものを番組表に並べないのは
 * 取り込むほう (denpa の epg.ts の DIGITAL_TV)
 */
export const SERVICE_TYPES = new Set([
  0x01, 0x02, 0xa1, 0xa4, 0xa5, 0xad, 0xc0,
]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc =
        crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

/** MPEG-2 の CRC32。セクション末尾の 4 バイトを含めて回すと 0 になる */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc =
      (((crc << 8) >>> 0) ^ CRC32_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

/**
 * セクション本体に CRC32 を付けて仕上げる。`section_length` も実長に直す。
 *
 * **書く側が 2 つある。** PAT を書き直して流す `service-filter.ts` と、
 * 偽の放送を組み立てる `synth.ts`。長さの直し方を間違えると読む側が黙って
 * 捨てるだけなので、1 箇所に置く。
 */
export function withCrc(body: number[]): Uint8Array {
  const section = Uint8Array.from(body);
  const length = section.length - 3 + 4;
  section[1] = 0xb0 | ((length >> 8) & 0x0f);
  section[2] = length & 0xff;

  const out = new Uint8Array(section.length + 4);
  out.set(section);
  new DataView(out.buffer).setUint32(section.length, crc32(section));
  return out;
}

export interface Service {
  serviceId: number;
  serviceType: number;
  /** 局名。SDT からしか取れないので、NIT 由来のものは空 */
  name: string;
}

export interface TransportInfo {
  transportStreamId: number;
  originalNetworkId: number;
  services: Service[];
}

export interface NetworkInfo {
  networkId: number;
  remoteControlKeyId: number | null;
  transportStreams: TransportInfo[];
}

/** 何も組み上がらなかったときの返り。使い回すので凍らせてある */
const NONE: readonly Uint8Array[] = Object.freeze([]);

/**
 * PSI セクションを組み立てる。
 *
 * セクションは TS パケットをまたいで運ばれ、パケットの切れ目とは無関係な
 * 位置で終わる。payload_unit_start_indicator と pointer_field を見て
 * 頭を合わせ、section_length ぶん溜まったら 1 本として返す。
 */
export class SectionAssembler {
  private buffer = new Uint8Array(0);

  /**
   * @param pid 読む PID
   * @param crc CRC の見方。
   *   `always` … 末尾 4 バイトを CRC32 とみなして必ず確かめる (PSI はこちら)
   *   `syntax` … `section_syntax_indicator` が立っているときだけ確かめる。
   *     DSM-CC は立っていないと末尾が CRC ではなく Checksum なので、
   *     いつも確かめると**全部捨ててしまう**
   */
  constructor(
    private readonly pid: number,
    private readonly crc: "always" | "syntax" = "always",
  ) {}

  /**
   * パケットを 1 つ渡す。組み上がったセクションを返す。
   *
   * 返りは**読むだけ**にすること。何も組み上がらないとき (ほとんどのパケット) は
   * 使い回しの空配列を返す (関係ないパケットのたびに配列を作っていた)
   */
  feed(packet: Uint8Array): readonly Uint8Array[] {
    // トランスポートエラーが立っているものは信用しない
    if (
      packet[0] !== SYNC ||
      packetPid(packet) !== this.pid ||
      packet[1]! & 0x80
    )
      return NONE;

    const adaptation = (packet[3]! >> 4) & 0x03;
    if (adaptation === 0 || adaptation === 2) return NONE;
    let offset = 4;
    if (adaptation === 3) offset += 1 + packet[4]!;
    if (offset >= PACKET) return NONE;

    const payload = packet.subarray(offset);
    if (packet[1]! & 0x40) {
      const pointer = payload[0]!;
      if (1 + pointer > payload.length) return NONE;
      // pointer_field の手前は前のセクションの続き
      this.append(payload.subarray(1, 1 + pointer));
      const done = this.flush();
      // 写す。パケットは届いた塊の上の窓で、塊は使い回される (PacketStream)
      this.buffer = payload.slice(1 + pointer);
      const next = this.flush();
      if (done.length === 0) return next;
      return next.length === 0 ? done : [...done, ...next];
    }

    this.append(payload);
    return this.flush();
  }

  private append(data: Uint8Array): void {
    if (this.buffer.length > 0) this.buffer = concatBytes([this.buffer, data]);
  }

  private flush(): readonly Uint8Array[] {
    let sections: Uint8Array[] | null = null;
    for (;;) {
      if (this.buffer.length < 3) return sections ?? NONE;
      // 詰め物。ここから先にセクションは無い
      if (this.buffer[0] === 0xff) {
        this.buffer = new Uint8Array(0);
        return sections ?? NONE;
      }
      const length = 3 + (u16(this.buffer, 1) & 0x0fff);
      if (this.buffer.length < length) return sections ?? NONE;
      const section = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      // 壊れたセクションを読むと嘘の局が並ぶので、CRC を通ったものだけ使う
      const syntax = (section[1]! & 0x80) !== 0;
      if ((this.crc === "syntax" && !syntax) || crc32(section) === 0) {
        sections ??= [];
        sections.push(section);
      }
    }
  }
}

/**
 * 同期が取れているとみなすのに必要な連続パケット数。
 * 1 つだけでは中身のたまたまの 0x47 を頭と誤認する
 */
const CONFIRM = 3;

/** `from` 以降 `until` の手前までで、188 間隔に 0x47 が続くところを探す。無ければ -1 (denpa の `seek.ts` も使う) */
export function findSync(
  data: Uint8Array,
  from = 0,
  until = data.length,
): number {
  for (
    let at = from;
    at < until && at + PACKET * (CONFIRM - 1) < data.length;
    at++
  ) {
    let i = 0;
    while (i < CONFIRM && data[at + i * PACKET] === SYNC) i++;
    if (i === CONFIRM) return at;
  }
  return -1;
}

/**
 * 任意の長さで届くバイト列を 188 バイトのパケットに切り分ける。
 *
 * 頭が必ずパケットの先頭とは限らず、電波が弱いと途中で数バイト落ちる。
 * ずれたままだと**以降ずっと 1 パケットも読めなくなる**ので、頭が 0x47 でなければ
 * 取り直す。普段は先頭が 0x47 なので、探しに行くのはずれたときだけ。
 *
 * **出すパケットは渡された塊の上の窓** (写しではない。写すと録画の処理の 1/3 を食う)。
 * 塊の入れ物を使い回す呼び出し側がある
 * (denpa の `server/recorded-bml.ts`) ので、**次の `feed` より後まで持つなら写すこと**。
 * いまのパーサ (`SectionAssembler`・`PesDemuxer`) は溜めるときに写している
 */
export class PacketStream {
  private rest = new Uint8Array(0);

  *feed(chunk: Uint8Array): Generator<Uint8Array> {
    /*
     * 前の残り (`rest`) と塊を繋いだ並びの上を歩く。位置 `at` はその並びでの位置。
     * 繋ぐのは**残りに頭があるパケットを読むのに要るぶんだけ** (頭を探すのに
     * 3 パケットぶん先まで見る)
     */
    const split = this.rest.length;
    const total = split + chunk.length;
    let at = 0;
    let lost = false;
    if (split > 0) {
      const head = new Uint8Array(
        split + Math.min(chunk.length, PACKET * CONFIRM),
      );
      head.set(this.rest);
      head.set(chunk.subarray(0, head.length - split), split);
      while (at < split && at + PACKET <= total) {
        if (head[at] !== SYNC) {
          const found = findSync(head, at, split);
          // 残りの中には無い。塊のほうを探す
          if (found < 0) {
            lost = true;
            break;
          }
          at = found;
        }
        yield head.subarray(at, at + PACKET);
        at += PACKET;
      }
    }

    let offset = at - split;
    if (lost) {
      const found = findSync(chunk);
      if (found >= 0) {
        offset = found;
        lost = false;
      }
    }
    if (!lost) {
      while (offset + PACKET <= chunk.length) {
        if (chunk[offset] !== SYNC) {
          const found = findSync(chunk, offset);
          if (found < 0) break;
          offset = found;
          if (offset + PACKET > chunk.length) break;
        }
        yield chunk.subarray(offset, offset + PACKET);
        offset += PACKET;
      }
      at = split + offset;
    }

    // 同期が取れないまま溜め込まないよう、頭を探せるぶんだけ残す
    const from = Math.max(at, total - PACKET * CONFIRM);
    if (from >= split) {
      this.rest = chunk.slice(from - split);
    } else {
      // 塊が短くて、前の残りにまだ食い込んでいる
      const rest = new Uint8Array(total - from);
      rest.set(this.rest.subarray(from));
      rest.set(chunk, split - from);
      this.rest = rest;
    }
  }
}

/**
 * PAT から 1 つの局の PMT を追う。`serviceId` を渡さなければ PAT の最初の局
 * (1 局に絞った TS を渡すところ)。PAT で PMT の PID が替われば組み立て直す
 */
export class PmtTracker {
  private readonly pat = new SectionAssembler(PID_PAT);
  private pmt: SectionAssembler | null = null;
  /** 追っている PMT の PID。PAT を読むまでは null。替わったかは呼ぶ前後で比べる */
  pid: number | null = null;

  constructor(private readonly serviceId?: number) {}

  /** パケットを 1 つ (`pid` はその PID)。組み上がった PMT のセクションを返す */
  feed(packet: Uint8Array, pid: number): readonly Uint8Array[] {
    if (pid === PID_PAT) {
      for (const section of this.pat.feed(packet)) {
        const programs = parsePat(section);
        const next =
          this.serviceId === undefined
            ? programs.values().next().value
            : programs.get(this.serviceId);
        if (next === undefined || next === this.pid) continue;
        this.pid = next;
        this.pmt = new SectionAssembler(next);
      }
    }
    return pid === this.pid ? this.pmt!.feed(packet) : NONE;
  }
}

/** 記述子の並びを (tag, 中身) に切り分ける */
export function* descriptors(
  data: Uint8Array,
): Generator<[number, Uint8Array]> {
  let at = 0;
  while (at + 2 <= data.length) {
    const tag = data[at]!;
    const length = data[at + 1]!;
    const body = data.subarray(at + 2, at + 2 + length);
    if (body.length < length) return;
    yield [tag, body];
    at += 2 + length;
  }
}

/** デジタルコピー制御記述子。EIT の番組ごとと PMT に入る */
export const DESC_DIGITAL_COPY_CONTROL = 0xc1;

/**
 * デジタルコピー制御記述子の中身 (タグと長さを除いたもの) から、**コピー禁止か**を読む。
 *
 * 先頭 2 ビットの digital_recording_control_data が 11 なら禁止
 * (00 コピー可、01 事業者定義、10 1 世代のみ)。禁止の番組は録らない
 * ([data.md](https://github.com/danything/denpa/blob/main/docs/data.md)「コピー禁止の番組は録らない」)
 */
export function isCopyNever(data: Uint8Array): boolean {
  return data.length >= 1 && data[0]! >> 6 === 0b11;
}

/**
 * PMT の**番組ぜんたいに掛かる記述子** (program_info)。CA (ECM の PID) はここにも入る
 */
export function pmtProgramInfo(section: Uint8Array): Uint8Array {
  if (section[0] !== TABLE_PMT || section.length < 16) return new Uint8Array(0);
  const length = u16(section, 10) & 0x0fff;
  return section.subarray(12, 12 + length);
}

/**
 * PMT の ES の並びを `[stream_type, PID, 記述子]` で返す。
 *
 * **`stream_type` では物を見分けられません。** データ放送も AIT もロゴも同じ
 * DSM-CC セクション (0x0D) を名乗るので、見分けるのは記述子のほう
 * (component_tag や application_signalling) です。だからここは**素通しで並べる
 * だけ**にして、選り分けは呼ぶ側に置いてあります。
 */
export function* pmtStreams(
  section: Uint8Array,
): Generator<[number, number, Uint8Array]> {
  if (section[0] !== TABLE_PMT || section.length < 16) return;
  const programInfoLength = u16(section, 10) & 0x0fff;
  let at = 12 + programInfoLength;
  const end = section.length - 4;
  while (at + 5 <= end) {
    const pid = u16(section, at + 1) & 0x1fff;
    const infoLength = u16(section, at + 3) & 0x0fff;
    yield [section[at]!, pid, section.subarray(at + 5, at + 5 + infoLength)];
    at += 5 + infoLength;
  }
}

/** PAT から `サービスID → PMT の PID`。サービス 0 は NIT なので飛ばす */
export function parsePat(section: Uint8Array): Map<number, number> {
  const programs = new Map<number, number>();
  if (section[0] !== TABLE_PAT) return programs;
  const end = section.length - 4;
  for (let at = 8; at + 4 <= end; at += 4) {
    const serviceId = u16(section, at);
    if (serviceId === 0) continue;
    programs.set(serviceId, u16(section, at + 2) & 0x1fff);
  }
  return programs;
}

/**
 * SDT のサービスの並びを (service_id, 記述子の並び) に切り分ける。
 *
 * **読む側が 2 つある。** 局名 (`parseSdt`) とロゴの対応 (denpa の `ts/logo.ts`) で、
 * 欲しい記述子が違うだけで歩き方は同じ。並びの読み方をここ 1 箇所に置く。
 */
export function* sdtServices(
  section: Uint8Array,
): Generator<[number, Uint8Array]> {
  let at = 11;
  const end = section.length - 4;
  while (at + 5 <= end) {
    const serviceId = u16(section, at);
    const loop = u16(section, at + 3) & 0x0fff;
    yield [serviceId, section.subarray(at + 5, at + 5 + loop)];
    at += 5 + loop;
  }
}

/** SDT のサービスの並び。自分の TS (actual) とほかの TS (other) で形式は同じ */
function sdtTransport(section: Uint8Array): TransportInfo {
  const services: Service[] = [];
  for (const [serviceId, body] of sdtServices(section)) {
    for (const [tag, descriptor] of descriptors(body)) {
      if (tag === DESC_SERVICE && descriptor.length > 0) {
        /*
         * service_descriptor は 種別 → 事業者名 → サービス名 の順。
         * 事業者名 (「東京メトロポリタンテレビジョン」) は要らないので飛ばし、
         * その先のサービス名 (「TOKYO MX1」) を取る
         */
        const providerLength = descriptor[1] ?? 0;
        const nameAt = 2 + providerLength;
        const nameLength = descriptor[nameAt] ?? 0;
        services.push({
          serviceId,
          serviceType: descriptor[0]!,
          name: decodeAribText(
            descriptor.subarray(nameAt + 1, nameAt + 1 + nameLength),
          ),
        });
        break;
      }
    }
  }

  return {
    transportStreamId: u16(section, 3),
    originalNetworkId: u16(section, 8),
    services,
  };
}

/** SDT からサービスの一覧を読む。自分の TS のものだけ */
export function parseSdt(section: Uint8Array): TransportInfo | null {
  return section[0] === TABLE_SDT_ACTUAL ? sdtTransport(section) : null;
}

/**
 * SDT[other] からサービスの一覧を読む。**ほかの TS のもの。**
 *
 * 衛星は、どの TS にもネットワークのほかの TS の局名を流している (番組表の EIT[other] と同じ考え)。
 * 開いていない TS の局名をこれで知る。TS ごとに別のセクションで来るので、集めるのは `SdtReader`
 */
export function parseSdtOther(section: Uint8Array): TransportInfo | null {
  return section[0] === TABLE_SDT_OTHER ? sdtTransport(section) : null;
}

/** 衛星の分配の記述子 (0x43)。どの周波数で流れているか */
export interface SatelliteDelivery {
  kind: "satellite";
  /**
   * 周波数 (kHz)。**放送の周波数そのもの** (BS-1 は 11727480)。
   * チューナーに渡す中間周波数は、ここから LNB の局発の周波数 (BS・CS は 10678 MHz) を引いたもの
   */
  frequency: number;
  /** 軌道位置 (0.1 度単位。東経 110 度は 1100) */
  orbitalPosition: number;
  /** 東経なら true */
  east: boolean;
  /** 偏波。0 水平・1 垂直・2 左旋・3 右旋 */
  polarization: number;
  /** 変調方式 (ARIB STD-B10 の値のまま) */
  modulation: number;
  /** シンボルレート (シンボル/秒) */
  symbolRate: number;
  /** 内符号 (ARIB STD-B10 の値のまま) */
  fec: number;
}

/** 地上の分配の記述子 (0xFA)。地上波は自分の TS のぶんしか載らない */
export interface TerrestrialDelivery {
  kind: "terrestrial";
  /** 地域の識別 (ARIB STD-B10 の area_code) */
  areaCode: number;
  guardInterval: number;
  transmissionMode: number;
  /** 周波数 (Hz)。中継局ごとに並ぶことがある。放送は 1/7 MHz 単位で書く */
  frequencies: number[];
}

export type Delivery = SatelliteDelivery | TerrestrialDelivery;

/** NIT の TS の 1 件。サービスの一覧に、どこで流れているかが付く */
export interface NetworkTransport extends TransportInfo {
  delivery: Delivery | null;
}

/** BCD の桁を左から `digits` 桁ぶん読んで、10 進の整数にする */
function bcdDigits(data: Uint8Array, at: number, digits: number): number {
  let value = 0;
  for (let i = 0; i < digits; i++) {
    const byte = data[at + (i >> 1)] ?? 0;
    value = value * 10 + ((i & 1) === 0 ? byte >> 4 : byte & 0x0f);
  }
  return value;
}

/**
 * 衛星の分配の記述子を読む。周波数は 8 桁の BCD で、上から 3 桁が GHz (011.72748 GHz)。
 * シンボルレートは 7 桁で、上から 3 桁が Msym/s
 */
function satelliteDelivery(descriptor: Uint8Array): SatelliteDelivery | null {
  if (descriptor.length < 11) return null;
  return {
    kind: "satellite",
    frequency: bcdDigits(descriptor, 0, 8) * 10,
    orbitalPosition: bcdDigits(descriptor, 4, 4),
    east: (descriptor[6]! & 0x80) !== 0,
    polarization: (descriptor[6]! >> 5) & 0x03,
    modulation: descriptor[6]! & 0x1f,
    symbolRate: bcdDigits(descriptor, 7, 7) * 100,
    fec: descriptor[10]! & 0x0f,
  };
}

/** 地上の分配の記述子を読む。周波数は 16 ビットずつ、1/7 MHz 単位 */
function terrestrialDelivery(
  descriptor: Uint8Array,
): TerrestrialDelivery | null {
  if (descriptor.length < 2) return null;
  const head = u16(descriptor, 0);
  const frequencies: number[] = [];
  for (let at = 2; at + 2 <= descriptor.length; at += 2) {
    frequencies.push(Math.round((u16(descriptor, at) * 1_000_000) / 7));
  }
  return {
    kind: "terrestrial",
    areaCode: head >> 4,
    guardInterval: (head >> 2) & 0x03,
    transmissionMode: head & 0x03,
    frequencies,
  };
}

/** NIT のセクション 1 つ。表は何本かのセクションに分かれて来るので、そろえるのは `NitReader` */
export interface NitSection {
  /** NIT[other] (ほかのネットワークのもの) なら true */
  other: boolean;
  networkId: number;
  version: number;
  /** current_next_indicator。0 (これから使う表) のものは `NitReader` が読まない */
  current: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  remoteControlKeyId: number | null;
  transportStreams: NetworkTransport[];
}

/** NIT のセクションを 1 つ読む。actual (0x40) と other (0x41) のどちらも */
export function parseNitSection(section: Uint8Array): NitSection | null {
  const tableId = section[0];
  if (tableId !== TABLE_NIT_ACTUAL && tableId !== TABLE_NIT_OTHER) return null;
  if (section.length < 16) return null;

  const networkLength = u16(section, 8) & 0x0fff;
  let at = 10 + networkLength;
  if (at + 2 > section.length) return null;
  at += 2; // transport_stream_loop_length

  let remoteControlKeyId: number | null = null;
  const transportStreams: NetworkTransport[] = [];
  const end = section.length - 4;
  while (at + 6 <= end) {
    const transportStreamId = u16(section, at);
    const originalNetworkId = u16(section, at + 2);
    const loop = u16(section, at + 4) & 0x0fff;
    const body = section.subarray(at + 6, Math.min(at + 6 + loop, end));
    at += 6 + loop;

    const services: Service[] = [];
    let delivery: Delivery | null = null;
    for (const [tag, descriptor] of descriptors(body)) {
      if (
        tag === DESC_TS_INFORMATION &&
        descriptor.length > 0 &&
        remoteControlKeyId === null
      ) {
        remoteControlKeyId = descriptor[0]!;
      } else if (tag === DESC_SERVICE_LIST) {
        for (let i = 0; i + 3 <= descriptor.length; i += 3) {
          services.push({
            serviceId: u16(descriptor, i),
            serviceType: descriptor[i + 2]!,
            name: "",
          });
        }
      } else if (tag === DESC_SATELLITE_DELIVERY) {
        delivery = satelliteDelivery(descriptor) ?? delivery;
      } else if (tag === DESC_TERRESTRIAL_DELIVERY) {
        delivery = terrestrialDelivery(descriptor) ?? delivery;
      }
    }
    transportStreams.push({
      transportStreamId,
      originalNetworkId,
      services,
      delivery,
    });
  }

  return {
    other: tableId === TABLE_NIT_OTHER,
    networkId: u16(section, 3),
    version: (section[5]! >> 1) & 0x1f,
    current: (section[5]! & 0x01) !== 0,
    sectionNumber: section[6]!,
    lastSectionNumber: section[7]!,
    remoteControlKeyId,
    transportStreams,
  };
}

/**
 * NIT からネットワーク ID とリモコン番号、他の TS の顔ぶれを読む。**セクション 1 つぶん。**
 * スキャンで「どのネットワークか」を知るにはこれで足りる。ネットワークの全部の TS が要るなら `NitReader`
 */
export function parseNit(section: Uint8Array): NetworkInfo | null {
  if (section[0] !== TABLE_NIT_ACTUAL) return null;
  const parsed = parseNitSection(section);
  if (parsed === null) return null;
  const { networkId, remoteControlKeyId, transportStreams } = parsed;
  return { networkId, remoteControlKeyId, transportStreams };
}

/**
 * 1 つの表のセクションを集める。**version が変わったら集め直す。**
 *
 * 表は何本かのセクション (section_number 0〜last_section_number) に分かれて来る。
 * 違う version のものを混ぜると、書き換わる前と後の TS が 1 つの表に並ぶ
 */
class SectionSet<T> {
  private version = -1;
  private last = -1;
  private parts = new Map<number, T>();

  /** 足す。そろったら true */
  add(version: number, number: number, last: number, part: T): boolean {
    if (version !== this.version || last !== this.last) {
      this.version = version;
      this.last = last;
      this.parts = new Map();
    }
    if (number <= last) this.parts.set(number, part);
    return this.parts.size === last + 1;
  }

  /** section_number の順に */
  ordered(): T[] {
    return [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => part);
  }
}

/** そろった NIT。セクションをつないだもの */
export interface Network {
  /** NIT[other] なら true */
  other: boolean;
  networkId: number;
  version: number;
  remoteControlKeyId: number | null;
  transportStreams: NetworkTransport[];
}

/**
 * NIT を**全部のセクション**そろえて読む。
 *
 * 衛星の NIT[actual] には、そのネットワークの全部の TS (TSID・周波数・サービスの一覧) が載っている。
 * TS が多いと 1 セクション (1024 バイトまで) に収まらないので、ネットワークごとに (actual と other を
 * 分けて) 集め、そろったものを返す。
 *
 * **version が変わっても、新しい表がそろうまでは前の表を返す。** 読む側が見るのは、いつも 1 つの
 * version でそろった表。全部のセクションが 1 回りするまで (NIT は 10 秒に 1 回は流れるので、長くて 10 秒ほど) は何も返らない。
 *
 * 置き換えた 1 つ前の version のセクションが遅れて届いても読まない。読むと、そろったときに表が前に戻る。
 *
 * 1 つの中継を読む前提で作ってある。別の中継へ移るときは作り直す。`actual` は、最初にそろった自分のネットワークの表を返す
 */
export class NitReader {
  private readonly assembler = new SectionAssembler(PID_NIT);
  private readonly packets = new PacketStream();
  private readonly pending = new Map<string, SectionSet<NitSection>>();
  private readonly done = new Map<string, Network>();
  /** 置き換えた表の version (表ごと) */
  private readonly replaced = new Map<string, number>();

  /** 任意の長さのバイト列を渡す。そろった表が増えたか変わったら true */
  feed(chunk: Uint8Array): boolean {
    let changed = false;
    for (const packet of this.packets.feed(chunk)) {
      for (const section of this.assembler.feed(packet)) {
        const tableId = section[0];
        if (tableId !== TABLE_NIT_ACTUAL && tableId !== TABLE_NIT_OTHER)
          continue;
        // current_next_indicator が 0 (これから使う表) のものは読まない
        if (section.length < 16 || (section[5]! & 0x01) === 0) continue;
        const key = `${tableId === TABLE_NIT_OTHER ? "other" : "actual"}:${u16(section, 3)}`;
        // そろっている表と同じ version なら、繰り返し流れてきただけ。中身を読む前に見る (同じものが何度も来る)
        const version = (section[5]! >> 1) & 0x1f;
        if (
          this.done.get(key)?.version === version ||
          this.replaced.get(key) === version
        )
          continue;
        const parsed = parseNitSection(section);
        if (parsed !== null && this.add(key, parsed)) changed = true;
      }
    }
    return changed;
  }

  private add(key: string, section: NitSection): boolean {
    const set = this.pending.get(key) ?? new SectionSet<NitSection>();
    this.pending.set(key, set);
    const complete = set.add(
      section.version,
      section.sectionNumber,
      section.lastSectionNumber,
      section,
    );
    if (!complete) return false;

    const parts = set.ordered();
    this.pending.delete(key);
    const before = this.done.get(key);
    if (before !== undefined) this.replaced.set(key, before.version);
    this.done.set(key, {
      other: section.other,
      networkId: section.networkId,
      version: section.version,
      remoteControlKeyId:
        parts.find((part) => part.remoteControlKeyId !== null)
          ?.remoteControlKeyId ?? null,
      transportStreams: parts.flatMap((part) => part.transportStreams),
    });
    return true;
  }

  /** 自分のネットワークの表 (NIT[actual])。まだそろっていなければ null */
  get actual(): Network | null {
    for (const network of this.done.values()) {
      if (!network.other) return network;
    }
    return null;
  }

  /** そろった表を全部。actual が先 */
  networks(): Network[] {
    return [...this.done.values()].sort(
      (a, b) => Number(a.other) - Number(b.other) || a.networkId - b.networkId,
    );
  }
}

/** そろった SDT。TS 1 本ぶん */
export interface ServiceTable extends TransportInfo {
  /** SDT[other] (ほかの TS のもの) なら true */
  other: boolean;
  version: number;
}

/**
 * SDT を TS ごとに**全部のセクション**そろえて読む。自分の TS (actual) とほかの TS (other) の両方。
 *
 * 衛星はほかの TS の局名も流しているので、1 つの TS を開けばネットワークの局名がそろう
 * (そろうかは放送しだい。来なかった TS は返らない)。version の扱いと、1 つの中継を読む前提は `NitReader` と同じ
 */
export class SdtReader {
  private readonly assembler = new SectionAssembler(PID_SDT);
  private readonly packets = new PacketStream();
  private readonly pending = new Map<string, SectionSet<TransportInfo>>();
  private readonly done = new Map<string, ServiceTable>();
  /** 置き換えた表の version (TS ごと) */
  private readonly replaced = new Map<string, number>();

  /** 任意の長さのバイト列を渡す。そろった表が増えたか変わったら true */
  feed(chunk: Uint8Array): boolean {
    let changed = false;
    for (const packet of this.packets.feed(chunk)) {
      for (const section of this.assembler.feed(packet)) {
        const tableId = section[0];
        if (tableId !== TABLE_SDT_ACTUAL && tableId !== TABLE_SDT_OTHER)
          continue;
        // current_next_indicator が 0 (これから使う表) のものは読まない
        if (section.length < 15 || (section[5]! & 0x01) === 0) continue;
        if (this.add(section, tableId === TABLE_SDT_OTHER)) changed = true;
      }
    }
    return changed;
  }

  private add(section: Uint8Array, other: boolean): boolean {
    const version = (section[5]! >> 1) & 0x1f;
    const key = `${other ? "other" : "actual"}:${u16(section, 8)}:${u16(section, 3)}`;
    // そろっている表と同じ version なら、繰り返し流れてきただけ。局名を読む前に見る (2 秒おきに同じものが来る)
    if (
      this.done.get(key)?.version === version ||
      this.replaced.get(key) === version
    )
      return false;
    const transport = sdtTransport(section);
    const set = this.pending.get(key) ?? new SectionSet<TransportInfo>();
    this.pending.set(key, set);
    if (!set.add(version, section[6]!, section[7]!, transport)) return false;

    this.pending.delete(key);
    const before = this.done.get(key);
    if (before !== undefined) this.replaced.set(key, before.version);
    this.done.set(key, {
      ...transport,
      services: set.ordered().flatMap((part) => part.services),
      other,
      version,
    });
    return true;
  }

  /** 自分の TS の表 (SDT[actual])。まだそろっていなければ null */
  get actual(): ServiceTable | null {
    for (const table of this.done.values()) {
      if (!table.other) return table;
    }
    return null;
  }

  /** そろった表を全部。actual が先、あとはネットワーク・TSID の順 */
  tables(): ServiceTable[] {
    return [...this.done.values()].sort(
      (a, b) =>
        Number(a.other) - Number(b.other) ||
        a.originalNetworkId - b.originalNetworkId ||
        a.transportStreamId - b.transportStreamId,
    );
  }
}

export interface FoundService extends Service {
  networkId: number;
  transportStreamId: number;
  remoteControlKeyId: number | null;
}

/**
 * 流れてくる TS を読んで、NIT と SDT が揃うまで待つ。
 *
 * Mirakurun のスキャンと同じで、**両方**揃って初めてそのチャンネルを
 * 「受信できた」とみなす。SDT だけ取れても、どのネットワークのものか
 * 分からないと設定に書けない。
 */
export class ServiceReader {
  private readonly nit = new SectionAssembler(PID_NIT);
  private readonly sdt = new SectionAssembler(PID_SDT);
  private readonly packets = new PacketStream();

  network: NetworkInfo | null = null;
  transport: TransportInfo | null = null;

  get complete(): boolean {
    return this.network !== null && this.transport !== null;
  }

  /** 任意の長さのバイト列を渡す。揃ったら true */
  feed(chunk: Uint8Array): boolean {
    for (const packet of this.packets.feed(chunk)) {
      if (this.network === null) {
        for (const section of this.nit.feed(packet)) {
          this.network = parseNit(section) ?? this.network;
        }
      }
      if (this.transport === null) {
        for (const section of this.sdt.feed(packet)) {
          this.transport = parseSdt(section) ?? this.transport;
        }
      }
    }
    return this.complete;
  }

  /** 録るに値するサービスだけ。リモコン番号は NIT のものを配る */
  services(): FoundService[] {
    if (this.network === null || this.transport === null) return [];
    const { networkId, remoteControlKeyId } = this.network;
    const { transportStreamId } = this.transport;
    return this.transport.services
      .filter((service) => SERVICE_TYPES.has(service.serviceType))
      .map((service) => ({
        ...service,
        networkId,
        transportStreamId,
        remoteControlKeyId,
      }));
  }
}

/** CAT の conditional_access_descriptor (tag 0x09) */
export interface CaDescriptor {
  caSystemId: number;
  caPid: number;
  privateData: Uint8Array;
}

/**
 * CAT (PID 0x0001, table_id 0x01) の記述子ループから CA 記述子を切り出す。
 */
export function* catDescriptors(section: Uint8Array): Generator<CaDescriptor> {
  if (section[0] !== TABLE_CAT || section.length < 12) return;
  // 8バイト目から末尾の CRC32 (4バイト) の手前までが記述子領域
  const data = section.subarray(8, section.length - 4);
  for (const [tag, body] of descriptors(data)) {
    if (tag === DESC_CONDITIONAL_ACCESS && body.length >= 4) {
      const caSystemId = (body[0]! << 8) | body[1]!;
      const caPid = ((body[2]! & 0x1f) << 8) | body[3]!;
      yield {
        caSystemId,
        caPid,
        privateData: body.subarray(4),
      };
    }
  }
}

/**
 * CAT セクションから指定された CA_system_id (デフォルト 0x0005: B-CAS) の EMM PID 一覧を取得する。
 */
export function getEmmPids(
  section: Uint8Array,
  caSystemId: number = CA_SYSTEM_BCAS,
): number[] {
  const pids = new Set<number>();
  for (const desc of catDescriptors(section)) {
    if (
      desc.caSystemId === caSystemId &&
      desc.caPid !== 0x0000 &&
      desc.caPid !== 0x1fff
    ) {
      pids.add(desc.caPid);
    }
  }
  return [...pids];
}

/** EMM-S (0x84) セクション内の EMM メッセージ要素 */
export interface EmmMessage {
  /** 48ビットの B-CAS カードID */
  cardId: bigint;
  /** プロトコル種別 (0: 契約更新・有効期限更新など) */
  protocolNumber: number;
  /** 事業者グループ識別 */
  broadcasterGroupId: number;
  /** 更新番号 */
  updateNumber: number;
  /** 有効期限 (MJD) */
  expirationDate: number;
  /** B-CAS カードの APDU (0x90 0x36) に送るペイロード (card_id 6B + 長さ 1B + 更新データ) */
  payload: Uint8Array;
}

/**
 * EMM-S (table_id 0x84) セクションから EMM メッセージ一覧を抽出する (ARIB STD-B25)。
 */
export function* parseEmmSection(section: Uint8Array): Generator<EmmMessage> {
  if (section[0] !== TABLE_EMM_S || section.length < 17) return;
  // 8バイト目から CRC32 (4バイト) の手前まで
  const data = section.subarray(8, section.length - 4);
  let at = 0;
  while (at + 7 <= data.length) {
    let cardId = 0n;
    for (let i = 0; i < 6; i++) {
      cardId = (cardId << 8n) | BigInt(data[at + i]!);
    }
    const infoLength = data[at + 6]!;
    const elementLength = 7 + infoLength;
    if (at + elementLength > data.length) break;

    const protocolNumber = infoLength >= 1 ? data[at + 7]! : 0;
    const broadcasterGroupId = infoLength >= 2 ? data[at + 8]! : 0;
    const updateNumber =
      infoLength >= 4 ? (data[at + 9]! << 8) | data[at + 10]! : 0;
    const expirationDate =
      infoLength >= 6 ? (data[at + 11]! << 8) | data[at + 12]! : 0;

    const emmPayload = data.subarray(at, at + elementLength);
    yield {
      cardId,
      protocolNumber,
      broadcasterGroupId,
      updateNumber,
      expirationDate,
      payload: emmPayload,
    };

    at += elementLength;
  }
}

/**
 * TS パケットから CAT (PID 0x0001) を検知して EMM PID を特定し、
 * EMM パケットから EMM メッセージを取り出す受信機。
 */
export class EmmReceiver {
  private readonly cat = new SectionAssembler(PID_CAT);
  private readonly emmAssemblers = new Map<number, SectionAssembler>();
  private readonly emmPids = new Set<number>();
  private readonly targetCardId?: bigint | undefined;
  readonly caSystemId: number;

  constructor(options?: {
    caSystemId?: number | undefined;
    targetCardId?: bigint | string | undefined;
  }) {
    this.caSystemId = options?.caSystemId ?? CA_SYSTEM_BCAS;
    if (options?.targetCardId !== undefined) {
      this.targetCardId =
        typeof options.targetCardId === "bigint"
          ? options.targetCardId
          : BigInt(String(options.targetCardId).replace(/\s+/g, ""));
    }
  }

  /** 検知した EMM PID 一覧 */
  get pids(): ReadonlySet<number> {
    return this.emmPids;
  }

  /**
   * TS パケットを 1 つ投入する。
   * 完成した EMM セクションから対象カード宛て (指定されていれば) のメッセージを返す。
   */
  feed(packet: Uint8Array): EmmMessage[] {
    const pid = packetPid(packet);
    if (pid === PID_CAT) {
      for (const section of this.cat.feed(packet)) {
        for (const emmPid of getEmmPids(section, this.caSystemId)) {
          if (!this.emmPids.has(emmPid)) {
            this.emmPids.add(emmPid);
            this.emmAssemblers.set(emmPid, new SectionAssembler(emmPid));
          }
        }
      }
      return [];
    }

    const assembler = this.emmAssemblers.get(pid);
    if (!assembler) return [];

    const messages: EmmMessage[] = [];
    for (const section of assembler.feed(packet)) {
      for (const msg of parseEmmSection(section)) {
        if (
          this.targetCardId === undefined ||
          msg.cardId === this.targetCardId
        ) {
          messages.push(msg);
        }
      }
    }
    return messages;
  }
}
