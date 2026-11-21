/**
 * データ放送 (ARIB STD-B24 の BML) をデコードする。**1 局に絞った TS を渡すと、
 * 組み立て終わったファイルが出てくる。**
 *
 *     TS → PAT → PMT → データ符号化方式記述子 (0xFD) の付いた ES
 *                       → DII/DDB (カルーセル) → モジュール → ファイル
 *
 * ## なぜ自前なのか
 *
 * **運び方は衛星のロゴと同じ DSM-CC** で、denpa はそれを既に持っている
 * ([dsmcc.ts](dsmcc.ts) / [logo-dsmcc.ts](https://github.com/danything/denpa/blob/main/src/lib/ts/logo-dsmcc.ts))。
 * [web-bml](https://github.com/otya128/web-bml) の `decode_ts.ts` は使わない。要るのは
 * その一部だけで、残り (EIT/SDT/NIT・字幕の PES) は自前で読んでおり
 * ([eit.ts](eit.ts) / [psi.ts](psi.ts) / [b24caption.ts](b24caption.ts))、`@chinachu/aribts` も抱えずに済む。
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
  NPTReference,
  ResponseMessage,
} from "./bml-protocol.js";
import { u16, u32 } from "./bytes.js";
import type { Dii, DiiModule } from "./dsmcc.js";
import {
  dataEventIdOf,
  MAX_MODULE_SIZE,
  ModuleBuilder,
  parseDdb,
  parseDii,
  TABLE_DII,
  TABLE_STREAM_DESCRIPTOR,
} from "./dsmcc.js";
import { parseTimeTable, PID_TIME } from "./eit.js";
import { parseMediaType, readEntity } from "./multipart.js";
import { pcrBase, WRAP } from "./pes.js";
import {
  componentTagOf,
  descriptors,
  packetPid,
  PacketStream,
  pmtPcrPid,
  pmtStreams,
  PmtTracker,
  SectionAssembler,
  STREAM_AAC,
} from "./psi.js";

/** データ符号化方式記述子 (STD-B10 第 2 部 6.2.20) */
const DESC_DATA_COMPONENT = 0xfd;

/**
 * BML が載っている符号化方式 (STD-B10 第 2 部 付録 J 表 J-1)。
 * 0x0C/0x0D が地上波、0x07 が BS、0x0B が CS
 */
const BXML_COMPONENT_IDS = new Set([0x07, 0x0b, 0x0c, 0x0d]);

/**
 * DSM-CC を運ぶ ES の stream_type (ISO/IEC 13818-6 の type B・C・D)。
 * **イベントメッセージだけを運ぶ ES は、データ符号化方式記述子が BML でなくても読む** (`BmlDecoder.onPmt`)
 */
const DSMCC_STREAM_TYPES = new Set([0x0b, 0x0c, 0x0d]);

/** zlib。Compression Type 記述子で運用されるのはこれだけ */
const COMPRESSION_ZLIB = 0;

/**
 * データ符号化方式記述子の後半を読む。
 *
 * 地上波は TR-B14 第二分冊 2.1.4 表 2-3、BS/CS は TR-B15 第一分冊 5.1.5 表 5-4。
 *
 * **`data_component_id` は 16 ビット** (aribts は 8 ビットで読んでいる)。
 */
