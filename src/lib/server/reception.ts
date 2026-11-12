/**
 * **チャンネルを受信できるかを、番組表の取得のついでに確かめる。**
 *
 * BS と CS は放送の一覧 (NIT) から作るので (`satellite.ts`)、「放送されているもの」が全部入る。
 * その家で受信できるかは別の話で、CATV で一部の中継器しか通らないこともある。確かめるために選局を増やさず、
 * 番組表の取得 (`epg-collect.ts`) が中継器を開けなかったことと、誰かが選局できたこと (`tuner.openChannel`) を記録する。
 *
 * - **エージェントごとに数える。** アンテナとチューナーはエージェントごとにあるので、記録は選局を送ったエージェントのものにし、
 *   「同じ種別のほかのチャンネル」もそのエージェントの中で見る
 * - **受信できたら、印を消す。** 1 回でも受信できれば受信できるチャンネル。ライブ・録画・スキャンなど、誰の選局でも数える。
 *   番組表の取得の失敗は 1 台のチューナーでの結果で (読み直しも、空いていれば同じチューナーに入る)、
 *   ほかのチューナーで選局できたならチャンネルの問題ではない
 * - **2 回続けて受信できず、その間に同じ種別のほかのチャンネルは受信できていれば、受信できないと決める。**
 *   1 回の失敗では決めない (一時的な受信の不調がある)。その種別が全部受信できないのは、アンテナか
 *   チューナーの問題で、チャンネルの問題ではないので決めない (受信できなくなってから、ほかのチャンネルが
 *   1 つも受信できていなければ決めない)
 * - 同じ周回の中の失敗は 1 回と数える (`RECOUNT_AFTER`)
 * - チューナーの空き待ち・途中で切れた回・同じ周回で読み直す前の選局の失敗は、失敗に数えない (呼ぶ側が渡さない。`epg-collect.receptionFailed`)
 *
 * 受信できないチャンネルは、局の取り込みで見かけなかったことにする (`epg.syncServices`)。**局を番組表・ライブ・ルールから外すのは、
 * その局の TS を受けられる全部のエージェントで受信できないと決めたときだけ** (`agent-channels.unreceivableService`)。
 * **外すのは BS と CS だけ。** 地上波はスキャンで受信できたものだけが入っているので、続けて選局できなくても外さない (知らせるのは別)。
 * CATV と SKY もスキャンで受信できたものだけが入るので外さない (SKY は番組表を取得しないので、ここでは確かめない)。
 * 番組表の取得はそのチャンネルにも行き続けるので、受信できるようになれば戻る
 */
import { and, eq, gte, ne } from "drizzle-orm";

import { type ChannelType, isSatellite } from "../types";
import { now, orm } from "./db";
import { channelReception } from "./schema";

/** 何回続けて受信できなければ、受信できないと決めるか */
const MARK_AFTER = 2;

/** この間の失敗は 1 回と数える。番組表の取得の周回 (30 分) より長く、行き直す間隔 (2 時間) より短く */
export const RECOUNT_AFTER = 60 * 60_000;

export type Reception = "ok" | "checking" | "unreceivable";

const keyOf = (type: string, channel: string) => `${type}:${channel}`;

/** 1 つのエージェントの 1 つのチャンネルの行を指す条件 */
function rowOf(agent: number, type: string, channel: string) {
  return and(
    eq(channelReception.agent_id, agent),
    eq(channelReception.type, type as ChannelType),
    eq(channelReception.channel, channel),
  );
}

/** 受信できた。印を消す。`agent` は選局を送ったエージェント (`agents.id`) */
export function recordReceived(
  agent: number,
  type: ChannelType,
  channel: string,
  at = now(),
): void {
  orm()
    .insert(channelReception)
    .values({
      agent_id: agent,
      type,
      channel,
      ok_at: at,
      failing_since: null,
      failures: 0,
      unreceivable: false,
    })
    .onConflictDoUpdate({
      target: [
        channelReception.agent_id,
        channelReception.type,
        channelReception.channel,
      ],
      set: { ok_at: at, failing_since: null, failures: 0, unreceivable: false },
    })
    .run();
}

/**
 * 受信できなかった (選局できない・何も流れてこない)。**受信できないと決めたら true**
 * (この回で印が付いた。局が外れるのは次の局の取り込みのとき)
 */
export function recordFailed(
  agent: number,
  type: ChannelType,
  channel: string,
  at = now(),
): boolean {
  const row = orm()
    .select()
    .from(channelReception)
    .where(rowOf(agent, type, channel))
    .get();
  // 受信できたあと (`failing_since` が空) の最初の失敗は、前の失敗から間が無くても数える
  const recount =
    row?.failing_since === null ||
    row?.failing_since === undefined ||
    row.failed_at === null ||
    at - row.failed_at >= RECOUNT_AFTER;
  const failures = (row?.failures ?? 0) + (recount ? 1 : 0);
  const since = row?.failing_since ?? at;
  const others = othersReceived(agent, type, channel, since);
  // 外すのは衛星だけ。地上波・CATV・SKY はスキャンで受信できたものだけが入っている (続けて選局できないときは知らせるだけ)
  const unreceivable = isSatellite(type) && failures >= MARK_AFTER && others;
  orm()
    .insert(channelReception)
    .values({
      agent_id: agent,
      type,
      channel,
      failed_at: at,
      failing_since: since,
      failures,
      unreceivable,
    })
    .onConflictDoUpdate({
      target: [
        channelReception.agent_id,
        channelReception.type,
        channelReception.channel,
      ],
      set: { failed_at: at, failing_since: since, failures, unreceivable },
    })
    .run();
  return unreceivable && row?.unreceivable !== true;
}

