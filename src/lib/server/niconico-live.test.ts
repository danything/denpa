import { describe, expect, test } from "bun:test";

import { DEFAULT_POST_STYLE } from "../jikkyo/command";
import {
  allowedSocket,
  CONNECT_WAIT,
  IDLE,
  type LiveDeps,
  MAX_SESSIONS,
  NiconicoLive,
  RETRY_AFTER,
  type WatchResult,
} from "./niconico-live";

/*
 * 公式の実況への接続。外 (hub・ニコニコ) には繋がず、偽の hub と偽の WebSocket と偽の時計で見る
 */

class FakeSocket {
  readyState = 0;
  sent: { type?: string; data?: Record<string, unknown> }[] = [];
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
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  posts() {
    return this.sent.filter((m) => m.type === "postComment");
  }
}

const T = Date.UTC(2026, 10, 2, 12, 0, 0);

function harness(
  opts: {
    watch?: (token: string, channel: string) => WatchResult;
    token?: () => string | null;
    user?: string | null;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const timers: { run: () => void; at: number; id: number }[] = [];
  const asked: { token: string; channel: string; user: string }[] = [];
  let renewed = 0;
  let id = 0;
  const clock = { now: T };
  let token = "access-1";
  const deps: LiveDeps = {
    watch: async (t, channel, user) => {
      asked.push({ token: t, channel, user });
      return (
        opts.watch?.(t, channel) ?? {
          url: `wss://watch.example/${channel}`,
        }
      );
    },
    open: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    token: async () => (opts.token === undefined ? token : opts.token()),
    renew: async () => {
      renewed++;
      token = `access-${renewed + 1}`;
      return token;
    },
    user: () => (opts.user === undefined ? "12345678" : opts.user),
    now: () => clock.now,
    setTimeout: (run, ms) => {
      timers.push({ run, at: clock.now + ms, id: ++id });
      return id;
    },
    clearTimeout: (handle) => {
      const at = timers.findIndex((t) => t.id === handle);
      if (at >= 0) timers.splice(at, 1);
    },
  };
  const live = new NiconicoLive(deps);
  /** 時計を進め、その間に来る目覚ましを鳴らす */
  const advance = (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (next === undefined || next.at > until) break;
      timers.shift();
      clock.now = next.at;
      next.run();
    }
    clock.now = until;
  };
  /** 非同期の続き (偽の hub の返事) を流す */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    live,
    sockets,
    asked,
    advance,
    flush,
    clock,
    renewed: () => renewed,
  };
}

/** 繋いで、最初の返事 (`seat`) まで */
async function connected(h: ReturnType<typeof harness>, channel = "jk1") {
  expect(h.live.touch(channel)).toBe("connecting");
  await h.flush();
  const socket = h.sockets.at(-1)!;
  socket.open();
  expect(socket.sent[0]).toEqual({
    type: "startWatching",
    data: { reconnect: false },
  });
  socket.receive({
    type: "seat",
    data: {
      keepIntervalSec: 30,
      vposBaseTime: new Date(T - 60_000).toISOString(),
    },
  });
  expect(h.live.touch(channel)).toBe("ready");
  return socket;
}

describe("繋ぐ", () => {
  test("hub から接続先を受け取り、映像は頼まずに視聴を始める。最初の返事で書ける", async () => {
    const h = harness();
    const socket = await connected(h);
    expect(h.asked).toEqual([
      { token: "access-1", channel: "jk1", user: "12345678" },
    ]);
    expect(socket.url).toBe("wss://watch.example/jk1");
  });

  test("ping に pong を返し、seat の間隔で keepSeat を送る", async () => {
    const h = harness();
    const socket = await connected(h);
    socket.receive({ type: "ping" });
    expect(socket.sent.at(-1)).toEqual({ type: "pong" });
    h.advance(30_000);
    expect(socket.sent.at(-1)).toEqual({ type: "keepSeat" });
  });

  test("hub がアクセストークンを断ったら、1 回だけ更新してやり直す", async () => {
    const h = harness({
      watch: (token) =>
        token === "access-1"
          ? { error: "invalid_token", status: 401 }
          : { url: "wss://watch.example/x" },
    });
    h.live.touch("jk1");
    await h.flush();
    await h.flush();
    expect(h.renewed()).toBe(1);
    expect(h.asked.map((a) => a.token)).toEqual(["access-1", "access-2"]);
    expect(h.sockets).toHaveLength(1);
  });

  test("連携していなければ繋がない", async () => {
    const h = harness({ user: null });
    expect(h.live.touch("jk1")).toBe("unlinked");
    expect(h.asked).toEqual([]);
  });

  test("繋げなければ down にし、RETRY_AFTER の間は hub を呼ばない", async () => {
    const h = harness({
      watch: () => ({ error: "not_on_air", status: 404 }),
    });
    h.live.touch("jk1");
    await h.flush();
    expect(h.live.touch("jk1")).toBe("down");
    h.advance(RETRY_AFTER - 1);
    expect(h.live.touch("jk1")).toBe("down");
    expect(h.asked).toHaveLength(1);
    h.advance(1);
    expect(h.live.touch("jk1")).toBe("connecting");
    await h.flush();
    expect(h.asked).toHaveLength(2);
  });

  test("wss: でない接続先には繋がない (試験の偽物のループバックだけは ws: も通す)", async () => {
    const h = harness({ watch: () => ({ url: "ws://evil.example/" }) });
    h.live.touch("jk1");
    await h.flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.live.touch("jk1")).toBe("down");
    expect(allowedSocket("wss://a.example/x")).toBe(true);
    expect(allowedSocket("ws://127.0.0.1:8100/x")).toBe(true);
    expect(allowedSocket("ws://a.example/x")).toBe(false);
    expect(allowedSocket("https://a.example/x")).toBe(false);
  });

  test("呼ばれなくなったら IDLE で閉じる。次に呼ばれたらすぐ繋ぎ直す", async () => {
    const h = harness();
    const socket = await connected(h);
    h.advance(IDLE - 1);
    expect(socket.closed).toBe(false);
    h.advance(1);
    expect(socket.closed).toBe(true);
    expect(h.live.touch("jk1")).toBe("connecting");
  });

  test(`同時に開くのは ${MAX_SESSIONS} 本まで。超えたら長く呼ばれていないものを閉じる`, async () => {
    const h = harness();
    const first = await connected(h, "jk1");
    h.advance(1_000);
    const second = await connected(h, "jk4");
    h.advance(1_000);
    h.live.touch("jk4");
    await connected(h, "jk6");
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });

  test("相手が閉じたら (番組の替わり目)、次に呼ばれたときに接続先から取り直す", async () => {
    const h = harness();
    const socket = await connected(h);
    socket.receive({ type: "disconnect", data: { reason: "END_PROGRAM" } });
    expect(socket.closed).toBe(true);
    expect(h.live.touch("jk1")).toBe("connecting");
    await h.flush();
    expect(h.asked).toHaveLength(2);
  });
});

