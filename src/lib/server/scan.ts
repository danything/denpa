/**
 * チャンネルスキャン。地上波は物理チャンネルを片端から選局して、ある局を探す。
 * **BS と CS は放送の NIT から一覧を作る** (`satellite.ts`。中継器に 1 回合わせれば全部の TS が分かる)。
 *
 * **選局はエージェントに任せ、読むのはこちら。** エージェントは中身を読まないので
 * ([agent.md](../../../docs/agent.md))、NIT と SDT を読み取って局名を取るのは
 * denpa の仕事になる。局名は ARIB の文字符号で入っていて、そのデコーダは
 * `packages/arib/src/aribtext.ts` にしかない。
 *
 * 地上波は Mirakurun の走査に合わせてある。
 *
 * - 地上波は 13〜62ch を総当たり (パススルーも選ぶと C13〜C63 も)
 * - ケーブル (CATV。ISDB-C) は QC13〜QC63・QU13〜QU62・QV1〜QV12 を総当たり。TSMF で束ねた搬送波は、
 *   束ねた TS をそれぞれ選局する (`QC30:1`…。`tsmfJobs`)。局ごとの CA_system_id も数え、復号できるかを決める (`ca-observe.ts`)。
 *   選局の答えが TLV (分割 TLV から組み立てた 4K の放送。`tuner.openChannel` の `transport`) なら、TLV の表で局を読む (`readTlvServices`)
 * - SKY (スカパー！プレミアムサービス光) は H01〜H105 を総当たり。番組表は取得しない (`services.decodable`)。
 *   代わりに、カード無しで分かること (CA_system_id・番組表とロゴが来ているか) を数えて記録と受信の設定に出す (`ca-observe.ts`)
 * - 1 チャンネルにつき最大 30 秒待ち、NIT と SDT が**両方**揃ったら受信できたとみなす。CATV は SDT だけで揃ったとみなす
 *   (`ServiceReader` の `requireNit`)
 * - Mirakurun と同じサービス種別を残す (`psi.SERVICE_TYPES`。ラジオ・データも入り、
 *   映像の無いものは取り込みで落とす: `schema.DIGITAL_TV`)
 *
 * **録画中でも実行できる。** 選局はエージェントの取り合いに加わるので、録画が
 * 使っているチューナーは取られないだけ (空きが無ければ待ち、飛ばさない)。
 */

import { type EitEvent, EpgReader } from "@danything/arib/eit";
import { type AccessControl, TlvServiceReader } from "@danything/arib/mmt-si";
import { type FoundService, ServiceReader } from "@danything/arib/psi";

import { type ChannelType, isSatellite, type Transport } from "../types";
import { CaObserver, describe, type Observed } from "./ca-observe";
import { config } from "./config";
import { savePrograms, settle, sync, typeRank } from "./epg";
import { collectOnce } from "./epg-collect";
import { emit } from "./events";
import { knownNames, readLineup, type SatelliteType } from "./satellite";
import { resolveConflicts } from "./scheduler";
import { readUntil } from "./stream";
import {
  type AgentChannel,
  type AgentTuner,
  deleteChannels,
  getChannels,
  getTuners,
  openChannel,
  openChannelStream,
  putChannels,
  TunerBusyError,
} from "./tuner";

/**
 * 1 チャンネルあたりの待ち時間。
 *
 * 電波が無ければ選局がすぐ落ちるので、実際にここまで待つのは受信できた局だけ。
 * NIT は 10 秒に 1 回しか流れてこないうえ、選局が落ち着くまでにも数秒かかるので、
 * Mirakurun の 20 秒では取りこぼすことがある
 */
const TUNE_TIMEOUT = 30_000;

/** チューナーが空くのを待ち直す間隔。録画が終われば空く */
const BUSY_RETRY = 10_000;

/** 記録しておく行数。総当たりは何十行も流れる */
const LOG_LIMIT = 400;

/** 地上波の UHF の範囲 */
const UHF_RANGE = { min: 13, max: 62 };

/**
 * スキャンの種類。**`PASSTHROUGH` は地上波の局として、UHF に加えてケーブルテレビの周波数変換パススルー (C13〜C63) も回す。**
 * ケーブルテレビは地デジをそのまま CATV のチャンネルの周波数に移して送ることがあり、局によって移すものと移さないものが混ざるので両方回す。
 * `CATV` はケーブル (ISDB-C) の局で、種別も `CATV` になる (`catvChannels`)
 */
export const SCAN_KINDS = [
  "GR",
  "BS",
  "CS",
  "PASSTHROUGH",
  "CATV",
  "SKY",
] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];
const PASSTHROUGH_RANGE = { min: 13, max: 63 };

/**
 * ケーブル (ISDB-C) のチャンネル。エージェントの選局表の `QC13`〜`QC63` (C13〜C63 の周波数)・`QU13`〜`QU62` (UHF)・
 * `QV1`〜`QV12` (VHF) (docs/agent.md「選局表」)。**総当たりにする。** 地上波と同じく、局ごとに使うチャンネルが違う
 */
