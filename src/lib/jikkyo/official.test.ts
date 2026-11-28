import { describe, expect, test } from "bun:test";

import { DEFAULT_POST_STYLE } from "./command";
import type { Comment } from "./comments";
import { HEARTBEAT, OfficialReader, OfficialWriter } from "./official";

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
  function reader() {
    const got: Comment[] = [];
    const boundaries: (number | null)[] = [];
    const r = new OfficialReader(
      {
        comments: (comments) => got.push(...comments),
        boundary: (at) => boundaries.push(at),
      },
      () => 0,
    );
    return { r, got, boundaries };
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

  test("番号の続きを載せ、境 = max(since, 最初の now) より後だけ流す。自分の書き込みの戻りは 1 回だけ捨てる", () => {
    const h = reader();
    expect(h.r.body()).toEqual({});
    h.r.expectEcho("送った");
    expect(h.r.apply(reply({ seq: 3 }))).toBe(0);
    expect(h.r.body()).toEqual({ after: 3, epoch: "e1" });
    h.r.apply(
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
    );
    expect(h.boundaries).toEqual([5_000]);
    expect(h.got).toEqual([
      { at: 6_000, text: "後", style: { place: "ue" } },
      { at: 8_000, text: "送った" },
    ]);
  });

  test("サーバが受けていない・届かない・形が違うときは境を無くす", () => {
    const h = reader();
    h.r.apply(reply({}));
    h.r.apply(reply({ since: null }));
    h.r.apply(reply({}));
    h.r.fail();
    h.r.apply(reply({}));
    expect(h.r.apply({ epoch: 1 })).toBeNull();
    expect(h.boundaries).toEqual([5_000, null, 5_000, null, 5_000, null]);
  });

  test("epoch が変わったら、その返事の now から境を取り直す", () => {
    const h = reader();
    h.r.apply(reply({ seq: 9 }));
    h.r.apply(reply({ epoch: "e2", seq: 0, now: 20_000, since: 15_000 }));
    expect(h.boundaries).toEqual([5_000, 20_000]);
  });
});
