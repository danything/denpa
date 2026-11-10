/**
 * 番組表を集める。
 *
 * やり方は 3 つとも「denpa が番組表を全部持っている」ことから来ている。
 *
 * - **チューナーが空いているだけ並列に回す**
 * - **順番を決められる。** 番組表が薄い局から先に行く
 * - **録画と同居できる。** 録画で開いているチャンネルなら、エージェントが
 *   選局を共有させるのでチューナーは増えない。番組表はただで手に入る
 *
 * 集め終わりは時間ではなく **EIT 自身が言っている**ところで決める
 * (`packages/arib/src/eit.ts` の ScheduleProgress)。揃えばすぐ離すので、次のチャンネルへ回せる。
 */

import { EpgReader } from "@danything/arib/eit";
import { ServiceReader } from "@danything/arib/psi";
import { max } from "drizzle-orm";

import { isSatellite } from "../types";
import { config } from "./config";
import { orm } from "./db";
import {
  currentServices,
  savePrograms,
  settle,
  syncServices,
  widenServices,
} from "./epg";
import { emit } from "./events";
import { alertGround, forgetGround, GroundWatch } from "./ground-watch";
import { LineupWatch } from "./lineup-follow";
import { checkedAt, recordFailed, recordReceived } from "./reception";
import { resolveConflicts } from "./scheduler";
import { programs, services } from "./schema";
import { chunks } from "./stream";
import {
  type AgentChannel,
  decodableChannel,
  getChannels,
  getTuners,
  openChannelStream,
  serviceKey,
  TuneError,
} from "./tuner";

/**
 * 集めに行った時刻 (`type:channel` ごと)。番組が 0 件だった回も「行った」と覚えるため。
 * 再起動をまたぐぶんは局の行から数える (`lastCollected`)
 */
const collected = new Map<string, number>();

/**
 * その物理チャンネルを最後に集めた時刻。**局の行の `epg_at` から数える。**
 *
 * **DB から起こす。** 覚えているだけだと Pod が入れ替わるたびに「1 度も行って
 * いない」に戻り、番組表が 7 日先まで埋まっているのに全チャンネルを回し直して
 * いた (実機で、入れ替えのたびに 46 チャンネルぶん)。`epg_at` は番組表 (EIT の schedule) を
 * 書いたときだけ進む (`epg.savePrograms`。録画とスキャンが読んだぶんも入る)。番組の行の `updated_at` で
 * 数えると、ライブが p/f を写しただけで「集めたばかり」になり、2 時間は行き直さなかった。
 *
 * **数えるキーは局**で、`services.channel` は見ない。あの列に入るのは
 * 「最後に取り込んだときの枠の名前」1 つだけなので、**同じ TS を指す枠が
 * 2 つあると片方が必ず「一度も集めていない」ことになる**。実機の BS が
 * まさにそれで、9 枠が永久に「まっさら」に見えて周回のたびに開かれていた。
 *
 * 局で引けば、どの枠から開いても同じ時刻が出る。
 */
function lastCollected(channels: AgentChannel[]): Map<string, number> {
  const perService = new Map<number, number>();
  for (const row of orm()
    .select({ id: services.id, at: services.epg_at })
    .from(services)
    .all()) {
    if (row.at !== null) perService.set(row.id, row.at);
  }

  const map = new Map<string, number>();
  for (const channel of channels) {
    const at = lastOf(perService, channel);
    if (at > 0) map.set(key(channel), at);
  }
  // 覚えているほうが新しければそちらを採る (取り込む番組が 0 件だった回)
  for (const [name, at] of collected) {
    if (at > (map.get(name) ?? 0)) map.set(name, at);
  }
  return map;
}

/**
 * そのチャンネルを最後に集めた時刻。**入っている局のうちいちばん新しいもの。**
 *
 * 1 本開けば入っている局が全部まとめて埋まるので、どれか 1 つでも新しければ
 * そのチャンネルは行ったばかり。一度も入っていなければ 0 (まっさら)。
 */
