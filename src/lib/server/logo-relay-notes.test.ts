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

/**
 * **当たりの中継を「外れ」と控えてしまっても、「ロゴをいますぐ集める」で当たり直せる** (`logo.sweepNow`)。
 *
 * Linux DVB の dvr には前の選局の残りが溜まったままで (エージェントは直した。`DvbTuner.Tune`)、
 * 当たりの中継 (BS15_0) の頭で前の中継の PAT を読み、1週間「外れ」と控えることがあった。どの中継も
 * 外れと控えられていると、定期の取得は何も開かず、押しても「ロゴはすべて取得済みです」と言われるだけだった
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
const cs = logoModule(0x05, [{ logoId: 1, services: [[7, 330]], data: PNG }]);

function blocks(moduleId: number, module: Uint8Array): Uint8Array[] {
  const list: Uint8Array[] = [];
  for (let at = 0, n = 0; at < module.length; at += BLOCK, n++)
    list.push(
      packetize(
        ES_PID,
        ddbSection(
          DOWNLOAD_ID,
          moduleId,
          1,
          n,
          module.subarray(at, at + BLOCK),
        ),
      ),
    );
  return list;
}

/** 当たりの中継。1回でカルーセルを読み切れる */
const CARRIER = stream(
  packetize(0x0000, patSection([[ESS, PMT_PID]])),
  packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
  packetize(
    ES_PID,
    diiSection(DOWNLOAD_ID, BLOCK, [
      { moduleId: 1, moduleSize: bs.length, moduleVersion: 1, name: "LOGO-05" },
      {
        moduleId: 2,
        moduleSize: cs.length,
        moduleVersion: 1,
        name: "CS_LOGO-05",
      },
    ]),
  ),
  ...blocks(1, bs),
  ...blocks(2, cs),
);
const MISS = stream(packetize(0x0000, patSection([[101, 0x101]])));
const streams = new Map<string, Uint8Array>([
  ["BS01_0", MISS],
  ["BS15_0", CARRIER],
  ["CS02", MISS],
]);
const opened: string[] = [];

const agent = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/stream") {
      const channel = url.searchParams.get("channel") ?? "";
      opened.push(channel);
      return new Response(
        Uint8Array.from(streams.get(channel) ?? new Uint8Array(0)),
      );
    }
    return Response.json({
      tuners: [0, 1].map((index) => ({
        index,
        name: `S${index}`,
        types: ["BS", "CS"],
        disabled: false,
        rank: index,
        device: null,
        lnb: null,
        pid: null,
        error: null,
        channel: null,
        users: [],
      })),
    });
  },
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
const root = mkdtempSync(join(tmpdir(), "denpa-logo-relay-notes-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = `http://127.0.0.1:${agent.port}`;

// 前の選局の PAT を見て、当たりの中継まで外れと控えてしまった後
mkdirSync(join(root, "logos"), { recursive: true });
const now = Date.now();
writeFileSync(
  join(root, "logos", "satellite-relays.json"),
  JSON.stringify({
    noCarousel: { BS01_0: now, BS15_0: now, CS02: now },
    carriers: {},
    absent: {},
    gaveUp: {},
  }),
);

const { orm } = await import("./db");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { readLogo, stats, sweep, sweepNow, sweepState } = await import("./logo");

const STATIONS = [
  { network: 4, sid: 101, type: "BS", channel: "BS01_0" },
  { network: 4, sid: 211, type: "BS", channel: "BS15_0" },
  { network: 7, sid: 330, type: "CS", channel: "CS02" },
] as const;
orm()
  .insert(services)
  .values(
    STATIONS.map((s) => ({
      id: serviceKey(s.network, s.sid),
      service_id: s.sid,
      network_id: s.network,
      name: `局${s.sid}`,
      type: s.type,
      channel: s.channel,
      updated_at: 1,
    })),
  )
  .run();

describe("外れの控えが間違っていても当たり直せる", () => {
  test("どの中継も外れと控えられていると、定期の取得は何も開かない", async () => {
    await sweep();
    expect(opened).toEqual([]);
    expect(stats().satellite).toEqual({ missing: 3, carrier: null });
  });

  test("「いますぐ」を押すと外れの控えを捨てて当たり直し、当たりの中継でロゴを揃える", async () => {
    const result = await sweepNow();
    expect(result.started).toBe(true);
    for (let i = 0; i < 100 && sweepState().running; i++) await Bun.sleep(20);
    expect(sweepState().running).toBe(false);
    expect(opened).toContain("BS15_0");
    expect(readLogo(serviceKey(4, 211))).not.toBeNull();
    expect(readLogo(serviceKey(7, 330))).not.toBeNull();
  });
});
