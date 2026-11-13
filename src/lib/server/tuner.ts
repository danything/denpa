/**
 * チューナーエージェントを呼ぶところ。
 *
 * **相手が返すのは素の TS だけ**で、局も番組も時刻も、意味を持つものは何も
 * 返ってこない。読むのは denpa の仕事 ([agent.md](../../../docs/agent.md))。
 *
 * **使い方は 1 つだけ。** 物理チャンネルを丸ごと開く。局を選り分けるのは
 * `packages/arib/src/service-filter.ts`、番組の切れ目を見るのは `packages/arib/src/eit.ts`。
 */

import {
  array,
  boolean,
  type Infer,
  literal,
  nullable,
  number,
  object,
  optional,
  type Shape,
  string,
  tolerate,
} from "../shape";
import {
  ALL_CHANNEL_TYPES,
  type ChannelType,
  decodableService,
  epgReadableService,
  type Transport,
} from "../types";
import { keyRanks, NO_KEY } from "./agent-cards";
import { NO_CHANNEL } from "./agent-channels";
import { fetchAgent } from "./agent-client";
import { orderGroups, type Place } from "./agent-order";
import { type Agent, listAgents, NO_AGENT } from "./agents";
import { config } from "./config";
import type { Busy } from "./conflict";
import { recordReceived } from "./reception";

/*
 * **エージェントが返すものの形式は、ここで確かめてから型にする** (`shape.ts`)。
 * 相手は別のプロセス (agent/。別のイメージで動くこともある) で、バージョンがずれれば形式もずれる。キャストで型を
 * 付けていた頃は、ずれても「どこかで undefined」としてしか出なかった。
 *
 * **違っていても止めない** (`tolerate`)。バージョンがずれただけで録画が止まるのでは
 * 困るので、警告を出して来たものをそのまま使う。直すのは人
 */
const CHANNEL_TYPE: Shape<ChannelType> = literal(
  "GR",
  "BS",
  "CS",
  "CATV",
  "SKY",
);

/** エージェントが持っているチャンネル。スキャンの結果そのもの */
const AGENT_CHANNEL = object({
  type: CHANNEL_TYPE,
  channel: string,
  networkId: number,
  transportStreamId: number,
  remoteControlKeyId: nullable(number),
  /**
   * 伝送の形式。スキャンが選局の答えの Content-Type から書く (`openChannel`)。`tlv` (4K の放送) のときだけ書き、無ければ TS。
   * エージェントは値を解釈せず、そのまま返す
   */
  transport: optional(literal("ts", "tlv")),
  services: array(
    object({
      serviceId: number,
      serviceType: number,
      name: string,
      /**
       * PMT の CA 記述子にあった CA_system_id (`ca-observe.ts`)。TLV なら MPT のアクセス制御記述子のもの (`TlvServiceReader`)。
       * スキャンで PMT か MPT を読む CATV の局だけが持つ。CA 記述子が無ければ空。復号できるかはこれで決める (`types.decodableService`)
       */
      caSystemIds: optional(array(number)),
      /**
       * 番組表の表がスクランブルされずに来るか。スキャンが書く (TLV はいつも、SKY と CATV の TS は EIT を観測して)。
       * 無ければ読めない。復号できる局はこれによらず読める (`types.epgReadableService`)
       */
      epgReadable: optional(boolean),
    }),
  ),
});
export type AgentChannel = Infer<typeof AGENT_CHANNEL>;

/**
 * 控えの局が復号できるか (`types.decodableService`) と、番組表を読めるか (`types.epgReadableService`)。
 * 局の行の `services.decodable`・`services.epg_readable` にはこれを入れる (`epg.syncServices`)
 */
export function serviceAbilities(
  channel: AgentChannel,
  service: AgentChannel["services"][number],
): { decodable: boolean; epgReadable: boolean } {
  const decodable = decodableService(
    channel.type,
    channel.transport ?? "ts",
    service.caSystemIds ?? [],
  );
  return {
    decodable,
    epgReadable: epgReadableService(decodable, service.epgReadable === true),
  };
}

/**
 * 番組表を読める局が 1 つでも入っているチャンネルか。**番組表の取得に行くかは、チャンネルごとにこれで見る。**
 * 局ごとの判断は局の行の `services.epg_readable` (`epg.syncServices`)
 */
export function epgReadableChannel(channel: AgentChannel): boolean {
  return channel.services.some(
    (service) => serviceAbilities(channel, service).epgReadable,
  );
}

const SIGNAL = object({
  locked: boolean,
  cn: nullable(number),
  unit: literal("dB", "raw"),
  atTune: boolean,
  /** 電波の強度 (dBm)。dBm で測れる機材だけ。古いエージェントは返さない (無ければ出さない) */
  strengthDbm: optional(number),
});
export type TunerSignal = Infer<typeof SIGNAL>;