describe("書き込む", () => {
  test("いつも 184 で、選んだ装飾と vpos を付けて送り、postCommentResult で sent", async () => {
    const h = harness();
    const socket = await connected(h);
    const result = h.live.post("jk1", "こんにちは", {
      color: "red",
      position: "ue",
      size: "big",
    });
    await h.flush();
    expect(socket.posts()).toEqual([
      {
        type: "postComment",
        data: {
          text: "こんにちは",
          vpos: 6000,
          isAnonymous: true,
          color: "red",
          position: "ue",
          size: "big",
        },
      },
    ]);
    socket.receive({ type: "postCommentResult", data: {} });
    expect(await result).toBe("sent");
  });

  test("error は rejected (NOT_ON_AIR は not-on-air)、5 秒返事が無ければ unknown", async () => {
    const h = harness();
    const socket = await connected(h);
    const rejected = h.live.post("jk1", "a", DEFAULT_POST_STYLE);
    await h.flush();
    socket.receive({ type: "error", data: { message: "INVALID_MESSAGE" } });
    expect(await rejected).toBe("rejected");

    h.advance(3_000);
    const ended = h.live.post("jk1", "b", DEFAULT_POST_STYLE);
    await h.flush();
    socket.receive({ type: "error", data: { message: "NOT_ON_AIR" } });
    expect(await ended).toBe("not-on-air");

    h.advance(3_000);
    const silent = h.live.post("jk1", "c", DEFAULT_POST_STYLE);
    await h.flush();
    h.advance(5_000);
    expect(await silent).toBe("unknown");
  });

  test("世帯で 3 秒空ける (局をまたいでも)", async () => {
    const h = harness();
    const socket = await connected(h);
    await connected(h, "jk4");
    const first = h.live.post("jk1", "a", DEFAULT_POST_STYLE);
    await h.flush();
    socket.receive({ type: "postCommentResult", data: {} });
    expect(await first).toBe("sent");
    expect(await h.live.post("jk4", "b", DEFAULT_POST_STYLE)).toBe("wait");
    h.advance(3_000);
    const later = h.live.post("jk4", "c", DEFAULT_POST_STYLE);
    await h.flush();
    h.sockets.at(-1)!.receive({ type: "postCommentResult", data: {} });
    expect(await later).toBe("sent");
  });

  test("繋いでいなければ繋いでから送る。繋がらなければ closed", async () => {
    const h = harness();
    const result = h.live.post("jk1", "a", DEFAULT_POST_STYLE);
    await h.flush();
    const socket = h.sockets[0]!;
    socket.open();
    socket.receive({ type: "seat", data: { keepIntervalSec: 30 } });
    await h.flush();
    socket.receive({ type: "postCommentResult", data: {} });
    expect(await result).toBe("sent");

    const slow = harness();
    const late = slow.live.post("jk1", "a", DEFAULT_POST_STYLE);
    await slow.flush();
    slow.advance(CONNECT_WAIT);
    expect(await late).toBe("closed");
  });

  test("連携していなければ unlinked", async () => {
    const h = harness({ user: null });
    expect(await h.live.post("jk1", "a", DEFAULT_POST_STYLE)).toBe("unlinked");
  });

  test("返事を待っている間に切れたら unknown", async () => {
    const h = harness();
    const socket = await connected(h);
    const result = h.live.post("jk1", "a", DEFAULT_POST_STYLE);
    await h.flush();
    socket.drop();
    expect(await result).toBe("unknown");
  });

  test("連携を外したら全部閉じる", async () => {
    const h = harness();
    const socket = await connected(h);
    h.live.closeAll();
    expect(socket.closed).toBe(true);
  });
});