export function lastOf(
  perService: Map<number, number>,
  channel: AgentChannel,
): number {
  const times = perChannel(perService, channel);
  return times.length === 0 ? 0 : Math.max(...times);
}

/** チャンネルに入っている局それぞれの値。番組表に出てこない局は入れない */
function perChannel(
  perService: Map<number, number>,
  channel: AgentChannel,
): number[] {
  return channel.services
    .map((service) =>
      perService.get(
        serviceKey(channel.networkId, service.serviceId, channel.type),
      ),
    )
    .filter((value) => value !== undefined);
}

const key = (channel: AgentChannel) => `${channel.type}:${channel.channel}`;

interface CollectState {
  running: boolean;
  /** いま開いているチャンネル */
  active: string[];
  /** この周回で残っている数 */
  pending: number;
  /** この周回で回る数 (進み具合の分母) */
  total: number;
  /** 初回の、BS をネットワークごとに 1 中継で埋めている最中か (`firstSweeps`) */
  sweeping: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  /** 直近の周回で取り込んだ番組数 */
  programs: number;
  /** 人が押して、最優先で回している最中か */
  boosted: boolean;
}

let state: CollectState = {
  running: false,
  active: [],
  pending: 0,
  total: 0,
  sweeping: false,
  startedAt: null,
  finishedAt: null,
  programs: 0,
  boosted: false,
};

export function collectState(): CollectState {
  return state;
}

function update(patch: Partial<CollectState>): void {
  state = { ...state, ...patch };
  emit("tuners");
}

/**
 * 局ごとに番組表がどこまで先まで埋まっているか。
 *
 * **再起動しても分かる指標**なので、ここを見て「先に行くべきチャンネル」を決める。
 * 記憶だけで持っていると、Pod が入れ替わるたびに全チャンネルを回し直すことになる。
 */
function coverage(): Map<number, number> {
  const rows = orm()
    .select({
      service_id: programs.service_id,
      value: max(programs.end_at).mapWith(Number),
    })
    .from(programs)
    .groupBy(programs.service_id)
    .all();
  return new Map(rows.map((row) => [row.service_id, row.value]));
}

interface Work {
  channel: AgentChannel;
  /** この物理チャンネルに入っている局のうち、いちばん薄いものが埋まっている先の時刻 (`reachOf`) */
  reach: number;
  last: number;
}

/**
 * その物理チャンネルの番組表がどこまで先まで埋まっているか。
 *
 * 入っている局のうち**いちばん薄いもの**に合わせる。1 本開けば入っている局が
 * 全部まとめて埋まるので、1 局でも薄ければ行く値打ちがある。
 *
 * **番組表に出てこない局は数えない。** 数えていた頃は、その局を「0 まで
 * 埋まっている = いちばん薄い」と読んで、**毎周回そのチャンネルを選び直して
 * いた**。実機で番組表の取得が止まらなかった原因は次の局だった。
 *
 * - **データ放送・ワンセグ。** エージェントは TS にある全部の局を返すが、
 *   denpa は映像の入っていない局を落とす (`epg.syncServices`)。地上波は
 *   ほぼ全局がこれを積んでいるので、**地上波が丸ごと毎回対象になっていた**
 * - **放送を終えた枠と、受信できない局。** BS103 や、実機に残っている CS 24 局
 *
 * 番組表に出てこない局を外した結果、1 局も残らないチャンネルは 0 (まっさら) のままにする。
 * 入れたばかりのときはこれで正しく、あとは `epgChannelRetry` が空回りを止める。
 */
export function reachOf(
  reach: Map<number, number>,
  channel: AgentChannel,
): number {
  const reaches = perChannel(reach, channel);
  return reaches.length === 0 ? 0 : Math.min(...reaches);
}

