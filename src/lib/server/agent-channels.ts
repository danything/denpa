/**
 * **どの TS を、どのエージェントのどのチャンネルで受けられるか** (DB の `agent_channels`)。
 *
 * 控え (`channels.json`) はエージェントごとに持ち、denpa は取り込むたびにここへ写す (`epg.syncServices`)。
 * 局 (`services`) は局の ID で 1 行で、局からチャンネルを引くときは、局の TS (種別・`network_id`・`transport_stream_id`)
 * でここを引く (`serviceChannel`)。中継局の違いで、同じ TS を別の物理チャンネルで受けることがあるため、
 * 物理チャンネルは局に持たない。
 */
import { eq, notInArray, type SQL, sql } from "drizzle-orm";

import { orm } from "./db";
import { agentChannels, agents, channelReception, services } from "./schema";
import type { AgentChannel } from "./tuner";

/** 1 台のエージェントが返した控え */
export interface AgentChannels {
  /** `agents.id` */
  agent: number;
  channels: readonly AgentChannel[];
}

/** 1 台のエージェントの行を、返した控えで入れ直す。`syncServices` のトランザクションの中で呼ぶ */
export function storeAgentChannels(read: AgentChannels): void {
  orm()
    .delete(agentChannels)
    .where(eq(agentChannels.agent_id, read.agent))
    .run();
  for (const channel of read.channels) {
    orm()
      .insert(agentChannels)
      .values({
        agent_id: read.agent,
        type: channel.type,
        channel: channel.channel,
        network_id: channel.networkId,
        transport_stream_id: channel.transportStreamId,
        transport: channel.transport ?? "ts",
      })
      // 控えに同じチャンネルが 2 回あれば、後のものを使う (局の行と同じ)
      .onConflictDoUpdate({
        target: [
          agentChannels.agent_id,
          agentChannels.type,
          agentChannels.channel,
        ],
        set: {
          network_id: sql`excluded.network_id`,
          transport_stream_id: sql`excluded.transport_stream_id`,
          transport: sql`excluded.transport`,
        },
      })
      .run();
  }
}

/**
 * **行の無くなったエージェントの写しと受信の記録を消す** (`agents.syncEnvAgents`)。
 * 外部キーは効かせていないので、エージェントの行を消すところで一緒に消す
 */
export function forgetMissingAgents(): void {
  const ids = orm()
    .select({ id: agents.id })
    .from(agents)
    .all()
    .map((row) => row.id);
  orm()
    .delete(agentChannels)
    .where(notInArray(agentChannels.agent_id, ids))
    .run();
  orm()
    .delete(channelReception)
    .where(notInArray(channelReception.agent_id, ids))
    .run();
}

/** `agent_channels` の行が、外側の `services` の行の TS のものか */
function sameTs(): SQL {
  return sql`ac.type = ${services.type} AND ac.network_id = ${services.network_id} AND ac.transport_stream_id = ${services.transport_stream_id}`;
}

/**
 * **局を選局するときのチャンネルの名前** (`services` から読む select に入れる列)。
 *
 * 局の TS を受けられるエージェントのうち、並びの先頭のものを使う (選局を送るのが並びの先頭の 1 台のため。`agents.tuningAgents`)。
 * 同じエージェントで同じ TS を 2 つのチャンネルで受けられるときは、受信できないと決めていないほう、次に控えの後ろのほう
 * (局の行にチャンネルを 1 つ持っていた頃は、取り込みで後から書いたほうが残っていた)。
 * **エージェントの並びが先で、受信できるかは同じエージェントの中でだけ比べる。** 先頭のエージェントで受信できないと決めたチャンネルでも、
 * 2 台目で受信できれば局は外れず (`unreceivableService`)、ここは先頭のエージェントのチャンネルを返す。選局を送るのが先頭の 1 台だけのため。
 * どのエージェントに送るかを選局ごとに決めるようになったら、送る先のエージェントのチャンネルを引く。
 * どのエージェントの控えにも無い (上げてから一度も取り込んでいない) 局は null
 */