/** そのエージェントで受信できないと決めたチャンネル (`種別:名前`) */
export function unreceivableChannels(agent: number): Set<string> {
  return new Set(
    orm()
      .select({
        type: channelReception.type,
        channel: channelReception.channel,
      })
      .from(channelReception)
      .where(
        and(
          eq(channelReception.agent_id, agent),
          eq(channelReception.unreceivable, true),
        ),
      )
      .all()
      .map((row) => keyOf(row.type, row.channel)),
  );
}

/**
 * そのエージェントのチャンネル (`種別:名前`) ごとの、最後に確かめた時刻 (受信できた・できなかったの新しいほう)。
 * 一度も確かめていないチャンネルは入らない。CS の全局読みで開く中継を順に回すのに使う (`epg-collect.networkSweeps`)
 */
export function checkedAt(agent: number): Map<string, number> {
  return new Map(
    orm()
      .select()
      .from(channelReception)
      .where(eq(channelReception.agent_id, agent))
      .all()
      .map((row) => [
        keyOf(row.type, row.channel),
        Math.max(row.ok_at ?? 0, row.failed_at ?? 0),
      ]),
  );
}

/**
 * チャンネルごとの受信の様子 (設定の「受信」に出す)。`agent` はそのチャンネルで選局するエージェント。
 * 一度も確かめていない衛星のチャンネルは「確認中」。地上波・CATV・SKY はスキャンで受信できたものだけが入るので「確認中」にしない
 */
export function receptionOf(
  channels: readonly { agent: number; type: string; channel: string }[],
): Map<string, Reception> {
  const rows = new Map(
    orm()
      .select()
      .from(channelReception)
      .all()
      .map((row) => [`${row.agent_id}:${keyOf(row.type, row.channel)}`, row]),
  );
  const out = new Map<string, Reception>();
  for (const { agent, type, channel } of channels) {
    const key = keyOf(type, channel);
    const row = rows.get(`${agent}:${key}`);
    if (row?.unreceivable === true) out.set(key, "unreceivable");
    else if (row?.ok_at === null || row?.ok_at === undefined)
      out.set(key, isSatellite(type) ? "checking" : "ok");
    else out.set(key, "ok");
  }
  return out;
}

/**
 * そのエージェントの控えから消えたチャンネルの記録を捨てる (スキャンし直した・再編で無くなった)。
 * 残すと、前のチャンネルの局が「受信できない」として設定に出続ける。空の一覧では何もしない
 * (エージェントが起動直後や不調で空を返すことがある)
 */
export function pruneReception(
  agent: number,
  channels: readonly { type: string; channel: string }[],
): void {
  if (channels.length === 0) return;
  const listed = new Set(channels.map((c) => keyOf(c.type, c.channel)));
  for (const row of orm()
    .select({
      type: channelReception.type,
      channel: channelReception.channel,
    })
    .from(channelReception)
    .where(eq(channelReception.agent_id, agent))
    .all()) {
    if (listed.has(keyOf(row.type, row.channel))) continue;
    orm()
      .delete(channelReception)
      .where(rowOf(agent, row.type, row.channel))
      .run();
  }
}

/**
 * **続けて選局できない地上波のチャンネル。** 2 回続けて受信できず、その間に同じエージェントのほかの地上波のチャンネルは
 * 受信できているもの。どれかのエージェントでそうなっていれば入る (名前は重ねない)。
 * 地上波は外さずに知らせる (`ground-watch.ts`)。中継局の周波数が変わったなら、スキャンし直せば選局できる
 */
export function failingGround(): string[] {
  const failing = orm()
    .select()
    .from(channelReception)
    .where(eq(channelReception.type, "GR"))
    .all()
    .filter(
      (row) =>
        row.failures >= MARK_AFTER &&
        row.failing_since !== null &&
        othersReceived(row.agent_id, "GR", row.channel, row.failing_since),
    )
    .map((row) => row.channel);
  return [...new Set(failing)].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
}

/**
 * 同じエージェントの同じ種別のほかのチャンネルが、`since` から後に受信できたか。チャンネルの問題か、アンテナやチューナーの問題かを分ける
 * (`recordFailed` と `failingGround` で同じ決まりにする)
 */
function othersReceived(
  agent: number,
  type: ChannelType,
  channel: string,
  since: number,
): boolean {
  return (
    orm()
      .select({ channel: channelReception.channel })
      .from(channelReception)
      .where(
        and(
          eq(channelReception.agent_id, agent),
          eq(channelReception.type, type),
          ne(channelReception.channel, channel),
          gte(channelReception.ok_at, since),
        ),
      )
      .get() !== undefined
  );
}
