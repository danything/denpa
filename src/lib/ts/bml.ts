/**
 * データ放送 (ARIB STD-B24 の BML) をデコードする。**1局に絞った TS を食わせると、
 * 組み立て終わったファイルが出てくる。**
 *
 *     TS → PAT → PMT → データ符号化方式記述子 (0xFD) の付いた ES
 *                       → DII/DDB (カルーセル) → モジュール → ファイル
 *
 * ## なぜ自前なのか
 *
 * **運び方は衛星のロゴと同じ DSM-CC** で、denpa はそれを既に持っている
 * ([dsmcc.ts](dsmcc.ts) / [logo-dsmcc.ts](logo-dsmcc.ts))。
 * [web-bml](https://github.com/otya128/web-bml) の `decode_ts.ts` は使わない — 要るのは
 * その一部だけで、残り (EIT/SDT/NIT・字幕の PES) は自前で読んでおり
 * ([eit.ts](eit.ts) / [psi.ts](psi.ts) / ffmpeg)、`@chinachu/aribts` も抱えずに済む。
 *
 * **出す形式は web-bml の頃のまま** ([bml-protocol.ts](bml-protocol.ts))。録画の隣の
 * `.bml.jsonl` がこの形式で残っているので、変えると前に録ったものが読めなくなる。
 * モジュールの中身 (multipart) は [multipart.ts](multipart.ts) がデコードする。
 */

import { Buffer } from "node:buffer";
import { inflateSync } from "node:zlib";
import type {
  AdditionalAribBXMLInfo,
  ComponentPMT,
  ESEvent,
  ModuleFile,
  ResponseMessage,
} from "./bml-protocol";
import { u16, u32 } from "./bytes";
import type { Dii, DiiModule } from "./dsmcc";
import {
  dataEventIdOf,
  ModuleBuilder,
  parseDdb,
  parseDii,
  TABLE_DII,
  TABLE_STREAM_DESCRIPTOR,
} from "./dsmcc";
import { PID_TIME, parseTimeTable } from "./eit";
import { parseMediaType, readEntity } from "./multipart";
import {
  descriptors,
  PacketStream,
  PmtTracker,
  packetPid,
  pmtStreams,
  SectionAssembler,
} from "./psi";

const DESC_STREAM_IDENTIFIER = 0x52;
/** データ符号化方式記述子 (STD-B10 第2部 6.2.20) */
const DESC_DATA_COMPONENT = 0xfd;

/**
 * BML が載っている符号化方式 (STD-B10 第2部 付録J 表J-1)。
 * 0x0C/0x0D が地上波、0x07 が BS、0x0B が CS
 */
const BXML_COMPONENT_IDS = new Set([0x07, 0x0b, 0x0c, 0x0d]);

/** zlib。Compression Type 記述子で運用されるのはこれだけ */
const COMPRESSION_ZLIB = 0;

/**
 * データ符号化方式記述子の後半を読む。
 *
 * 地上波は TR-B14 第二分冊 2.1.4 表2-3、BS/CS は TR-B15 第一分冊 5.1.5 表5-4。
 *
 * **`data_component_id` は16ビット** (aribts は8ビットで読んでいる)。
 */
