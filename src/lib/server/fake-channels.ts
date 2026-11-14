/**
 * 単体テスト用: 局の行を、エージェントのチャンネルに置く (`agent_channels` と `services.transport_stream_id`)。
 * 局からチャンネルを引く所 (`agent-channels.serviceChannel`・`servicePlaces`) を通すテストが、局の行を入れたあとに呼ぶ。
 * 写しは、`config.agentUrl` にエージェントを書いてあれば並びの先頭のエージェントの行 (選局はそこへ送る)、
 * 無ければ環境変数のものでないエージェントの行に置く (無ければ足す)。
 * `config.dbPath` を決めてから呼ぶ。選局を送るテストは、`config.agentUrl` を決めてから呼ぶ
 * (差し替えると、起動の突き合わせ `agents.syncEnvAgents` が前の行を写しごと消す)
 */
import { and, eq } from "drizzle-orm";

import { listAgents } from "./agents";
import { config } from "./config";
import { orm } from "./db";
import { agentChannels, agents, services } from "./schema";

/** チャンネルの名前から作る TS の番号。同じ種別・名前なら同じ TS (`placeServices` で `ts` を渡さなかったとき) */
export function tsOf(type: string, channel: string): number {
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

/** 写しを置く行。環境変数にエージェントを書いてあれば並びの先頭、無ければ写しのための行 (`fakeAgent`) */
function placeAgent(): number {
  if (config.agentUrl.trim() === "") return fakeAgent();
  return listAgents()[0]?.id ?? fakeAgent();
}

/**
 * `placed` の局を、それぞれのチャンネルに置く。`agent` を渡さなければ `placeAgent`。
 * `ts` を渡すとその transport_stream_id にする (アンテナとケーブルで同じ TS を受けるとき)。渡さなければ `tsOf`
 */
export function placeServices(
  placed: readonly { id: number; channel: string; ts?: number }[],
  agent = placeAgent(),
): void {
  for (const { id, channel, ts: given } of placed) {
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
    const ts = given ?? tsOf(service.type, channel);
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