const CATV_BANDS = [
  { prefix: "QC", min: 13, max: 63 },
  { prefix: "QU", min: 13, max: 62 },
  { prefix: "QV", min: 1, max: 12 },
];

/** CATV で選局するチャンネルの一覧 (113 本)。TSMF で束ねた 2 つ目からの TS (`QC30:1`) は入らない (`tsmfJobs`) */
export function catvChannels(): string[] {
  return CATV_BANDS.flatMap(({ prefix, min, max }) =>
    Array.from({ length: max - min + 1 }, (_, i) => `${prefix}${min + i}`),
  );
}

/**
 * TSMF (1 つの搬送波に複数の TS を束ねる) の搬送波で、0 番目のほかに選局する TS (`QC30:1`〜)。
 * `streams` は選局の答えの `X-Denpa-Tsmf-Streams` (`tuner.openChannel`)。0 番目は名前に番号を付けない。
 * TSMF を使うのは C13〜C63 の周波数 (`QC`) だけで、番号の付いたもの (2 つ目から) は束ね直さない
 */
export function tsmfJobs(channel: string, streams: number): string[] {
  if (!/^QC\d+$/.test(channel) || streams < 2) return [];
  return Array.from({ length: streams - 1 }, (_, i) => `${channel}:${i + 1}`);
}

/**
 * **同じ TS (original_network_id と TSID が同じ) が 2 つの CATV のチャンネルで見つかったら、先のほうだけを残す。**
 * 並びはスキャンの結果の順 (チャンネル名の順)。同じ局が 2 回入ると、番組表と録画の ID がぶつかる (`tuner.serviceKey`)。
 * 落としたものは `dropped` に、残したチャンネルと組で返す
 */
export function dedupeCatv(entries: AgentChannel[]): {
  kept: AgentChannel[];
  dropped: { entry: AgentChannel; kept: string }[];
} {
  const seen = new Map<string, string>();
  const kept: AgentChannel[] = [];
  const dropped: { entry: AgentChannel; kept: string }[] = [];
  for (const entry of entries) {
    if (entry.type !== "CATV") {
      kept.push(entry);
      continue;
    }
    const ts = `${entry.networkId}:${entry.transportStreamId}`;
    const first = seen.get(ts);
    if (first === undefined) {
      seen.set(ts, entry.channel);
      kept.push(entry);
    } else dropped.push({ entry, kept: first });
  }
  return { kept, dropped };
}

/**
 * スカパー！プレミアムサービス光 (J.83B) のチャンネル。エージェントの選局表の `H01`〜`H105` (docs/agent.md「選局表」)。
 * **総当たりにする。** 地上波と同じく、NIT から TS の一覧を作れるかは確かめていない (実機の TS がまだ無い。#1578)
 */
const SKY_RANGE = { min: 1, max: 105 };

/** SKY で選局する物理チャンネルの一覧 (`H01`〜`H105`) */
export function skyChannels(): string[] {
  return Array.from(
    { length: SKY_RANGE.max - SKY_RANGE.min + 1 },
    (_, i) => `H${String(SKY_RANGE.min + i).padStart(2, "0")}`,
  );
}

/**
 * 地上波で選局する物理チャンネルの一覧。エージェントが受け付ける書き方で返す。
 *
 * **範囲は決め打ち。** 放送で使う物理チャンネルは決まっていて、狭めても
 * 総当たりの時間が少し減るだけ。狭めた結果 見つからない局が出るほうが困る
 */
export function channelsFor(type: "GR" | "PASSTHROUGH"): string[] {
  const uhf = Array.from(
    { length: UHF_RANGE.max - UHF_RANGE.min + 1 },
    (_, i) => `T${UHF_RANGE.min + i}`,
  );
  if (type === "GR") return uhf;
  const { min, max } = PASSTHROUGH_RANGE;
  return [
    ...uhf,
    ...Array.from({ length: max - min + 1 }, (_, i) => `C${min + i}`),
  ];
}

/**
 * カード無しで分かること (`ca-observe.ts`) を数えるとき、局が揃ってから番組表 (EIT) の具合が分かるまで読み続ける上限 (読み始めから)。
 * p/f は数秒おきに来るので、来ているならこの間に 1 つは来る。来なければ「来ていない」と出す。全体の待ち (`TUNE_TIMEOUT`) は延ばさない
 */
const OBSERVE_WAIT = 10_000;

interface ScanResult {
  services: FoundService[] | null;
  error: string | null;
  /** TS が 1 バイトでも来たか。アンテナの問題と読み取りの問題を分ける手掛かり */
  signal: boolean;
}

/**
 * 流れてくる TS を、NIT と SDT が揃うまで読む。
 *
 * 揃った時点で打ち切る。最後まで読む必要はないし、無い局で 30 秒待つのは
 * 総当たりだと効いてくる。
 *
 * 失敗の理由は分けて返す。総当たりなので「何も出なかった」と「電波は来ているが
 * 読めなかった」は原因がまるで違い、まとめてしまうと直しようがない。
 */
