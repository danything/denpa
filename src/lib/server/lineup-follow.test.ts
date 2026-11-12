import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NitReader, SdtReader } from "@danything/arib/psi";
import {
  nitSection,
  packetize,
  satelliteDeliveryDescriptor,
  sdtSection,
} from "@danything/arib/synth";

import { fakeAgentTls, fakeAgentUrl } from "./fake-agent";
import { trustFakeAgent } from "./fake-agent-trust";
import type { AgentChannel } from "./tuner";

/**
 * 再編に付いていく。合成の NIT を読ませ、偽のエージェントに預けた一覧を見る。
 * 値は本番の割当に合わせる (BS-15 の NHK BS 16625、BS-3 のアニマックス 17969)
 */
const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-follow-")), "denpa.db");
// 置き場 (組んだエージェントの証明書など) も同じ一時ディレクトリに。既定の /data は CI では書けない
config.dataDir = dirname(config.dbPath);

/** エージェントの控え。PUT で入れ替わる */
let saved: AgentChannel[] = [];
const puts: { channels: AgentChannel[]; scanned: string[] }[] = [];
const server = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/denpa/channels")
      return new Response("not found", { status: 404 });
    if (request.method === "PUT") {
      const body = (await request.json()) as {
        channels: AgentChannel[];
        scanned: string[];
      };
      puts.push(body);
      saved = [
        ...saved.filter((c) => !body.scanned.includes(c.type)),
        ...body.channels,
      ];
    }
    return Response.json(saved);
  },
});
config.agentUrl = fakeAgentUrl(server.port!);
trustFakeAgent();

const { orm } = await import("./db");
const { channelChanges } = await import("./schema");
const {
  changeText,
  followLineup,
  lineupDiff,
  lineupNotice,
  seenLineupChanges,
} = await import("./lineup-follow");

/** 時刻を渡して進める (2 回目に数えるのは 5 分たってから) */
const T = 1_800_000_000_000;
const MIN = 60_000;
const BS3 = 11_765_840;
const BS15 = 11_996_000;

const entry = (
  channel: string,
  tsid: number,
  services: [number, string][],
  type: "BS" | "CS" = "BS",
  networkId = 4,
): AgentChannel => ({
  type,
  channel,
  networkId,
  transportStreamId: tsid,
  remoteControlKeyId: null,
  services: services.map(([serviceId, name]) => ({
    serviceId,
    serviceType: 1,
    name,
  })),
});

/** 読んだ NIT と SDT。`streams` は [TSID, 周波数, サービス ID[]] */
function read(
  streams: [number, number, number[]][],
  version: number,
): { nit: NitReader; sdt: SdtReader } {
  const nit = new NitReader();
  nit.feed(
    packetize(
      0x10,
      nitSection(
        4,
        null,
        streams.map(([tsid, frequency, ids]) => [
          tsid,
          4,
          ids.map((id) => [id, 0x01] as [number, number]),
          satelliteDeliveryDescriptor(frequency),
        ]),
        { version },
      ),
    ),
  );
  const sdt = new SdtReader();
  for (const [i, [tsid, , ids]] of streams.entries()) {
    sdt.feed(
      packetize(
        0x11,
        sdtSection(
          tsid,
          4,
          ids.map((id) => [id, 0x01, `局${id}`] as [number, number, string]),
          { other: i > 0 },
        ),
        i,
      ),
    );
  }
  return { nit, sdt };
}

describe("一覧の違い", () => {
  test("新しい局・終わった局・移った局を数える", () => {
    const current = [
      entry("BS15:16625", 16625, [[101, "NHK BS"]]),
      entry("BS03:17970", 17970, [[251, "釣りビジョン"]]),
    ];
    const next = [
      entry("BS15:16625", 16625, [[101, "NHK BS"]]),
      entry("BS03:17969", 17969, [
        [236, "アニマックス"],
        [252, "BS12 2"],
      ]),
      entry("BS21:18256", 18256, [[251, "釣りビジョン"]]),
    ];
    expect(lineupDiff(current, next)).toEqual({
      added: 2,
      removed: 0,
      moved: 1,
      changed: true,
    });
    expect(lineupDiff(current, current).changed).toBe(false);
  });

  test("局が同じでも TSID が変われば違う", () => {
    const diff = lineupDiff(
      [entry("BS03:17969", 17969, [[236, "アニマックス"]])],
      [entry("BS03:17970", 17970, [[236, "アニマックス"]])],
    );
    expect(diff).toEqual({ added: 0, removed: 0, moved: 1, changed: true });
  });

  test("知らせる 1 行", () => {
    expect(
      changeText("BS", { added: 1, removed: 1, moved: 0, changed: true }),
    ).toBe(
      "BS のチャンネルが放送で変わったため、受信できるチャンネルを書き換えました (新しい局 1、終わった局 1)",
    );
  });
});