export function parseBxmlInfo(data: Uint8Array): AdditionalAribBXMLInfo {
  let at = 0;
  // 00 のみ運用 (データカルーセル伝送方式およびイベントメッセージ伝送方式)
  const transmissionFormat = (data[at]! >> 6) & 0b11;
  // component_tag=0x40 のとき必ず1。startup.xml が最初に起動される
  const entryPointFlag = ((data[at]! >> 5) & 1) === 1;
  const info: AdditionalAribBXMLInfo = { transmissionFormat, entryPointFlag };

  if (entryPointFlag) {
    const autoStartFlag = ((data[at]! >> 4) & 1) === 1;
    /*
     * 画面の大きさ。運用されるのは 0011 (960x540)、0100 (640x480 16:9)、
     * 0101 (640x480 4:3) の3つ
     */
    const documentResolution = data[at]! & 0x0f;
    at++;
    const useXML = ((data[at]! >> 7) & 1) === 1;
    const defaultVersionFlag = ((data[at]! >> 6) & 1) === 1;
    // BS/CS では 0 のとき単独視聴不可。地上波は常に1
    const independentFlag = ((data[at]! >> 5) & 1) === 1;
    const styleForTVFlag = ((data[at]! >> 4) & 1) === 1;
    at++;
    // 既定は BS の 1.0。地上波は3、CS は2が入ってくる
    info.entryPointInfo = {
      autoStartFlag,
      documentResolution,
      useXML,
      defaultVersionFlag,
      independentFlag,
      styleForTVFlag,
      bmlMajorVersion: 1,
      bmlMinorVersion: 0,
    };
    if (!defaultVersionFlag) {
      info.entryPointInfo.bmlMajorVersion = u16(data, at);
      info.entryPointInfo.bmlMinorVersion = u16(data, at + 2);
      at += 4;
      // 運用されない
      if (useXML) {
        info.entryPointInfo.bxmlMajorVersion = u16(data, at);
        info.entryPointInfo.bxmlMinorVersion = u16(data, at + 2);
        at += 4;
      }
    }
  } else {
    at++;
  }

  if (transmissionFormat === 0) {
    // additional_arib_carousel_info (STD-B24 第三分冊 第三編 C.1)
    const dataEventId = (data[at]! >> 4) & 0x0f;
    const eventSectionFlag = ((data[at]! >> 3) & 1) === 1;
    at++;
    const ondemandRetrievalFlag = ((data[at]! >> 7) & 1) === 1;
    const fileStorableFlag = ((data[at]! >> 6) & 1) === 1;
    const startPriority = (data[at]! >> 5) & 1;
    info.additionalAribCarouselInfo = {
      dataEventId,
      eventSectionFlag,
      ondemandRetrievalFlag,
      fileStorableFlag,
      startPriority,
    };
  }
  return info;
}

/**
 * PMT から ES を並べる。**部品タグ (component_tag) を持たない ES は数に入れない** —
 * データ放送は「何番の部品か」でしか物を指せないので、番号の無いものは指しようがない。
 */
function parsePmt(section: Uint8Array): ComponentPMT[] {
  const components: ComponentPMT[] = [];
  for (const [streamType, pid, info] of pmtStreams(section)) {
    let componentId: number | undefined;
    let dataComponentId: number | undefined;
    let bxmlInfo: AdditionalAribBXMLInfo | undefined;
    for (const [tag, descriptor] of descriptors(info)) {
      if (tag === DESC_STREAM_IDENTIFIER && descriptor.length >= 1)
        componentId = descriptor[0];
      else if (tag === DESC_DATA_COMPONENT && descriptor.length >= 2) {
        dataComponentId = u16(descriptor, 0);
        if (BXML_COMPONENT_IDS.has(dataComponentId))
          bxmlInfo = parseBxmlInfo(descriptor.subarray(2));
      }
    }
    if (componentId === undefined) continue;
    components.push({
      componentId,
      pid,
      streamType,
      ...(dataComponentId === undefined ? {} : { dataComponentId }),
      ...(bxmlInfo === undefined ? {} : { bxmlInfo }),
    });
  }
  return components;
}

/** `at` の下位1ビットと続く4バイトで 33 ビット (STC・NPT) */
const u33 = (data: Uint8Array, at: number) =>
  (data[at]! & 1) * 0x100000000 + u32(data, at + 1);

/** ストリーム記述子 (table_id 0x3D)。NPT と イベントメッセージが載っている */
function parseEsEvents(section: Uint8Array): ESEvent[] {
  const events: ESEvent[] = [];
  const length = u16(section, 1) & 0x0fff;
  const body = section.subarray(8, Math.min(3 + length - 4, section.length));
  for (const [tag, descriptor] of descriptors(body)) {
    if (tag === 0x17 && descriptor.length >= 18) {
      // NPT 参照記述子。放送の時計と番組内の時刻を結び付ける
      events.push({
        type: "nptReference",
        postDiscontinuityIndicator: (descriptor[0]! & 0x80) !== 0,
        dsmContentId: descriptor[0]! & 0x7f,
        STCReference: u33(descriptor, 1),
        NPTReference: u33(descriptor, 9),
        scaleNumerator: u16(descriptor, 14),
        scaleDenominator: u16(descriptor, 16),
      });
    } else if (tag === 0x40 && descriptor.length >= 11) {
      // 汎用イベントメッセージ記述子。運用されるのは time_mode 0 と 2 だけ
      const timeMode = descriptor[2];
      const message = {
        eventMessageGroupId: (u16(descriptor, 0) >> 4) & 0x0fff,
        eventMessageType: descriptor[8]!,
        eventMessageId: u16(descriptor, 9),
        privateDataByte: [...descriptor.subarray(11)],
      };
      if (timeMode === 0)
        events.push({ type: "immediateEvent", timeMode: 0, ...message });
      else if (timeMode === 2)
        events.push({
          type: "nptEvent",
          timeMode: 2,
          eventMessageNPT: u33(descriptor, 3),
          ...message,
        });
    }
  }
  return events;
}

