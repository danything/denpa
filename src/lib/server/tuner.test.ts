import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeAgentTls, fakeAgentUrl } from "./fake-agent";
import { trustFakeAgent } from "./fake-agent-trust";
import {
  type AgentTuner,
  expectTransport,
  openChannelStream,
  programKey,
  recordingHolds,
  recordingOf,
  recordingUse,
  retryWhileBusy,
  serviceKey,
  streamTransport,
  TransportChangedError,
  tsmfStreams,
  TuneError,
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
    // ケーブルで受けた 4K の BS-TBS 4K (0x000B) と、ケーブルで受けた 2K の BS-TBS (4) は重ならない
    expect(serviceKey(0x000b, 161, "CATV")).toBe(6_554_700_161);
    expect(serviceKey(4, 161, "CATV")).toBe(6_554_000_161);
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

describe("流れてくるバイト列の形式", () => {
  test("application/x-arib-tlv なら TLV、video/MP2T なら TS", () => {
    const of = (type: string) =>
      streamTransport(new Headers({ "Content-Type": type }));
    expect(of("application/x-arib-tlv")).toBe("tlv");
    expect(of("Application/X-ARIB-TLV; charset=binary")).toBe("tlv");
    expect(of("video/MP2T")).toBe("ts");
  });

  test("知らない形式と Content-Type の無い答えは、TS として読む", () => {
    expect(streamTransport(new Headers({ "Content-Type": "text/plain" }))).toBe(
      "ts",
    );
    expect(streamTransport(new Headers())).toBe("ts");
  });

  test("選局の答えの形式が控えと違えば、ストリームを閉じて読まない", async () => {
    let canceled = false;
    const stream = () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
    const same = stream();
    expect(
      await expectTransport({ stream: same, transport: "tlv" }, "tlv"),
    ).toBe(same);
    expect(canceled).toBe(false);
    const changed = expectTransport(
      { stream: stream(), transport: "ts" },
      "tlv",
    );
    await expect(changed).rejects.toThrow(TransportChangedError);
    expect(canceled).toBe(true);
    expect(new TransportChangedError().message).toBe(
      "チャンネルの形式が変わりました。ケーブルをスキャンし直してください",
    );
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
    agent: 1,
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
 * 偽のエージェントを立て、`config` をそちらへ向けて `run` を呼ぶ。終われば戻す。
 * 証明書と DB は一時ディレクトリに置く (既定の /data は CI では書けない)
 */
async function withAgent(
  answer: (request: Request) => Response,
  run: () => Promise<void>,
): Promise<void> {
  const agent = Bun.serve({ port: 0, tls: fakeAgentTls(), fetch: answer });
  const { config } = await import("./config");
  const before = { ...config };
  const dir = mkdtempSync(join(tmpdir(), "denpa-tuner-"));
  config.agentUrl = fakeAgentUrl(agent.port!);
  config.dataDir = dir;
  config.dbPath = join(dir, "denpa.db");
  trustFakeAgent();
  try {
    await run();
  } finally {
    config.agentUrl = before.agentUrl;
    config.dataDir = before.dataDir;
    config.dbPath = before.dbPath;
    agent.stop(true);
  }
}

/**
 * **引き継ぎ (`after`) は、選局の API にそのまま並べて渡す。** エージェントは何度でも書ける
 * `after` を読み、その利用者をもう離れたものとして選ぶ (docs/agent.md「選ぶ順の約束」の 4)
 */
describe("openChannelStream の引き継ぎ", () => {
  test("止めた録画の利用者を after に並べる", async () => {
    const asked: URLSearchParams[] = [];
    await withAgent(
      (request) => {
        asked.push(new URL(request.url).searchParams);
        return new Response("");
      },
      async () => {
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
      },
    );
    expect(asked[0]?.getAll("after")).toEqual(["rec 7", "rec 8"]);
    expect(asked[0]?.get("use")).toBe("rec 9");
  });
});

/**
 * **誰の選局でも、選局できたら受信できたと残す** (`reception.ts`)。番組表の取得が 1 台のチューナーで
 * 選局できなかった地上波のチャンネルも、ライブがほかのチューナーで選局できれば「続けて選局できません」が消える
 */
describe("選局できたら受信できたと残す", () => {
  const HOUR = 60 * 60_000;

  test("ライブで選局できたら、続けて選局できなかった記録を消す", async () => {
    const { recordFailed, recordReceived, failingGround } =
      await import("./reception");
    let ok = false;
    await withAgent(
      () =>
        ok
          ? new Response("ts")
          : Response.json(
              { error: "adapter1: 同期しませんでした" },
              { status: 500 },
            ),
      async () => {
        const at = Date.now() - 4 * HOUR;
        recordReceived("GR", "T16", at);
        recordFailed("GR", "T26", at + HOUR);
        recordReceived("GR", "T16", at + 2 * HOUR);
        recordFailed("GR", "T26", at + 3 * HOUR);
        expect(failingGround()).toEqual(["T26"]);

        // 選局できなかった回は何も残さない (失敗を数えるのは番組表の取得だけ)
        await expect(
          openChannelStream(
            "GR",
            "T26",
            new AbortController().signal,
            "live T26",
          ),
        ).rejects.toThrow("選局できません (500)");
        expect(failingGround()).toEqual(["T26"]);

        ok = true;
        const aborter = new AbortController();
        await openChannelStream("GR", "T26", aborter.signal, "live T26");
        aborter.abort();
        expect(failingGround()).toEqual([]);
      },
    );
  });
});

/**
 * **答え (レスポンスヘッダ) を待つ上限** (`answerWithin`)。エージェントは最初の TS を送るときにヘッダを返すので、
 * TS が届かないとリクエストが返らない。本番で、名指しのライブが答えを待ったまま「読み込み中」になり続けた
 */
describe("openChannelStream の答えを待つ上限", () => {
  test("上限までに答えが来なければ、理由を付けて TuneError を送出する", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await withAgent(
      // ヘッダを返さない (TS が届かないエージェント)
      () => held.then(() => new Response("")) as unknown as Response,
      async () => {
        const aborter = new AbortController();
        const error = await openChannelStream(
          "GR",
          "T27",
          aborter.signal,
          "live GR/T27",
          4,
          [],
          "it930x:3-1:0",
          null,
          50,
        ).catch((thrown: unknown) => thrown);
        release();
        expect(error).toBeInstanceOf(TuneError);
        expect((error as TuneError).reason).toBe(
          "エージェントから選局の答えが 0 秒返りませんでした",
        );
      },
    );
  });

  test("答えが来たあとのストリームは打ち切らない", async () => {
    await withAgent(
      () =>
        new Response(
          new ReadableStream({
            // 最初の塊でヘッダが返る。続きは上限より遅れて届く
            async start(controller) {
              controller.enqueue(new Uint8Array(188));
              await Bun.sleep(150);
              controller.enqueue(new Uint8Array(188));
              controller.close();
            },
          }),
          { headers: { "content-type": "video/MP2T" } },
        ),
      async () => {
        const aborter = new AbortController();
        const stream = await openChannelStream(
          "GR",
          "T27",
          aborter.signal,
          "live GR/T27",
          4,
          [],
          null,
          null,
          50,
        );
        let bytes = 0;
        for await (const chunk of stream) bytes += chunk.length;
        expect(bytes).toBe(376);
      },
    );
  });

  test("エージェントの理由 (本文の error) を reason に持つ", async () => {
    await withAgent(
      () =>
        Response.json(
          {
            error:
              "PLEX PX-MLT8PE 3-1 #0 (it930x:3-1:0) は BS を受けられません",
          },
          { status: 400 },
        ),
      async () => {
        const error = await openChannelStream(
          "BS",
          "BS15_0",
          new AbortController().signal,
          "live BS/BS15_0",
          4,
          [],
          "it930x:3-1:0",
        ).catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(TuneError);
        expect((error as TuneError).reason).toBe(
          "PLEX PX-MLT8PE 3-1 #0 (it930x:3-1:0) は BS を受けられません",
        );
      },
    );
  });
});
