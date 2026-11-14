import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packetize, stream, withCrc } from "@danything/arib/synth";

import { fakeAgentTls, fakeAgentUrl } from "./fake-agent";
import { trustFakeAgent } from "./fake-agent-trust";

/**
 * **ケーブルの地上波の再送信と自主放送は、その TS の CDT から取得する** (`logo.logoSource` が `cdt`)。
 *
 * 6 分開いても CDT が来なかったケーブルの TS は控え (`noCdt`)、1 週間 (`NO_CDT_RETRY`) はその TS の局を取得しない。
 * 「ロゴをいますぐ集める」を押すたびに 6 分ずつ空振りしないため。控えが古くなれば、また取得する
 */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad,
]);
const be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const NETWORK = 0x7fe0;

/** CDT (data_type=0x01 がロゴ) */
function cdtSection(logoId: number, data: Uint8Array): Uint8Array {
  return withCrc([
    0xc8,
    0x00,
    0x00,
    ...be(0x0004),
    0xc1,
    0x00,
    0x00,
    ...be(NETWORK),
    0x01,
    ...be(0xf000),
    0x05,
    ...be(logoId),
    ...be(1),
    ...be(data.length),
    ...data,
  ]);
}

/** SDT の logo_transmission_descriptor (0xCF) 付き */
function sdtWithLogo(serviceId: number, logoId: number): Uint8Array {
  const descriptor = [0xcf, 0x07, 0x01, ...be(logoId), ...be(1), ...be(1)];
  return withCrc([
    0x42,
    0x00,
    0x00,
    ...be(NETWORK),
    0xc1,
    0x00,
    0x00,
    ...be(NETWORK),
    0xff,
    ...be(serviceId),
    0xfc,
    ...be(0x8000 | descriptor.length),
    ...descriptor,
  ]);
}

const GROUND = stream(
  packetize(0x0029, cdtSection(3, PNG)),
  packetize(0x0011, sdtWithLogo(1024, 3)),
);
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
        Uint8Array.from(channel === "QU55" ? GROUND : new Uint8Array(0)),
      );
    }
    return Response.json({
      tuners: [0, 1].map((index) => ({
        index,
        name: `C${index}`,
        types: ["CATV"],
        disabled: false,
        rank: index,
        device: null,
        lnb: null,
        error: null,
        channel: null,
        users: [],
      })),
    });
  },
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
const root = mkdtempSync(join(tmpdir(), "denpa-logo-cable-cdt-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = fakeAgentUrl(agent.port!);
trustFakeAgent();

// QC35 の TS は 2 日前に 6 分開いて CDT が来なかった。QC36 の TS は 8 日前 (控えが古い)。QC42 の BS の TS は当たり
const day = 24 * 60 * 60_000;
mkdirSync(join(root, "logos"), { recursive: true });
writeFileSync(
  join(root, "logos", "satellite-relays.json"),
  JSON.stringify({
    noCarousel: {},
    carriers: { "4:16625": Date.now() },
    noCdt: {
      [`${0xfffe}:${0x23}`]: Date.now() - 2 * day,
      [`${0xfffe}:${0x27}`]: Date.now() - 8 * day,
    },
    absent: {},
    gaveUp: {},
  }),
);

const { orm } = await import("./db");
const { placeServices } = await import("./fake-channels");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { logoSource, readLogo, stats, sweepNow, sweepState } =
  await import("./logo");

const STATIONS = [
  { network: NETWORK, sid: 1024, channel: "QU55", ts: NETWORK },
  { network: 0xfffe, sid: 99, channel: "QC35", ts: 0x23 },
  { network: 0xfffe, sid: 98, channel: "QC36", ts: 0x27 },
  { network: 4, sid: 211, channel: "QC42", ts: 16625 },
] as const;
orm()
  .insert(services)
  .values(
    STATIONS.map((s) => ({
      id: serviceKey(s.network, s.sid, "CATV"),
      service_id: s.sid,
      network_id: s.network,
      name: `局${s.sid}`,
      type: "CATV" as const,
      updated_at: 1,
    })),
  )
  .run();
placeServices(
  STATIONS.map((s) => ({
    id: serviceKey(s.network, s.sid, "CATV"),
    channel: s.channel,
    ts: s.ts,
  })),
);

const ownStation = (ts: number) =>
  logoSource({
    type: "CATV",
    network_id: 0xfffe,
    transport_stream_id: ts,
    transport: "ts",
    decodable: true,
  });

describe("ケーブルの CDT", () => {
  test("CDT が来なかったと控えた TS の局は取得しない。控えが古ければまた取得する", () => {
    expect(ownStation(0x23)).toBeNull();
    expect(ownStation(0x27)).toBe("cdt");
    // 取得する局は QU55・QC36・QC42 の 3 局
    expect(stats().total).toBe(3);
  });

  test("ロゴを積んだ中継がケーブルなら、そう添えて出す", () => {
    expect(stats().satellite).toEqual({
      missing: 1,
      carrier: "QC42 (ケーブル)",
    });
  });

  test("「いますぐ」は控えた TS を開かず、地上波の再送信の CDT からロゴを取得する", async () => {
    const result = await sweepNow();
    expect(result.started).toBe(true);
    for (let i = 0; i < 200 && sweepState().running; i++) await Bun.sleep(20);
    expect(sweepState().running).toBe(false);
    expect(opened).toContain("QU55");
    expect(opened).toContain("QC36");
    expect(opened).not.toContain("QC35");
    expect(readLogo(serviceKey(NETWORK, 1024, "CATV"))).not.toBeNull();
    // 途中で切れた回 (6 分開けきっていない) は、CDT が来なかった証拠にしない
    expect(ownStation(0x27)).toBe("cdt");
  });
});
