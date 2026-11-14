import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
 * **アンテナが無く、ケーブル (CATV) だけを受ける家でも、BS の再送信の局のロゴを取得する** (`logo.logoSource`・`awaitCarousel`)。
 *
 * ケーブルの BS の再送信は TS が元の BS と同じ (ONID 4・TSID も同じ)。カルーセルを積んだ BS の TS を再送信しているチャンネルが
 * あれば、そこを開いて待つ。どのチャンネルかは決め打ちせず、BS の再送信のチャンネルを 1 秒ほどの PAT で当たっていく。
 * 地上波の再送信と自主放送のチャンネルは、カルーセルを探しに開かない。4K (TLV) の局は取得しない
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
  return Array.from({ length: Math.ceil(module.length / BLOCK) }, (_, n) =>
    packetize(
      ES_PID,
      ddbSection(
        DOWNLOAD_ID,
        moduleId,
        1,
        n,
        module.subarray(n * BLOCK, (n + 1) * BLOCK),
      ),
    ),
  );
}

/** カルーセルを積んだ BS の TS。1 回で読み切れる (BS と CS のモジュールが揃う) */
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
const MISS = stream(packetize(0x0000, patSection([[200, 0x101]])));
const streams = new Map<string, Uint8Array>([
  ["QC15", MISS],
  ["QC42", CARRIER],
]);
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
        Uint8Array.from(streams.get(channel) ?? new Uint8Array(0)),
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
const root = mkdtempSync(join(tmpdir(), "denpa-logo-cable-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = fakeAgentUrl(agent.port!);
trustFakeAgent();

const { orm } = await import("./db");
const { placeServices } = await import("./fake-channels");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { cdtVerdict, logoSource, readLogo, stats, sweep } =
  await import("./logo");

/** ケーブルの回線 (J:COM の回線で見えた形。TSID は実機と同じ) */
const STATIONS = [
  // BS の再送信 (TSMF。ONID 4)。QC42 がカルーセルを積んだ BS の TS
  { network: 4, sid: 200, channel: "QC15", ts: 18675, transport: "ts" },
  { network: 4, sid: 211, channel: "QC42", ts: 16625, transport: "ts" },
  // 地上波の再送信 (ONID 0x7FE0)
  { network: 0x7fe0, sid: 1024, channel: "QU55", ts: 0x7fe0, transport: "ts" },
  // 自主放送
  { network: 0xfffe, sid: 99, channel: "QC35", ts: 0x23, transport: "ts" },
  // 4K (TLV)
  { network: 0x000b, sid: 101, channel: "QC26", ts: 0xb111, transport: "tlv" },
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
      transport: s.transport,
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

describe("ロゴの出どころ (logoSource)", () => {
  const cable = (network: number, transport = "ts", decodable = true) =>
    logoSource({
      type: "CATV",
      network_id: network,
      transport_stream_id: 1,
      transport,
      decodable,
    });

  test("ケーブルの局は元の放送で分ける", () => {
    expect(cable(4)).toBe("carousel");
    expect(cable(7)).toBe("carousel");
    expect(cable(0x7fe0)).toBe("cdt");
    expect(cable(0xfffe)).toBe("cdt");
  });

  test("4K・TLV・復号できない局・スカパー！プレミアムの局は取得しない", () => {
    expect(cable(0x000b)).toBeNull();
    expect(cable(4, "tlv")).toBeNull();
    expect(cable(4, "ts", false)).toBeNull();
    expect(
      logoSource({
        type: "SKY",
        network_id: 1,
        transport_stream_id: 1,
        transport: "ts",
        decodable: true,
      }),
    ).toBeNull();
  });

  test("アンテナの局は今までどおり", () => {
    const antenna = (type: string) =>
      logoSource({
        type,
        network_id: type === "GR" ? 0x7fe0 : 4,
        transport_stream_id: 1,
        transport: "ts",
        decodable: true,
      });
    expect(antenna("GR")).toBe("cdt");
    expect(antenna("BS")).toBe("carousel");
    expect(antenna("CS")).toBe("carousel");
  });
});

describe("CDT が来なかったと言えるか (cdtVerdict)", () => {
  test("1 つでも来れば来た", () => {
    expect(cdtVerdict(1, false, 1)).toBe(true);
  });

  test("6 分開けきって 0 なら来なかった。短い共有や途中で切れた回は決めない", () => {
    expect(cdtVerdict(0, true, 6 * 60_000)).toBe(false);
    expect(cdtVerdict(0, true, 3 * 60_000)).toBeNull();
    expect(cdtVerdict(0, false, 6 * 60_000)).toBeNull();
  });
});

describe("ケーブルだけの家で BS の再送信のロゴを集める", () => {
  test("BS の再送信のチャンネルだけを当たり、カルーセルを積んだチャンネルで取得する", async () => {
    await sweep();
    expect(opened).toEqual(["QC15", "QC42"]);
    expect(readLogo(serviceKey(4, 211, "CATV"))).not.toBeNull();
  });

  test("カルーセルに載っていなかった局は取れない局に数え、待っている表示は消える", () => {
    expect(readLogo(serviceKey(4, 200, "CATV"))).toBeNull();
    const now = stats();
    expect(now.unavailable).toBe(1);
    expect(now.satellite).toEqual({ missing: 0, carrier: null });
    // 4K の局は数えない (地上波の再送信・BS の再送信 2・自主放送の 4 局)
    expect(now.total).toBe(4);
  });
});
