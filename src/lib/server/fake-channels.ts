/**
 * 単体テスト用: 局の行を、エージェントのチャンネルに置く (`agent_channels` と `services.transport_stream_id`)。
 * 局からチャンネルを引く所 (`agent-channels.serviceChannel`) を通すテストが、局の行を入れたあとに呼ぶ。
 * 写しは環境変数のものでないエージェントの行に置く (無ければ足す)。
 * `config.dbPath` を決めてから呼ぶ
 */
import { and, eq } from "drizzle-orm";

import { orm } from "./db";
import { agentChannels, agents, services } from "./schema";

/** チャンネルの名前から作る TS の番号。同じ種別・名前なら同じ TS */
function tsOf(type: string, channel: string): number {
  let hash = 0;
  for (const char of `${type}:${channel}`)
    hash = (hash * 31 + char.charCodeAt(0)) % 65_521;
  return hash + 1;
}

/** 写しを置くエージェントの行の宛先 (テストはここへ繋がない) */
const FAKE_ORIGIN = "https://fake-agent:25252";

/**
 * 写しを置く行。**環境変数のエージェントの行には置かない。** テストが `config.agentUrl` を差し替えると、
 * 起動の突き合わせ (`agents.syncEnvAgents`) が前の行を写しごと消すため
 */
function fakeAgent(): number {
  const row = orm()
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.origin, FAKE_ORIGIN), eq(agents.from_env, false)))
    .get();
  if (row !== undefined) return row.id;
  return orm()
    .insert(agents)
    .values({
      name: "fake-agent",
      origin: FAKE_ORIGIN,
      from_env: false,
      position: 1000,
      added_at: 0,
    })
    .returning({ id: agents.id })
    .get().id;
}

/** `placed` の局を、それぞれのチャンネルに置く。`agent` を渡さなければ写しのための行 (`fakeAgent`) */
export function placeServices(
  placed: readonly { id: number; channel: string }[],
  agent = fakeAgent(),
): void {
  for (const { id, channel } of placed) {
    const service = orm()
      .select({
        type: services.type,
        network_id: services.network_id,
        transport: services.transport,
      })
      .from(services)
      .where(eq(services.id, id))
      .get();
    if (service === undefined) throw new Error(`局 ${id} がありません`);
    const ts = tsOf(service.type, channel);
    orm()
      .update(services)
      .set({ transport_stream_id: ts })
      .where(eq(services.id, id))
      .run();
    orm()
      .insert(agentChannels)
      .values({
        agent_id: agent,
        type: service.type,
        channel,
        network_id: service.network_id,
        transport_stream_id: ts,
        transport: service.transport,
      })
      .onConflictDoNothing()
      .run();
  }
}