/**
 * この周回で回すチャンネルを選ぶ。
 *
 * 集め直すのは「しばらく行っていない」か「番組表が薄い」チャンネル。
 * **薄いほうから先に**行く。スキャンの直後や初回起動では全部が空なので、
 * ここが効いて画面に番組が出るまでが早くなる。
 *
 * ただし**行った直後は行き直さない** (`epgChannelRetry`)。開いても EIT が
 * 来ない局は永久に薄いままなので、これが無いと周回のたびに選ばれ続ける。
 */
export function pickChannels(
  channels: AgentChannel[],
  reachOf: (channel: AgentChannel) => number,
  lastOf: (channel: AgentChannel) => number,
  at: number,
): AgentChannel[] {
  const work: Work[] = channels.map((channel) => ({
    channel,
    reach: reachOf(channel),
    last: lastOf(channel),
  }));

  return work
    .filter((item) => at - item.last >= config.epgChannelRetry)
    .filter(
      (item) =>
        item.reach - at < config.epgMinCoverage ||
        at - item.last >= config.epgChannelInterval,
    )
    .sort((a, b) => a.reach - b.reach || a.last - b.last)
    .map((item) => item.channel);
}

/**
 * 1 チャンネル開いて、番組表が揃うまで読む。
 *
 * `whole` のときは**ほかの TS の局の番組表も読む** (`firstSweeps`)。
 */
