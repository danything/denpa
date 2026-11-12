import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packetize, patSection, stream } from "@danything/arib/synth";

import { fakeAgentTls, fakeAgentUrl } from "./fake-agent";
import { trustFakeAgent } from "./fake-agent-trust";

/**
 * 「ロゴをいますぐ集める」を、**地上波のチューナー 1 台と衛星のチューナー 2 台**で回す。
 *
 * 衛星の空きが 2 台なので 2 つの手で回る。地上波は 1 台しかないので、2 つの手が同じ地上波の空きを取り合う。
 * 開けなかったほうが、もう一方が使っている台を「空きが無い」と取り違え、地上波の残りを取りやめていた。
 *
 * チューナーの API は手元に立てた偽物。中継はどれもロゴを流さない (PAT だけ流して閉じる)
 */
const STATIONS = [
  { network: 32391, sid: 23608, type: "GR", channel: "T16" },
  { network: 32392, sid: 23609, type: "GR", channel: "T17" },
  { network: 4, sid: 101, type: "BS", channel: "BS01_0" },
] as const;

const empty = stream(packetize(0x0000, patSection([[101, 0x101]])));

type Tuner = {
  types: ("GR" | "BS" | "CS")[];
  channel: { type: string; channel: string } | null;
  users: { use: string; priority: number }[];
};
let tuners: Tuner[] = [];
const opened: string[] = [];

const agent = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/stream") {
      const type = url.searchParams.get("type") as Tuner["types"][number];
      const channel = url.searchParams.get("channel") ?? "";
      const use = url.searchParams.get("use") ?? "";
      const priority = Number(url.searchParams.get("priority"));
      const after = url.searchParams.getAll("after");
      const tuner = tuners.find(
        (t) =>
          t.types.includes(type) &&
          t.users.every((user) => after.includes(user.use)),
      );
      if (tuner === undefined)
        return new Response("空きがありません", { status: 409 });
      opened.push(channel);
      tuner.channel = { type, channel };
      tuner.users = [{ use, priority }];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(Uint8Array.from(empty));
              controller.close();
              tuner.users = tuner.users.filter((user) => user.use !== use);
            }, 100);
          },
        }),
      );
    }
    return Response.json({
      tuners: tuners.map((tuner, index) => ({
        index,
        name: `S${index}`,
        disabled: false,
        rank: 0,
        device: null,
        lnb: null,
        error: null,
        ...tuner,
      })),
    });
  },
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
const root = mkdtempSync(join(tmpdir(), "denpa-logo-sweep-ground-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = fakeAgentUrl(agent.port!);
trustFakeAgent();

const { orm } = await import("./db");
const { placeServices } = await import("./fake-channels");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { sweepNow, sweepState } = await import("./logo");

orm()
  .insert(services)
  .values(
    STATIONS.map((s) => ({
      id: serviceKey(s.network, s.sid, s.type),
      service_id: s.sid,
      network_id: s.network,
      name: `局${s.sid}`,
      type: s.type,
      updated_at: 1,
    })),
  )
  .run();
placeServices(
  STATIONS.map((s) => ({
    id: serviceKey(s.network, s.sid, s.type),
    channel: s.channel,
  })),
);

async function finished(): Promise<void> {
  while (sweepState().running) await Bun.sleep(20);
}

describe("地上波のチューナー 1 台で「ロゴをいますぐ集める」", () => {
  test("もう一方が使っている地上波を「空きが無い」と取り違えず、地上波を全部開く", async () => {
    tuners = [
      { types: ["GR"], channel: null, users: [] },
      { types: ["BS", "CS"], channel: null, users: [] },
      { types: ["BS", "CS"], channel: null, users: [] },
    ];
    const started = await sweepNow();
    expect(started.started).toBe(true);
    await finished();
    expect(sweepState().message).not.toContain("空きチューナー");
    expect(opened).toContain("T16");
    expect(opened).toContain("T17");
  });
});
