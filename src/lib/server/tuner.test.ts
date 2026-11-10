import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeAgentTls, fakeAgentUrl, trustFakeAgent } from "./fake-agent";
import {
  type AgentTuner,
  openChannelStream,
  programKey,
  recordingHolds,
  recordingOf,
  recordingUse,
  retryWhileBusy,
  serviceKey,
  tsmfStreams,
  TunerBusyError,
} from "./tuner";

describe("局と番組の ID", () => {
  test("アンテナの局の ID は今までどおり networkId * 100000 + serviceId", () => {
    expect(serviceKey(32391, 23608, "GR")).toBe(3239123608);
    expect(serviceKey(4, 151, "BS")).toBe(400151);
    expect(programKey(4, 151, 1, "BS")).toBe(40015100001);
  });

  test("CATV が再送信する BS の局は、同じ original_network_id と service_id でもアンテナの BS と別の ID になる", () => {
    const antenna = serviceKey(4, 151, "BS");
    const cable = serviceKey(4, 151, "CATV");
    expect(cable).not.toBe(antenna);
    expect(cable).toBe((0x10000 + 4) * 100000 + 151);
    expect(programKey(4, 151, 1, "CATV")).not.toBe(programKey(4, 151, 1, "BS"));
    // いちばん大きい番組の ID も、JS の整数で正しく持てる
    expect(
      Number.isSafeInteger(programKey(0xffff, 0xffff, 0xffff, "CATV")),
    ).toBe(true);
  });
});

describe("TSMF で束ねた TS の数", () => {
  test("ヘッダが無い・読めないときは 1 (TSMF ではない)", () => {
    expect(tsmfStreams(new Headers())).toBe(1);
    expect(tsmfStreams(new Headers({ "X-Denpa-Tsmf-Streams": "x" }))).toBe(1);
    expect(tsmfStreams(new Headers({ "X-Denpa-Tsmf-Streams": "0" }))).toBe(1);
    expect(tsmfStreams(new Headers({ "X-Denpa-Tsmf-Streams": "3" }))).toBe(3);
  });
});

/**
 * **空きが無いだけなら、掛け直せば通る。**
 *
 * ライブはチャンネルを変える一瞬だけ、前のチャンネルと合わせてチューナーが
 * 2 台要る。前のを離してから次を要求しているが、離れたことがエージェントに届くのは
 * 非同期なので重なる瞬間が残る。地上波は 2 台しかないので、録画か番組表の取得が
 * 1 台使っていると、そこで断られていた (実機で
 * `[live] GR:T15: チューナーに空きがありません`)。
 *
 * 字幕側で一度断られると、**そのチャンネルの字幕がそれきり出ない**という
 * 出方をしていた。見ている側は局を選び直すまで戻せない。
 *
 * **待つところは差し替える。** 本当に待たせるとテストがそのぶん延びるだけで、
 * 確かめたいのは「何回掛け直すか」のほう
 */
describe("retryWhileBusy", () => {
  /** 待った回数を数えるだけの、待たない待ち */
  const clock = () => {
    const waits: number[] = [];
    return { waits, wait: async (ms: number) => void waits.push(ms) };
  };

  test("空き待ちなら掛け直して通る", async () => {
    const { waits, wait } = clock();
    let asked = 0;
    const got = await retryWhileBusy(
      () => {
        asked++;
        if (asked === 1) throw new TunerBusyError("空きがありません");
        return Promise.resolve("とれた");
      },
      () => false,
      wait,
    );
    expect(got).toBe("とれた");
    expect(asked).toBe(2);
    expect(waits).toHaveLength(1);
  });

  /** 選局そのものが駄目なら、何度やっても同じ。待たせるだけ無駄 */
  test("空き待ち以外は掛け直さない", async () => {
    const { waits, wait } = clock();
    let asked = 0;
    await expect(
      retryWhileBusy(
        () => {
          asked++;
          return Promise.reject(new Error("選局できません (500)"));
        },
        () => false,
        wait,
      ),
    ).rejects.toThrow(/選局できません/);
    expect(asked).toBe(1);
    expect(waits).toHaveLength(0);
  });

  /** 畳まれたなら待たない。見ている人はもう別の局へ行っている */
  test("畳まれたら待たずに諦める", async () => {
    const { waits, wait } = clock();
    let asked = 0;
    await expect(
      retryWhileBusy(
        () => {
          asked++;
          return Promise.reject(new TunerBusyError("空きがありません"));
        },
        () => true,
        wait,
      ),
    ).rejects.toThrow(/空きがありません/);
    expect(asked).toBe(1);
    expect(waits).toHaveLength(0);
  });

  /** 待っても空かないなら、いつかは諦める。無限には掛け直さない */
  test("いつかは諦める", async () => {
    const { waits, wait } = clock();
    let asked = 0;
    await expect(
      retryWhileBusy(
        () => {
          asked++;
          return Promise.reject(new TunerBusyError("空きがありません"));
        },
        () => false,
        wait,
      ),
    ).rejects.toThrow(/空きがありません/);
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThanOrEqual(5);
    expect(waits.every((ms) => ms > 0)).toBe(true);
  });
});

