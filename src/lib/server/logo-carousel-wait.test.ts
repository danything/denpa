import { afterAll, describe, expect, spyOn, test } from "bun:test";
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

/**
 * 衛星のロゴを流す中継で、**カルーセルが来るまで待つ** (`logo.awaitCarousel`・「いますぐ」)。
 *
 * 実機の報告 (#1939): 衛星のチューナーが2台の環境で、番組表集めが次のチャンネルへ移るたびにロゴの選局を
 * 取り上げ、一晩経っても BS/CS のロゴが揃わなかった。当たりの中継で待つときは番組表集めより上の優先度で開き、
 * 上限で切れても途中まで届いていれば6時間空けずに続きを読む。
 *
 * チューナーの API は手元に立てた偽物で、選局は中継ごとに用意した TS を流したあと、`holding` の中継は
 * こちらが閉じるまで開いたままにする (上限 `config.logoCarouselWait` まで待たせるため)。カルーセルは作り物
 */
const ESS = 929;
const PMT_PID = 0x1f0;
const ES_PID = 0x1f1;
const DOWNLOAD_ID = 0x12345678;
const BS_MODULE = 1;
const CS_MODULE = 2;
const BLOCK = 8;
/** PNG の署名だけのもの。中身は問わない */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbe, 0xef,
]);

const bs = logoModule(0x05, [
  { logoId: 1, services: [[4, 211]], data: PNG },
  { logoId: 2, services: [[4, 212]], data: PNG },
]);
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
const bsBlocks = blocks(BS_MODULE, bs);
const csBlocks = blocks(CS_MODULE, cs);
const psi = [
  packetize(0x0000, patSection([[ESS, PMT_PID]])),
  packetize(PMT_PID, pmtSection(ESS, ES_PID, 0x79)),
];
const dii = packetize(
  ES_PID,
  diiSection(DOWNLOAD_ID, BLOCK, [
    {
      moduleId: BS_MODULE,
      moduleSize: bs.length,
      moduleVersion: 1,
      name: "LOGO-05",
    },
    {
      moduleId: CS_MODULE,
      moduleSize: cs.length,
      moduleVersion: 1,
      name: "CS_LOGO-05",
    },
  ]),
);

type Tuner = {
  channel: { type: "BS" | "CS"; channel: string } | null;
  users: { use: string; priority: number }[];
};
const idle = (): Tuner => ({ channel: null, users: [] });
const tuners: Tuner[] = [idle(), idle()];
/** 中継ごとに、次に選局されたときに流すもの */
const streams = new Map<string, Uint8Array>();
/** 流し終えても閉じない中継 */
const holding = new Set<string>();
/** 開かれた中継と、そのときの優先度 */
const opened: { channel: string; priority: number }[] = [];