export function parseBxmlInfo(data: Uint8Array): AdditionalAribBXMLInfo {
  let at = 0;
  // 00 のみ運用 (データカルーセル伝送方式およびイベントメッセージ伝送方式)
  const transmissionFormat = (data[at]! >> 6) & 0b11;
  // component_tag=0x40 のとき必ず 1。startup.xml が最初に起動される
  const entryPointFlag = ((data[at]! >> 5) & 1) === 1;
  const info: AdditionalAribBXMLInfo = { transmissionFormat, entryPointFlag };

  if (entryPointFlag) {
    const autoStartFlag = ((data[at]! >> 4) & 1) === 1;
    /*
     * 画面の大きさ。運用されるのは 0011 (960x540)、0100 (720x480 16:9)、
     * 0101 (720x480 4:3) の 3 つ
     */
    const documentResolution = data[at]! & 0x0f;
    at++;
    const useXML = ((data[at]! >> 7) & 1) === 1;
    const defaultVersionFlag = ((data[at]! >> 6) & 1) === 1;
    // BS/CS では 0 のとき単独視聴不可。地上波は常に 1
    const independentFlag = ((data[at]! >> 5) & 1) === 1;
    const styleForTVFlag = ((data[at]! >> 4) & 1) === 1;
    at++;
    // 既定は BS の 1.0。地上波は 3、CS は 2 が入ってくる
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
 * PMT から ES を並べる。**部品タグ (component_tag) を持たない ES は数に入れない。**
 * データ放送は「何番の部品か」でしか物を指せないので、番号の無いものは指しようがない。
 *
 * `BmlDecoder` の外からも使う。denpa のライブは、カルーセルをデコードする前に入口の部品の自動起動の指定をこれで読む
 */
export function parsePmt(section: Uint8Array): ComponentPMT[] {
  const components: ComponentPMT[] = [];
  for (const [streamType, pid, info] of pmtStreams(section)) {
    const componentId = componentTagOf(info);
    if (componentId === null) continue;
    let dataComponentId: number | undefined;
    let bxmlInfo: AdditionalAribBXMLInfo | undefined;
    for (const [tag, descriptor] of descriptors(info)) {
      if (tag === DESC_DATA_COMPONENT && descriptor.length >= 2) {
        dataComponentId = u16(descriptor, 0);
        // 追加の識別情報が無ければ読まない (無いまま読むと、全部 0 のカルーセルに見える)
        if (BXML_COMPONENT_IDS.has(dataComponentId) && descriptor.length > 2)
          bxmlInfo = parseBxmlInfo(descriptor.subarray(2));
      }
    }
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

/**
 * PMT にある音声 (AAC) の ES の部品タグを、PMT の順に並べる (`PMTMessage.audios`)。**部品タグの無い ES は null で数に入れる。**
 * `parsePmt` と違って落とさないので、何本目の音声かが画面の再生 (pes.ts の `readPmt`) と ffmpeg の `0:a:<n>` にそろう
 */
export function pmtAudios(section: Uint8Array): (number | null)[] {
  const audios: (number | null)[] = [];
  for (const [streamType, , info] of pmtStreams(section)) {
    if (streamType === STREAM_AAC) audios.push(componentTagOf(info));
  }
  return audios;
}

/** `at` の下位 1 ビットと続く 4 バイトで 33 ビット (STC・NPT) */
const u33 = (data: Uint8Array, at: number) =>
  (data[at]! & 1) * 0x100000000 + u32(data, at + 1);

/**
 * いまの NPT (90 kHz)。TR-B14 第二分冊の NPT 値の算出に従う。
 * 進む (scale 1/1) か止まっている (scale 0/1) ときだけ求め、ほかの速さ (運用されない) は null
 */
function nptAt(reference: NPTReference, stc: number): number | null {
  if (reference.scaleDenominator !== 1) return null;
  if (reference.scaleNumerator === 0) return reference.NPTReference;
  if (reference.scaleNumerator !== 1) return null;
  const elapsed = (stc - reference.STCReference + WRAP) % WRAP;
  return (reference.NPTReference + elapsed) % WRAP;
}

/**
 * NPT 参照記述子に書かれた時刻 (STC_Reference) に STC が達したか。**達する前の参照は使わない。**
 * 放送は切り替える少し前から次の参照を送るので、達する前に使うと NPT が先へ飛ぶ。
 * 33 ビットで一周するので、差が半周より大きいものはまだ先とみなす
 */
function reached(reference: NPTReference, stc: number): boolean {
  return since(reference.STCReference, stc) < WRAP / 2;
}

/** `from` から `to` まで STC が進んだ量 (90 kHz)。33 ビットで一周するので、戻ったものは半周より大きく出る */
function since(from: number, to: number): number {
  return (((to - from) % WRAP) + WRAP) % WRAP;
}

/** 同じ参照か (NPT 参照記述子の中身が全部同じ) */
function sameReference(a: NPTReference, b: NPTReference | null): boolean {
  return (
    b !== null &&
    a.postDiscontinuityIndicator === b.postDiscontinuityIndicator &&
    a.dsmContentId === b.dsmContentId &&
    a.STCReference === b.STCReference &&
    a.NPTReference === b.NPTReference &&
    a.scaleNumerator === b.scaleNumerator &&
    a.scaleDenominator === b.scaleDenominator
  );
}

/**
 * **PCR がこれより先へ飛んだら、放送の時計 (STC) が不連続になったとみなす** (10 秒。90 kHz)。PCR は 0.1 秒より短い間隔で
 * 届くので、ふつうは飛ばない。戻ったときと、適応フィールドの discontinuity_indicator が立ったときも不連続とみなす。
 * 電波が数秒途切れただけなら STC は続いているので、短い飛びでは参照を捨てない
 */
const STC_JUMP = 10 * 90_000;

/** ストリーム記述子 (table_id 0x3D)。NPT とイベントメッセージが載っている */
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
 * 組み立て中のモジュール 1 つ。
 *
 * **DII に書いてあったことを持っておく。** 圧縮されているか・中身が何かは DII にしか書いておらず、
 * ブロックを運ぶ DDB には無い。揃ったときに読み方が分からないと困る
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

/**
 * 1 つの `BmlDecoder` で同時に組み立てるモジュールの大きさの合計の上限 (64 MiB)。
 * 1 つずつは `MAX_MODULE_SIZE` に収まっても、たくさん並べた DII や ES でメモリを使い切らせられる。
 * 実際のカルーセルは全部で数 MB に収まる
 */
const MAX_CAROUSEL_SIZE = 64 * 1024 * 1024;

/** カルーセルが流れている ES 1 本ぶんの覚え書き */
interface Component {
  componentId: number;
  /**
   * カルーセル (DII・DDB) を組み立てるか。BML の符号化方式が付いた ES だけ true。
   * false の ES はイベントメッセージ (ストリーム記述子) だけを読む
   */
  carousel: boolean;
  /** 使い始めた NPT 参照 (`reached`)。時刻指定のイベントメッセージを起こす時刻を決める */
  npt: NPTReference | null;
  /**
   * 最後に NPT が替わった STC (90 kHz。参照を使い始めた時点か、STC が不連続になって NPT が無くなった時点)。
   * 次の参照を使い始める時点は、これより前に戻さない (`nptUpdated` の `stc`)。まだ替わっていなければ null
   */
  nptSince: number | null;
  sections: SectionAssembler;
  /** DII の transaction_id。**変わっていなければ組み立て直さない** */
  transactionId: number | null;
  dataEventId: number;
  /** 組み立て中のモジュール (moduleId ごと) */
  building: Map<number, Building>;
  /** 配り終えたモジュールのバージョン (`doneMark`)。**同じものを配り直さない**ため */
  done: Map<number, string>;
  /** 今の DII (諦めたモジュールを除いた一覧を配り直すのに使う) */
  dii: Dii | null;
  /** 今の DII のモジュールの大きさの合計 (カルーセルの一周の下限) */
  size: number;
  /** 今の DII で、来ないか読めないと諦めたモジュール */
  abandoned: Set<number>;
}

/** `Component.done` に置く印。モジュールのバージョンとカルーセルの回 (dataEventId) の組 */
function doneMark(component: Component, version: number): string {
  return `${version}:${component.dataEventId}`;
}

/**
 * 1 局に絞った TS を渡すと、データ放送の通知が出てくる。
 *
 * **1 つの選局に 1 つ。** 局を変えたら作り直す。カルーセルは局ごとに別物で、
 * 組み立て中のものを持ち越すと混ざる。
 */
export class BmlDecoder {
  private readonly packets = new PacketStream();
  /** **1 局に絞ったあとを渡す前提。** 入っているサービスは 1 つなので、最初の局の PMT を追う */
  private readonly pmt = new PmtTracker();
  // TDT は CRC を持たない。DSM-CC と同じ理由で 'syntax' で受ける
  private readonly time = new SectionAssembler(PID_TIME, "syntax");
  /** カルーセルが流れている ES。PID ごと */
  private readonly components = new Map<number, Component>();
  /** 最後に配った PMT。**変わったときだけ配る** */
  private sent: string | null = null;
  /** PMT の PCR_PID。読むまでは null */
  private pcrPid: number | null = null;
  /** 最後に読んだ PCR の基準部 (90 kHz)。**放送の STC**。時刻指定のイベントメッセージに使う (`dueEvents`) */
  private stc: number | null = null;

  constructor(private readonly send: (message: ResponseMessage) => void) {}

  /** 1 局に絞った TS を渡す */
  feed(chunk: Uint8Array): void {
    for (const packet of this.packets.feed(chunk)) this.feedPacket(packet);
  }

  /**
   * 切り分け済みのパケットを 1 つ。ライブは同じ TS を時計や Hybridcast とも
   * 分け合うので、切り分けは 1 回で済ませて配る (denpa の `server/live.ts` の `tap`)。
   *
   * **PID で渡し先を引く。** データ放送と関係ない映像のパケットで、カルーセルの組み立て処理を呼ばない。
   *
   * `packet` は呼び出し側が渡したチャンクの一部を指す (`psi.ts` の `PacketStream`)。**返ったあとまで
   * 持つならコピーすること。** チャンクのバッファは使い回される
   */
  feedPacket(packet: Uint8Array): void {
    const pid = packetPid(packet);
    // 同じ PID を 2 つの用途で使うこともあるので、else でつながない
    for (const section of this.pmt.feed(packet, pid)) this.onPmt(section);
    if (pid === this.pcrPid) this.readPcr(packet);
    if (pid === PID_TIME)
      for (const section of this.time.feed(packet)) this.onTime(section);
    const component = this.components.get(pid);
    if (component !== undefined) {
      for (const section of component.sections.feed(packet))
        this.onCarousel(component, section);
    }
  }

  /**
   * 適応フィールドの PCR の基準部 (90 kHz。`pcrBase`)。**STC が不連続になったら、使っていた NPT 参照を捨てる** (`STC_JUMP`)。
   * 前の時計の参照で NPT を求めると、飛んだぶんだけ NPT も飛ぶ。新しい時計で達した参照が届けば、そこから使い直す
   */
  private readPcr(packet: Uint8Array): void {
    const stc = pcrBase(packet);
    if (stc === null) return;
    const previous = this.stc;
    this.stc = stc;
    if (previous === null) return;
    // 適応フィールドの discontinuity_indicator (pcrBase が読めたので、適応フィールドの長さは 7 以上ある)
    const flagged = (packet[5]! & 0x80) !== 0;
    const step = since(previous, stc);
    if (!flagged && step <= STC_JUMP) return;
    for (const component of this.components.values()) {
      if (component.npt === null) continue;
      component.npt = null;
      component.nptSince = stc;
      this.send({
        type: "nptUpdated",
        componentId: component.componentId,
        reference: null,
        stc,
      });
    }
  }

  private onPmt(section: Uint8Array): void {
    this.pcrPid = pmtPcrPid(section);
    const components = parsePmt(section);
    if (components.length === 0) return;
    const audios = pmtAudios(section);

    /*
     * 放送は同じ表を何度も送る。**変わったときだけ配る。** 受け側は
     * PMT が来るたびに画面を組み直すので、そのまま通すと出っ放しになる
     */
    const shape = JSON.stringify([components, audios]);
    if (this.sent !== shape) {
      this.sent = shape;
      this.send({ type: "pmt", components, audios });
    }

    for (const component of components) {
      /*
       * カルーセルが流れているのは、BML の符号化方式が付いた ES だけ。**イベントメッセージは、運用では文書とは別の ES で
       * 送られる** (文書の `es_ref` で指す)。その ES に BML の符号化方式が付いているとは限らないので、DSM-CC の ES は
       * どれもストリーム記述子を読む
       */
      const carousel = component.bxmlInfo !== undefined;
      if (!carousel && !DSMCC_STREAM_TYPES.has(component.streamType)) continue;
      const held = this.components.get(component.pid);
      if (held !== undefined) {
        // 番組が替わって、イベントメッセージだけの ES にカルーセルが載ることがある
        if (carousel) held.carousel = true;
        continue;
      }
      this.components.set(component.pid, {
        componentId: component.componentId,
        carousel,
        npt: null,
        nptSince: null,
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
        events: this.dueEvents(component, parseEsEvents(section)),
        dataEventId: extension >> 12,
      });
      return;
    }
    if (!component.carousel) return;
    if (section[0] === TABLE_DII) this.onDii(component, section);
    else this.onDdb(component, section);
  }

  /**
   * **時刻指定 (NPT) のイベントメッセージは、NPT がその時刻に達したら、すぐ起きるもの (time_mode 0) として配る。**
   *
   * NPT は PCR (STC) と NPT 参照記述子から求める。描く側 (denpa の `bml/engine.ts`) は PCR を受け取らない
   * (映像の再生位置で動く) ので、PCR を読めるここで決める。放送は同じストリーム記述子を繰り返し送るので、
   * 達したあとに届いた回で起きる。達していないものと、NPT が分からないもの (参照がまだ来ていない・PCR を読んでいない) は、
   * 時刻指定のまま配る (描く側は起こさない)
   */
  private dueEvents(component: Component, events: ESEvent[]): ESEvent[] {
    const stc = this.stc;
    if (stc === null) return events;
    this.useReference(component, events, stc);
    const npt = component.npt === null ? null : nptAt(component.npt, stc);
    if (npt === null) return events;
    return events.map((event) =>
      event.type === "nptEvent" && event.eventMessageNPT <= npt
        ? {
            type: "immediateEvent",
            eventMessageGroupId: event.eventMessageGroupId,
            timeMode: 0,
            eventMessageType: event.eventMessageType,
            eventMessageId: event.eventMessageId,
            privateDataByte: event.privateDataByte,
          }
        : event,
    );
  }

  /**
   * STC が達した参照のうち、いちばん新しいもの (STC_Reference が最も近いもの) を使う。**替わったら `nptUpdated` を送る。**
   * 同じ参照は繰り返し届くので、中身が変わったときだけ送る。
   *
   * 使い始める STC はふつう参照の STC_Reference。前に NPT が替わった時点 (`nptSince`) より前になるときは、
   * 届いた今の STC にする。STC が不連続になったあとに前と同じ参照が届いたとき、NPT を無くした時点より前へ戻さないため
   */
  private useReference(
    component: Component,
    events: ESEvent[],
    stc: number,
  ): void {
    let chosen: NPTReference | null = null;
    for (const event of events) {
      if (event.type !== "nptReference" || !reached(event, stc)) continue;
      if (
        chosen === null ||
        since(event.STCReference, stc) < since(chosen.STCReference, stc)
      )
        chosen = event;
    }
    if (chosen === null || sameReference(chosen, component.npt)) return;
    const held = component.nptSince;
    const start =
      held !== null && since(held, chosen.STCReference) >= WRAP / 2
        ? stc
        : chosen.STCReference;
    component.npt = chosen;
    component.nptSince = start;
    this.send({
      type: "nptUpdated",
      componentId: component.componentId,
      reference: chosen,
      stc: start,
    });
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
    // ほかの ES で組み立て中のものと合わせて `MAX_CAROUSEL_SIZE` に収める
    let budget = MAX_CAROUSEL_SIZE;
    for (const other of this.components.values())
      if (other !== component) budget -= other.size;
    for (const module of dii.modules) {
      /*
       * **大きすぎるモジュールは組み立てない。** 来ないものとして一覧から外す
       * (受け側が待ち続けないように)
       */
      if (
        module.moduleSize > MAX_MODULE_SIZE ||
        component.size + module.moduleSize > budget
      ) {
        component.abandoned.add(module.moduleId);
        continue;
      }
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
   * 待ちを終わらせる。前の DII で配り終えたバージョンのままのもの (受け側が持っている) は一覧から外さず、
   * 組み立てるのをやめるだけ。次に DII のバージョンが変われば、また待つ
   */
  private giveUp(component: Component): void {
    const limit = component.size * GIVE_UP_ROUNDS;
    let changed = false;
    for (const [moduleId, held] of component.building) {
      if (held.quietDiis < GIVE_UP_ROUNDS || held.quietBytes < limit) continue;
      component.building.delete(moduleId);
      if (
        component.done.get(moduleId) ===
        doneMark(component, held.module.moduleVersion)
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
    // バージョンが食い違うブロックを混ぜると壊れたファイルができる
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
     * **同じものを配り直さない。** カルーセルは回り続けるので、バージョンが上がって
     * いなくても同じモジュールが何度も揃う。そのたびに配ると、受け側は
     * 中身の変わらない画面を組み直し続ける
     */
    const version = held.builder.moduleVersion;
    const mark = doneMark(component, version);
    if (component.done.get(moduleId) === mark) return;

    // 大きさ 0 は展開しようが無い。ファイルの無いモジュールとして配り、待っている受け側を終わらせる
    const empty = held.module.moduleSize === 0;
    const data = empty
      ? held.builder.data
      : inflate(held.builder.data, held.module.compression);
    const files =
      data === null ? [] : moduleFiles(data, held.module.contentType);
    /*
     * **展開できない・分けられないモジュールは諦める。** 配らずに黙ると、受け側は DII に
     * 載っている限り待ち続ける。ブロックは CRC を通っているので、組み直しても同じ結果になる
     */
    if (files.length === 0 && !empty) {
      component.abandoned.add(moduleId);
      this.sendList(component);
      return;
    }
    component.done.set(moduleId, mark);

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
 * **多くは `multipart/mixed`** で、1 つのモジュールに BML と画像がまとめて
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

/** zlib で圧縮してあれば展開する。展開できなければ諦めて null */
export function inflate(
  data: Uint8Array,
  compression: { type: number } | null,
): Uint8Array | null {
  if (compression === null) return data;
  if (compression.type !== COMPRESSION_ZLIB) return null;
  try {
    // 展開した大きさにも上限を置く。小さな DDB から何 GB にも展開されるものを作れる
    return inflateSync(data, { maxOutputLength: MAX_MODULE_SIZE });
  } catch {
    return null;
  }
}