/**
 * **録画中の予約がどのチューナーにいるかは、エージェントの一覧の利用者から読む** (`recordingHolds`)。
 * 名乗り (`rec <録画ID>`) の書き方が変わると黙って読めなくなり、録画中のチューナーを空きとして
 * 割り振ってしまうので、書くほうと読むほうを対にして押さえる
 */
describe("recordingHolds", () => {
  const tuner = (over: Partial<AgentTuner>): AgentTuner => ({
    index: 0,
    name: "mlt0",
    types: ["GR", "BS", "CS"],
    disabled: false,
    rank: 1,
    device: null,
    pin: "mlt0",
    lnb: null,
    channel: { type: "GR", channel: "T21" },
    users: [],
    error: null,
    signal: null,
    ...over,
  });

  test("録画の名乗りは読み戻せる。録画以外は読まない", () => {
    expect(recordingOf(recordingUse(42))).toBe(42);
    expect(recordingOf("live GR:T21")).toBeNull();
    expect(recordingOf("epg T21")).toBeNull();
    expect(recordingOf("rec 12x")).toBeNull();
  });

  test("録画の利用者がいるチューナーを、録画が終わるまで塞ぐ", () => {
    const ends = new Map([
      [7, 1_000],
      [8, 2_000],
    ]);
    const holds = recordingHolds(
      [
        tuner({
          users: [
            { use: recordingUse(7), priority: 10 },
            { use: recordingUse(8), priority: 10 },
            { use: "epg T21", priority: 3 },
          ],
        }),
        // ライブや番組表の取得だけのチューナーは入れない (録画に譲る約束)
        tuner({
          name: "gr0",
          rank: 0,
          channel: { type: "GR", channel: "T16" },
          users: [{ use: "live GR:T16", priority: 9 }],
        }),
        // 空いているチューナー
        tuner({ name: "bs0", rank: 2, channel: null }),
        // 無効にしたチューナー
        tuner({
          name: "off0",
          rank: null,
          disabled: true,
          users: [{ use: recordingUse(7), priority: 10 }],
        }),
      ],
      (id) => ends.get(id),
    );
    expect(holds).toEqual([
      { type: "GR", channel: "T21", rank: 1, until: 2_000 },
    ]);
  });

  test("終わる時刻の分からない録画は入れない", () => {
    const holds = recordingHolds(
      [tuner({ users: [{ use: recordingUse(9), priority: 10 }] })],
      () => undefined,
    );
    expect(holds).toEqual([]);
  });
});

/**
 * **引き継ぎ (`after`) は、選局の API にそのまま並べて渡す。** エージェントは何度でも書ける
 * `after` を読み、その利用者をもう離れたものとして選ぶ (docs/agent.md「選ぶ順の約束」の 4)
 */
describe("openChannelStream の引き継ぎ", () => {
  test("止めた録画の利用者を after に並べる", async () => {
    const asked: URLSearchParams[] = [];
    const agent = Bun.serve({
      port: 0,
      tls: fakeAgentTls(),
      fetch(request) {
        asked.push(new URL(request.url).searchParams);
        return new Response("");
      },
    });
    const { config } = await import("./config");
    const before = config.agentUrl;
    const beforeData = config.dataDir;
    config.agentUrl = fakeAgentUrl(agent.port!);
    // 組んだエージェントの証明書を置く所。既定の /data は CI では書けない
    config.dataDir = mkdtempSync(join(tmpdir(), "denpa-tuner-"));
    trustFakeAgent();
    try {
      const aborter = new AbortController();
      await openChannelStream(
        "BS",
        "BS11_0",
        aborter.signal,
        recordingUse(9),
        10,
        [recordingUse(7), recordingUse(8)],
      );
      aborter.abort();
    } finally {
      config.agentUrl = before;
      config.dataDir = beforeData;
      agent.stop(true);
    }
    expect(asked[0]?.getAll("after")).toEqual(["rec 7", "rec 8"]);
    expect(asked[0]?.get("use")).toBe("rec 9");
  });
});
