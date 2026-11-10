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
import { type ChannelType, decodableService } from "../types";
import { agentFetch } from "./agent-client";
import { config } from "./config";
import type { Busy } from "./conflict";

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
  services: array(
    object({
      serviceId: number,
      serviceType: number,
      name: string,
      /**
       * PMT の CA 記述子にあった CA_system_id (`ca-observe.ts`)。スキャンで PMT を読む CATV の局だけが持つ。
       * CA 記述子が無ければ空。復号できるかはこれで決める (`types.decodableService`)
       */
      caSystemIds: optional(array(number)),
    }),
  ),
});
export type AgentChannel = Infer<typeof AGENT_CHANNEL>;

/**
 * 復号できる局が 1 つでも入っているチャンネルか。**チャンネルごとに決めること (スキャンで番組表も読むか・番組表の取得に行くか) はこれで見る。**
 * 局ごとの判断は局の行の `services.decodable` (`epg.syncServices`)
 */
export function decodableChannel(channel: AgentChannel): boolean {
  return channel.services.some((service) =>
    decodableService(channel.type, service.caSystemIds ?? []),
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
   * `unit` が `raw` なら dB ではなく、機材やドライバが返した値のまま (同じチューナーで比べる目安)。
   * `atTune` は選局したときの値 (px4d は選局の答えでしか返さない)。docs/tuners.md「信号レベル」
   */
  signal: nullable(SIGNAL),
});
export type AgentTuner = Infer<typeof AGENT_TUNER>;

const TUNERS = object({
  tuners: array(AGENT_TUNER),
  detected: boolean,
});

/** 画面から書き換えられる部分だけ */
export interface TunerConfig {
  name: string;
  types: ChannelType[];
  device: string | null;
  lnb: string | null;
  disabled: boolean;
}

/**
 * CATV の局の ID を、アンテナで受けた局と分ける下駄 (`serviceKey`)。network_id は 16 ビットなので、足すと重ならない
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

async function get<T>(path: string, shape: Shape<T>): Promise<T> {
  const res = await agentFetch(path, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `エージェント ${path} -> ${res.status} ${await res.text()}`,
    );
  }
  return tolerate(shape, await res.json(), `エージェントの ${path}`);
}

/** 書き換えを預ける。控えを書くのを待つので、読むより長く待つ */
function put(path: string, body: unknown): Promise<Response> {
  return agentFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

export function getChannels(): Promise<AgentChannel[]> {
  return get("/denpa/channels", array(AGENT_CHANNEL));
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
): Promise<AgentChannel[]> {
  const res = await put("/denpa/channels", { channels: found, scanned });
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

/** 一覧と、定義を書いていないので自分で見つけた状態か (`detected`。設定の「チューナー」に出す) を 1 度に */
export function tunerList(): Promise<Infer<typeof TUNERS>> {
  return get("/denpa/tuners", TUNERS);
}

export async function getTuners(): Promise<AgentTuner[]> {
  return (await tunerList()).tuners;
}

/**
 * 機材の定義を書き換える。
 *
 * **選局コマンドは無い。** エージェントがデバイスと種別から選局する
 * (渡せると、denpa に入れた人が privileged なチューナー側で好きなコマンドを走らせられる)。
 *
 * **空を渡すと定義そのものが消える** = 自動検出に戻す。
 */
export async function putTuners(tuners: TunerConfig[]): Promise<void> {
  const res = await put("/denpa/tuners", { tuners });
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
    "disabled" | "rank" | "channel" | "users"
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
export class TunerBusyError extends Error {}

/**
 * **エージェントが「選局できない」と返した** (同期しない・デバイスが無いなど)。空き待ち (`TunerBusyError`) と、
 * エージェントに繋がらないのは別。受信できるかの記録 (`epg-collect.ts` → `reception.ts`) は、開けなかった回のうちこれだけを失敗に数える
 * (ほかに数えるのは、開けたのに上限まで待っても何も来なかった回)
 */
export class TuneError extends Error {}

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
  channel: string,
  signal: AbortSignal,
  use: StreamUse,
  priority = config.priority.recording,
  after: readonly StreamUse[] = [],
  /** デバッグ用の名指し。このチューナーだけで選局し、ほかへ振り替えない (docs/agent.md「デバッグ用の名指し」) */
  pin: string | null = null,
): Promise<ReadableStream<Uint8Array>> {
  return (await openChannel(type, channel, signal, use, priority, after, pin))
    .stream;
}

/** 選局の答えのヘッダ。TSMF で束ねた TS の数 (無ければ TSMF ではない) */
const TSMF_STREAMS = "X-Denpa-Tsmf-Streams";

/**
 * `openChannelStream` と同じく開いて、**答えのヘッダから分かることも返す。** チャンネルスキャンが使う (`scan.ts`)。
 *
 * `tsmfStreams` は、選局した搬送波に TSMF (ARIB STD-B32。1 つの搬送波に複数の TS を束ねる) で束ねてある TS の数。
 * エージェントが `X-Denpa-Tsmf-Streams` で返す。返さなければ (TSMF でない・古いエージェント) 1
 */
export async function openChannel(
  type: string,
  channel: string,
  signal: AbortSignal,
  use: StreamUse,
  priority = config.priority.recording,
  after: readonly StreamUse[] = [],
  pin: string | null = null,
): Promise<{ stream: ReadableStream<Uint8Array>; tsmfStreams: number }> {
  const query = new URLSearchParams({
    type,
    channel,
    priority: String(priority),
    use,
  });
  for (const leaving of after) query.append("after", leaving);
  if (pin !== null) query.set("tuner", pin);
  const res = await agentFetch(`/denpa/stream?${query}`, {
    signal,
  });
  if (!res.ok || res.body === null) {
    const detail = await res.text().catch(() => "");
    if (res.status === 409)
      throw new TunerBusyError(`チューナーに空きがありません ${detail}`);
    throw new TuneError(`選局できません (${res.status}) ${detail}`);
  }
  return { stream: res.body, tsmfStreams: tsmfStreams(res.headers) };
}

/** `X-Denpa-Tsmf-Streams` を読む。無い・読めなければ 1 (TSMF ではない) */
export function tsmfStreams(headers: Headers): number {
  const value = Number(headers.get(TSMF_STREAMS));
  return Number.isInteger(value) && value >= 1 ? value : 1;
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
 *
 * 録画には使わない。録画は自前で掛け直す (`recorder.openWithRetry`。空き待ちに
 * 限らず、終了時刻まで取り直す)。
 */
export function openWhenFree(
  type: string,
  channel: string,
  signal: AbortSignal,
  use: StreamUse,
  priority: number,
  giveUp: () => boolean,
  pin: string | null = null,
): Promise<ReadableStream<Uint8Array>> {
  return retryWhileBusy(
    () => openChannelStream(type, channel, signal, use, priority, [], pin),
    giveUp,
  );
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
