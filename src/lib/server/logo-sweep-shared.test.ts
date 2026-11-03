import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
 * 「ロゴをいますぐ集める」を、**BS と CS で共通のチューナー 2 台**で回す (#1939)。
 *
 * 実機の報告では、`BS01_0`・`BS01_1`・`BS01_2`・`BS03_0` と外れの中継を当たったところで「CS の空きチューナーが
 * 無くなったため、残りは取りやめました」と止まり、当たりの中継 (`BS15_0`) まで行き着かなかった。
 * エージェントは誰も読まなくなった選局を少しの間畳まずに残す (余韻) ので、外れを閉じた直後の一覧では
 * チャンネルが付いたまま利用者が空になる。それを使用中と数えて、空きを 0 と見ていた。
 *
 * チューナーの API は手元に立てた偽物。閉じた選局はチャンネルを付けたまま利用者だけ空にして残す (余韻)。
 * カルーセルは作り物
 */
const ESS = 929;
const PMT_PID = 0x1f0;
const ES_PID = 0x1f1;
const DOWNLOAD_ID = 0x12345678;
const BLOCK = 8;
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbe, 0xef,
]);

const STATIONS = [
  { network: 4, sid: 101, type: "BS", channel: "BS01_0" },
  { network: 4, sid: 151, type: "BS", channel: "BS03_0" },
  { network: 4, sid: 211, type: "BS", channel: "BS15_0" },
  { network: 7, sid: 330, type: "CS", channel: "CS02" },
] as const;

const bs = logoModule(
  0x05,
  STATIONS.filter((s) => s.network === 4).map((s, i) => ({
    logoId: i + 1,
    services: [[s.network, s.sid]],
    data: PNG,
  })),
);
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

/** ロゴを流す中継。BS と CS のモジュールを 1 回ぶん流す */
const carrier = stream(
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
/** 外れの中継。PAT にエンジニアリングサービスがいない */
const miss = stream(packetize(0x0000, patSection([[101, 0x101]])));

type Tuner = {
  channel: { type: "BS" | "CS"; channel: string } | null;
  users: { use: string; priority: number }[];
};
let tuners: Tuner[] = [];
const opened: { channel: string; priority: number }[] = [];

/** 選ぶのは、利用者がいないか (空き・余韻)、引き継ぐ利用者しかいないチューナー。無ければ断る */
function pick(after: string[]): Tuner | undefined {
  return tuners.find((tuner) =>
    tuner.users.every((user) => after.includes(user.use)),
  );
}

const agent = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/denpa/stream") {
      const type = url.searchParams.get("type") as "BS" | "CS";
      const channel = url.searchParams.get("channel") ?? "";
      const use = url.searchParams.get("use") ?? "";
      const priority = Number(url.searchParams.get("priority"));
      const tuner = pick(url.searchParams.getAll("after"));
      if (tuner === undefined)
        return new Response("空きがありません", { status: 409 });
      opened.push({ channel, priority });
      tuner.channel = { type, channel };
      tuner.users = [{ use, priority }];
      // 抜けたら利用者だけ空にする。チャンネルは付いたまま (余韻)
      const leave = () => {
        tuner.users = tuner.users.filter((user) => user.use !== use);
      };
      const hit = channel === "BS15_0";
      /*
       * 外れの中継は少し遅らせて流す。2 つの手が同時に外れを開いて 2 台とも使い、
       * 閉じたあとは 2 台とも余韻になる (報告の `BS01_2` と `BS03_0`)
       */
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const send = () => {
              controller.enqueue(Uint8Array.from(hit ? carrier : miss));
              controller.close();
              leave();
            };
            if (hit) send();
            else setTimeout(send, 100);
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
        rank: 0,
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
const root = mkdtempSync(join(tmpdir(), "denpa-logo-sweep-shared-"));
config.dbPath = join(root, "denpa.db");
config.dataDir = root;
config.agentUrl = `http://127.0.0.1:${agent.port}`;

const { orm } = await import("./db");
const { services } = await import("./schema");
const { serviceKey } = await import("./tuner");
const { readLogo, sweepNow, sweepState } = await import("./logo");

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

async function finished(): Promise<void> {
  while (sweepState().running) await Bun.sleep(20);
}

describe("BS と CS で共通のチューナー 2 台で「ロゴをいますぐ集める」", () => {
  test("外れの中継を閉じた直後の余韻を空きとして数え、当たりの中継まで当たる", async () => {
    tuners = [
      { channel: null, users: [] },
      { channel: null, users: [] },
    ];
    const started = await sweepNow();
    expect(started.started).toBe(true);
    await finished();
    expect(sweepState().message).not.toContain("空きチューナー");
    expect(opened.map((o) => o.channel)).toContain("BS15_0");
    expect(logos()).toBe(STATIONS.length);
  });

  test("当たりと分かっている中継を外れ探しより先に開き、揃ったら残りの中継は開かない", async () => {
    for (const s of STATIONS)
      rmSync(join(root, "logos", `${serviceKey(s.network, s.sid)}.png`));
    opened.length = 0;
    // 1 台は番組表集めが使っている。空きは 1 台なので 1 つずつ回る
    tuners = [
      { channel: null, users: [] },
      {
        channel: { type: "BS", channel: "BS21_0" },
        users: [{ use: "epg BS21_0", priority: config.priority.epg }],
      },
    ];
    const started = await sweepNow();
    expect(started.started).toBe(true);
    await finished();
    expect(opened).toEqual([
      { channel: "BS15_0", priority: config.priority.carousel },
    ]);
    expect(logos()).toBe(STATIONS.length);
  });
});
