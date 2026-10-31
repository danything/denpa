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

/**
 * 衛星のロゴを、**チューナーを取り合いながら**揃える (`logo.ride` / `logo.sweep`)。
 *
 * 実機の報告: 衛星のチューナーが2台の環境で、地上波のロゴは揃ったのに BS/CS は何日経っても進まなかった。
 * カルーセルは十数分に一度しか流れてこないのに、共有は3分で切り上げ、番組表集めやライブに
 * 取り上げられるたびに一から読み直していた。
 *
 * チューナーの API は手元に立てた偽物で、`tuners` は場面ごとに差し替え、選局は中継ごとに用意した TS を
 * 流して閉じる (閉じる = 優先度の高い要求に譲った)。カルーセルは作り物
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
/** ブロックを3回に分ける。どの回もそれだけでは揃わない */
const thirds = (list: Uint8Array[]) => {
  const size = Math.ceil(list.length / 3);
  return [0, 1, 2].map((i) => list.slice(i * size, (i + 1) * size));
};
const bsParts = thirds(blocks(BS_MODULE, bs));
const csParts = thirds(blocks(CS_MODULE, cs));
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
/** 当たりの中継の n 回目。DII が流れるのは最初だけで、2回目からはブロックだけ */
const part = (n: number) =>
  stream(...psi, ...(n === 0 ? [dii] : []), ...bsParts[n]!, ...csParts[n]!);
/** ロゴを積んでいない中継。PAT にエンジニアリングサービスがいない */
const MISS = stream(packetize(0x0000, patSection([[101, 0x101]])));

type Tuner = {
  channel: { type: "BS" | "CS"; channel: string } | null;
  users: { use: string; priority: number }[];
};
const idle = (): Tuner => ({ channel: null, users: [] });
const busy = (): Tuner[] => [
  {
    channel: { type: "BS", channel: "BS09_0" },
    users: [{ use: "live BS09_0", priority: 9 }],
  },
  {
    channel: { type: "CS", channel: "CS08" },
    users: [{ use: "epg CS08", priority: 3 }],
  },
];
let tuners: Tuner[] = busy();
/** 中継ごとに、次に選局されたときに流すもの */
const streams = new Map<string, Uint8Array>([["BS01_0", MISS]]);
const opened: string[] = [];
/** 名乗り (`use`)。設定の「チューナー」にこのまま出る */
const uses = new Set<string>();

const agent = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/stream") {
      const channel = url.searchParams.get("channel") ?? "";
      opened.push(channel);
      uses.add(url.searchParams.get("use") ?? "");
      return new Response(
        Uint8Array.from(streams.get(channel) ?? new Uint8Array(0)),
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
const root = mkdtempSync(join(tmpdir(), "denpa-logo-carousel-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = `http://127.0.0.1:${agent.port}`;

const { orm } = await import("./db");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { logoState, readLogo, ride, stats, sweep } = await import("./logo");

const STATIONS = [
  // カルーセルに載っていない局。読み切ったら「取れない局」になる
  { network: 4, sid: 101, type: "BS", channel: "BS01_0" },
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

describe("衛星のロゴをチューナーを取り合いながら揃える", () => {
  test("チューナーがどれも使われていれば、自分では開かない", async () => {
    await sweep();
    expect(opened).toEqual([]);
    expect(stats().satellite).toEqual({ missing: 4, carrier: null });
  });

  test("空いていれば、確かめていない中継を順に開いて当たりを探す。途中で取り上げられても読みかけを残す", async () => {
    tuners = [idle(), idle()];
    streams.set("BS15_0", part(0));
    await sweep();
    // 外れ (BS01_0) は PAT で見切って次へ。当たりで止まる (CS02 までは行かない)
    expect(opened).toEqual(["BS01_0", "BS15_0"]);
    expect(logos()).toBe(0);
    // 画面では「どこで待っているか」を言う
    expect(stats().satellite).toEqual({ missing: 4, carrier: "BS15_0" });
  });

  test("番組表集めの選局を共有して、続きを読む", async () => {
    tuners = [
      {
        channel: { type: "BS", channel: "BS15_0" },
        users: [{ use: "epg BS15_0", priority: 3 }],
      },
      idle(),
    ];
    streams.set("BS15_0", part(1));
    await ride();
    expect(opened).toEqual(["BS01_0", "BS15_0", "BS15_0"]);
    expect(logos()).toBe(0);
  });

  test("ほかの用途で塞がっていれば開かない", async () => {
    tuners = busy();
    await sweep();
    expect(opened).toHaveLength(3);
  });

  test("空いたら当たりの中継だけを開いて待ち、DII の来ない3回目で読み切る", async () => {
    tuners = [idle(), idle()];
    streams.set("BS15_0", part(2));
    await sweep();
    // 外れと分かった中継は開き直さない
    expect(opened).toEqual(["BS01_0", "BS15_0", "BS15_0", "BS15_0"]);
    expect(logos()).toBe(3);
    // 読み切っても来なかった局は「取れない局」。待っている局はもう無い
    expect(logoState(serviceKey(4, 101))).toBe("absent");
    expect(stats().satellite).toEqual({ missing: 0, carrier: null });
  });

  test("揃ったあとは開かない", async () => {
    await sweep();
    expect(opened).toHaveLength(4);
    expect([...uses]).toEqual(["logo BS/BS01_0", "logo BS/BS15_0"]);
  });
});