export async function readServices(
  stream: ReadableStream<Uint8Array>,
  timeout = TUNE_TIMEOUT,
  abort?: AbortSignal,
  /** 同じストリームから番組表も取得する。読む時間は延ばさない (揃った時点で打ち切るのは同じ) */
  epg?: EpgReader,
  /**
   * 同じストリームで、カード無しで分かること (CA_system_id・番組表が来ているか) も数える (SKY と CATV の局だけ)。
   * 局が揃っても、SKY は番組表の具合が、CATV は局ごとの CA_system_id (PMT) が分かるまで、`OBSERVE_WAIT` までは読み続ける
   */
  observer?: CaObserver,
  /** ケーブル (ISDB-C) の TS か。SDT だけで揃ったとみなす (`ServiceReader` の `requireNit`) */
  cable = false,
): Promise<ScanResult> {
  const reader = new ServiceReader({ requireNit: !cable });
  let bytes = 0;
  const started = Date.now();
  const observed = (watching: CaObserver) =>
    cable ? watching.pmtsKnown : watching.epgKnown;
  const tail = await readUntil(
    stream,
    (chunk) => {
      bytes += chunk.byteLength;
      epg?.feed(chunk);
      observer?.feed(chunk);
      const complete = reader.feed(chunk);
      return (
        complete &&
        (observer === undefined ||
          observed(observer) ||
          Date.now() - started >= OBSERVE_WAIT)
      );
    },
    timeout,
    abort,
  );

  const signal = bytes > 0;
  if (reader.complete)
    return { services: reader.services(), error: null, signal };

  const detail = tail === "" ? "" : ` (${tail})`;
  const fail = (why: string) => ({
    services: null,
    error: `${why}${detail}`,
    signal,
  });
  if (!signal) return fail("受信できませんでした");
  if (cable) return fail("SDT を受信できませんでした");
  if (reader.network === null && reader.transport === null)
    return fail("受信はできましたが、局の情報を読み取れません");
  return fail(
    `${reader.network === null ? "NIT" : "SDT"} を受信できませんでした`,
  );
}

/** TLV (4K の放送) を読んだ結果。局ごとの CA_system_id と ECM の packet_id も返す (MPT のアクセス制御記述子) */
interface TlvScanResult extends ScanResult {
  caSystemIdsOf: (serviceId: number) => number[];
  accessOf: (serviceId: number) => AccessControl[];
}

/**
 * 流れてくる TLV (選局の答えが `application/x-arib-tlv`) を、TLV-NIT と MH-SDT[actual] が揃うまで読む (`TlvServiceReader`)。
 * TS の `readServices` に当たる。局が揃ってからも、PLT にある局の MPT が全部来るまで、読み始めから `OBSERVE_WAIT` までは読み続ける
 * (局ごとの CA_system_id を MPT から読む。TS の PMT と同じ)。番組表 (MH-EIT) はまだ読まない
 */
export async function readTlvServices(
  stream: ReadableStream<Uint8Array>,
  timeout = TUNE_TIMEOUT,
  abort?: AbortSignal,
): Promise<TlvScanResult> {
  const reader = new TlvServiceReader();
  let bytes = 0;
  const started = Date.now();
  const tail = await readUntil(
    stream,
    (chunk) => {
      bytes += chunk.byteLength;
      return (
        reader.feed(chunk) &&
        (reader.mptsKnown || Date.now() - started >= OBSERVE_WAIT)
      );
    },
    timeout,
    abort,
  );

  const signal = bytes > 0;
  const result = {
    signal,
    caSystemIdsOf: (serviceId: number) => reader.caSystemIdsOf(serviceId),
    accessOf: (serviceId: number) => reader.accessOf(serviceId),
  };
  if (reader.complete)
    return { ...result, services: reader.services(), error: null };
  const detail = tail === "" ? "" : ` (${tail})`;
  const why = !signal
    ? "受信できませんでした"
    : reader.network === null && reader.transport === null
      ? "受信はできましたが、局の情報を読み取れません"
      : `${reader.network === null ? "TLV-NIT" : "MH-SDT"} を受信できませんでした`;
  return { ...result, services: null, error: `${why}${detail}` };
}