export function serviceChannel(): SQL<string | null> {
  return sql<string | null>`(SELECT ac.channel ${chosen()})`;
}

/** `serviceChannel` のチャンネルを控えに持つエージェント (`agents.id`)。受信の様子を出すのに使う */
export function serviceAgent(): SQL<number | null> {
  return sql<number | null>`(SELECT ac.agent_id ${chosen()})`;
}

/** `serviceChannel` と `serviceAgent` が選ぶ 1 行 (SELECT の後ろ) */
function chosen(): SQL {
  return sql`FROM agent_channels ac
    JOIN agents a ON a.id = ac.agent_id
    LEFT JOIN channel_reception r ON r.agent_id = ac.agent_id AND r.type = ac.type AND r.channel = ac.channel
    WHERE ${sameTs()}
    ORDER BY a.position, a.id, COALESCE(r.unreceivable, 0), ac.rowid DESC LIMIT 1`;
}

/**
 * **チューナーを共有できるかを比べるときのキー** (同時に録る予約の割り振り・ルールの重なり)。
 * 選局するチャンネル (`serviceChannel`) で、無ければその局だけのキー (何とも共有しない)。
 * 名前だけで比べるのは、選局を送るのが先頭の 1 台だけのため。送る先を選局ごとに決めるようになったら、エージェントも含めたキーにする
 */
export function shareKey(): SQL<string> {
  return sql<string>`COALESCE(${serviceChannel()}, '#' || ${services.id})`;
}

/**
 * **全部のエージェントで受信できないと決めた局** (`services` の行の条件)。
 * 局の TS を控えに持つエージェントが 1 台以上あり、その全部で、TS を受けるチャンネルが受信できないと決めてあるもの。
 * どのエージェントの控えにも無い局は入らない (受信できないとは決めていない)
 */
export function unreceivableService(): SQL {
  return sql`(EXISTS (SELECT 1 FROM agent_channels ac WHERE ${sameTs()})
    AND NOT EXISTS (SELECT 1 FROM agent_channels ac
      LEFT JOIN channel_reception r ON r.agent_id = ac.agent_id AND r.type = ac.type AND r.channel = ac.channel
      WHERE ${sameTs()} AND COALESCE(r.unreceivable, 0) = 0))`;
}

/** 局のチャンネルの名前 (`serviceChannel`)。局が無いか、どの控えにも無ければ null */
export function channelOfService(serviceId: number): string | null {
  return (
    orm()
      .select({ channel: serviceChannel() })
      .from(services)
      .where(eq(services.id, serviceId))
      .get()?.channel ?? null
  );
}

/** 局のチャンネルが分からないとき (`serviceChannel` が null) の理由 */
export const NO_CHANNEL =
  "局のチャンネルがエージェントの控えにありません。局の取り込みを待つか、チャンネルスキャンをやり直してください";

/**
 * `answered` 以外のエージェント (今回一覧を返さなかったもの) の写しにある TS の局 (`services.id`)。
 * その台で受信できないと決めたチャンネルの TS は入れない (`epg.syncServices`)
 */
export function retainedServices(answered: readonly number[]): number[] {
  const others =
    answered.length === 0
      ? sql`1`
      : sql`ac.agent_id NOT IN (${sql.join(
          answered.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  return orm()
    .select({ id: services.id })
    .from(services)
    .where(
      sql`EXISTS (SELECT 1 FROM agent_channels ac
        JOIN agents a ON a.id = ac.agent_id
        LEFT JOIN channel_reception r ON r.agent_id = ac.agent_id AND r.type = ac.type AND r.channel = ac.channel
        WHERE ${sameTs()} AND ${others} AND COALESCE(r.unreceivable, 0) = 0)`,
    )
    .all()
    .map((row) => row.id);
}
