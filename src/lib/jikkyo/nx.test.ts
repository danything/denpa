import { describe, expect, test } from "bun:test";

import type { Comment } from "./comments";
import { commentPath, type NxDeps, NxJikkyo } from "./nx";

/*
 * NX-Jikkyo への繋ぎ方。外には繋がず、偽の WebSocket と偽の時計で見る。返事は自分で作った偽物
 */

class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; ms: number; id: number }[] = [];
  let id = 0;
  const clock = { now: T };
  const deps: NxDeps = {
    now: () => clock.now,
    open: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    setTimeout: (run, ms) => {
      timers.push({ run, ms, id: ++id });
      return id;
    },
    clearTimeout: (handle) => {
      const at = timers.findIndex((t) => t.id === handle);
      if (at >= 0) timers.splice(at, 1);
    },
  };
  const got: Comment[] = [];
  const states: boolean[] = [];
  const nx = new NxJikkyo(
    "jk9",
    {
      comments: (comments) => got.push(...comments),
      state: (ok) => states.push(ok),
      odd: () => {},
    },
    deps,
  );
  /** 仕掛けた目覚ましを 1 つ鳴らす (一番短いもの) */
  const fire = () => {
    timers.sort((a, b) => a.ms - b.ms);
    const timer = timers.shift();
    timer?.run();
    return timer?.ms;
  };
  return { nx, sockets, timers, got, states, fire, clock };
}

const T = Date.UTC(2026, 9, 28, 12, 0, 0);
/** スレッドの頭 (vpos の基準)。いまの 1 時間前 */
const BASE = T - 3_600_000;
const COMMENT_URL =
  "wss://nx-jikkyo.tsukumijima.net/api/v1/channels/jk9/ws/comment";

/** 視聴の WS を開いて room まで受ける。コメントの WS を返す */
function connect(h: ReturnType<typeof harness>, from = 0): FakeSocket {
  const watch = h.sockets[from]!;
  watch.open();
  watch.receive({ type: "seat", data: { keepIntervalSec: 30 } });
  watch.receive({
    type: "room",
    data: {
      messageServer: { uri: COMMENT_URL },
      threadId: "777",
      yourPostKey: "key",
      vposBaseTime: new Date(BASE).toISOString(),
    },
  });
  const comment = h.sockets[from + 1]!;
  comment.open();
  return comment;
}

describe("NxJikkyo", () => {
  test("視聴の WS → room の URL のコメントの WS に繋ぎ、直近 100 件からコメントを受ける", () => {
    const h = harness();
    h.nx.start();
    expect(h.sockets[0]!.url).toBe(
      "wss://nx-jikkyo.tsukumijima.net/api/v1/channels/jk9/ws/watch",
    );
    const comment = connect(h);
    expect(h.sockets[0]!.sent[0]).toEqual({
      type: "startWatching",
      data: { reconnect: false },
    });
    expect(comment.url).toBe(COMMENT_URL);
    const thread = (comment.sent[0] as { thread?: unknown }[]).find(
      (item) => "thread" in item,
    );
    expect(thread).toEqual({
      thread: {
        version: "20061206",
        thread: "777",
        threadkey: "key",
        res_from: -100,
      },
    });
    comment.receive({ thread: { resultcode: 0 } });
    comment.receive({
      chat: { date: T / 1000, date_usec: 0, content: "わこつ", user_id: "x" },
    });
    expect(h.got).toEqual([{ at: T, text: "わこつ" }]);
  });

  test("ping には pong、seat の間隔で keepSeat を返す", () => {
    const h = harness();
    h.nx.start();
    connect(h);
    const watch = h.sockets[0]!;
    watch.receive({ type: "ping" });
    expect(watch.sent).toContainEqual({ type: "pong" });
    expect(h.fire()).toBe(30_000);
    expect(watch.sent).toContainEqual({ type: "keepSeat" });
  });

  test("切れたら 1 秒 → 2 秒 … と間を空けて繋ぎ直し、5 回続けて失敗したら読めないと言う", () => {
    const h = harness();
    h.nx.start();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      h.sockets[h.sockets.length - 1]!.drop();
      waits.push(h.fire() ?? -1);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(h.states).toEqual([false]);
    // 戻ったら読めると言う
    const comment = connect(h, h.sockets.length - 1);
    comment.receive({ thread: { resultcode: 0 } });
    expect(h.states).toEqual([false, true]);
  });

  test("4:00 にサーバがきれいに閉じたら、失敗に数えず 1 秒で視聴の WS から繋ぎ直す", () => {
    const h = harness();
    h.nx.start();
    const comment = connect(h);
    comment.receive({ thread: { resultcode: 0 } });
    h.sockets[0]!.drop(1000);
    expect(h.fire()).toBe(1000);
    expect(h.sockets[h.sockets.length - 1]!.url).toContain("/ws/watch");
    expect(h.states).toEqual([]);
  });

  test("遡るのは 1 回だけ。when 付きで 1000 件まで", () => {
    const h = harness();
    h.nx.start();
    const comment = connect(h);
    h.nx.backfill(T);
    h.nx.backfill(T - 60_000);
    const asked = comment.sent
      .flat()
      .filter(
        (item) =>
          (item as { thread?: { when?: number } }).thread?.when !== undefined,
      );
    expect(asked).toEqual([
      {
        thread: {
          version: "20061206",
          thread: "777",
          threadkey: "key",
          res_from: -1000,
          when: T / 1000,
        },
      },
    ]);
  });

  test("room のコメントの WS が NX-Jikkyo の外を指していたら繋がない", () => {
    const h = harness();
    h.nx.start();
    const watch = h.sockets[0]!;
    watch.open();
    watch.receive({
      type: "room",
      data: { messageServer: { uri: "wss://example.com/ws" }, threadId: "1" },
    });
    expect(h.sockets).toHaveLength(1);
    expect(commentPath("wss://nx-jikkyo.tsukumijima.net/api/v1/x?y=1")).toBe(
      "/api/v1/x?y=1",
    );
    expect(commentPath("ws://nx-jikkyo.tsukumijima.net/api")).toBeNull();
  });

  test("閉じたら繋ぎ直さない", () => {
    const h = harness();
    h.nx.start();
    connect(h);
    h.nx.close();
    expect(h.sockets.every((s) => s.closed)).toBe(true);
    expect(h.timers).toEqual([]);
  });
});

