import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packetize, patSection, stream } from "@danything/arib/synth";

import { fakeAgentTls, fakeAgentUrl, trustFakeAgent } from "./fake-agent";

/**
 * **外れの控えが 1 週間 (`RELAY_RETRY`) を過ぎた中継をもう一度開いて、また外れだったら、控えの時刻を書き直す** (`logo.markRelay`)。
 * 書き直さないと控えが古いままになり、定期の取得のたびに同じ中継を開き直す
 */
const MISS = stream(packetize(0x0000, patSection([[101, 0x101]])));
const opened: string[] = [];

const agent = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/stream") {
      opened.push(url.searchParams.get("channel") ?? "");
      return new Response(Uint8Array.from(MISS));
    }
    return Response.json({
      tuners: [
        {
          index: 0,
          name: "S0",
          types: ["BS", "CS"],
          disabled: false,
          rank: 0,
          device: null,
          lnb: null,
          error: null,
          channel: null,
          users: [],
        },
      ],
    });
  },
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
const root = mkdtempSync(join(tmpdir(), "denpa-logo-relay-expiry-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = fakeAgentUrl(agent.port!);
trustFakeAgent();

const notesPath = join(root, "logos", "satellite-relays.json");
const stale = Date.now() - 8 * 24 * 60 * 60_000;
mkdirSync(join(root, "logos"), { recursive: true });
writeFileSync(
  notesPath,
  JSON.stringify({
    noCarousel: { BS01_0: stale },
    carriers: {},
    absent: {},
    gaveUp: {},
  }),
);

const { orm } = await import("./db");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { sweep } = await import("./logo");

orm()
  .insert(services)
  .values({
    id: serviceKey(4, 101),
    service_id: 101,
    network_id: 4,
    name: "局101",
    type: "BS",
    channel: "BS01_0",
    updated_at: 1,
  })
  .run();

test("古い外れの控えは開き直し、また外れなら時刻を書き直して次は開かない", async () => {
  await sweep();
  expect(opened).toEqual(["BS01_0"]);
  const notes = JSON.parse(readFileSync(notesPath, "utf8")) as {
    noCarousel: Record<string, number>;
  };
  expect(notes.noCarousel["BS01_0"]).toBeGreaterThan(stale);
  await sweep();
  expect(opened).toEqual(["BS01_0"]);
});
