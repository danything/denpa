import { describe, expect, test } from "bun:test";

import { DEFAULT_POST_STYLE } from "../jikkyo/command";
import {
  allowedSocket,
  BATCH,
  CONNECT_WAIT,
  HOLD,
  IDLE,
  type LiveDeps,
  LONG_POLL,
  LONG_RETRY,
  MAX_SESSIONS,
  NiconicoLive,
  RETRY_AFTER,
  type WatchResult,
} from "./niconico-live";
import { STALL } from "./niconico-view";

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

/** メッセージサーバの偽の返事。テストが少しずつ流し、閉じる */
class FakeBody {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  aborted = false;
  constructor(
    readonly url: string,
    signal: AbortSignal | null,
  ) {
    this.stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    signal?.addEventListener("abort", () => {
      this.aborted = true;
      try {
        this.controller.error(new Error("aborted"));
      } catch {
        // 閉じたあと
      }
    });
  }
  /** 長さ付きの並びの 1 つを流す */
  send(message: number[]): void {
    this.controller.enqueue(new Uint8Array(delimited(message)));
  }
  end(): void {
    this.controller.close();
  }
}

/* protobuf を組む (`niconico-messages.test.ts` と同じ) */
function v(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  while (rest >= 128) {
    out.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}
function vf(no: number, n: number): number[] {
  return [...v(no * 8), ...v(n)];
}
function bf(no: number, body: number[] | string): number[] {
  const bytes =
    typeof body === "string" ? [...new TextEncoder().encode(body)] : body;
  return [...v(no * 8 + 2), ...v(bytes.length), ...bytes];
}
function delimited(body: number[]): number[] {
  return [...v(body.length), ...body];
}
/** view の `next` */
function next(at: number): number[] {
  return bf(4, vf(1, at));
}
/** view の `segment` */
function segment(uri: string, until: number): number[] {
  return bf(1, [...bf(2, vf(1, Math.floor(until / 1000))), ...bf(3, uri)]);
}
/** セグメントのコメント */
function chat(id: string, at: number, text: string, hashed?: string): number[] {
  const body = [...bf(1, text), ...(hashed === undefined ? [] : bf(6, hashed))];
  return [
    ...bf(1, [...bf(1, id), ...bf(2, vf(1, Math.floor(at / 1000)))]),
    ...bf(2, bf(1, body)),
  ];
}

const T = Date.UTC(2026, 10, 2, 12, 0, 0);

function harness(
  opts: {
    watch?: (token: string, channel: string) => WatchResult;
    token?: () => string | null;
    user?: string | null;
    /** 更新で hub に届かない */
    renewFails?: boolean;
    /** メッセージサーバの HTTP の状態 (既定 200) */
    status?: (url: string) => number;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const bodies: FakeBody[] = [];
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
    fetch: async () => {
      throw new Error("下で差し替える");
    },
    token: async () => (opts.token === undefined ? token : opts.token()),
    renew: async () => {
      renewed++;
      if (opts.renewFails === true) throw new Error("hub に届きません");
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
  deps.fetch = async (url, init) => {
    const body = new FakeBody(url, init.signal ?? null);
    bodies.push(body);
    return new Response(body.stream, { status: opts.status?.(url) ?? 200 });
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
    bodies,
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
  test("hub から接続先を受け取り、映像はリクエストせずに視聴を始める。最初の返事で書ける", async () => {
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

  test("更新で hub に届かなければ、連携は切れたことにせず down にする", async () => {
    const h = harness({
      watch: () => ({ error: "invalid_token", status: 401 }),
      renewFails: true,
    });
    h.live.touch("jk1");
    await h.flush();
    await h.flush();
    expect(h.renewed()).toBe(1);
    expect(h.live.touch("jk1")).toBe("down");
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

  test("wss: でない接続先には繋がない (テストの偽物のループバックだけは ws: も通す)", async () => {
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

  test("繋ぎ始めに 2 台から書いたら、先に送ったほうのあとは wait (送っていないほうは間隔を使わない)", async () => {
    const h = harness();
    const a = h.live.post("jk1", "a", DEFAULT_POST_STYLE);
    const b = h.live.post("jk1", "b", DEFAULT_POST_STYLE);
    await h.flush();
    const socket = h.sockets[0]!;
    socket.open();
    socket.receive({ type: "seat", data: { keepIntervalSec: 30 } });
    await h.flush();
    expect(await b).toBe("wait");
    expect(socket.posts()).toHaveLength(1);
    socket.receive({ type: "postCommentResult", data: {} });
    expect(await a).toBe("sent");
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

/** 非同期の続き (偽の fetch と、返事の読み取り) を何度か流す */
async function settle(h: ReturnType<typeof harness>, times = 8) {
  for (let i = 0; i < times; i++) await h.flush();
}

const VIEW = "https://mpn.example/api/view/v4/abc";

/** 繋いで `messageServer` を受け、view の `at=now` → 次の view → セグメントまで進める。セグメントの返事を返す */
async function receiving(h: ReturnType<typeof harness>, channel = "jk1") {
  const socket = await connected(h, channel);
  socket.receive({
    type: "messageServer",
    data: { viewUri: VIEW, hashedUserId: "a:own" },
  });
  await settle(h);
  const now = h.bodies.at(-1)!;
  expect(now.url).toBe(`${VIEW}?at=now`);
  now.send(next(1_000));
  now.end();
  await settle(h);
  const view = h.bodies.at(-1)!;
  expect(view.url).toBe(`${VIEW}?at=1000`);
  view.send(segment("https://mpn.example/data/segment/v4/s1", T + 16_000));
  await settle(h);
  const seg = h.bodies.at(-1)!;
  expect(seg.url).toBe("https://mpn.example/data/segment/v4/s1");
  // view を読めただけでは、まだ受けられていない
  expect((await h.live.feed(channel, null, null)).since).toBeNull();
  // 先読みしたセグメントの先頭の合図 (Signal.Flushed)。ここで受けられていることになる
  seg.send(vf(5, 0));
  await settle(h);
  expect((await h.live.feed(channel, null, null)).since).toBe(T);
  return { socket, view, seg };
}

describe("受ける", () => {
  test("messageServer の view からセグメントを読み、feed に渡す。受けている間は since がある", async () => {
    const h = harness();
    const first = await h.live.feed("jk1", null, null);
    expect(first.comments).toEqual([]);
    const { seg } = await receiving(h);
    const waiting = h.live.feed("jk1", first.seq, first.epoch);
    seg.send(chat("m1", T + 2_000, " こんにちは "));
    seg.send(chat("m2", T + 3_000, "自分", "a:own"));
    // 同じ ID は 1 回だけ
    seg.send(chat("m1", T + 2_000, " こんにちは "));
    await settle(h);
    h.advance(BATCH);
    const got = await waiting;
    expect(got.state).toBe("ready");
    expect(got.since).toBe(T);
    expect(got.comments).toEqual([
      { at: T + 2_000, text: "こんにちは" },
      { at: T + 3_000, text: "自分", own: true },
    ]);
    // 続きは番号の後ろから
    const again = h.live.feed("jk1", got.seq, got.epoch);
    h.advance(LONG_POLL);
    expect((await again).comments).toEqual([]);
  });

  test("epoch が違えば (サーバを起こし直した) 番号を捨て、いまの番号だけ返す", async () => {
    const h = harness();
    const { seg } = await receiving(h);
    seg.send(chat("m1", T, "a"));
    await settle(h);
    const got = await h.live.feed("jk1", 0, "old");
    expect(got.comments).toEqual([]);
    expect(got.seq).toBe(1);
  });

  test("状態が変わったら、待っている feed をすぐ返す", async () => {
    const h = harness();
    const first = await h.live.feed("jk1", null, null);
    const { socket } = await receiving(h);
    const waiting = h.live.feed("jk1", first.seq, first.epoch);
    socket.receive({ type: "disconnect", data: { reason: "END_PROGRAM" } });
    const got = await waiting;
    expect(got.since).toBeNull();
    expect(h.bodies.every((b) => b.aborted || b.url.includes("at=now"))).toBe(
      true,
    );
  });

  test("閉じたら、読んでいる view とセグメントを止める", async () => {
    const h = harness();
    const { view, seg } = await receiving(h);
    h.live.closeAll();
    expect(view.aborted).toBe(true);
    expect(seg.aborted).toBe(true);
  });

  test("view が止まったら (STALL の間バイトが来ない) 受けていないことにし、at=now から取り直す", async () => {
    const h = harness();
    await receiving(h);
    const before = h.bodies.length;
    h.advance(STALL);
    await settle(h);
    expect((await h.live.feed("jk1", null, null)).since).toBeNull();
    h.advance(1_000);
    await settle(h);
    expect(h.bodies.length).toBeGreaterThan(before);
    expect(h.bodies.at(-1)!.url).toBe(`${VIEW}?at=now`);
  });

  test("view の 403・404 は接続ごと down にする", async () => {
    const h = harness({ status: (url) => (url.includes("at=") ? 404 : 200) });
    const socket = await connected(h);
    socket.receive({
      type: "messageServer",
      data: { viewUri: VIEW, hashedUserId: "a:own" },
    });
    await settle(h);
    expect(socket.closed).toBe(true);
    expect(h.live.touch("jk1")).toBe("down");
  });

  test("https: でない view は読まない", async () => {
    const h = harness();
    const socket = await connected(h);
    socket.receive({
      type: "messageServer",
      data: { viewUri: "http://evil.example/view" },
    });
    await settle(h);
    expect(h.bodies).toHaveLength(0);
  });
});

describe("上限と聴かれている局", () => {
  test(`feed で聴かれている局は閉じない。${MAX_SESSIONS} つとも聴かれていれば新しい局は down。HOLD を過ぎれば開ける`, async () => {
    const h = harness();
    const a = await connected(h, "jk1");
    await h.live.feed("jk1", null, null);
    const b = await connected(h, "jk4");
    await h.live.feed("jk4", null, null);
    expect(h.live.touch("jk6")).toBe("down");
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
    h.advance(HOLD);
    expect(h.live.touch("jk6")).toBe("connecting");
    expect(a.closed).toBe(true);
  });
});

describe("切れ方", () => {
  test("reconnect は待ってから audience_token を替えて繋ぎ直す (hub は呼ばない)", async () => {
    const h = harness({
      watch: () => ({ url: "wss://watch.example/jk1?audience_token=t1" }),
    });
    const socket = await connected(h);
    socket.receive({
      type: "reconnect",
      data: { audienceToken: "t2", waitTimeSec: 10 },
    });
    expect(socket.closed).toBe(true);
    expect(h.live.touch("jk1")).toBe("connecting");
    h.advance(9_999);
    expect(h.sockets).toHaveLength(1);
    h.advance(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]!.url).toBe("wss://watch.example/jk1?audience_token=t2");
    expect(h.asked).toHaveLength(1);
  });

  test("追い出された・接続が多すぎるときは LONG_RETRY 待つ。ほかの理由は RETRY_AFTER", async () => {
    const h = harness();
    const socket = await connected(h);
    socket.receive({ type: "disconnect", data: { reason: "TAKEOVER" } });
    h.advance(RETRY_AFTER);
    expect(h.live.touch("jk1")).toBe("down");
    h.advance(LONG_RETRY - RETRY_AFTER);
    expect(h.live.touch("jk1")).toBe("connecting");

    const other = await connected(h, "jk4");
    other.receive({ type: "disconnect", data: { reason: "CROWDED" } });
    h.advance(RETRY_AFTER - 1);
    expect(h.live.touch("jk4")).toBe("down");
    h.advance(1);
    expect(h.live.touch("jk4")).toBe("connecting");
  });

  test("disconnect 無しに閉じられたら RETRY_AFTER 待つ (閉じられ続けて hub を呼び続けない)", async () => {
    const h = harness();
    const socket = await connected(h);
    socket.drop();
    expect(h.live.touch("jk1")).toBe("down");
    h.advance(RETRY_AFTER);
    expect(h.live.touch("jk1")).toBe("connecting");
  });
});