const AGENT_TUNER = object({
  index: number,
  name: string,
  types: array(CHANNEL_TYPE),
  /**
   * 機材が受けられる種別 (エージェントが自動検出で見つけたもの)。見つけていない機材 (null) と古いエージェント (返さない) は無い。
   * 設定の「受信できる種別」はこれに無いものを選ばせず、保存でも断る (`unreceivable`)
   */
  receivable: optional(array(CHANNEL_TYPE)),
  disabled: boolean,
  /**
   * エージェントが選ぶ順。小さいほど先に使う。無効なチューナーは null。予約の割り振りはこの順どおりに
   * 使われる前提で数える (`conflict.ts`、docs/agent.md「選ぶ順の約束」)
   */
  rank: nullable(number),
  /** 選局に使うデバイス。エージェントはこれを直に開く */
  device: nullable(string),
  /** ストリームのリクエストで名指しするときの目印 (`tuner`。デバッグ用) */
  pin: string,
  /** 衛星の給電。要る構成だけ */
  lnb: nullable(string),
  /** いま使っているチャンネル。空いていれば null */
  channel: nullable(object({ type: CHANNEL_TYPE, channel: string })),
  users: array(object({ use: string, priority: number })),
  error: nullable(string),
  /**
   * 受信の状態と C/N と強度。使用中で、機材が測れるときだけ (エージェントが 5 秒ごとに読む)。
   * `unit` が `raw` なら dB ではなく、DVB のドライバが返した相対値のまま (同じチューナーで比べる目安)。
   * `atTune` は選局したときに確かめた値で、受信中は読み直さない (asicend。同期したかだけで、`cn` は null)。docs/tuners.md「信号レベル」
   */
  signal: nullable(SIGNAL),
});
/** エージェントが返したチューナーに、どのエージェントのものか (`agent`。`agents` の行の ID) を付けたもの */
export type AgentTuner = Infer<typeof AGENT_TUNER> & { agent: number };

const TUNERS = object({
  tuners: array(AGENT_TUNER),
  detected: boolean,
});

/** 1 台のエージェントの一覧と、定義を書いていないので自分で見つけた状態か */
export interface TunerList {
  tuners: AgentTuner[];
  detected: boolean;
}

/** 画面から書き換えられる部分だけ */
export interface TunerConfig {
  name: string;
  types: ChannelType[];
  device: string | null;
  lnb: string | null;
  disabled: boolean;
}

/**
 * CATV の局の ID に足すオフセット (`serviceKey`)。アンテナで受けた局と分ける。network_id は 16 ビットなので、足すと重ならない
 */
const CATV_NETWORK_OFFSET = 0x10000;

/**
 * 局の内部 ID。`networkId * 100000 + serviceId`。**CATV の局は `(0x10000 + networkId) * 100000 + serviceId`。**
 *
 * CATV は地上波・BS を再送信していて、同じ original_network_id と service_id の局が
 * アンテナでも受けられる。同じ ID にすると、片方の番組表やロゴがもう片方に入る。
 *
 * 録画も予約も `services.id` を参照しているので、ここを変えると
 * 過去の録画が辿れなくなる (docs/data.md)。
 */
export function serviceKey(
  networkId: number,
  serviceId: number,
  type: string,
): number {
  return (
    (type === "CATV" ? CATV_NETWORK_OFFSET + networkId : networkId) * 100000 +
    serviceId
  );
}

/** 番組の ID。局の内部 ID + event_id */
export function programKey(
  networkId: number,
  serviceId: number,
  eventId: number,
  type: string,
): number {
  return serviceKey(networkId, serviceId, type) * 100000 + eventId;
}

async function get<T>(
  agent: Agent,
  path: string,
  shape: Shape<T>,
  /** 答えを待つ上限 (ms) */
  wait = 10_000,
): Promise<T> {
  const res = await fetchAgent(agent, path, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(wait),
  });
  if (!res.ok) {
    throw new Error(
      `エージェント ${path} -> ${res.status} ${await res.text()}`,
    );
  }
  return tolerate(shape, await res.json(), `エージェントの ${path}`);
}