/**
 * 組み立て中のモジュール1つ。
 *
 * **DII の言い分を持ち歩く。** 縮んでいるか・中身が何かは DII にしか書いておらず、
 * ブロックを運ぶ DDB は何も知らない。揃ったときに読み方が分からないと困る
 */
interface Building {
  module: DiiModule;
  builder: ModuleBuilder;
  /** 最後にブロックが増えてから、DII が繰り返した回数 */
  quietDiis: number;
  /** 最後にブロックが増えてから、この部品のカルーセルで流れた DDB のバイト数 (どのモジュールのものでも) */
  quietBytes: number;
}

/**
 * **DII に載ったモジュールが来なければ諦める。** 最後にブロックが増えてから、DII が
 * この回数繰り返し、しかもカルーセルが一覧の大きさのこの倍数ぶん流れたら、もう来ないとみなす。
 * 両方を見るのは、DII の繰り返しはカルーセルの一周より短いことがあり (回数だけだと大きい
 * カルーセルの途中で諦める)、よく使うモジュールは一周に何度も流れる (バイト数だけだと一周を
 * 短く見積もる) ため
 */
const GIVE_UP_ROUNDS = 4;

/** カルーセルが流れている ES 1本ぶんの覚え書き */
interface Component {
  componentId: number;
  sections: SectionAssembler;
  /** DII の transaction_id。**変わっていなければ組み立て直さない** */
  transactionId: number | null;
  dataEventId: number;
  /** 組み立て中のモジュール (moduleId ごと) */
  building: Map<number, Building>;
  /** 配り終えたモジュールの版。**同じものを配り直さない**ため */
  done: Map<number, string>;
  /** 今の DII (諦めたモジュールを除いた一覧を配り直すのに使う) */
  dii: Dii | null;
  /** 今の DII のモジュールの大きさの合計 (カルーセルの一周の下限) */
  size: number;
  /** 今の DII で、来ないと諦めたモジュール */
  abandoned: Set<number>;
}

/**
 * 1局に絞った TS を食わせると、データ放送の通知が出てくる。
 *
 * **1つの選局に1つ。** 局を変えたら作り直す — カルーセルは局ごとに別物で、
 * 組み立て中のものを持ち越すと混ざる。
 */
export class BmlDecoder {
  private readonly packets = new PacketStream();
  /** **1局に絞ったあとを食わせる前提。** 入っているサービスは1つなので、最初の局の PMT を追う */
  private readonly pmt = new PmtTracker();
  // TDT は CRC を持たない。DSM-CC と同じ理由で 'syntax' で受ける
  private readonly time = new SectionAssembler(PID_TIME, "syntax");
  /** カルーセルが流れている ES。PID ごと */
  private readonly components = new Map<number, Component>();
  /** 最後に配った PMT。**変わったときだけ配る** */
  private sent: string | null = null;

  constructor(private readonly send: (message: ResponseMessage) => void) {}

  /** 1局に絞った TS を食わせる */
  feed(chunk: Uint8Array): void {
    for (const packet of this.packets.feed(chunk)) this.feedPacket(packet);
  }

  /**
   * 切り分け済みのパケットを1つ。ライブは同じ TS を時計や Hybridcast とも
   * 分け合うので、切り分けは1回で済ませて配る (`server/live.ts` の `tap`)。
   *
   * **PID で行き先を引く。** 組み立て役を全部に回していた頃は、データ放送と
   * 関係ない映像のパケットのたびにカルーセルの数だけ呼んでいた。
   *
   * `packet` は呼び手の塊の上の窓 (`psi.ts` の `PacketStream`)。**返ったあとまで
   * 持つなら写すこと** — 塊の入れ物は使い回される
   */
  feedPacket(packet: Uint8Array): void {
    const pid = packetPid(packet);
    // 同じ PID を2役が名乗ることもあるので、else でつながない
    for (const section of this.pmt.feed(packet, pid)) this.onPmt(section);
    if (pid === PID_TIME)
      for (const section of this.time.feed(packet)) this.onTime(section);
    const component = this.components.get(pid);
    if (component !== undefined) {
      for (const section of component.sections.feed(packet))
        this.onCarousel(component, section);
    }
  }