describe("NxJikkyo.post", () => {
  const STYLE = { color: "red", position: "ue", size: "big" } as const;

  /** 繋いでスレッドの返事まで受けたもの */
  function ready() {
    const h = harness();
    h.nx.start();
    const comment = connect(h);
    comment.receive({ thread: { resultcode: 0 } });
    return { h, watch: h.sockets[0]!, comment };
  }

  test("視聴の WS に postComment を送る。いつも 184、vpos はスレッドの頭からの 1/100 秒", async () => {
    const { h, watch } = ready();
    h.clock.now = T + 1_230;
    const result = h.nx.post("わこつ", STYLE);
    expect(watch.sent.at(-1)).toEqual({
      type: "postComment",
      data: {
        text: "わこつ",
        vpos: (T + 1_230 - BASE) / 10,
        isAnonymous: true,
        color: "red",
        position: "ue",
        size: "big",
      },
    });
    watch.receive({
      type: "postCommentResult",
      data: { chat: { mail: "184 red ue big", content: "わこつ" } },
    });
    expect(await result).toBe("sent");
  });

  test("error の NOT_ON_AIR はスレッドの替わり目、INVALID_MESSAGE は受け付けられなかった", async () => {
    const { h, watch } = ready();
    const first = h.nx.post("一つ目", STYLE);
    watch.receive({ type: "error", data: { message: "NOT_ON_AIR" } });
    expect(await first).toBe("not-on-air");
    const second = h.nx.post("二つ目", STYLE);
    watch.receive({ type: "error", data: { message: "INVALID_MESSAGE" } });
    expect(await second).toBe("rejected");
  });

  test("5 秒返事が無ければ分からない", async () => {
    const { h } = ready();
    const result = h.nx.post("届いた?", STYLE);
    // keepSeat (30 秒) より先に鳴る
    expect(h.fire()).toBe(5_000);
    expect(await result).toBe("unknown");
  });

  test("返事を待っている間に切れたら分からない。繋ぎ直すまでは書けない", async () => {
    const { h, watch } = ready();
    const result = h.nx.post("切れた", STYLE);
    watch.drop();
    expect(await result).toBe("unknown");
    expect(h.nx.ready).toBe(false);
    expect(await h.nx.post("繋がっていない", STYLE)).toBe("closed");
  });

  test("1 件ずつ。返事を待っている間は送らない", async () => {
    const { h, watch } = ready();
    const first = h.nx.post("一つ目", STYLE);
    expect(h.nx.ready).toBe(false);
    expect(await h.nx.post("二つ目", STYLE)).toBe("closed");
    expect(
      watch.sent.filter((m) => (m as { type?: string }).type === "postComment"),
    ).toHaveLength(1);
    watch.receive({ type: "postCommentResult", data: { chat: {} } });
    expect(await first).toBe("sent");
    expect(h.nx.ready).toBe(true);
  });

  test("room の前は書けない", async () => {
    const h = harness();
    h.nx.start();
    h.sockets[0]!.open();
    expect(await h.nx.post("早すぎる", STYLE)).toBe("closed");
  });

  test("戻ってきた自分の書き込み (yourpost) は 1 回だけ流さない。ほかの人の同じ本文は流す", async () => {
    const { h, watch, comment } = ready();
    const result = h.nx.post("草", STYLE);
    watch.receive({ type: "postCommentResult", data: { chat: {} } });
    expect(await result).toBe("sent");
    const chat = { date: T / 1000, content: "草", mail: "184 red ue big" };
    comment.receive({ chat: { ...chat, yourpost: 1 } });
    comment.receive({ chat });
    comment.receive({ chat: { ...chat, yourpost: 1 } });
    expect(h.got.map((c) => c.text)).toEqual(["草", "草"]);
  });

  test("返事より先に自分の書き込みが戻ってきたら、返事が無くても送れている", async () => {
    const { h, comment } = ready();
    const result = h.nx.post("先に戻る", STYLE);
    comment.receive({
      chat: { date: T / 1000, content: "先に戻る", yourpost: 1 },
    });
    h.fire();
    expect(await result).toBe("sent");
    expect(h.got).toEqual([]);
  });

  test("送れなかったものは、戻ってきても捨てない", async () => {
    const { h, watch, comment } = ready();
    const result = h.nx.post("失敗", STYLE);
    watch.receive({ type: "error", data: { message: "INVALID_MESSAGE" } });
    expect(await result).toBe("rejected");
    comment.receive({ chat: { date: T / 1000, content: "失敗", yourpost: 1 } });
    expect(h.got.map((c) => c.text)).toEqual(["失敗"]);
  });
});