describe("放送の一覧に付いていく", () => {
  test("変わった一覧は 2 回読んでから書き換え、ほかのネットワークは残す", async () => {
    saved = [
      entry("BS15:16625", 16625, [[101, "NHK BS"]]),
      entry("BS03:17970", 17970, [[236, "アニマックス"]]),
      entry("CS02:24608", 24608, [[296, "CS の局"]], "CS", 6),
    ];
    puts.length = 0;
    // アニマックスが同じ中継器の別の TS に移った表 (version 3)
    const moved = (): { nit: NitReader; sdt: SdtReader } =>
      read(
        [
          [16625, BS15, [101]],
          [17969, BS3, [236]],
        ],
        3,
      );

    // 1 回目は書き換えない (放送に古い情報が混ざることがある)
    let { nit, sdt } = moved();
    expect(await followLineup("BS", nit, sdt, T)).toBe(false);
    expect(puts).toHaveLength(0);

    // 同じ周回で別の中継器を続けて読んでも、2 回とは数えない
    ({ nit, sdt } = moved());
    expect(await followLineup("BS", nit, sdt, T + MIN)).toBe(false);
    expect(puts).toHaveLength(0);

    ({ nit, sdt } = moved());
    expect(await followLineup("BS", nit, sdt, T + 5 * MIN)).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.scanned).toEqual(["BS"]);
    expect(saved.map((c) => c.channel).sort()).toEqual([
      "BS03:17969",
      "BS15:16625",
      "CS02:24608",
    ]);
    // 局名は放送のもの
    expect(
      saved.find((c) => c.channel === "BS03:17969")?.services[0]?.name,
    ).toBe("局236");

    // 知らせる。設定の「受信」を開いたら消える
    expect(lineupNotice()).toContain("移った局 1");
    seenLineupChanges();
    expect(lineupNotice()).toBeNull();

    // 同じ version はもう読み比べない
    ({ nit, sdt } = moved());
    expect(await followLineup("BS", nit, sdt, T + 20 * MIN)).toBe(false);
    expect(puts).toHaveLength(1);
  });

  test("1 回目と 2 回目で version が違えば、数え直す", async () => {
    saved = [entry("BS15:16625", 16625, [[101, "NHK BS"]])];
    puts.length = 0;
    const once = (version: number) =>
      read(
        [
          [16625, BS15, [101]],
          [18675, BS15, [200]],
        ],
        version,
      );
    let { nit, sdt } = once(7);
    await followLineup("BS", nit, sdt, T);
    ({ nit, sdt } = once(8));
    expect(await followLineup("BS", nit, sdt, T + 10 * MIN)).toBe(false);
    ({ nit, sdt } = once(8));
    expect(await followLineup("BS", nit, sdt, T + 20 * MIN)).toBe(true);
  });

  test("同時に読んでも二重に書き換えない", async () => {
    saved = [entry("BS15:16625", 16625, [[101, "NHK BS"]])];
    puts.length = 0;
    const once = () =>
      read(
        [
          [16625, BS15, [101]],
          [18675, BS15, [201]],
        ],
        11,
      );
    const first = once();
    await followLineup("BS", first.nit, first.sdt, T);
    const a = once();
    const b = once();
    const results = await Promise.all([
      followLineup("BS", a.nit, a.sdt, T + 6 * MIN),
      followLineup("BS", b.nit, b.sdt, T + 6 * MIN),
    ]);
    expect(results).toEqual([true, false]);
    expect(puts).toHaveLength(1);
  });

  test("変わっていなければ何もしない", async () => {
    saved = [entry("BS15:16625", 16625, [[101, "局101"]])];
    puts.length = 0;
    orm().delete(channelChanges).run();
    const { nit, sdt } = read([[16625, BS15, [101]]], 9);
    expect(await followLineup("BS", nit, sdt)).toBe(false);
    expect(puts).toHaveLength(0);
    expect(lineupNotice()).toBeNull();
  });
});
