import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ddbSection,
  diiSection,
  logoModule,
  packetize,
  patSection,
  pmtSection,
  stream,
} from "@danything/arib/synth";

import { fakeAgentTls, fakeAgentUrl } from "./fake-agent";
import { trustFakeAgent } from "./fake-agent-trust";

/**
 * **アンテナとケーブルの両方で同じ BS の TS を受ける家。** 当たりの中継の控えは TS で持つので、アンテナの
 * `BS15:16625` で当たった TS は、それを再送信するケーブルのチャンネルでも当たり (`logo.carrierTargets`)。
 * アンテナの衛星のチューナーが録画で塞がっていれば、ケーブルのチャンネルで待つ (`freeRelay`)。
 * 取れたロゴは ONID・SID の同じアンテナの局にもケーブルの局にも入る (`store`)
 */
const ESS = 929;
const PMT_PID = 0x1f0;
const ES_PID = 0x1f1;
const DOWNLOAD_ID = 0x12345678;
const BLOCK = 8;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbe, 0xef,
]);
const bs = logoModule(0x05, [{ logoId: 1, services: [[4, 211]], data: PNG }]);
const CARRIER = stream(
  packetize(0x0000, patSection([[ESS, PMT_PID]])),
  packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
  packetize(
    ES_PID,
    diiSection(DOWNLOAD_ID, BLOCK, [
      { moduleId: 1, moduleSize: bs.length, moduleVersion: 1, name: "LOGO-05" },
    ]),
  ),
  ...Array.from({ length: Math.ceil(bs.length / BLOCK) }, (_, n) =>
    packetize(
      ES_PID,
      ddbSection(DOWNLOAD_ID, 1, 1, n, bs.subarray(n * BLOCK, (n + 1) * BLOCK)),
    ),
  ),
);

type Tuner = {
  types: string[];
  channel: { type: string; channel: string } | null;
  users: { use: string; priority: number }[];
};
/** 衛星のチューナーは録画で塞がっている (別の中継)。ケーブルのチューナーは空いている */
const tuners: Tuner[] = [
  {
    types: ["BS", "CS"],
    channel: { type: "BS", channel: "BS03_0" },
    users: [{ use: "recording 1", priority: 9 }],
  },
  { types: ["CATV"], channel: null, users: [] },
];
const opened: string[] = [];

const agent = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/stream") {
      const channel = url.searchParams.get("channel") ?? "";
      opened.push(channel);
      return new Response(
        Uint8Array.from(channel === "QC42" ? CARRIER : new Uint8Array(0)),
      );
    }
    return Response.json({
      tuners: tuners.map((tuner, index) => ({
        index,
        name: `T${index}`,
        disabled: false,
        rank: index,
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
const root = mkdtempSync(join(tmpdir(), "denpa-logo-cable-shared-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = fakeAgentUrl(agent.port!);
trustFakeAgent();

// アンテナの BS15:16625 で前に当たった (控えのキーは TS)
mkdirSync(join(root, "logos"), { recursive: true });
writeFileSync(
  join(root, "logos", "satellite-relays.json"),
  JSON.stringify({
    noCarousel: {},
    carriers: { "4:16625": Date.now() },
    absent: {},
    gaveUp: {},
  }),
);

const { orm } = await import("./db");
const { placeServices } = await import("./fake-channels");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { readLogo, stats, sweep } = await import("./logo");

const STATIONS = [
  { type: "BS", channel: "BS15_0" },
  { type: "CATV", channel: "QC42" },
] as const;
orm()
  .insert(services)
  .values(
    STATIONS.map((s) => ({
      id: serviceKey(4, 211, s.type),
      service_id: 211,
      network_id: 4,
      name: "局211",
      type: s.type,
      updated_at: 1,
    })),
  )
  .run();
placeServices(
  STATIONS.map((s) => ({
    id: serviceKey(4, 211, s.type),
    channel: s.channel,
    ts: 16625,
  })),
);

describe("アンテナとケーブルで同じ BS の TS を受ける", () => {
  test("待っている中継には、アンテナのチャンネルを先に出す", () => {
    expect(stats().satellite).toEqual({ missing: 2, carrier: "BS15_0" });
  });

  test("衛星のチューナーが塞がっていれば、同じ TS をケーブルで開き、両方の局にロゴが入る", async () => {
    await sweep();
    expect(opened).toEqual(["QC42"]);
    expect(readLogo(serviceKey(4, 211, "BS"))).not.toBeNull();
    expect(readLogo(serviceKey(4, 211, "CATV"))).not.toBeNull();
    expect(stats().satellite).toEqual({ missing: 0, carrier: null });
  });
});