async function collectChannel(
  channel: AgentChannel,
  /** 全局読みのとき、来るはずの局 (service_id)。普段 (自分の中継だけ) は null */
  whole: number[] | null = null,
): Promise<{ programs: number; complete: boolean; failed: boolean }> {
  const reader = new EpgReader(Date.now, {
    other: whole !== null,
    settle: config.epgSweepSettle,
    expect: whole ?? [],
  });
  const controller = new AbortController();
  /** 上限まで読んだか。開けたのに上限まで何も来なかったら、受信できなかったと数える (`reception.ts`) */
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.epgChannelTimeout);
  timer.unref?.();

  const label =
    whole !== null ? `${key(channel)} (${channel.type} 全局)` : key(channel);
  const startedAt = Date.now();
  update({ active: [...state.active, label] });
  /**
   * 開けたか。**使えなかった回は「行った」ことにしない。** 録画に譲って
   * 開けなかっただけの局まで `epgChannelRetry` で休ませると、番組表が古くなる
   */
  let opened = false;
  /** TS が 1 バイトでも来たか。受信できたかの印 (`reception.ts`) */
  let received = false;
  /** 衛星なら、ついでに読む放送の一覧 (`lineup-follow.ts`) */
  let lineup: LineupWatch | null = null;
  /** 地上波なら、ついでに読む SDT (局の顔ぶれをスキャンの結果と比べる。`ground-watch.ts`) */
  const ground = channel.type === "GR" ? new GroundWatch(channel) : null;
  /** エージェントが「選局できない」と返したか (空き待ちやエージェントに繋がらないのは入れない) */
  let refused = false;
  /*
   * **読みながら少しずつ保存する。** 揃うまで待ってからまとめて書くと、全局読みの
   * 数分のあいだ画面に何も出ない。今日・明日の番組は先に流れてくるので、開いて
   * 数十秒で番組表が埋まり始める。予約の組み直しは周回の終わりにまとめて (`settle`)
   */
  let saved = 0;
  let flushedAt = Date.now();
  const flush = () => {
    flushedAt = Date.now();
    const batch = reader.takeChanged();
    if (batch.length === 0) return;
    /*
     * 書けなくても読むのはやめない。読み取りの失敗 (下の catch) と混ざると
     * 「使えなかった」と出て、理由が追えなくなる。最後にまとめて書き直すので、
     * 書けなかったぶんは `reader` に戻しておく
     */
    try {
      saved += savePrograms(batch, { type: channel.type });
      emit("programs");
    } catch (error) {
      reader.requeue(batch);
      console.warn(`[epg] ${label} の番組表を書けませんでした: ${error}`);
    }
  };
  try {
    const stream = await openChannelStream(
      channel.type,
      channel.channel,
      controller.signal,
      `epg ${channel.channel}`,
      // 押されている間は、開くたびに高い優先度で取る
      boosted ? config.priority.epgNow : config.priority.epg,
    );
    opened = true;
    /*
     * **局の名前の幅も放送から取り直す** (`epg.widenServices`)。SDT は 1 秒足らずで来るので、
     * 読めたら手放す (その先のパケットまで 2 度パースしない)。来ないまま `SDT_LIMIT` を過ぎても手放す
     */
    let sdt: ServiceReader | null = new ServiceReader();
    let sdtBytes = 0;
    /*
     * **衛星は放送の一覧 (NIT) も読み、変わっていればチャンネルを書き換える** (`lineup-follow.ts`)。
     * どの中継器にもネットワークの全部の TS が載っている。読むのは最初の `lineup-follow.ts` の `WATCH_FOR` だけ (SDT[other] がそろうまで)
     */
    lineup = isSatellite(channel.type) ? new LineupWatch(channel.type) : null;
    for await (const chunk of chunks(stream)) {
      received ||= chunk.length > 0;
      lineup?.feed(chunk);
      ground?.feed(chunk);
      if (sdt !== null) {
        sdt.feed(chunk);
        sdtBytes += chunk.length;
        if (sdt.transport === null && sdtBytes > SDT_LIMIT) {
          sdt = null;
        } else if (sdt.transport !== null) {
          try {
            widenServices(
              sdt.transport.originalNetworkId,
              sdt.transport.services,
              channel.type,
            );
          } catch (error) {
            console.warn(`[epg] ${label} の局名を書けませんでした: ${error}`);
          }
          sdt = null;
        }
      }
      // `feed` の返りは「番組が増えたか」。揃ったかは増えたときだけ見る
      if (reader.feed(chunk) && reader.complete) break;
      if (Date.now() - flushedAt >= FLUSH_EVERY) flush();
    }
  } catch (error) {
    // 使えなかった・途中で切れた。**読めたところまでは取り込む。**
    // 電波が弱い局で 1 件も入らないより、半分でも埋まっているほうがいい
    if (!controller.signal.aborted) {
      console.warn(`[epg] ${label} を集められませんでした: ${error}`);
    }
    refused = error instanceof TuneError;
  } finally {
    clearTimeout(timer);
    controller.abort();
    update({ active: state.active.filter((name) => name !== label) });
  }

  /*
   * **受信できたかを残す** (`reception.ts`)。BS と CS は放送の一覧から作るので、受信できないチャンネルも入る。
   * 選局できなかった回も「行った」と覚える (受信できないチャンネルを周回のたびに選び直さない)。
   * 開けたのに何も来ないまま終わった回は、上限まで待ったときだけ数える (録画やライブに譲った・止めたときは数えない)
   */
  lineup?.follow();
  ground?.compare();
  const failed = !received && (refused || (opened && timedOut));
  if (received) {
    recordReceived(channel.type, channel.channel);
  } else if (failed) {
    collected.set(key(channel), Date.now());
    if (recordFailed(channel.type, channel.channel)) {
      console.warn(
        `[epg] ${label} を受信できないチャンネルにしました (続けて選局できませんでした)`,
      );
    }
  }
  // 地上波は外さずに知らせる (続けて選局できない・局の顔ぶれがスキャンの結果と違う)
  if (channel.type === "GR") alertGround();

  /*
   * **どれだけ使っていたかと、なぜ離したかを残す。**
   *
   * 揃えば早く離すのは denpa だけがやっていることなので (よそは時間で
   * 打ち切る)、そこが効いていないと**何も出力せずに 1 台 10 分ずつ占有し続ける**。
   * 実測でチューナーを 1 台 600 秒 (上限ちょうど) 使っているのを見つけたが、
   * 揃わなかったのか電波が欠けていたのかは記録が無くて追えなかった。
   */
  if (opened) {
    /*
     * **1 件も取れなくても「行った」と覚える。** 番組の行から数え直すだけだった頃は、
     * EIT が来ない局の `last` が永久に 0 のままで、周回のたびに選ばれ続けていた
     */
    collected.set(key(channel), Date.now());
    const secs = Math.round((Date.now() - startedAt) / 1000);
    if (reader.complete) {
      console.log(`[epg] ${label}: 揃ったので ${secs} 秒で離しました`);
    } else {
      const why = reader.shortfall();
      console.warn(
        `[epg] ${label}: 揃わないまま ${secs} 秒で離しました` +
          `${why.length === 0 ? "" : ` (${why.slice(0, 4).join(" / ")})`}`,
      );
    }
  }

  flush();
  // 同じ番組を何度か書いているので、数えるのは読めた番組の数まで
  return {
    programs: Math.min(saved, reader.all().length),
    complete: opened && reader.complete,
    failed,
  };
}

