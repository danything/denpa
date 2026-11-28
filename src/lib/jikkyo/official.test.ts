import { describe, expect, test } from "bun:test";

import { DEFAULT_POST_STYLE } from "./command";
import type { Comment } from "./comments";
import {
  FEED_GAP,
  FEED_RETRY,
  HEARTBEAT,
  OfficialReader,
  OfficialWriter,
} from "./official";

/*
 * 公式の実況に書く端末の側。サーバ (`/api/jikkyo/niconico/…`) は偽の fetch で答える
 */

function harness(answer: (name: string, body: unknown) => unknown) {
  const calls: { name: string; body: unknown }[] = [];
  const clock = { now: 0 };
  let channel: string | null = "jk1";
  const writer = new OfficialWriter(
    {
      session: "/denpa/api/jikkyo/niconico/session",
      comments: "/denpa/api/jikkyo/niconico/comments",
    },
    () => channel,
    {
      now: () => clock.now,
      fetch: async (url, init) => {
        const name = url.split("/").at(-1)!;
        const body = JSON.parse(String(init.body)) as unknown;
        calls.push({ name, body });
        expect(url.startsWith("/denpa/api/jikkyo/niconico/")).toBe(true);
        return Response.json(answer(name, body));
      },
    },
  );
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    writer,
    calls,
    clock,
    flush,
    to: (next: string | null) => (channel = next),
  };
}

describe("接続を保つ", () => {
  test("開いたとき・HEARTBEAT ごと・局を替えたときだけサーバにリクエストし、状態を受け取る", async () => {
    const h = harness(() => ({ state: "ready" }));
    h.writer.tick();
    await h.flush();
    expect(h.writer.state).toBe("ready");
    h.clock.now = HEARTBEAT - 1;
    h.writer.tick();
    expect(h.calls).toHaveLength(1);
    h.clock.now = HEARTBEAT;
    h.writer.tick();
    expect(h.calls).toHaveLength(2);
    h.to("jk4");
    h.writer.tick();
    expect(h.writer.state).toBe("connecting");
    expect(h.calls.at(-1)).toEqual({
      name: "session",
      body: { channel: "jk4" },
    });
  });

  test("繋いでいる途中なら 1 秒で見直す", async () => {
    const h = harness(() => ({ state: "connecting" }));
    h.writer.tick();
    await h.flush();
    h.clock.now = 999;
    h.writer.tick();
    expect(h.calls).toHaveLength(1);
    h.clock.now = 1_000;
    h.writer.tick();
    expect(h.calls).toHaveLength(2);
  });

  test("閉じたらもうリクエストしない", () => {
    const h = harness(() => ({ state: "ready" }));
    h.writer.stop();
    h.writer.tick();
    expect(h.calls).toEqual([]);
  });
});

describe("書き込む", () => {
  test("いまの局と本文と装飾を送り、結果を返す。想定外の結果は unknown", async () => {
    let result: unknown = "sent";
    const h = harness(() => ({ result }));
    expect(await h.writer.post("わこつ", DEFAULT_POST_STYLE)).toBe("sent");
    expect(h.calls[0]).toEqual({
      name: "comments",
      body: { channel: "jk1", text: "わこつ", style: DEFAULT_POST_STYLE },
    });
    result = "unlinked";
    expect(await h.writer.post("a", DEFAULT_POST_STYLE)).toBe("unlinked");
    expect(h.writer.state).toBe("unlinked");
    result = "something-new";
    expect(await h.writer.post("a", DEFAULT_POST_STYLE)).toBe("unknown");
  });
});

describe("OfficialReader", () => {
  /** 偽のサーバ。呼ばれるたびに次の答えを返す (無ければ止めるまで待つ) */
  function reader(answers: unknown[]) {
    const bodies: Record<string, unknown>[] = [];
    const got: Comment[] = [];
    const boundaries: (number | null)[] = [];
    const timers: { run: () => void; ms: number }[] = [];
    const clock = { now: 0 };
    const r = new OfficialReader(
      "/denpa/api/jikkyo/niconico/feed",
      "jk1",
      {
        comments: (comments) => got.push(...comments),
        boundary: (at) => boundaries.push(at),
      },
      {
        now: () => clock.now,
        fetch: async (url, init) => {
          expect(url).toBe("/denpa/api/jikkyo/niconico/feed");
          bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          const answer = answers.shift();
          if (answer === undefined)
            return new Promise((_, reject) =>
              init.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            );
          if (answer instanceof Error) throw answer;
          return Response.json(answer);
        },
        setTimeout: (run, ms) => {
          timers.push({ run, ms });
          return timers.length;
        },
        clearTimeout: () => {},
      },
    );
    const flush = async () => {
      for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    /** 仕掛けた待ちを鳴らして、続きを流す */
    const step = async () => {
      timers.shift()?.run();
      await flush();
    };
    return { r, bodies, got, boundaries, timers, clock, flush, step };
  }

  const reply = (over: Record<string, unknown>) => ({
    epoch: "e1",
    state: "ready",
    since: 1_000,
    now: 5_000,
    seq: 0,
    comments: [],
    ...over,
  });

  test("番号の続きをリクエストし、境 = max(since, 最初の now) より後だけ流す。自分の書き込みの戻りは 1 回だけ捨てる", async () => {
    const h = reader([
      reply({ seq: 3 }),
      reply({
        seq: 6,
        now: 9_000,
        comments: [
          { at: 4_000, text: "境より前" },
          { at: 6_000, text: "後", style: { place: "ue" } },
          { at: 7_000, text: "送った", own: true },
          { at: 8_000, text: "送った", own: true },
        ],
      }),
    ]);
    h.r.expectEcho("送った");
    h.r.start();
    await h.flush();
    // コメントの無い返事のあとは FEED_GAP 置く
    expect(h.timers[0]?.ms).toBe(FEED_GAP);
    await h.step();
    expect(h.bodies[0]).toEqual({ channel: "jk1" });
    expect(h.bodies[1]).toEqual({ channel: "jk1", after: 3, epoch: "e1" });
    expect(h.boundaries).toEqual([5_000]);
    expect(h.got).toEqual([
      { at: 6_000, text: "後", style: { place: "ue" } },
      { at: 8_000, text: "送った" },
    ]);
    h.r.stop();
  });

  test("サーバが受けていなければ境を無くす。届かなければ境を無くし FEED_RETRY 置く", async () => {
    const h = reader([reply({}), reply({ since: null }), new Error("down")]);
    h.r.start();
    await h.flush();
    await h.step();
    expect(h.boundaries).toEqual([5_000, null]);
    // since が無い返事もすぐ返ってくるので、詰めて呼ばない
    expect(h.timers[0]?.ms).toBe(FEED_GAP);
    await h.step();
    expect(h.timers[0]?.ms).toBe(FEED_RETRY);
    h.r.stop();
  });

  test("epoch が変わったら、その返事の now から境を取り直す", async () => {
    const h = reader([
      reply({ seq: 9 }),
      reply({ epoch: "e2", seq: 0, now: 20_000, since: 15_000 }),
    ]);
    h.r.start();
    await h.flush();
    await h.step();
    expect(h.boundaries).toEqual([5_000, 20_000]);
    h.r.stop();
  });
});