  private onPmt(section: Uint8Array): void {
    const components = parsePmt(section);
    if (components.length === 0) return;

    /*
     * 放送は同じ表を何度も送る。**変わったときだけ配る** — 受け側は
     * PMT が来るたびに画面を組み直すので、そのまま通すと出っ放しになる
     */
    const shape = JSON.stringify(components);
    if (this.sent !== shape) {
      this.sent = shape;
      this.send({ type: "pmt", components });
    }

    for (const component of components) {
      // カルーセルが流れているのは、BML の符号化方式が付いた ES だけ
      if (component.bxmlInfo === undefined) continue;
      if (this.components.has(component.pid)) continue;
      this.components.set(component.pid, {
        componentId: component.componentId,
        // DSM-CC は section_syntax_indicator が立たないことがある (psi.ts)
        sections: new SectionAssembler(component.pid, "syntax"),
        transactionId: null,
        dataEventId: -1,
        building: new Map(),
        done: new Map(),
        dii: null,
        size: 0,
        abandoned: new Set(),
      });
    }
  }

  /** TDT / TOT。読み方は [eit.ts](eit.ts) にまとめてある */
  private onTime(section: Uint8Array): void {
    const at = parseTimeTable(section);
    if (at !== null) this.send({ type: "currentTime", timeUnixMillis: at });
  }

  private onCarousel(component: Component, section: Uint8Array): void {
    if (section[0] === TABLE_STREAM_DESCRIPTOR) {
      const extension = u16(section, 3);
      this.send({
        type: "esEventUpdated",
        componentId: component.componentId,
        events: parseEsEvents(section),
        dataEventId: extension >> 12,
      });
      return;
    }
    if (section[0] === TABLE_DII) this.onDii(component, section);
    else this.onDdb(component, section);
  }

  private onDii(component: Component, section: Uint8Array): void {
    const dii = parseDii(section);
    if (dii === null) return;
    // 同じカルーセルが回ってきただけ。組み立て中のものを捨てない
    if (component.transactionId === dii.transactionId) {
      for (const held of component.building.values()) held.quietDiis++;
      this.giveUp(component);
      return;
    }
    component.transactionId = dii.transactionId;

    /*
     * **番組が変わったら覚えていたものを捨てる。** dataEventId はカルーセルの
     * 「回」で、ここが変わると前の番組のファイルは使えない
     */
    const dataEventId = dataEventIdOf(dii.downloadId);
    if (component.dataEventId !== dataEventId) {
      component.dataEventId = dataEventId;
      component.done.clear();
    }

    component.building.clear();
    component.abandoned.clear();
    component.dii = dii;
    component.size = 0;
    for (const module of dii.modules) {
      component.size += module.moduleSize;
      component.building.set(module.moduleId, {
        module,
        builder: new ModuleBuilder(
          module.moduleVersion,
          module.moduleSize,
          dii.blockSize,
        ),
        quietDiis: 0,
        quietBytes: 0,
      });
    }
    this.sendList(component);
    // 大きさ 0 のものは DDB が来ない。待たせずに配る (来ないまま諦めると、受け側は無いものと見なす)
    for (const [moduleId, held] of component.building) {
      if (held.builder.complete) this.finish(component, moduleId, held);
    }
  }

  /** 今の DII の一覧を配る。**諦めたモジュールは載せない** */
  private sendList(component: Component): void {
    const dii = component.dii;
    if (dii === null) return;
    this.send({
      type: "moduleListUpdated",
      componentId: component.componentId,
      modules: dii.modules
        .filter((module) => !component.abandoned.has(module.moduleId))
        .map((module) => ({
          id: module.moduleId,
          version: module.moduleVersion,
          size: module.moduleSize,
        })),
      dataEventId: component.dataEventId,
      ...(dii.returnToEntry === null
        ? {}
        : { returnToEntryFlag: dii.returnToEntry }),
    });
  }