/** SDT を待つ上限 (`collectChannel`)。BS の数秒ぶん。SDT は 2 秒に 1 回は流れる */
const SDT_LIMIT = 32 * 1024 * 1024;

/** 読みながら保存する間隔 (`collectChannel`) */
const FLUSH_EVERY = 30_000;

/** 走っている周回。重なった呼び出しはこれに合流する */
let inflight: Promise<number> | null = null;

/** 人が押して待っている間だけ立つ。開くたびに読むので、走っている回にも効く */
let boosted = false;

export function collectOnce(): Promise<number> {
  /*
   * **走っている最中に呼ばれたら、その回に合流する。** 断って 0 を返していると、
   * 起動直後の 1 周と手で押したぶんが重なったときに「取り込めていない」ように見える
   */
  if (inflight !== null) return inflight;
  inflight = run().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * **いますぐ、全チューナーで、最優先で集める。**
 *
 * 入れたばかりのときのためのもの。普段の周回 (`collectOnce`) は録画・ライブ・
 * スキャン・衛星のロゴの当たりの中継 (`config.priority.carousel`) に譲るので、他が動いていると番組表がなかなか埋まらない。
 * 押されている間は**録画とライブ以外には全部譲らせて**取得する (`config.priority.epgNow`)。
 *
 * **既に回っている最中なら、その回の優先度を上げる。** 開くのは 1 チャンネルずつなので、
 * 次に開くところから効く (待たせて仕切り直すより早い)。
 */
export function collectNow(): Promise<number> {
  boosted = true;
  update({ boosted: true });
  return collectOnce().finally(() => {
    boosted = false;
    update({ boosted: false });
  });
}

/**
 * **番組表に詳細を流していない種別。** 中継ごとに開いても取れるものが変わらないので、
 * いつもネットワークごとに 1 中継で全局ぶんを読む (`networkSweeps`)。
 *
 * CS は自分の中継のぶんにも詳細 (`0x58-0x5F`) が 1 つも来ない (実測。docs/data.md)。
 * 1 中継を約 3 分読めば、そのネットワークの全局の基本が 7 日先まで揃う
 */
const WHOLE_ONLY = new Set(["CS"]);

/**
 * **初回は、BS をネットワークごとに 1 つの中継で先に埋める。**
 *
 * BS はどの中継にもネットワーク全局ぶんの番組表 (基本) が流れている。
 * 1 つ読めば約 6 分で 45 局ぶんが 7 日先まで揃う (実測。docs/data.md)。中継を
 * 1 つずつ回ると衛星のチューナー 2 台で数十分かかり、その間は番組表が空のまま。
 *
 * **詳細 (番組内容・出演者) は自分の中継にしか流れていない** ので、そのあと
 * いつもどおり中継ごとに回って足す。初回はどの中継も「まっさら」なので、
 * 同じ周回の続きで必ず回る。CS は詳細が無いので、いつも全局読み (`WHOLE_ONLY`)。
 *
 * 「初回」は、そのネットワークの局に番組が 1 件も無いとき。受信できない局が
 * 残っていても、ほかの局が埋まっていれば動かない (毎周回 6 分ずつ塞がない)。
 *
 * **地上波と CATV は全局読みをしない。** CATV は自分の TS の番組表だけを読む (地上波と同じ)。
 * BS を再送信する CATV の TS はネットワーク ID が BS と同じ 4 なので、束ねるキーには種別も入れる
 */
export function firstSweeps(
  channels: AgentChannel[],
  reach: Map<number, number>,
  lastOf: (channel: AgentChannel) => number = () => 0,
): AgentChannel[] {
  const byNetwork = new Map<string, AgentChannel[]>();
  for (const channel of channels) {
    if (!isSatellite(channel.type) || WHOLE_ONLY.has(channel.type)) continue;
    const network = `${channel.type}:${channel.networkId}`;
    byNetwork.set(network, [...(byNetwork.get(network) ?? []), channel]);
  }
  const sweeps: AgentChannel[] = [];
  for (const members of byNetwork.values()) {
    const filled = members.some((channel) =>
      channel.services.some((service) =>
        reach.has(
          serviceKey(channel.networkId, service.serviceId, channel.type),
        ),
      ),
    );
    // いちばん長く行っていない中継から。受信できない中継に当たり続けない
    if (!filled)
      sweeps.push([...members].sort((a, b) => lastOf(a) - lastOf(b))[0]!);
  }
  return sweeps;
}

/**
 * 詳細の無い種別 (`WHOLE_ONLY`) の、この周回で読むべきものを**ネットワークごとに 1 中継**へまとめる。
 * そのネットワークの中継が 1 つでも選ばれていれば、`sweepOrder` の先頭の中継で全局を読む
 */
export function networkSweeps(
  targets: AgentChannel[],
  channels: AgentChannel[],
  checkedOf: (channel: AgentChannel) => number,
): AgentChannel[] {
  const wanted = new Set(
    targets.filter((c) => WHOLE_ONLY.has(c.type)).map((c) => c.networkId),
  );
  return [...wanted].map(
    (network) => sweepOrder(channels, network, checkedOf)[0]!,
  );
}

/**
 * 全局読みで開く中継の順。**受信できるかをいちばん長く確かめていない中継から** (一度も確かめていないものが先)。
 *
 * 番組の行の時刻では選べない。1 中継の全局読みでネットワークの全局の番組が新しくなるので、
 * どの中継も同じ時刻になり、いつも先頭の中継 (CS02・CS04) ばかり開いていた。受信できたかは
 * 開いた中継にしか残らないので、ほかの中継がずっと「確認中」のままだった (`reception.ts`)
 */
export function sweepOrder(
  channels: AgentChannel[],
  network: number,
  checkedOf: (channel: AgentChannel) => number,
): AgentChannel[] {
  return channels
    .filter((c) => WHOLE_ONLY.has(c.type) && c.networkId === network)
    .sort((a, b) => checkedOf(a) - checkedOf(b));
}

/**
 * 詳細の無い種別の全局読みが受信できなかったときに、代わりに読む中継 (`order` の次の中継)。
 * ネットワークごとに 1 回まで (`replaced` に足す)。替えないときは undefined
 */
export function replacement(
  job: { channel: AgentChannel; whole: number[] | null },
  failed: boolean,
  replaced: Set<number>,
  order: (network: number) => AgentChannel[],
): { channel: AgentChannel; whole: number[] } | undefined {
  const { channel, whole } = job;
  if (whole === null || !failed || !WHOLE_ONLY.has(channel.type)) return;
  if (replaced.has(channel.networkId)) return;
  replaced.add(channel.networkId);
  const next = order(channel.networkId).find((c) => c !== channel);
  return next === undefined ? undefined : { channel: next, whole };
}

/**
 * 読み終えた 1 本が、初回の全局読み (`first`) の 1 つを終えたか。画面の「詳細はあとで足す」は、これが
 * `first` の数だけ来たら消す。**列へ戻した読み直し (`whole: null`) は数えない。** 同じ中継の全局読みを
 * 数え終えたあとなので、数えるとほかの全局読みが終わる前に 0 になり、二重に減らしていた
 */
export function firstSweepDone(
  job: { channel: AgentChannel; whole: number[] | null },
  first: readonly AgentChannel[],
): boolean {
  return job.whole !== null && first.includes(job.channel);
}

async function run(): Promise<number> {
  const all = await getChannels().catch(() => [] as AgentChannel[]);
  if (all.length === 0) return 0;
  // 局の一覧はここでも取り込んでおく。スキャンの直後に呼ばれることがある
  syncServices(all);
  forgetGround(all);
  // 復号できる局が 1 つも無いチャンネル (SKY など) は番組表を取得しない (`decodableChannel`。番組表とライブに出さないので要らない)
  const channels = all.filter(decodableChannel);
  if (channels.length === 0) return 0;

  const reach = coverage();
  const at = Date.now();
  const thinnest = (channel: AgentChannel) => reachOf(reach, channel);

  const last = lastCollected(channels);
  const lastOf = (channel: AgentChannel) => last.get(key(channel)) ?? 0;
  /*
   * 全局読みの種別は**ネットワークで 1 つの時刻**にする。全局読みで開くのは 1 中継だけなので、
   * 中継ごとの時刻だと残りが「行っていない」に見え、受信できない局のある中継が
   * 周回のたびにネットワークごと読み直させる
   */
  const networkLast = (channel: AgentChannel) =>
    WHOLE_ONLY.has(channel.type)
      ? Math.max(
          0,
          ...channels
            .filter(
              (c) =>
                c.type === channel.type && c.networkId === channel.networkId,
            )
            .map(lastOf),
        )
      : lastOf(channel);

  /*
   * 押されたときは**選り好みしない。**
   *
   * 普段は「薄い」か「しばらく行っていない」チャンネルだけ回るので、
   * さっき集め終えたところで押すと 1 本も回らず、何も起きていないように見える。
   * 押した人は「いま集め直したい」なので、全部回って薄いほうから行く
   */
  const targets = boosted
    ? [...channels].sort((a, b) => thinnest(a) - thinnest(b))
    : pickChannels(channels, thinnest, networkLast, at);

  // 行ったばかりなら休ませる (局が来なかったネットワークで毎周回 6 分ずつ塞がない)
  const first = firstSweeps(channels, reach, lastOf).filter(
    (channel) => at - lastOf(channel) >= config.epgChannelRetry,
  );
  const checked = checkedAt();
  const checkedOf = (channel: AgentChannel) => checked.get(key(channel)) ?? 0;
  const sweeps = [...first, ...networkSweeps(targets, channels, checkedOf)];
  // 全局ぶんを読んだ中継は、自分の中継の詳細もそこで取れている。続きでは回らない
  const rest = targets.filter(
    (channel) => !sweeps.includes(channel) && !WHOLE_ONLY.has(channel.type),
  );
  const total = sweeps.length + rest.length;
  if (total === 0) return 0;

  /*
   * 全局読みで来るはずの局。**DB にある局だけ** (映像の無い局は入れていない)。
   * 全部見えて揃えばすぐ閉じる
   */
  const known = new Set(
    orm()
      .select({ id: services.id })
      .from(services)
      .where(currentServices())
      .all()
      .map((row) => row.id),
  );
  const expect = (sweep: AgentChannel) =>
    channels
      .filter((c) => c.type === sweep.type && c.networkId === sweep.networkId)
      .flatMap((c) => c.services.map((service) => service.serviceId))
      .filter((serviceId) =>
        known.has(serviceKey(sweep.networkId, serviceId, sweep.type)),
      );

  const tuners = (await getTuners().catch(() => [])).filter(
    (tuner) => !tuner.disabled,
  );

  update({
    running: true,
    startedAt: at,
    finishedAt: null,
    pending: total,
    total,
    // 画面の「詳細はあとで足す」は BS の初回だけ。CS はいつもの全局読み
    sweeping: first.length > 0,
    programs: 0,
  });
  let programs = 0;
  try {
    /*
     * **1 台に 1 つの処理。** 種別ごとに「その種別のチューナー台数」だけ並べていた頃は、
     * BS と CS を同時に集めると衛星の台数を二重に数えていた (同じ 2 台が
     * BS でも CS でも 1 台ぶんに見える)。溢れたぶんは 409 で弾かれ、その回は
     * 集められないまま落ちる。1 つの列を全チューナーで引けば数は合う
     */
    let sweepsLeft = first.length;
    /** 全局読みが受信できず、この周回でほかの中継に替えたネットワーク */
    const replaced = new Set<number>();
    // 全局ぶんを読む中継を列の先頭に置く。衛星のチューナーが最初に取る
    const queue: { channel: AgentChannel; whole: number[] | null }[] = [
      ...sweeps.map((channel) => ({ channel, whole: expect(channel) })),
      ...rest.map((channel) => ({ channel, whole: null })),
    ];
    const take = (types: string[]) => {
      const at = queue.findIndex((job) => types.includes(job.channel.type));
      return at === -1 ? undefined : queue.splice(at, 1)[0];
    };
    const lane = async (types: string[]) => {
      for (;;) {
        const job = take(types);
        if (job === undefined) return;
        update({ pending: state.pending - 1 });
        const result = await collectChannel(job.channel, job.whole);
        programs += result.programs;
        /*
         * 全局読みが揃わないまま上限で切れたら、その中継の詳細も欠けている。
         * 列の後ろへ戻して、いつもどおり自分の中継ぶんを読み直す
         * (詳細の無い種別は、読み直しても取れるものが無い)
         */
        if (
          job.whole !== null &&
          !result.complete &&
          !WHOLE_ONLY.has(job.channel.type)
        ) {
          queue.push({ channel: job.channel, whole: null });
          update({ pending: state.pending + 1, total: state.total + 1 });
        }
        /*
         * 詳細の無い種別の全局読みが受信できなかったら、**この周回のうちに次の中継で読み直す。**
         * 受信できない中継の番が来ても、そのネットワークの番組表を止めない
         * (失敗した中継も「行った」と覚えるので、そのままだと次に集め直すときまで延びる)。
         * 替えるのはネットワークごとに 1 回まで。どれも受信できないとき (アンテナの不調) に、
         * 中継を全部開いて回らない
         */
        const next = replacement(job, result.failed, replaced, (network) =>
          sweepOrder(channels, network, checkedOf),
        );
        if (next !== undefined) {
          queue.push(next);
          update({ pending: state.pending + 1, total: state.total + 1 });
        }
        if (firstSweepDone(job, first) && --sweepsLeft === 0)
          update({ sweeping: false });
      }
    };

    // エージェントに聞けなかったときは 1 台だけで回す (聞けないだけで、チューナーはある)
    await Promise.all(
      tuners.length === 0
        ? [lane([...new Set(queue.map((job) => job.channel.type))])]
        : tuners.map((tuner) => lane(tuner.types)),
    );
  } finally {
    update({
      running: false,
      finishedAt: Date.now(),
      active: [],
      pending: 0,
      sweeping: false,
      programs,
    });
  }

  if (programs > 0) {
    settle();
    await resolveConflicts();
    console.log(
      `[epg] ${total} チャンネルから ${programs} 件の番組を取り込みました`,
    );
  }
  return programs;
}
