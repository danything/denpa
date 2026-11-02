import { describe, expect, test } from "bun:test";

import { DEFAULT_POST_STYLE } from "./command";
import { HEARTBEAT, OfficialWriter } from "./official";

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
  test("開いたとき・HEARTBEAT ごと・局を替えたときだけサーバに頼み、状態を受け取る", async () => {
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

  test("閉じたらもう頼まない", () => {
    const h = harness(() => ({ state: "ready" }));
    h.writer.stop();
    h.writer.tick();
    expect(h.calls).toEqual([]);
  });
});

describe("書き込む", () => {
  test("いまの局と本文と装飾を送り、結果を返す。知らない結果は分からない扱い", async () => {
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