  /**
   * **来ないモジュールを諦める** (`GIVE_UP_ROUNDS`)。待っている受け側 (`Resources` の `wait`) は、
   * DII に無いモジュールを「もう来ない」と決める (`gone`) ので、諦めたものを除いた一覧を配り直して
   * 待ちを終わらせる。前の DII で配り終えた版のままのもの (受け側が持っている) は一覧から外さず、
   * 組み立てるのをやめるだけ。次に DII の版が変われば、また待つ
   */
  private giveUp(component: Component): void {
    const limit = component.size * GIVE_UP_ROUNDS;
    let changed = false;
    for (const [moduleId, held] of component.building) {
      if (held.quietDiis < GIVE_UP_ROUNDS || held.quietBytes < limit) continue;
      component.building.delete(moduleId);
      if (
        component.done.get(moduleId) ===
        `${held.module.moduleVersion}:${component.dataEventId}`
      )
        continue;
      component.abandoned.add(moduleId);
      changed = true;
    }
    if (changed) this.sendList(component);
  }

  private onDdb(component: Component, section: Uint8Array): void {
    const ddb = parseDdb(section);
    if (ddb === null) return;
    for (const waiting of component.building.values())
      waiting.quietBytes += ddb.block.length;
    const held = component.building.get(ddb.moduleId);
    // 版が食い違うブロックを混ぜると壊れたファイルができる
    if (held === undefined || held.builder.moduleVersion !== ddb.moduleVersion)
      return;
    const before = held.builder.blocks;
    const complete = held.builder.add(ddb.blockNumber, ddb.block);
    if (held.builder.blocks > before) {
      held.quietDiis = 0;
      held.quietBytes = 0;
    }
    if (complete) this.finish(component, ddb.moduleId, held);
  }

  /** 揃ったモジュールを配る */
  private finish(component: Component, moduleId: number, held: Building): void {
    // 次の DII が来るまで組み立て直さない
    component.building.delete(moduleId);
    /*
     * **同じものを配り直さない。** カルーセルは回り続けるので、版が上がって
     * いなくても同じモジュールが何度も揃う。そのたびに配ると、受け側は
     * 中身の変わらない画面を組み直し続ける
     */
    const version = held.builder.moduleVersion;
    const stamp = `${version}:${component.dataEventId}`;
    if (component.done.get(moduleId) === stamp) return;
    component.done.set(moduleId, stamp);

    // 大きさ 0 は伸ばしようが無い。ファイルの無いモジュールとして配り、待っている受け側を終わらせる
    const empty = held.module.moduleSize === 0;
    const data = empty
      ? held.builder.data
      : inflate(held.builder.data, held.module.compression);
    if (data === null) return;
    const files = moduleFiles(data, held.module.contentType);
    if (files.length === 0 && !empty) return;

    this.send({
      type: "moduleDownloaded",
      componentId: component.componentId,
      moduleId,
      files,
      version,
      dataEventId: component.dataEventId,
    });
  }
}

/**
 * 揃ったモジュールをファイルに分ける。
 *
 * **多くは `multipart/mixed`** で、1つのモジュールに BML と画像がまとめて
 * 入っている。Type 記述子が無いときも中身は multipart なので、同じ扱いにする。
 */
export function moduleFiles(
  data: Uint8Array,
  contentType: string | null,
): ModuleFile[] {
  const declared = contentType === null ? null : parseMediaType(contentType);
  if (
    declared !== null &&
    !(declared.type === "multipart" && declared.subtype === "mixed")
  ) {
    return [
      {
        contentLocation: null,
        contentType: declared,
        dataBase64: base64(data),
      },
    ];
  }

  const entity = readEntity(data);
  if (entity?.parts == null) return [];
  const files: ModuleFile[] = [];
  for (const part of entity.parts) {
    const location = part.headers.find(
      (header) => header.name === "content-location",
    );
    const type = part.headers.find((header) => header.name === "content-type");
    // どちらも必ず入っている。欠けているものは置き場所も読み方も分からない
    if (location === undefined || type === undefined) continue;
    const mediaType = parseMediaType(type.value);
    if (mediaType === null) continue;
    files.push({
      contentLocation: location.value,
      contentType: mediaType,
      dataBase64: base64(part.body),
    });
  }
  return files;
}

function base64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/** zlib で縮めてあれば伸ばす。伸ばせなければ諦めて null */
export function inflate(
  data: Uint8Array,
  compression: { type: number } | null,
): Uint8Array | null {
  if (compression === null) return data;
  if (compression.type !== COMPRESSION_ZLIB) return null;
  try {
    return inflateSync(data);
  } catch {
    return null;
  }
}