const hex = (value: number) =>
  `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * TLV のチャンネルについて、スキャンの記録の 1 行に足す説明。局ごとの CA_system_id と ECM の packet_id (MPT のアクセス制御記述子)。
 * B-CAS と同じ `0x0005` でも B-CAS のカードでは復号できないので、TS の `describe` と違って B-CAS とは書かない
 */
function describeTlv(
  services: readonly FoundService[],
  accessOf: (serviceId: number) => AccessControl[],
): string {
  const found = services.flatMap((service) =>
    accessOf(service.serviceId).map(
      (entry) =>
        `CA_system_id ${hex(entry.caSystemId)} ECM ${entry.location.packetId === null ? "不明" : hex(entry.location.packetId)}`,
    ),
  );
  return [
    "4K (MMT/TLV)",
    found.length === 0
      ? "アクセス制御記述子なし"
      : [...new Set(found)].join("・"),
  ].join("、");
}

/**
 * スキャンで分かったことを 1 件にまとめる。`caSystemIdsOf` を渡すと、局ごとの CA_system_id も入れる (CATV。`CaObserver`・`TlvServiceReader`)。
 * `transport` は TLV (4K の放送) のときだけ書く。無ければ TS
 */
export function channelEntry(
  type: ChannelType,
  channel: string,
  services: FoundService[],
  caSystemIdsOf?: (serviceId: number) => number[],
  transport: Transport = "ts",
): AgentChannel {
  const first = services[0];
  return {
    type,
    channel,
    networkId: first?.networkId ?? 0,
    transportStreamId: first?.transportStreamId ?? 0,
    remoteControlKeyId: first?.remoteControlKeyId ?? null,
    ...(transport === "ts" ? {} : { transport }),
    services: services
      .map((service) => ({
        serviceId: service.serviceId,
        serviceType: service.serviceType,
        name: service.name,
        ...(caSystemIdsOf === undefined
          ? {}
          : { caSystemIds: caSystemIdsOf(service.serviceId) }),
      }))
      .sort((a, b) => a.serviceId - b.serviceId),
  };
}

interface ScanState {
  state: "idle" | "running" | "done" | "failed" | "canceled";
  /** いま何をしているか。そのまま画面に出す */
  phase: string;
  log: string[];
  /** 選局し終えた物理チャンネル数と、その総数。進捗バーに使う */
  scanned: number;
  total: number;
  /** 見つかったチャンネル数 */
  channels: number;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const IDLE: ScanState = {
  state: "idle",
  phase: "",
  log: [],
  scanned: 0,
  total: 0,
  channels: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
};

let current: ScanState = IDLE;

/**
 * 最後のスキャンで、SKY と CATV のチャンネルについて分かったこと (`種別:チャンネル` → 中身)。
 * 受信の設定の「受信できるチャンネル」に出す。**denpa の中にだけ持つ** (再起動で消える。もう一度スキャンすれば出る)。
 * SKY の局の番組表を取り込むかは、この観測の報告を見てから決める (docs/tuner-it930x.md)。
 * CATV の局ごとの CA_system_id は、これとは別にチャンネルの控えに入れる (`channelEntry`)
 */
const observations = new Map<string, Observed>();

/** そのチャンネルについて最後のスキャンで分かったこと。スキャンしていなければ undefined */
export function observedOf(
  type: string,
  channel: string,
): Observed | undefined {
  return observations.get(`${type}:${channel}`);
}
/** 走っているスキャン。中断のために持っておく */
let running: Scanner | null = null;

function push(
  line?: string,
  counts: Omit<Progress, "line"> = {},
  fields: Partial<ScanState> = {},
): void {
  current = {
    ...current,
    ...fields,
    log:
      line === undefined
        ? current.log
        : [...current.log, line].slice(-LOG_LIMIT),
    scanned: current.scanned + (counts.scanned ?? 0) + (counts.skipped ?? 0),
    total: current.total + (counts.added ?? 0),
    channels: current.channels + (counts.channels ?? 0),
  };
  emit("scan");
}

interface Progress {
  line?: string;
  scanned?: number;
  channels?: number;
  skipped?: number;
  /** 回すチャンネルが増えた数 (TSMF で束ねた TS。`tsmfJobs`) */
  added?: number;
}

/** 総当たりの 1 件。どの種別のどの物理チャンネルか */
interface Job {
  type: ChannelType;
  channel: string;
}

/** チューナーの台数ぶん並べて総当たりする */
class Scanner {
  /** 中断の合図。押されたら選局を切り、残りのチャンネルには行かない */
  private readonly aborter = new AbortController();
  private readonly found = new Map<string, AgentChannel>();
  /** 電波が来た(TS が 1 バイトでも出た)チャンネル数。種別ごと */
  private readonly tuned = new Map<ChannelType, number>();
  /** 電波は来たのに局情報が揃わなかったチャンネル。1 周したあとで回し直す */
  private retry: Job[] = [];
  /** 放送の一覧を読めた衛星の種別。読めなかった種別は控えを書き換えない (`runScan`) */
  readonly lineups = new Set<SatelliteType>();
  /**
   * 局を探している間に流れてきた番組表。**ついでに取得しておく。** NIT と SDT を待つ
   * 数秒〜十数秒で「いま・次」と今日ぶんくらいは来るので、スキャンが終わった
   * 時点で番組表が空にならない。局が DB に入ってから書く (`runScan`)。
   * **読んだチャンネルの種別ごとに持つ。** CATV で読んだ番組は CATV の局にだけ書く (`epg.savePrograms`)
   */
  readonly events = new Map<ChannelType, EitEvent[]>();
  /** SKY と CATV の、局が見つかったチャンネルで分かったこと (`種別:チャンネル` → 中身)。保存できたら `observations` に移す */
  readonly observed = new Map<string, Observed>();

  constructor(private readonly onProgress: (progress: Progress) => void) {}

  /** 中断する (理由は外の `stop`) */
  stop(): void {
    this.aborter.abort();
  }

  get aborted(): boolean {
    return this.aborter.signal.aborted;
  }

  /**
   * targets は [種別, チャンネル一覧] の並び。見つかったチャンネル定義を返す。
   * 衛星 (BS・CS) は総当たりせず、放送の一覧を読む (`satellite`)。地上波・CATV・SKY の総当たりと同時に進む。
   * 同じ TS が 2 つの CATV のチャンネルで見つかったら、先のほうだけを返す (`dedupeCatv`)
   */
  async run(targets: [ChannelType, string[]][]): Promise<AgentChannel[]> {
    const tuners = (await getTuners().catch(() => [])).filter(
      (tuner) => !tuner.disabled,
    );
    const satellites = targets
      .map(([type]) => type)
      .filter(isSatellite)
      .map((type) => this.satellite(type, tuners));
    await Promise.all([
      this.ground(
        targets.filter(([type]) => !isSatellite(type)),
        tuners,
      ),
      ...satellites,
    ]);

    const sorted = [...this.found.entries()]
      .sort(([a], [b]) => {
        const at = (key: string) => key.indexOf(":");
        const typeA = a.slice(0, at(a));
        const typeB = b.slice(0, at(b));
        return (
          typeRank(typeA) - typeRank(typeB) ||
          a.slice(at(a) + 1).localeCompare(b.slice(at(b) + 1), "en", {
            numeric: true,
          })
        );
      })
      .map(([, entry]) => entry);
    const { kept, dropped } = dedupeCatv(sorted);
    for (const { entry, kept: first } of dropped)
      this.onProgress({
        line: `${entry.channel}: ${first} と同じ TS のため、スキャンの結果に入れませんでした`,
      });
    return kept;
  }

  /** 流れてきた番組表を、読んだチャンネルの種別ごとに取っておく (`events`) */
  private keep(type: ChannelType, epg: EpgReader): void {
    const list = this.events.get(type) ?? [];
    list.push(...epg.all());
    this.events.set(type, list);
  }

  /**
   * **衛星の一覧を放送の NIT から作る** (`satellite.readLineup`)。読めなかったら控えはそのまま (`lineups` に入れない)。
   * 進み具合は 1 種別で 1 つと数える
   */
  private async satellite(
    type: SatelliteType,
    tuners: AgentTuner[],
  ): Promise<void> {
    if (!tuners.some((tuner) => tuner.types.includes(type))) {
      this.onProgress({
        line: `${type}: 対応するチューナーがありません`,
        skipped: 1,
      });
      return;
    }
    const current = await getChannels().catch(() => []);
    const known = knownNames(current);
    const lineup = await readLineup(
      type,
      (channel) => this.openWaiting(type, channel),
      {
        timeout: TUNE_TIMEOUT,
        abort: this.aborter.signal,
        known,
        // CS で読めなかったネットワークは今のチャンネルを残す (欠けた一覧で置き換えない)
        previous: current,
        onEvents: (epg) => this.keep(type, epg),
      },
    );
    for (const line of lineup.log) this.onProgress({ line });
    if (this.aborted) return;
    if (lineup.channels.length === 0) {
      this.onProgress({
        line: `${type}: 放送の一覧を読めませんでした。今のチャンネルをそのまま使います`,
        scanned: 1,
      });
      return;
    }
    for (const entry of lineup.channels)
      this.found.set(`${type}:${entry.channel}`, entry);
    this.lineups.add(type);
    const services = lineup.channels.reduce(
      (sum, entry) => sum + entry.services.length,
      0,
    );
    this.onProgress({
      line: `${type}: 放送の一覧から ${lineup.channels.length} チャンネル・${services} 局を入れました`,
      scanned: 1,
      channels: lineup.channels.length,
    });
  }

  /** 開く。**チューナーが塞がっていれば空くまで待つ** (地上波の総当たりと同じ。録画が終われば空く) */
  private async openWaiting(
    type: SatelliteType,
    channel: string,
  ): Promise<ReadableStream<Uint8Array>> {
    for (;;) {
      try {
        return await openChannelStream(
          type,
          channel,
          this.aborter.signal,
          `scan ${channel}`,
          config.priority.scan,
        );
      } catch (error) {
        if (!(error instanceof TunerBusyError) || this.aborted) throw error;
        this.onProgress({ line: `${channel}: 空きを待っています` });
        await Bun.sleep(BUSY_RETRY);
      }
    }
  }

  /** 地上波・CATV・SKY の総当たり。チューナーの台数ぶん並べる */
  private async ground(
    targets: [ChannelType, string[]][],
    tuners: AgentTuner[],
  ): Promise<void> {
    const queue: Job[] = [];
    for (const [type, channels] of targets) {
      if (!tuners.some((tuner) => tuner.types.includes(type))) {
        this.onProgress({
          line: `${type}: 対応するチューナーがありません`,
          skipped: channels.length,
        });
        continue;
      }
      for (const channel of channels) queue.push({ type, channel });
    }

    /** そのチューナーで引けるものが 1 つでもあるチューナーだけ動かす */
    const wanted = new Set(queue.map((job) => job.type));
    const workers = tuners.filter((tuner) =>
      tuner.types.some((type) => wanted.has(type)),
    );

    if (workers.length > 0) {
      await Promise.all(workers.map((tuner) => this.work(tuner.types, queue)));

      /*
       * 電波は来たのに揃わなかったチャンネルは、もう一度だけ回す。
       *
       * NIT は 10 秒に 1 回しか流れてこないので、選局が落ち着くのが遅れると
       * 待ち時間の中に 1 回も入らないことがある。**受信できたチャンネルだけ**を
       * 対象にするので、総当たりの時間はほとんど増えない
       */
      const retry = this.retry;
      this.retry = [];
      if (retry.length > 0 && !this.aborted) {
        this.onProgress({ line: `${retry.length}ch をもう一度試します` });
        await Promise.all(
          workers.map((tuner) => this.work(tuner.types, retry, false)),
        );
      }
    }

    /*
     * 種別ごとに 1 行でまとめる。
     *
     * 「電波は来たのに局情報が揃わなかった」のか「そもそも何も来なかった」のかで
     * 疑うところがまるで違う (前者は受信環境、後者は配線やデバイス指定)。
     * 総当たりのログは何十行も流れるので、最後に要約が無いと読み取れない
     */
    for (const [type, channels] of targets) {
      const found = [...this.found.keys()].filter((key) =>
        key.startsWith(`${type}:`),
      ).length;
      const tuned = this.tuned.get(type) ?? 0;
      this.onProgress({
        line: `${type}: ${channels.length}ch 中 ${tuned}ch で受信、うち ${found}ch で局情報が揃いました`,
      });
    }
  }

  /** そのチューナーで引ける先頭の 1 件を取り出す。引けないものは飛ばして次を見る */
  private take(queue: Job[], types: ChannelType[]): Job | undefined {
    const at = queue.findIndex((job) => types.includes(job.type));
    return at === -1 ? undefined : queue.splice(at, 1)[0];
  }

  /**
   * チューナー 1 台ぶんの担当。列が尽きるまで引き続ける。
   *
   * `types` はそのチューナーが受けられる種別。地上波のチューナーは地上波の分だけ、衛星のチューナーは
   * 衛星の分だけを引くので、片方が先に終わってももう片方は止まらない。
   *
   * first が false のときは数え直さない (同じチャンネルを 2 回数えないため)
   */
  private async work(
    types: ChannelType[],
    queue: Job[],
    first = true,
  ): Promise<void> {
    for (;;) {
      if (this.aborted) return;
      const job = this.take(queue, types);
      if (job === undefined) return;
      const { type, channel } = job;

      /*
       * 1 チャンネルごとに切る手段を持つ。読み終えたらここで接続を落とし、
       * エージェントにチューナーを返す
       */
      const closer = new AbortController();
      let stream: ReadableStream<Uint8Array>;
      let transport: Transport = "ts";
      try {
        const opened = await openChannel(
          type,
          channel,
          closer.signal,
          `scan ${channel}`,
          config.priority.scan,
        );
        stream = opened.stream;
        transport = opened.transport;
        /*
         * TSMF で束ねた搬送波なら、2 つ目からの TS も回す (`tsmfJobs`)。束ねた数は選局してから分かるので、
         * そのつど列の先頭に足して進み具合の分母も増やす。先頭に足すのは、列が尽きて止まったチューナーには渡らないため
         * (ほかのチューナーがまだ動いているうちに引かせる)。回し直し (`first` が false) では足さない
         */
        const extra =
          type === "CATV" && first ? tsmfJobs(channel, opened.tsmfStreams) : [];
        if (extra.length > 0) {
          queue.unshift(...extra.map((name) => ({ type, channel: name })));
          this.onProgress({
            line: `${channel}: TSMF で ${opened.tsmfStreams} つの TS を束ねています`,
            added: extra.length,
          });
        }
      } catch (error) {
        /*
         * チューナーが全部塞がっている。**飛ばさずに待つ。**
         * 録画中のチューナーは取り上げられないので、ここで諦めるとその
         * チャンネルだけ設定から消える
         */
        if (error instanceof TunerBusyError) {
          this.onProgress({ line: `${channel}: 空きを待っています` });
          queue.unshift(job);
          await Bun.sleep(BUSY_RETRY);
          continue;
        }
        const counts = first ? { scanned: 1 } : {};
        this.onProgress({ line: `${channel}: ${error}`, ...counts });
        continue;
      }

      // TSMF から選んだ TS が分割 TLV (4K の放送) なら、TLV の表で局を読む
      if (transport === "tlv") {
        await this.tlv(job, stream, closer, first);
        if (this.aborted) return;
        continue;
      }

      /*
       * SKY は番組表を取得しない (復号できない。番組表とライブに出さないので要らない)。
       * SKY と CATV は、カード無しで分かること (CA_system_id・番組表が来ているか) を数えて記録に出す (`ca-observe.ts`)。
       * CATV は局ごとの CA_system_id をチャンネルの控えにも入れ、復号できるかを決める (`types.decodableService`)
       */
      const cable = type === "CATV";
      const epg = type === "SKY" ? undefined : new EpgReader();
      const observer = type === "SKY" || cable ? new CaObserver() : undefined;
      const { services, error, signal } = await readServices(
        stream,
        TUNE_TIMEOUT,
        this.aborter.signal,
        epg,
        observer,
        cable,
      );
      closer.abort();
      if (this.aborted) return;
      const counts = first ? { scanned: 1 } : {};
      if (first && signal)
        this.tuned.set(type, (this.tuned.get(type) ?? 0) + 1);
      // 電波が来たチャンネルは、局が揃わなくても分かったことを出す
      const observed = signal ? observer?.result() : undefined;
      const note = observed === undefined ? "" : `  ${describe(observed)}`;

      /*
       * CATV は、SDT が来ない TS と PAT に局が 1 つも無い TS (データだけの TS) を「局なし」として入れない。
       * 電波が来ていても回し直さない (SDT は 2 秒に 1 回は来るので、30 秒待って来なければ局の無い TS)
       */
      if (cable && (error !== null || services?.length === 0)) {
        const why = error === null ? "" : ` (${error})`;
        this.onProgress({
          line: `${channel}: 局なし${why}${note}`,
          ...counts,
        });
        continue;
      }
      if (error !== null) {
        // 電波は来ているのに揃わなかったものだけ、あとでもう一度回す
        if (first && signal) this.retry.push(job);
        this.onProgress({ line: `${channel}: ${error}${note}`, ...counts });
        continue;
      }
      if (observed !== undefined)
        this.observed.set(`${type}:${channel}`, observed);
      if (services === null || services.length === 0) {
        this.onProgress({
          line: `${channel}: 録画できる局がありません${note}`,
          ...counts,
        });
        continue;
      }

      const entry = channelEntry(
        type,
        channel,
        services,
        cable && observer !== undefined
          ? (serviceId) => observer.caSystemIdsOf(serviceId)
          : undefined,
      );
      this.found.set(`${type}:${channel}`, entry);
      if (epg !== undefined) this.keep(type, epg);
      this.onProgress({
        line: `${channel}: ${services.length} 局${note}`,
        ...counts,
        channels: 1,
      });
    }
  }

  /**
   * TLV (4K の放送) のチャンネルを読む。局は MH-SDT[actual] から、局ごとの CA_system_id は MPT から (`readTlvServices`)。
   * 揃わなければ CATV の TS と同じく「局なし」として入れず、回し直さない。番組表はまだ取得しない
   */
  private async tlv(
    job: Job,
    stream: ReadableStream<Uint8Array>,
    closer: AbortController,
    first: boolean,
  ): Promise<void> {
    const { type, channel } = job;
    const result = await readTlvServices(
      stream,
      TUNE_TIMEOUT,
      this.aborter.signal,
    );
    closer.abort();
    if (this.aborted) return;
    const counts = first ? { scanned: 1 } : {};
    if (first && result.signal)
      this.tuned.set(type, (this.tuned.get(type) ?? 0) + 1);
    const services = result.services ?? [];
    if (result.error !== null || services.length === 0) {
      const why = result.error === null ? "" : ` (${result.error})`;
      this.onProgress({
        line: `${channel}: 局なし${why}  4K (MMT/TLV)`,
        ...counts,
      });
      return;
    }
    this.found.set(
      `${type}:${channel}`,
      channelEntry(type, channel, services, result.caSystemIdsOf, "tlv"),
    );
    this.onProgress({
      line: `${channel}: ${services.length} 局  ${describeTlv(services, result.accessOf)}`,
      ...counts,
      channels: 1,
    });
  }
}

interface ScanOptions {
  types: ScanKind[];
}

async function runScan(targets: [ChannelType, string[]][]): Promise<void> {
  const scanner = new Scanner((progress) => push(progress.line, progress));
  running = scanner;
  try {
    push("チャンネルを探しています...", {}, { phase: "スキャン中" });
    const found = await scanner.run(targets);

    /*
     * 中断されたら**何も書かない**。
     * 途中までの結果で上書きすると、まだ回っていない種別やチャンネルの
     * 定義が消える。押した人は「やめたい」だけで「消したい」ではない
     */
    if (scanner.aborted) {
      push(
        "中断しました",
        {},
        { state: "canceled", phase: "中断", finishedAt: Date.now() },
      );
      return;
    }

    // 1 件も見つからないまま上書きすると、今まで録れていた局まで消える
    if (found.length === 0) {
      throw new Error(
        "チャンネルが 1 件も見つかりませんでした。チューナーとアンテナを確認してください",
      );
    }

    push("チャンネルを保存しています...", {}, { phase: "保存" });
    // 放送の一覧を読めなかった衛星の種別は置き換えない (今のチャンネルを消さない)
    await putChannels(
      found,
      targets
        .map(([type]) => type)
        .filter((type) => !isSatellite(type) || scanner.lineups.has(type)),
    );
    // 回した種別のぶんだけ、分かったことを入れ替える (チャンネルと同じく、回していない種別は残す)
    for (const [type] of targets) {
      for (const key of [...observations.keys()])
        if (key.startsWith(`${type}:`)) observations.delete(key);
    }
    for (const [key, observed] of scanner.observed)
      observations.set(key, observed);
    push(
      "完了しました",
      {},
      { state: "done", phase: "完了", finishedAt: Date.now() },
    );

    /*
     * 局が入れ替わった。**取り込み直して、番組表を集め直す。**
     *
     * 番組表を持っているのは denpa なので、**待つ相手がいない**。
     * 見つかった局をその場で取り込んで、そのまま集めに行く
     */
    await sync().catch(() => undefined);
    // 局が入ったので、スキャン中に取得した番組表を書ける
    // ついでの保存なので、失敗しても局の通知と番組表の取得は止めない
    if (scanner.events.size > 0) {
      try {
        let saved = 0;
        for (const [type, events] of scanner.events)
          saved += savePrograms(events, { type });
        if (saved > 0) {
          settle();
          // 立った予約の取り合いを裁き直す (`settle` は裁かない。ほかの呼び手と同じ)
          await resolveConflicts();
        }
      } catch (error) {
        console.warn(
          `[scan] スキャン中に取得した番組表を書けませんでした: ${error}`,
        );
      }
    }
    emit("services");
    void collectOnce().catch(() => undefined);
  } catch (error) {
    push(
      `失敗しました: ${error}`,
      {},
      { state: "failed", error: String(error), finishedAt: Date.now() },
    );
  } finally {
    running = null;
  }
}

/**
 * 選んだ種別から、回すチャンネルを決める。知らない種別と重複は除く。
 * パススルー (`PASSTHROUGH`) は UHF も回すので、地上波と両方来ても UHF を 2 回回さない。
 * CATV は QC・QU・QV を (`catvChannels`)、SKY は H01〜H105 を総当たりする。
 * 衛星は総当たりしないので、チャンネルの一覧は持たない。進み具合では 1 つと数える
 * (放送の一覧を 1 回読む。CS はネットワークが 2 つなので 2 回選局するが、数は 1 のまま)
 */
export function scanTargets(
  chosen: readonly ScanKind[],
): [ChannelType, string[]][] {
  const types = new Set(chosen.filter((kind) => SCAN_KINDS.includes(kind)));
  if (types.has("PASSTHROUGH")) types.delete("GR");
  return [...types].map((type) =>
    type === "GR" || type === "PASSTHROUGH"
      ? ["GR", channelsFor(type)]
      : type === "CATV"
        ? ["CATV", catvChannels()]
        : type === "SKY"
          ? ["SKY", skyChannels()]
          : [type, [type]],
  );
}

export function start(options: ScanOptions): {
  started: boolean;
  message: string;
} {
  const targets = scanTargets(options.types);
  if (targets.length === 0)
    return { started: false, message: "チャンネル種別の指定が不正です" };
  if (current.state === "running")
    return { started: false, message: "すでに実行中です" };

  current = {
    ...IDLE,
    state: "running",
    phase: "準備中",
    total: targets.reduce((sum, [, channels]) => sum + channels.length, 0),
    startedAt: Date.now(),
  };
  emit("scan");
  void runScan(targets);
  return { started: true, message: "チャンネルスキャンを始めました" };
}

/**
 * 走っているスキャンを中断する。
 *
 * 地上波の総当たりは十数分かかる。始めてから「いま録りたい」に気づいたときに、
 * 待つしかないのは困る。中断しても設定は書き換えない (途中までの結果で
 * 上書きすると、まだ回っていない局の定義が消える)。
 */
export function stop(): { stopped: boolean; message: string } {
  if (current.state !== "running" || running === null) {
    return { stopped: false, message: "実行中ではありません" };
  }
  running.stop();
  push("中断しています...", {}, { phase: "中断中" });
  return { stopped: true, message: "チャンネルスキャンを中断しています" };
}

/**
 * 1 つの種別のチャンネルと局を消す。設定の「チャンネル」の「削除を確定」から。
 *
 * **局がある種別なら、チューナーの有無によらず消せる** (種別ごとの例外は作らない)。スキャンは 1 件も見つからない結果を書かない
 * (アンテナを抜いたまま回して全部消えるのを防ぐ) ので、チューナーが挿さったまま回線だけが無くなったとき (引っ越しでケーブルが無くなったなど) は、
 * スキャンし直しても消えないため。スキャンの実行中だけ断る。
 * 局の行は消さず、取り込み直したときに見かけなかった局として画面から外れる (録画は残る。`currentServices`)。スキャンし直せば戻る
 */
export async function removeType(
  type: ChannelType,
): Promise<{ removed: boolean; message: string }> {
  if (current.state === "running")
    return { removed: false, message: "スキャンの実行中は削除できません" };
  await deleteChannels(type);
  for (const key of [...observations.keys()])
    if (key.startsWith(`${type}:`)) observations.delete(key);
  await sync().catch(() => undefined);
  emit("services");
  return { removed: true, message: "局を削除しました" };
}

/** いまの状況。走らせているのは denpa 自身なので、denpa を入れ替えれば `idle` に戻る */
export function scanState(): ScanState {
  return current;
}