/** 書き換えを預ける。控えを書くのを待つので、読むより長く待つ */
function put(agent: Agent, path: string, body: unknown): Promise<Response> {
  return fetchAgent(agent, path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

/** エージェントの控えのチャンネル */
export async function getChannels(agent: Agent): Promise<AgentChannel[]> {
  return get(agent, "/denpa/channels", array(AGENT_CHANNEL));
}

/**
 * チャンネルスキャンの結果を預ける。
 *
 * **見つけたのは denpa** (総当たりの選局はエージェントに任せるが、NIT と SDT を
 * 読むのはこちら)。それでも控えはエージェントが持つ。
 * アンテナに何が映るかは機材ごとに違い、エージェントを増やせば顔ぶれも変わるため。
 *
 * `scanned` には**探した種別**を渡す。地上波だけ探したときに全部を置き換えると
 * BS と CS が設定から消える。
 */
export async function putChannels(
  found: AgentChannel[],
  scanned: ChannelType[],
  agent: Agent,
): Promise<AgentChannel[]> {
  const res = await put(agent, "/denpa/channels", {
    channels: found,
    scanned,
  });
  if (!res.ok)
    throw new Error(
      `チャンネルを保存できません (${res.status}) ${await res.text()}`,
    );
  return tolerate(
    array(AGENT_CHANNEL),
    await res.json(),
    "エージェントの PUT /denpa/channels",
  );
}

/**
 * 1 つの種別のチャンネルを全部消す (エージェントの `DELETE /denpa/channels?type=…`)。
 * 設定の「チャンネル」の「局を削除」から呼ぶ (`scan.ts` の `removeType`。種別もチューナーの有無も問わない)
 */
export async function deleteChannels(
  type: ChannelType,
  agent: Agent,
): Promise<AgentChannel[]> {
  const res = await fetchAgent(
    agent,
    `/denpa/channels?type=${encodeURIComponent(type)}`,
    { method: "DELETE", signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok)
    throw new Error(
      `チャンネルを消せません (${res.status}) ${await res.text()}`,
    );
  return tolerate(
    array(AGENT_CHANNEL),
    await res.json(),
    "エージェントの DELETE /denpa/channels",
  );
}

/**
 * 1 台のエージェントの一覧と、定義を書いていないので自分で見つけた状態か (`detected`。設定の「チューナー」に出す) を 1 度に
 */
export async function tunerList(
  agent: Agent,
  /** 答えを待つ上限 (ms) */
  wait?: number,
): Promise<TunerList> {
  const got = await get(agent, "/denpa/tuners", TUNERS, wait);
  const tuners = got.tuners.map((tuner) => ({ ...tuner, agent: agent.id }));
  lastLists.set(agent.id, tuners);
  return { tuners, detected: got.detected };
}

/**
 * 1 台のエージェント (`agents.id`) のチューナー。チューナーの `index` はエージェントごとの番号なので、エージェントで絞ってから引く。
 * ほかのエージェントには訊かない (遅いエージェントや落ちたエージェントを待たない)。もう無いエージェントなら空
 */
export async function tunersOf(
  id: number,
  /** 答えを待つ上限 (ms) */
  wait?: number,
): Promise<AgentTuner[]> {
  const agent = listAgents().find((a) => a.id === id);
  if (agent === undefined) return [];
  const askedAt = Date.now();
  const { tuners } = await tunerList(agent, wait);
  settlePending(agent.id, askedAt);
  return tuners;
}

/**
 * **エージェントごとの、最後に返した一覧** (`agents.id` →)。メモリだけに持つ (DB には写さない)。
 * 予約の割り振りは、落ちているエージェントをこれで数える (`tunerSnapshot`)
 */
const lastLists = new Map<number, AgentTuner[]>();

/** 1 台のエージェントに一覧を訊いた結果。返さなければ `tuners` が null */
interface Asked {
  agent: Agent;
  tuners: AgentTuner[] | null;
  error: unknown;
}

/**
 * 全部のエージェントに一覧を訊く (並びの順)。返したものは、それまでに出した選局の数え (`pending`) を片付ける。
 * エージェントが 1 台も無ければ `NO_AGENT` を送出する
 */
async function askAll(wait?: number): Promise<Asked[]> {
  const all = listAgents();
  if (all.length === 0) throw new Error(NO_AGENT);
  return Promise.all(
    all.map(async (agent): Promise<Asked> => {
      const askedAt = Date.now();
      try {
        const { tuners } = await tunerList(agent, wait);
        settlePending(agent.id, askedAt);
        return { agent, tuners, error: null };
      } catch (error) {
        return { agent, tuners: null, error };
      }
    }),
  );
}

/**
 * 全部のエージェントのチューナーを、エージェントの並びの順につなげたもの。**返さなかったエージェントのものは入れない。**
 * どのエージェントも返さなければ reject する (エージェントが 1 台のときは、今までどおりそのエージェントの失敗)
 */
export async function getTuners(): Promise<AgentTuner[]> {
  const asked = await askAll();
  if (asked.every((a) => a.tuners === null)) throw asked[0]!.error;
  return asked.flatMap((a) => a.tuners ?? []);
}

/**
 * **予約の割り振りで数える一覧** (`scheduler.tunerState`)。返さなかったエージェントは、最後に返した一覧で数える。
 * 落ちている間に予約表が全部「競合」に変わって通知が出るのを避けるため。
 * どのエージェントも返さないか、起動してから一度も返していないエージェントがあれば null (台数不明として、何も競合にしない)
 */
export async function tunerSnapshot(): Promise<AgentTuner[] | null> {
  let asked: Asked[];
  try {
    asked = await askAll();
  } catch {
    return null;
  }
  if (asked.every((a) => a.tuners === null)) return null;
  const out: AgentTuner[] = [];
  for (const a of asked) {
    const tuners = a.tuners ?? lastLists.get(a.agent.id);
    if (tuners === undefined) return null;
    out.push(...tuners);
  }
  return out;
}

/**
 * 機材の定義を書き換える。
 *
 * **選局コマンドは無い。** エージェントがデバイスと種別から選局する
 * (渡せると、denpa に入れた人が privileged なチューナー側で好きなコマンドを走らせられる)。
 *
 * **空を渡すと定義そのものが消える** = 自動検出に戻す。
 */
export async function putTuners(
  tuners: TunerConfig[],
  agent: Agent,
): Promise<void> {
  const res = await put(agent, "/denpa/tuners", { tuners });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error =
      typeof body === "object" && body !== null && "error" in body
        ? body.error
        : undefined;
    throw new Error(
      typeof error === "string"
        ? error
        : `チューナーを保存できません (${res.status})`,
    );
  }
}

/**
 * 何のために開いたかを伝える印。設定の「チューナー」にそのまま出る。
 *
 * **ASCII だけ**にしてある。番組名は入れず録画 ID だけ渡して、読める言葉に直すのは
 * 画面側 (routes/settings/reception/tuners.server.ts)。
 *
 * **先頭の語はエージェントも読む。** `epg` `logo` `scan` は掛かっていない SI しか読まないので、それだけの選局は
 * カードに聞かずに流す (docs/agent.md「選局コマンドは画面から渡させない」)。復号の要る使い方を足すなら別の語にする
 */
export type StreamUse =
  | `rec ${number}`
  | `logo ${string}`
  | `epg ${string}`
  | `scan ${string}`
  | `live ${string}`;

/** 録画の利用者の名乗り。読むほう (`recordingOf`) と対にしておく */
export function recordingUse(id: number): StreamUse {
  return `rec ${id}`;
}

/**
 * 録画の利用者 (`recordingUse`) なら、その録画 ID。**どの録画がどのチューナーにいるか**を
 * エージェントの一覧から読む (`recordingHolds`) のと、設定の「チューナー」に録画の名前を出すのに使う
 */
export function recordingOf(use: string): number | null {
  const found = /^rec (\d+)$/.exec(use);
  return found === null ? null : Number(found[1]);
}

/**
 * **録画中の予約が、いまどのチューナーにいるか。** 割り振りのなぞり始めの状態になる。
 *
 * 録り始めた予約は割り振り直さない (候補に入れない) が、終わるまでチューナーを塞ぐ。どのチューナーに
 * 入ったかはエージェントの一覧に出るので、一覧の利用者 (`users`) の `rec <録画ID>`
 * (`recordingUse`) から読む。利用者のいるチューナーは今まさに録っているチューナーなので、いる場所を取り違えることは無い。
 * ただし録り始めたのに、まだ使えていない (空き待ちで掛け直している) 録画は数えられない。
 *
 * 録画以外の利用者 (ライブ・番組表の取得など) は入れない。録画には譲る約束なので
 * (docs/agent.md「選ぶ順の約束」)、予約の割り振りには効かない。
 * 終わる時刻の分からない録画 (DB に無い) も入れない
 */
export function recordingHolds(
  tuners: readonly Pick<
    AgentTuner,
    "agent" | "disabled" | "rank" | "channel" | "users"
  >[],
  untilOf: (recordingId: number) => number | undefined,
): Busy[] {
  return tuners.flatMap((tuner) => {
    if (tuner.disabled || tuner.rank === null || tuner.channel === null)
      return [];
    const ends = tuner.users.flatMap((u) => {
      const id = recordingOf(u.use);
      const until = id === null ? undefined : untilOf(id);
      return until === undefined ? [] : [until];
    });
    if (ends.length === 0) return [];
    return [
      {
        agent: tuner.agent,
        type: tuner.channel.type,
        channel: tuner.channel.channel,
        rank: tuner.rank,
        until: Math.max(...ends),
      },
    ];
  });
}

/**
 * チューナーに空きが無い。**待って掛け直せば通る**ので、他の失敗と分ける。
 *
 * 総当たりのスキャンでここを区別できないと、録画中で塞がっていただけの
 * チャンネルを「受信できない」と判断して設定から落としてしまう。
 */
export class TunerBusyError extends Error {
  /** エージェントが返した理由 (本文の `error`)。読めなければ null */
  constructor(
    message: string,
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/**
 * **エージェントが「選局できない」と返した** (同期しない・デバイスが無いなど)。空き待ち (`TunerBusyError`) と、
 * エージェントに繋がらないのは別。受信できるかの記録 (`epg-collect.ts` → `reception.ts`) は、開けなかった回のうちこれだけを失敗に数える
 * (ほかに数えるのは、開けたのに上限まで待っても何も来なかった回)
 */
export class TuneError extends Error {
  constructor(
    message: string,
    /** エージェントが返した理由 (本文の `error`)。読めなければ null */
    readonly reason: string | null = null,
    /** 選局を送った所 (エージェントとそのチャンネル)。受信できなかった記録はこのエージェントに付ける */
    readonly place: Place | null = null,
  ) {
    super(message);
  }
}

/** エージェントの失敗の本文 (`{ "error": "…" }`) から理由を読む。形が違えば null */
function agentReason(detail: string): string | null {
  try {
    const body = JSON.parse(detail) as { error?: unknown } | null;
    return typeof body?.error === "string" && body.error !== ""
      ? body.error
      : null;
  } catch {
    return null;
  }
}

/**
 * 物理チャンネルを丸ごと開く。**使い方はこれ 1 つ。**
 *
 * 同じチャンネルを誰かが既に開いていれば、エージェントが選局を共有させる
 * (チューナーは増えない)。空きが無ければ 409 が返るので、呼んだ側は待って掛け直す。
 *
 * `after` の利用者は、もう離れたものとしてエージェントに選ばせる (引き継ぎ。録画を止めて
 * 同じ定期チェックで次を始めるとき。docs/agent.md「選ぶ順の約束」)
 */
export async function openChannelStream(
  type: string,
  /** 局を受けられる所 (`openChannel` の `places`) */
  places: readonly Place[],
  signal: AbortSignal,
  use: StreamUse,
  priority = config.priority.recording,
  after: readonly StreamUse[] = [],
  /** デバッグ用の名指し。このチューナーだけで選局し、ほかへ振り替えない (docs/agent.md「デバッグ用の名指し」) */
  pin: string | null = null,
  /**
   * 観る局 (放送の service_id)。1 局だけを観るとき (ライブ) に渡す。エージェントは選局の先頭で、この局の PMT と鍵がそろえば
   * ほかの局を待たずに流し始める (docs/agent.md「B25 の復号もカードリーダーも自前」)。TS をまるごと使う録画は渡さない
   */
  service: number | null = null,
  /** 答え (レスポンスヘッダ) を待つ上限 (ms)。`openChannel` の `answerWithin` */
  answerWithin: number | null = null,
  /** 復号して使う局 (`services.id`)。`openChannel` の `keyed` */
  keyed: number | null = null,
): Promise<ReadableStream<Uint8Array>> {
  return (
    await openChannel(
      type,
      places,
      signal,
      use,
      priority,
      after,
      pin,
      service,
      answerWithin,
      keyed,
    )
  ).stream;
}

/** 選局の答えのヘッダ。TSMF で束ねた TS の数 (無ければ TSMF ではない) */
const TSMF_STREAMS = "X-Denpa-Tsmf-Streams";

/**
 * `openChannelStream` と同じく開いて、**答えのヘッダから分かることも返す。** チャンネルスキャンが使う (`scan.ts`)。
 *
 * `tsmfStreams` は、選局した搬送波に TSMF (ARIB STD-B32。1 つの搬送波に複数の TS を束ねる) で束ねてある TS の数。
 * エージェントが `X-Denpa-Tsmf-Streams` で返す。返さなければ (TSMF でない・古いエージェント) 1
 *
 * `transport` は流れてくるバイト列の形式 (`streamTransport`)。TSMF から選んだ TS が分割 TLV なら `tlv`
 *
 * `answerWithin` (ms) を渡すと、その間にエージェントが答え (レスポンスヘッダ) を返さなければリクエストを打ち切り、
 * `TuneError` を送出する。エージェントは最初の TS を送るときにヘッダを返すので、答えが来ないのは TS が届いていないとき。
 * 答えが来たあとのストリームには効かない
 *
 * **どのエージェントに送るかはここで決める** (`route`)。`places` は局を受けられる所 (エージェントとそのチャンネル。
 * `agent-channels.servicePlaces`)。エージェントの中のどのチューナーかは、今までどおりエージェントが決める。
 * 送った所は `place` で返す
 *
 * `keyed` は、復号して使う局 (`services.id`)。録画とライブが渡す。渡すと、局を受けられるエージェントのうち、
 * その局を復号できる見込みのいちばん高いカードのエージェントに絞って振り分ける (`agent-cards.keyRanks`)。
 * 鍵の要らない番組表・ロゴ・スキャンは渡さない (カードの無いエージェントでも受けられる)
 */
export async function openChannel(
  type: string,
  places: readonly Place[],
  signal: AbortSignal,
  use: StreamUse,
  priority = config.priority.recording,
  after: readonly StreamUse[] = [],
  pin: string | null = null,
  service: number | null = null,
  answerWithin: number | null = null,
  keyed: number | null = null,
): Promise<{
  stream: ReadableStream<Uint8Array>;
  tsmfStreams: number;
  transport: Transport;
  place: Place;
}> {
  if (places.length === 0) throw new Error(NO_CHANNEL);
  // 送る所を決めると同時に手元の数えに足す (`claim`)。決めてから足すまでの間に、ほかの選局が同じ空きを数えない
  const sent = await claim({ type, places, priority, after, pin, keyed }, use);
  const place: Place = { agent: sent.agent, channel: sent.channel };
  const agent = listAgents().find((a) => a.id === place.agent);
  if (agent === undefined) {
    pending.delete(sent);
    throw new Error(NO_AGENT);
  }
  const query = new URLSearchParams({
    type,
    channel: place.channel,
    priority: String(priority),
    use,
  });
  // 引き継ぐ利用者は全部渡す。送った先にいなければ、エージェントはふつうに選ぶ (docs/agent.md「選ぶ順の約束」の 4)
  for (const leaving of after) query.append("after", leaving);
  if (pin !== null) query.set("tuner", splitPin(pin).pin);
  if (service !== null) query.set("service", String(service));
  const answer = new AbortController();
  const timer =
    answerWithin === null
      ? undefined
      : setTimeout(() => answer.abort(), answerWithin);
  let res: Response;
  try {
    res = await fetchAgent(agent, `/denpa/stream?${query}`, {
      signal:
        timer === undefined ? signal : AbortSignal.any([signal, answer.signal]),
    });
  } catch (error) {
    pending.delete(sent);
    if (answer.signal.aborted && !signal.aborted) {
      const reason = `エージェントから選局の答えが ${Math.round((answerWithin ?? 0) / 1000)} 秒返りませんでした`;
      throw new TuneError(`選局できません (${reason})`, reason, place);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok || res.body === null) {
    pending.delete(sent);
    const detail = await res.text().catch(() => "");
    const reason = agentReason(detail);
    if (res.status === 409)
      throw new TunerBusyError(
        `チューナーに空きがありません ${detail}`,
        reason,
      );
    throw new TuneError(
      `選局できません (${res.status}) ${detail}`,
      reason,
      place,
    );
  }
  sent.answeredAt = Date.now();
  recordTuned(agent.id, type, place.channel);
  return {
    stream: res.body,
    tsmfStreams: tsmfStreams(res.headers),
    transport: streamTransport(res.headers),
    place,
  };
}

/**
 * **denpa が送った選局のうち、エージェントの一覧にまだ出ていないかもしれないもの。** 振り分け (`route`) はこれを一覧に足して数える。
 * 一覧は訊いた時点のものなので、送ってから一覧に出るまでの間に次の選局を振り分けると、同じ空きを 2 本に数えてしまう。
 * 利用者は全部 denpa が出したものなので、手元で足せば足りる (同じ定期チェックで録画が 2 本始まるときも、同じ組を取り合わない)
 */
interface Pending {
  agent: number;
  type: string;
  channel: string;
  use: string;
  priority: number;
  after: readonly string[];
  /** エージェントが答えた時刻。答える前は null */
  answeredAt: number | null;
}

const pending = new Set<Pending>();

/** 答えてからこれより経った選局は、もう一覧に出ているものとして数えない (ms。一覧を訊かずにいる間に溜めない) */
const PENDING_KEEP = 60_000;

function addPending(entry: Pending): void {
  const old = Date.now() - PENDING_KEEP;
  for (const p of pending)
    if (p.answeredAt !== null && p.answeredAt < old) pending.delete(p);
  pending.add(entry);
}

/**
 * エージェント `agent` の一覧を `askedAt` に訊いて返ってきた。それより前に答えた選局は、その一覧に出ている
 * (エージェントは利用者を載せてから答える) か、もう終わっているので、手元の数えから外す
 */
function settlePending(agent: number, askedAt: number): void {
  for (const p of pending)
    if (p.agent === agent && p.answeredAt !== null && p.answeredAt <= askedAt)
      pending.delete(p);
}

/** 振り分けで一覧を訊くときに答えを待つ上限 (ms)。落ちたエージェントのせいで、ライブの選局を長く待たせない */
const ROUTE_ASK_WAIT = 3_000;

/**
 * 送る所を決めて、手元の数え (`pending`) に足す。**局を受けられるエージェントが 1 台だけなら一覧を訊かずにそこへ送る**
 * (エージェントが 1 台のときの動きは変わらない)。2 台以上なら全部のエージェントに一覧を訊き (復号して使う局ならカードも。`agent-cards.keyRanks`)、手元の数えを足して `route` で選ぶ。
 * 選ぶのと足すのは、間に await を挟まずに続けてやる (同時に振り分ける選局が、同じ空きを 2 本に数えない)
 */
async function claim(request: RouteRequest, use: string): Promise<Pending> {
  const agents = new Set(request.places.map((place) => place.agent));
  let place = request.places[0]!;
  if (agents.size > 1) {
    // 一覧とカードは同時に訊く (待つのは長いほうの 1 回)
    const [asked, keys] = await Promise.all([
      askAll(ROUTE_ASK_WAIT),
      request.keyed === null
        ? Promise.resolve(null)
        : keyRanks(request.keyed, [...agents], ROUTE_ASK_WAIT),
    ]);
    place = route(
      withPending(
        asked.map((a) => ({
          agent: a.agent.id,
          up: a.tuners !== null,
          tuners: a.tuners ?? lastLists.get(a.agent.id) ?? [],
        })),
        [...pending],
      ),
      request,
      keys,
    );
  }
  const sent: Pending = {
    agent: place.agent,
    type: request.type,
    channel: place.channel,
    use,
    priority: request.priority,
    after: request.after,
    answeredAt: null,
  };
  addPending(sent);
  return sent;
}

/** 振り分けに要るチューナーの中身 */
export type RoutedTuner = Pick<
  AgentTuner,
  "disabled" | "rank" | "types" | "channel" | "users" | "pin"
>;

/** 1 台のエージェントの一覧。`up` が false なら今は返さない (順を決めるのにだけ使う。最後に返した一覧か空) */
export interface RoutedList {
  agent: number;
  up: boolean;
  tuners: readonly RoutedTuner[];
}

/** 振り分ける選局 */
export interface RouteRequest {
  type: string;
  places: readonly Place[];
  priority: number;
  after: readonly string[];
  pin: string | null;
  /** 復号して使う局 (`services.id`)。鍵の要らない選局は null (`openChannel` の `keyed`) */
  keyed: number | null;
}

/** そのチューナーを使ってよいか。空いている (余韻だけ) か、引き継ぐ利用者と自分より優先度の低い利用者しかいない (約束の 2・4) */
function usable(
  tuner: RoutedTuner,
  priority: number,
  after: readonly string[],
): boolean {
  return (
    !tuner.disabled &&
    tuner.rank !== null &&
    tuner.users.every((u) => after.includes(u.use) || u.priority < priority)
  );
}

/**
 * **デバッグ用の名指しは `<エージェントの ID>:<pin>`** (設定の「その他」の「この端末」のライブのチューナー)。
 * エージェントごとに pin が重なりうるので、どのエージェントのチューナーかを前に付ける
 */
export function pinKey(tuner: Pick<AgentTuner, "agent" | "pin">): string {
  return `${tuner.agent}:${tuner.pin}`;
}

/** 名指しを、エージェントの ID と pin に分ける。前に ID が付いていなければ、どのエージェントでもよい */
function splitPin(named: string): { agent: number | null; pin: string } {
  const found = /^(\d+):(.+)$/s.exec(named);
  return found === null
    ? { agent: null, pin: named }
    : { agent: Number(found[1]), pin: found[2]! };
}

/**
 * **名指しのチューナーがもう無いか** (ライブで名指しの選局が断られたとき。画面を自動に戻すか決める)。
 * 名指しのエージェントがもう無ければ無い。一覧を取得できなければ無いとはみなさない (落ちているだけかもしれない)。
 * エージェントの ID が付いていない前の名指しは、全部のエージェントで探す (`splitPin` と同じ)
 */
export async function pinGone(named: string): Promise<boolean> {
  const { agent, pin } = splitPin(named);
  try {
    if (agent !== null)
      return !(await tunersOf(agent)).some((tuner) => tuner.pin === pin);
    const asked = await askAll();
    if (asked.some((a) => a.tuners === null)) return false;
    return !asked.some((a) => a.tuners!.some((tuner) => tuner.pin === pin));
  } catch {
    return false;
  }
}

/**
 * **送る所を選ぶ** (docs/architecture.md「全体」、docs/agent.md「エージェントが何台もあるとき」)。エージェントの約束 (docs/agent.md「選ぶ順の約束」) を、
 * 全部のエージェントをまとめた選ぶ順 (`agent-order.orderGroups`。予約の割り振りと同じ関数) に読み替える。
 *
 * 1. 局を受けられて、一覧を返したエージェントに絞る。名指し (`pin`) なら、そのチューナーのあるエージェントに送る (無ければ絞った所の先頭)。
 *    復号して使う局 (`keys` を渡したとき) なら、さらにその局を復号できる見込みのいちばん高いカードのエージェントに絞る
 *    (`agent-cards.cardRanks`。契約を確かめたカード、確かめていないカード、未契約のカード、カード無しの順)
 * 2. 同じチャンネルを、自分と同じか優先度の高い利用者が読んでいるエージェントがあれば、そこで共有する (約束の 3)
 * 3. 選ぶ順に組を見て、その種別を受けられ、使ってよいチューナー (`usable`) のある最初のエージェント (約束の 2)
 * 4. どこにも無ければ、1 で絞った所の先頭 (`places` の順) に送る (エージェントが 409 で断り、呼んだ側が空き待ちで掛け直す)
 *
 * 一覧を返したエージェントが 1 台も無ければ `places` の先頭 (エージェントに繋がらない失敗をそのまま返す)
 *
 * @param keys エージェントごとの、局を復号できる見込みの順 (`agent-cards.keyRanks`)。鍵の要らない選局は null
 */
export function route(
  lists: readonly RoutedList[],
  request: RouteRequest,
  keys: ReadonlyMap<number, number> | null = null,
): Place {
  const { type, priority, after, pin } = request;
  const listOf = new Map(lists.map((list) => [list.agent, list]));
  let up = request.places.filter(
    (place) => listOf.get(place.agent)?.up === true,
  );
  if (up.length === 0) return request.places[0]!;
  if (pin !== null) {
    const named = splitPin(pin);
    return (
      up.find(
        (place) =>
          (named.agent === null || place.agent === named.agent) &&
          listOf.get(place.agent)!.tuners.some((t) => t.pin === named.pin),
      ) ?? up[0]!
    );
  }
  if (keys !== null) {
    const rank = (place: Place) => keys.get(place.agent) ?? NO_KEY;
    const best = Math.min(...up.map(rank));
    up = up.filter((place) => rank(place) === best);
  }
  const shared = up.find((place) =>
    listOf
      .get(place.agent)!
      .tuners.some(
        (t) =>
          t.channel?.type === type &&
          t.channel.channel === place.channel &&
          t.users.some((u) => !after.includes(u.use) && u.priority >= priority),
      ),
  );
  if (shared !== undefined) return shared;
  const groups = orderGroups(
    lists.flatMap((list) =>
      list.tuners.map((t) => ({ agent: list.agent, ...t })),
    ),
  );
  for (const group of groups) {
    if (!group.types.has(type)) continue;
    const place = up.find((p) => p.agent === group.agent);
    if (place === undefined) continue;
    if (
      listOf
        .get(group.agent)!
        .tuners.some((t) => t.rank === group.rank && usable(t, priority, after))
    )
      return place;
  }
  return up[0]!;
}

/**
 * 一覧に、手元の数え (`pending`) をまだ出ていない利用者として足す。足す先は、同じチャンネルの選局があればそれ、
 * 無ければ受けられて使ってよいチューナーのうち `rank` のいちばん小さいもの (エージェントの選び方と同じ。約束の 2・3)。
 * 一覧はそのまま残し、写しを返す
 */
function withPending(
  lists: readonly RoutedList[],
  sent: readonly Omit<Pending, "answeredAt">[],
): RoutedList[] {
  const copies = lists.map((list) => ({
    ...list,
    tuners: list.tuners.map((t) => ({
      ...t,
      users: [...t.users],
      channel: t.channel === null ? null : { ...t.channel },
    })),
  }));
  for (const entry of sent) {
    const list = copies.find((l) => l.agent === entry.agent);
    if (list === undefined) continue;
    if (list.tuners.some((t) => t.users.some((u) => u.use === entry.use)))
      continue;
    const user = { use: entry.use, priority: entry.priority };
    const same = list.tuners.find(
      (t) =>
        !t.disabled &&
        t.channel?.type === entry.type &&
        t.channel.channel === entry.channel &&
        t.users.some((u) => u.priority >= entry.priority),
    );
    if (same !== undefined) {
      same.users.push(user);
      continue;
    }
    const free = list.tuners
      .filter(
        (t) =>
          t.types.includes(entry.type as ChannelType) &&
          usable(t, entry.priority, entry.after),
      )
      .sort((a, b) => a.rank! - b.rank!)[0];
    if (free === undefined) continue;
    free.channel = { type: entry.type as ChannelType, channel: entry.channel };
    // 取り上げた相手 (優先度の低い利用者・引き継いだ利用者) はいなくなる
    free.users.splice(0, free.users.length, user);
  }
  return copies;
}

/**
 * **選局できたら、誰の選局でも「受信できた」と残す** (`reception.recordReceived`。選局を送ったエージェントの記録にする)。
 * エージェントは最初の塊を書くときに答えのヘッダを送るので、答えが返った時点でそのチャンネルから TS が届いている。
 * 番組表の取得の成否だけを残していた頃は、番組表の取得が 1 台のチューナーで選局できなかった地上波のチャンネルを、
 * 同じ日にライブがほかのチューナーで選局できていても「続けて選局できません」と知らせ続けていた。
 * 書けなくても選局は止めない (受信の記録は知らせるためのもの)
 */
function recordTuned(agent: number, type: string, channel: string): void {
  const known = ALL_CHANNEL_TYPES.find((t) => t === type);
  if (known === undefined) return;
  try {
    recordReceived(agent, known, channel);
  } catch (error) {
    console.warn(
      `[tuner] ${type}:${channel} を受信できたと書けませんでした: ${error}`,
    );
  }
}

/** `X-Denpa-Tsmf-Streams` を読む。無い・読めなければ 1 (TSMF ではない) */
export function tsmfStreams(headers: Headers): number {
  const value = Number(headers.get(TSMF_STREAMS));
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/** 選局の答えの Content-Type。TS は `video/MP2T`、TLV (4K の放送) は `application/x-arib-tlv` (docs/agent.md「通信は HTTPS」)。HTTP のライブの `codec=raw` も同じ名前で返す */
const CONTENT_TS = "video/mp2t";
export const TLV_TYPE = "application/x-arib-tlv";

/**
 * 選局の答えの Content-Type から、流れてくるバイト列の形式を読む。**想定していない形式は TS として読む。**
 * エージェントと denpa のバージョンがずれただけで選局を止めないため (外から来る形式のずれは警告を出して続ける)
 */
export function streamTransport(headers: Headers): Transport {
  const type = (headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (type === TLV_TYPE) return "tlv";
  if (type !== CONTENT_TS)
    console.warn(
      `[tuner] エージェントが想定していない形式 (${type || "Content-Type なし"}) で流しています。TS として読みます。エージェントと denpa のバージョンが合っているか確かめてください`,
    );
  return "ts";
}

/**
 * **選局の答えの形式が、局の行の形式 (`services.transport`。控えの `transport`) と違った。** 読み方を黙って変えずに、その選局を失敗にする。
 * 形式はスキャンが決め、選局の前に読み方と復号できるかを決めるのに使っている。違うのはケーブル局が搬送波の中身を入れ替えたときで、スキャンし直せば合う
 */
export class TransportChangedError extends Error {
  constructor() {
    super("チャンネルの形式が変わりました。ケーブルをスキャンし直してください");
  }
}

/**
 * 開いたストリームの形式が `expected` と同じか確かめる。同じならストリームを返し、違えばストリームを閉じて `TransportChangedError` を投げる
 */
export async function expectTransport(
  opened: { stream: ReadableStream<Uint8Array>; transport: Transport },
  expected: Transport,
): Promise<ReadableStream<Uint8Array>> {
  if (opened.transport === expected) return opened.stream;
  await opened.stream.cancel().catch(() => {});
  throw new TransportChangedError();
}

/** 空き待ちで掛け直す回数と間隔 (ms)。待つのは前のチャンネルが離れるまで */
const BUSY_TRIES = 3;
const BUSY_WAIT = 700;

/**
 * 開く。**空きが無ければ少し待って掛け直す。**
 *
 * ライブは**チャンネルを変える一瞬だけ、前のチャンネルと合わせて 2 台要る**。
 * 前のを離してから次を要求しているが、離れたことがエージェントに届くのは非同期なので、
 * 重なる瞬間が残る。地上波は 2 台しかないため、録画か番組表の取得が 1 台使っていると
 * そこで断られていた (実機で `[live] GR:T15: チューナーに空きがありません`)。
 *
 * **待っているのは前のチャンネルが離れるまで**なので、長くは掛からない。
 * 掛け直すのは空き待ちのときだけ。選局そのものが駄目なら何度試しても同じ。
 * **答えの形式が局の行の形式と違えば止める** (`expectTransport`。番組表の取得・録画と同じ)。TS の読み方で TLV を流しても何も出ない
 *
 * 録画には使わない。録画は自前で掛け直す (`recorder.openWithRetry`。空き待ちに
 * 限らず、終了時刻まで取り直す)。
 */
export function openWhenFree(
  type: string,
  /** 局を受けられる所 (`openChannel` の `places`) */
  places: readonly Place[],
  signal: AbortSignal,
  use: StreamUse,
  priority: number,
  giveUp: () => boolean,
  /** 局の行の形式 (`services.transport`) */
  expected: Transport,
  pin: string | null = null,
  /** 観る局 (放送の service_id)。`openChannelStream` の `service` */
  service: number | null = null,
  /** 1 回のリクエストで答えを待つ上限 (ms)。`openChannel` の `answerWithin` */
  answerWithin: number | null = null,
  /** 復号して使う局 (`services.id`)。`openChannel` の `keyed` */
  keyed: number | null = null,
): Promise<{ stream: ReadableStream<Uint8Array>; place: Place }> {
  return retryWhileBusy(async () => {
    const opened = await openChannel(
      type,
      places,
      signal,
      use,
      priority,
      [],
      pin,
      service,
      answerWithin,
      keyed,
    );
    return {
      stream: await expectTransport(opened, expected),
      place: opened.place,
    };
  }, giveUp);
}

/**
 * 空き待ちのときだけ掛け直す。**掛け方そのものは渡してもらう。**
 *
 * 分けてあるのはテストのため。本物のエージェントを立てなくても、掛け直すかの
 * 判断だけを確かめられる (`tuner.test.ts`)
 */
export async function retryWhileBusy<T>(
  open: () => Promise<T>,
  giveUp: () => boolean = () => false,
  wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await open();
    } catch (error) {
      if (!(error instanceof TunerBusyError) || tries >= BUSY_TRIES || giveUp())
        throw error;
      await wait(BUSY_WAIT);
    }
  }
}
