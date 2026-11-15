import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * **設定の「受信」の「チャンネル」に出す受信の様子** (`routes/settings/reception/channels.server.ts`)。
 * 同じ TS を 2 台のエージェントで受けられるとき、「受信できません」と出すのは 2 台とも受信できないと決めたときだけ
 */
const { config } = await import("./config");
const dir = mkdtempSync(join(tmpdir(), "denpa-reception-channels-"));
config.dataDir = dir;
config.dbPath = join(dir, "denpa.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { orm } = await import("./db");
const { agentChannels, agents, channelReception, services } =
  await import("./schema");
const { load } =
  await import("../../routes/settings/reception/channels.server");

const CHANNEL = "BS01:16400";
const TS = 16400;

/** 並びの先頭 (`position` 0) と 2 台目のエージェントの `agents.id` */
let first = 0;
let second = 0;

beforeEach(() => {
  orm().delete(channelReception).run();
  orm().delete(agentChannels).run();
  orm().delete(services).run();
  orm().delete(agents).run();
  const agent = (name: string, position: number) =>
    orm()
      .insert(agents)
      .values({
        name,
        origin: `https://${name}:25252`,
        from_env: false,
        position,
        added_at: 0,
      })
      .returning({ id: agents.id })
      .get().id;
  first = agent("first", 0);
  second = agent("second", 1);
  orm()
    .insert(services)
    .values({
      service_id: 101,
      network_id: 4,
      name: "BSでんぱ",
      type: "BS",
      transport_stream_id: TS,
      updated_at: 0,
    })
    .run();
  for (const id of [first, second])
    orm()
      .insert(agentChannels)
      .values({
        agent_id: id,
        type: "BS",
        channel: CHANNEL,
        network_id: 4,
        transport_stream_id: TS,
        transport: "ts",
      })
      .run();
});

/** そのエージェントでの受信の記録を書く。`unreceivable` なら受信できないと決めたもの */
function reception(agent: number, unreceivable: boolean): void {
  orm()
    .insert(channelReception)
    .values({
      agent_id: agent,
      type: "BS",
      channel: CHANNEL,
      ok_at: unreceivable ? null : 1,
      failures: unreceivable ? 2 : 0,
      unreceivable,
    })
    .run();
}

describe("受信の様子 (設定の「受信」)", () => {
  test("先頭のエージェントで受信できなくても、2 台目で受信できれば受信できるチャンネル", () => {
    reception(first, true);
    reception(second, false);
    const [entry] = load().channels;
    expect(entry?.reception).toBe("ok");
    // 受信の様子と測定は、選局する 2 台目のもの
    expect(entry?.agent).toBe(second);
  });

  test("2 台とも受信できないと決めたら「受信できません」", () => {
    reception(first, true);
    reception(second, true);
    const [entry] = load().channels;
    expect(entry?.reception).toBe("unreceivable");
    expect(entry?.agent).toBe(first);
  });

  test("どちらも受信できるなら、並びの先頭のエージェントのもの", () => {
    reception(first, false);
    reception(second, false);
    const [entry] = load().channels;
    expect(entry?.reception).toBe("ok");
    expect(entry?.agent).toBe(first);
  });
});
