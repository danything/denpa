import { describe, expect, test } from "bun:test";

import { IDLE, JikkyoLive, type LiveDeps } from "./jikkyo-live";

/*
 * hub の購読を局ごとに 1 本だけ受けて、端末に続きを渡す。hub の SSE は偽物 (ReadableStream)
 */

/** 開くたびに新しい流れを作る偽の hub。`send` で流し、`end` で切る */
function fakeHub(status = 200) {
  const opened: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const timers: { run: () => void; ms: number }[] = [];
  let now = 1_000_000;
  const deps: LiveDeps = {
    open: async (path) => {
      opened.push(path);
      if (status !== 200)
        return new Response(JSON.stringify({ error: "unknown_channel" }), {
          status,
        });
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            controller = c;
          },
        }),
      );
    },
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (id) => {
      const at = timers.indexOf(id as (typeof timers)[number]);
      if (at >= 0) timers.splice(at, 1);
    },
  };
  return {
    deps,
    opened,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    send: (text: string) => controller?.enqueue(encoder.encode(text)),
    end: () => controller?.close(),
  };
}

const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

const comments = (id: number, list: unknown[]) =>
  `id: ${id}\nevent: comments\ndata: ${JSON.stringify(list)}\n\n`;

describe("JikkyoLive", () => {
  test("局ごとに 1 本だけ受け、初めての呼び出しには控えの全部、続きには新しいものだけを返す", async () => {
    const hub = fakeHub();
    const live = new JikkyoLive(hub.deps);
    const first = await live.feed("jk1", null, null);
    expect(first.comments).toEqual([]);
    await tick();
    hub.send(`event: state\ndata: {"nx":"up","epoch":"h1"}\n\n`);
    hub.send(comments(10, [{ at: 999_001, text: "a", src: "nx" }]));
    await tick();
    const all = await live.feed("jk1", null, null);
    expect(all.hub).toBe("up");
    expect(all.comments.map((c) => c.text)).toEqual(["a"]);

    // 続きを待っている間に来たものを返す
    const waiting = live.feed("jk1", all.seq, all.epoch);
    hub.send(
      comments(11, [
        { at: 999_002, text: "b", src: "hub", id: "x" },
        { at: 999_001, text: "a", src: "nx" },
      ]),
    );
    const next = await waiting;
    expect(next.comments).toEqual([
      { at: 999_002, text: "b", src: "hub", id: "x" },
    ]);
    // 別の端末が呼んでも、hub への購読は 1 本
    await live.feed("jk1", null, null);
    expect(hub.opened).toEqual(["/jikkyo/channels/jk1/live"]);
    // epoch が違えば控えの全部
    const stale = await live.feed("jk1", next.seq, "old");
    expect(stale.comments.map((c) => c.text)).toEqual(["a", "b"]);
    live.closeAll();
  });

  test("切れたら hub の番号と印を渡して続きから繋ぎ直す", async () => {
    const hub = fakeHub();
    const live = new JikkyoLive(hub.deps);
    await live.feed("jk1", null, null);
    await tick();
    hub.send(`event: state\ndata: {"nx":"up","epoch":"h1"}\n\n`);
    hub.send(comments(42, [{ at: 999_001, text: "a", src: "nx" }]));
    await tick();
    hub.end();
    await tick();
    expect((await live.feed("jk1", null, null)).hub).toBe("down");
    // 1 秒の待ちを進める
    hub.timers.find((t) => t.ms === 1_000)?.run();
    await tick();
    expect(hub.opened[1]).toBe("/jikkyo/channels/jk1/live?after=42&epoch=h1");
    live.closeAll();
  });

  test("呼ばれなくなって 30 秒たったら閉じる", async () => {
    const hub = fakeHub();
    const live = new JikkyoLive(hub.deps);
    await live.feed("jk1", null, null);
    expect(live.size).toBe(1);
    hub.advance(IDLE + 1);
    hub.timers.find((t) => t.ms === 10_000)?.run();
    expect(live.size).toBe(0);
  });

  test("hub が局を知らないと言ったら、しばらく繋ぎ直さない", async () => {
    const hub = fakeHub(400);
    const live = new JikkyoLive(hub.deps);
    await live.feed("jk404", null, null);
    await tick();
    const again = await live.feed("jk404", null, null);
    expect(again.hub).toBe("down");
    expect(hub.opened).toHaveLength(1);
    live.closeAll();
  });
});
