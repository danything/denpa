import { describe, expect, test } from "bun:test";

import { type LiveComment, LiveReader, readLiveComment } from "./live";

/*
 * ライブの実況のコメントを denpa のサーバから続きで受ける。fetch とタイマーを差し替える
 */

/** 返事を順に返す偽の fetch。返事が尽きたら止まったまま (ロングポーリングで待っている) */
function fake(replies: (Response | Error)[]) {
  const bodies: Record<string, unknown>[] = [];
  const timers: (() => void)[] = [];
  const deps = {
    fetch: async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const next = replies.shift();
      if (next === undefined) return new Promise<Response>(() => {});
      if (next instanceof Error) throw next;
      return next;
    },
    setTimeout: (run: () => void) => {
      timers.push(run);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  return { deps, bodies, timers };
}

const reply = (body: unknown) => new Response(JSON.stringify(body));
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("readLiveComment", () => {
  test("出どころと ID を残し、色を読む。運営のコメントは流さず、形が違えば undefined", () => {
    expect(readLiveComment({ at: 1, text: " a ", src: "nicolive" })).toEqual({
      at: 1,
      text: "a",
      src: "nicolive",
    });
    expect(readLiveComment({ at: 1, text: "b", id: "x" })).toEqual({
      at: 1,
      text: "b",
      src: "nx",
      id: "x",
    });
    expect(readLiveComment({ at: 1, text: "/nicoad {}" })).toBeNull();
    expect(readLiveComment({ at: "1", text: "c" })).toBeUndefined();
  });
});

describe("LiveReader", () => {
  test("前に受けた番号と印を渡して続きを受ける", async () => {
    const { deps, bodies } = fake([
      reply({
        epoch: "e1",
        seq: 3,
        hub: "up",
        nx: "up",
        comments: [{ at: 1, text: "a", src: "nx" }],
      }),
      reply({
        epoch: "e1",
        seq: 4,
        hub: "up",
        nx: "down",
        comments: [{ at: 2, text: "b", src: "hub", id: "i" }],
      }),
    ]);
    const got: LiveComment[] = [];
    const states: [boolean, boolean][] = [];
    const reader = new LiveReader(
      "jk1",
      "/api/jikkyo/feed",
      {
        comments: (c) => got.push(...c),
        state: (hub, nx) => states.push([hub, nx]),
        odd: () => {},
      },
      deps,
    );
    expect(reader.writable).toBe(false);
    reader.start();
    for (let i = 0; i < 5; i++) await tick();
    expect(bodies[0]).toEqual({ channel: "jk1" });
    expect(bodies[1]).toEqual({ channel: "jk1", after: 3, epoch: "e1" });
    expect(bodies[2]).toEqual({ channel: "jk1", after: 4, epoch: "e1" });
    expect(got.map((c) => c.text)).toEqual(["a", "b"]);
    // NX-Jikkyo が落ちても hub に繋がっていれば書ける
    expect(states).toEqual([[true, false]]);
    expect(reader.writable).toBe(true);
    reader.stop();
  });

  test("3 回続けて届かなければ繋がっていない (書けない) にし、10 秒おきに呼び直す", async () => {
    const { deps, timers } = fake([
      reply({ epoch: "e", seq: 0, hub: "up", nx: "up", comments: [] }),
      new Error("down"),
      new Error("down"),
      new Error("down"),
    ]);
    const states: boolean[] = [];
    const reader = new LiveReader(
      "jk1",
      "/api/jikkyo/feed",
      { comments: () => {}, state: (hub) => states.push(hub), odd: () => {} },
      deps,
    );
    reader.start();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 5; i++) await tick();
      timers.shift()?.();
    }
    for (let i = 0; i < 5; i++) await tick();
    expect(states).toEqual([false]);
    expect(reader.writable).toBe(false);
    reader.stop();
  });
});