const agent = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/stream") {
      const channel = url.searchParams.get("channel") ?? "";
      opened.push({
        channel,
        priority: Number(url.searchParams.get("priority")),
      });
      const data = Uint8Array.from(streams.get(channel) ?? new Uint8Array(0));
      const hold = holding.has(channel);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            if (!hold) controller.close();
          },
        }),
      );
    }
    return Response.json({
      tuners: tuners.map((tuner, index) => ({
        index,
        name: `S${index}`,
        types: ["BS", "CS"],
        disabled: false,
        rank: index,
        device: null,
        lnb: null,
        pid: null,
        error: null,
        ...tuner,
      })),
    });
  },
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
const root = mkdtempSync(join(tmpdir(), "denpa-logo-carousel-wait-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = `http://127.0.0.1:${agent.port}`;
// 同じプロセスで走るほかのテストファイルへ持ち越さない
const wait = config.logoCarouselWait;
afterAll(() => {
  config.logoCarouselWait = wait;
});

const { orm } = await import("./db");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { readLogo, sweep, sweepNow, sweepState, waitedMessage } =
  await import("./logo");

const STATIONS = [
  { network: 4, sid: 211, type: "BS", channel: "BS15_0" },
  { network: 4, sid: 212, type: "BS", channel: "BS15_0" },
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

const logos = () =>
  STATIONS.filter((s) => readLogo(serviceKey(s.network, s.sid)) !== null)
    .length;

/** `sweep` の間に出た記録の行のうち、ロゴのもの */
async function logged(run: () => Promise<unknown>): Promise<string[]> {
  const spy = spyOn(console, "log");
  try {
    await run();
    return spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[logo]"));
  } finally {
    spy.mockRestore();
  }
}

describe("ロゴを流す中継でカルーセルを待つ", () => {
  test("当たりが分かるまではいちばん下の優先度で探す。上限で切れても途中まで届いていれば、6時間空けずに次も開く", async () => {
    config.logoCarouselWait = 300;
    // DII と BS のブロックの一部だけ。読み切れないまま上限で切れる
    streams.set("BS15_0", stream(...psi, dii, ...bsBlocks.slice(0, 1)));
    holding.add("BS15_0");
    const lines = await logged(sweep);
    expect(opened).toEqual([
      { channel: "BS15_0", priority: config.priority.logo },
    ]);
    expect(logos()).toBe(0);
    expect(lines).toEqual([
      "[logo] BS15_0 を 0 分開いて途中まで読みました。次に空いたときに続きから読みます",
    ]);
  });

  test("当たりと分かった中継は番組表集めより上の優先度で開く。何も届かずに上限で切れたら、6時間は開き直さない", async () => {
    // 前の回と同じ DII と受け取り済みのブロックだけ。読み進まないので「来なかった」と数える
    streams.set("BS15_0", stream(...psi, dii, ...bsBlocks.slice(0, 1)));
    const lines = await logged(sweep);
    expect(opened.at(-1)).toEqual({
      channel: "BS15_0",
      priority: config.priority.carousel,
    });
    expect(config.priority.carousel).toBeGreaterThan(config.priority.epg);
    expect(config.priority.carousel).toBeLessThan(config.priority.scan);
    expect(lines).toEqual([
      "[logo] BS15_0 を 0 分開いてもロゴが流れてこなかったので、6 時間あけて開き直します",
    ]);

    await sweep();
    expect(opened).toHaveLength(2);
  });

  test("「いますぐ」も当たりの中継は番組表集めより上の優先度で開き、読み切ったら上限を待たずに手放す", async () => {
    config.logoCarouselWait = 60_000;
    // DII は前の回に読んだぶんを覚えている。続きのブロックだけ流して、閉じずに待つ
    streams.set("BS15_0", stream(...psi, ...bsBlocks.slice(1), ...csBlocks));
    const startedAt = Date.now();
    const started = await sweepNow();
    expect(started.started).toBe(true);
    while (sweepState().running) await Bun.sleep(20);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(opened).toContainEqual({
      channel: "BS15_0",
      priority: config.priority.carousel,
    });
    // 当たりと分かっていない中継はいちばん下のまま
    expect(opened).toContainEqual({
      channel: "CS02",
      priority: config.priority.logo,
    });
    expect(logos()).toBe(3);
  });
});

describe("待ったあとの記録の1行", () => {
  test("読み切った・譲った・止めた・来なかったを言い分ける。外れと開けなかった回は出さない", () => {
    const minute = 60_000;
    expect(waitedMessage("BS15_0", "done", true, 14 * minute)).toBe(
      "BS15_0 を 14 分開いて、カルーセルを読み切りました",
    );
    expect(waitedMessage("BS15_0", "yielded", false, 8 * minute)).toBe(
      "BS15_0 を 8 分開いて、ほかの選局に譲りました。読んだところまでは覚えています",
    );
    expect(waitedMessage("BS15_0", "stopped", false, minute)).toBe(
      "BS15_0 を 1 分開いて、「ロゴをいますぐ集める」に譲りました",
    );
    expect(waitedMessage("BS15_0", "miss", false, 0)).toBeNull();
    expect(waitedMessage("BS15_0", "busy", false, 0)).toBeNull();
  });
});
