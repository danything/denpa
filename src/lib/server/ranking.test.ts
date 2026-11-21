import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { eq } from "drizzle-orm";

/**
 * 番組ランキングに送るもの (`ranking.ts`)。外の hub には繋がず、偽の hub で受けた本文を見る。
 * 送る中身・差分・送る時刻のずらし方・オフにしたときの取り消しを見る
 */
const dir = mkdtempSync(joinPath(tmpdir(), "denpa-ranking-"));
const { config } = await import("./config");
config.dbPath = joinPath(dir, "denpa.db");
config.dataDir = dir;

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);

interface Received {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
  /** クエリ (`?limit=50`) */
  search: string;
}
let received: Received[] = [];
/** 偽の hub の返事。`path` ごとに差し替える */
let reply: (request: Received) => Response | Promise<Response>;
/** 偽の hub が出すトークン (出すたびに次へ進む) */
let tokens: string[] = [];
/** 偽の hub が `GET /ranking` で返す順位 */
let rankingBody: unknown = { v: 1, entries: [] };

function defaultReply(request: Received): Response {
  if (request.path === "/ranking" && request.method === "GET")
    return Response.json(rankingBody);
  if (request.path === "/ranking/tokens")
    return Response.json({ token: tokens.shift() ?? TOKEN_A }, { status: 201 });
  if (request.path === "/ranking/votes")
    return Response.json({ accepted: 0, rejected: 0 });
  if (request.path === "/ranking/tokens/self")
    return new Response(null, { status: 204 });
  return Response.json({ error: "not_found" }, { status: 404 });
}

const hub = Bun.serve({
  port: 0,
  async fetch(request) {
    const text = await request.text();
    const entry: Received = {
      method: request.method,
      path: new URL(request.url).pathname,
      auth: request.headers.get("authorization"),
      body: text === "" ? null : (JSON.parse(text) as unknown),
      search: new URL(request.url).search,
    };
    received.push(entry);
    return reply(entry);
  },
});
config.hubUrl = `http://127.0.0.1:${hub.port}`;
afterAll(() => {
  void hub.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const ranking = await import("./ranking");
const {
  JITTER,
  MAX_ADD,
  SEND_EVERY,
  VIEW_FRESH,
  VIEW_RETRY,
  VIEW_STALE,
  currentVotes,
  digest,
  dropRankingView,
  isoJst,
  DECIDED_KEY,
  decline,
  join,
  leave,
  nextSendAt,
  plan,
  rankingInvite,
  rankingState,
  rankingView,
  sendIfDue,
} = ranking;
const { now, orm } = await import("./db");
const {
  programs,
  rankingLink,
  rankingSent,
  rankingWatched,
  recordings,
  reservations,
  services,
  settings,
} = await import("./schema");
const watch = await import("./ranking-watch");
const { programKey, serviceKey } = await import("./tuner");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 局。`type` が CATV ならケーブルで受けた局 */
const STATIONS = {
  bs11: { network: 4, service: 211, type: "BS", name: "BS11イレブン" },
  mx: { network: 32391, service: 23608, type: "GR", name: "TOKYO MX1" },
  cs: { network: 7, service: 333, type: "CS", name: "AT-X" },
  /** 系列の地方局 (近畿広域の TBS 系) */
  mbs: { network: 32720, service: 2064, type: "GR", name: "MBS毎日放送" },
  /** ケーブルで再送信している BS (元の放送は BS) */
  catvBs: { network: 4, service: 211, type: "CATV", name: "BS11イレブン" },
  /** ケーブルの自主放送 */
  catvOwn: {
    network: 0xfffe,
    service: 100,
    type: "CATV",
    name: "ケーブル 11ch",
  },
  sky: { network: 10, service: 500, type: "SKY", name: "スカパー！の局" },
} as const;
type Station = keyof typeof STATIONS;

function addServices(): void {
  for (const s of Object.values(STATIONS)) {
    orm()
      .insert(services)
      .values({
        id: serviceKey(s.network, s.service, s.type),
        service_id: s.service,
        network_id: s.network,
        name: s.name,
        type: s.type,
        updated_at: now(),
      })
      .onConflictDoNothing()
      .run();
  }
}

let eventSerial = 1000;
/** 番組と予約を 1 つ入れる。返すのは event_id */
function reserve(
  station: Station,
  options: {
    startsIn?: number;
    /** 始まりの時刻。あれば `startsIn` より先に使う */
    at?: number;
    minutes?: number;
    manual?: boolean;
    state?: "scheduled" | "conflict" | "skipped" | "canceled";
    started?: boolean;
    free?: boolean;
    name?: string;
    event?: number;
  } = {},
): number {
  const s = STATIONS[station];
  const event = options.event ?? eventSerial++;
  const start = options.at ?? now() + (options.startsIn ?? 2 * HOUR);
  const end = start + (options.minutes ?? 30) * MINUTE;
  const id = programKey(s.network, s.service, event, s.type);
  orm()
    .insert(programs)
    .values({
      id,
      service_id: serviceKey(s.network, s.service, s.type),
      network_id: s.network,
      event_id: event,
      start_at: start,
      end_at: end,
      name: options.name ?? `番組 ${event}`,
      genres: [7, 7, 3],
      is_free: options.free ?? true,
      updated_at: now(),
    })
    .run();
  orm()
    .insert(reservations)
    .values({
      program_id: id,
      rule_id: options.manual === false ? 1 : null,
      service_id: serviceKey(s.network, s.service, s.type),
      name: options.name ?? `番組 ${event}`,
      start_at: start,
      end_at: end,
      manual: options.manual ?? true,
      state: options.state ?? "scheduled",
      started_at: options.started === true ? start : null,
      created_at: now(),
      updated_at: now(),
    })
    .run();
  return event;
}

function votesSent(): Received[] {
  return received.filter((r) => r.path === "/ranking/votes");
}

function lastBody(): {
  v: number;
  add: Record<string, unknown>[];
  remove: Record<string, unknown>[];
} {
  const all = votesSent();
  return all[all.length - 1]!.body as ReturnType<typeof lastBody>;
}

beforeEach(() => {
  orm().delete(rankingSent).run();
  orm().delete(rankingLink).run();
  orm().delete(reservations).run();
  orm().delete(recordings).run();
  orm().delete(programs).run();
  addServices();
  received = [];
  tokens = [TOKEN_A, TOKEN_B];
  reply = defaultReply;
  rankingBody = { v: 1, entries: [] };
  dropRankingView();
  orm().update(services).set({ listed: true }).run();
});

describe("送る中身", () => {
  test("終わっていない地上波・BS・CS の予約済みと競合を、録画中も有料放送も送る", () => {
    const bs = reserve("bs11", { manual: false });
    const gr = reserve("mx", { state: "conflict" });
    const pay = reserve("cs", { free: false });
    const recording = reserve("bs11", {
      startsIn: -10 * MINUTE,
      started: true,
    });
    const onAir = reserve("bs11", { startsIn: -10 * MINUTE });
    reserve("bs11", { state: "skipped" });
    reserve("bs11", { state: "canceled" });
    reserve("bs11", { startsIn: -HOUR });
    reserve("catvOwn");
    reserve("sky");
    const events = currentVotes()
      .map((c) => c.vote.event_id)
      .sort();
    expect(events).toEqual([bs, gr, pay, recording, onAir].sort());
  });

  test("1 件の形は hub の add と同じ。家の住所やルールの中身は入らない", () => {
    // 期待値と同じ時刻を渡す。now() を読み直すと、その間に秒が進んで start_at がずれることがある
    const start = now() + 3 * HOUR;
    const event = reserve("bs11", {
      at: start,
      minutes: 30,
      manual: false,
      name: "  [字]アニメ\n例の番組  ",
    });
    const [only] = currentVotes();
    expect(only!.vote).toEqual({
      network_id: 4,
      service_id: 211,
      event_id: event,
      start_at: isoJst(start),
      duration: 1800,
      name: "[字]アニメ 例の番組",
      service_name: "BS11イレブン",
      genres: [7, 3],
      kinds: ["reserved"],
    });
    expect(Object.keys(only!.vote).sort()).toEqual(
      [
        "duration",
        "event_id",
        "genres",
        "kinds",
        "name",
        "network_id",
        "service_id",
        "service_name",
        "start_at",
      ].sort(),
    );
  });

  test("始まりは日本時間の ISO 8601 で、秒より下を落とす", () => {
    expect(isoJst(Date.UTC(2026, 10, 20, 12, 0, 0, 500))).toBe(
      "2026-11-20T21:00:00+09:00",
    );
  });

  test("同じ放送を BS とケーブルの再送信で予約していたら 1 件にする", () => {
    reserve("bs11", { event: 77, manual: false });
    reserve("catvBs", { event: 77, manual: true });
    const votes = currentVotes();
    expect(votes).toHaveLength(1);
    expect(votes[0]!.vote.kinds).toEqual(["reserved"]);
    expect(votes[0]!.vote.network_id).toBe(4);
  });

  test("ケーブルで再送信している BS の局も、元の放送の識別で送る", () => {
    reserve("catvBs", { event: 78 });
    expect(currentVotes().map((c) => c.vote.network_id)).toEqual([4]);
  });

  test("番組名は 120 文字で切り、サロゲートペアを半分にしない", () => {
    reserve("bs11", { name: `${"あ".repeat(119)}🎵` });
    const name = currentVotes()[0]!.vote.name;
    expect(name).toBe("あ".repeat(119));
  });
});

describe("差分", () => {
  function sentRow(
    event: number,
    startAt: number,
    d: string,
    endAt = startAt + 30 * MINUTE,
  ) {
    return {
      network_id: 4,
      service_id: 211,
      event_id: event,
      start_at: startAt,
      end_at: endAt,
      digest: d,
    };
  }

  test("送っていないもの・中身が変わったものを add、外れたものを remove、終わったものは控えから消すだけ", () => {
    const a = reserve("bs11");
    const b = reserve("bs11");
    const current = currentVotes();
    const voteA = current.find((c) => c.vote.event_id === a)!;
    const at = now();
    const result = plan(
      current,
      [
        // a は同じ中身で送ってある
        sentRow(a, voteA.startMs, digest(voteA.vote)),
        // b は前と中身が違う (延長など)
        sentRow(b, at + HOUR, "old"),
        // 取り消した予約
        sentRow(9001, at + HOUR, "x"),
        // もう終わった番組
        sentRow(9002, at - HOUR, "x"),
        // 放送中に取り消した予約は remove を送る
        sentRow(9003, at - 10 * MINUTE, "x"),
        // 終わりを持たない行 (列を足す前) は始まりで見る
        sentRow(9004, at - 10 * MINUTE, "x", 0),
      ],
      at,
    );
    expect(result.add.map((c) => c.vote.event_id)).toEqual([b]);
    expect(result.remove).toEqual([
      { network_id: 4, service_id: 211, event_id: 9001 },
      { network_id: 4, service_id: 211, event_id: 9003 },
    ]);
    expect(result.drop).toEqual([
      { network_id: 4, service_id: 211, event_id: 9002 },
      { network_id: 4, service_id: 211, event_id: 9004 },
    ]);
  });

  test("add は始まりの早い順に 2000 件まで", () => {
    const current = Array.from({ length: MAX_ADD + 5 }, (_, i) => ({
      vote: {
        network_id: 4,
        service_id: 211,
        event_id: i + 1,
        start_at: isoJst(now() + HOUR),
        duration: 60,
        name: "x",
        service_name: "y",
        genres: [],
        kinds: ["reserved" as const],
      },
      startMs: now() + (MAX_ADD + 5 - i) * MINUTE,
      endMs: now() + (MAX_ADD + 6 - i) * MINUTE,
    }));
    const result = plan(current, []);
    expect(result.add).toHaveLength(MAX_ADD);
    expect(result.add[0]!.vote.event_id).toBe(MAX_ADD + 5);
  });
});

describe("送る時刻", () => {
  const SLOT = 2 * HOUR + 17 * MINUTE;

  test("6 時間ごとの位置から ±15 分の中で、いつも前より後", () => {
    const after = Date.UTC(2026, 10, 17, 0, 0, 0);
    for (const r of [0, 0.5, 0.999999]) {
      const next = nextSendAt(SLOT, after, () => r);
      expect(next).toBeGreaterThan(after);
      const offset = (((next - SLOT) % SEND_EVERY) + SEND_EVERY) % SEND_EVERY;
      const distance = Math.min(offset, SEND_EVERY - offset);
      expect(distance).toBeLessThanOrEqual(JITTER);
    }
    // 真ん中の乱数ならちょうど位置に来る
    expect((nextSendAt(SLOT, after, () => 0.5) - SLOT) % SEND_EVERY).toBe(0);
  });

  test("続けて送る間は 5.5〜6.5 時間", () => {
    let at = Date.UTC(2026, 10, 17, 0, 0, 0);
    let previous: number | null = null;
    for (let i = 0; i < 50; i++) {
      at = nextSendAt(SLOT, at);
      if (previous !== null) {
        expect(at - previous).toBeGreaterThanOrEqual(SEND_EVERY - 2 * JITTER);
        expect(at - previous).toBeLessThanOrEqual(SEND_EVERY + 2 * JITTER);
      }
      previous = at;
    }
  });

  test("家ごとの位置 (参加したときの乱数) で時刻が変わる", () => {
    const after = Date.UTC(2026, 10, 17, 0, 0, 0);
    const a = nextSendAt(1 * HOUR, after, () => 0.5);
    const b = nextSendAt(4 * HOUR, after, () => 0.5);
    expect(b - a).toBe(3 * HOUR);
  });
});

describe("オンにする・送る", () => {
  test("オンにするとトークンを受け取り、すぐ 1 回目を送る", async () => {
    reserve("bs11");
    const result = await join(() => 0.25);
    expect(result).toEqual({ ok: true });
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /ranking/tokens",
      "POST /ranking/votes",
    ]);
    expect(received[0]!.auth).toBeNull();
    expect(received[1]!.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(lastBody().v).toBe(1);
    expect(lastBody().add).toHaveLength(1);
    const state = rankingState();
    expect(state.state).toBe("on");
    if (state.state === "on") {
      expect(state.sentAt).not.toBeNull();
      expect(state.failure).toBeNull();
    }
    const link = orm().select().from(rankingLink).get()!;
    expect(link.slot).toBe(SEND_EVERY / 4);
    expect(link.next_at).toBeGreaterThan(now());
  });

  test("hub に届かなければオンにしない", async () => {
    reply = () => new Response("boom", { status: 503 });
    const result = await join();
    expect(result).toEqual({
      ok: false,
      message: "denpa-hub に届かないため、参加できませんでした",
    });
    expect(rankingState()).toEqual({ state: "off" });
  });

  test("hub がランキングを受け付けていない (404) ならオンにしない", async () => {
    reply = () => Response.json({ error: "not_found" }, { status: 404 });
    const result = await join();
    expect(result).toEqual({
      ok: false,
      message:
        "denpa-hub が番組ランキングを受け付けていないため、参加できませんでした",
    });
    expect(rankingState()).toEqual({ state: "off" });
  });

  test("2 回目からは前に送ってからの差分だけを送る", async () => {
    const keep = reserve("bs11");
    const gone = reserve("mx");
    await join();
    expect(lastBody().add).toHaveLength(2);
    // 1 つ取り消し、1 つ足す
    orm()
      .update(reservations)
      .set({ state: "canceled" })
      .where(
        // gone の予約
        eq(reservations.program_id, programKey(32391, 23608, gone, "GR")),
      )
      .run();
    const added = reserve("cs");
    orm()
      .update(rankingLink)
      .set({ next_at: now() - 1 })
      .run();
    await sendIfDue();
    const body = lastBody();
    expect(body.add.map((v) => v["event_id"])).toEqual([added]);
    expect(body.remove).toEqual([
      { network_id: 32391, service_id: 23608, event_id: gone },
    ]);
    expect(
      orm()
        .select()
        .from(rankingSent)
        .all()
        .map((r) => r.event_id)
        .sort(),
    ).toEqual([keep, added].sort());
  });

  test("送る時刻が来ていなければ送らない", async () => {
    await join();
    const before = votesSent().length;
    await sendIfDue();
    expect(votesSent()).toHaveLength(before);
  });

  test("送れなければ控えはそのままで、次の回に再試行する", async () => {
    await join();
    reserve("bs11");
    reply = (r) =>
      r.path === "/ranking/votes"
        ? new Response("busy", { status: 503 })
        : defaultReply(r);
    orm()
      .update(rankingLink)
      .set({ next_at: now() - 1 })
      .run();
    await sendIfDue();
    expect(rankingState()).toMatchObject({
      state: "on",
      failure: "unreachable",
    });
    expect(orm().select().from(rankingSent).all()).toHaveLength(0);
    const link = orm().select().from(rankingLink).get()!;
    // 次の回 (家ごとの位置) まで待つ。すぐには送り直さない
    expect(link.next_at).toBeGreaterThan(now());

    // 次の回で同じ予約を送る
    reply = defaultReply;
    orm()
      .update(rankingLink)
      .set({ next_at: now() - 1 })
      .run();
    await sendIfDue();
    expect(lastBody().add).toHaveLength(1);
    expect(rankingState()).toMatchObject({ state: "on", failure: null });
  });

  test("hub がランキングをやめていたら (404) そう出し、次の回にまた試す", async () => {
    await join();
    reply = (r) =>
      r.path === "/ranking/votes"
        ? Response.json({ error: "not_found" }, { status: 404 })
        : defaultReply(r);
    orm()
      .update(rankingLink)
      .set({ next_at: now() - 1 })
      .run();
    await sendIfDue();
    expect(rankingState()).toMatchObject({ state: "on", failure: "disabled" });
  });

  test("hub がトークンを断ったら (401) 取り直し、控えを空にして全部送り直す", async () => {
    reserve("bs11");
    await join();
    reserve("mx");
    let refused = false;
    reply = (r) => {
      if (r.path === "/ranking/votes" && r.auth === `Bearer ${TOKEN_A}`) {
        refused = true;
        return Response.json({ error: "invalid_token" }, { status: 401 });
      }
      return defaultReply(r);
    };
    orm()
      .update(rankingLink)
      .set({ next_at: now() - 1 })
      .run();
    await sendIfDue();
    expect(refused).toBe(true);
    const last = votesSent().at(-1)!;
    expect(last.auth).toBe(`Bearer ${TOKEN_B}`);
    expect((last.body as { add: unknown[] }).add).toHaveLength(2);
    expect(orm().select().from(rankingLink).get()!.token).toBe(TOKEN_B);
  });

  test("トークンと送った番組名は記録に書かない", async () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const warn = spyOn(console, "warn").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      reserve("bs11", { name: "ひみつの番組" });
      await join();
      await leave();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
    const text = logs.join("\n");
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain("ひみつの番組");
  });
});

describe("オフにする", () => {
  test("送った票を全部取り消してからトークンを消し、手元も消す", async () => {
    const a = reserve("bs11");
    const b = reserve("mx");
    await join();
    received = [];
    expect(await leave()).toEqual({ reached: true });
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /ranking/votes",
      "DELETE /ranking/tokens/self",
    ]);
    const body = received[0]!.body as {
      add: unknown[];
      remove: { event_id: number }[];
    };
    expect(body.add).toEqual([]);
    expect(body.remove.map((r) => r.event_id).sort()).toEqual([a, b].sort());
    expect(received[1]!.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(rankingState()).toEqual({ state: "off" });
    expect(orm().select().from(rankingSent).all()).toHaveLength(0);
  });

  test("hub に届かなくても手元は消す", async () => {
    reserve("bs11");
    await join();
    reply = () => new Response("down", { status: 503 });
    expect(await leave()).toEqual({ reached: false });
    expect(rankingState()).toEqual({ state: "off" });
    expect(orm().select().from(rankingSent).all()).toHaveLength(0);
  });

  test("オフのあとは送らない", async () => {
    await join();
    await leave();
    received = [];
    await sendIfDue(now() + 10 * SEND_EVERY);
    expect(received).toHaveLength(0);
  });
});

describe("参加するかの案内", () => {
  beforeEach(() => {
    orm().delete(settings).where(eq(settings.key, DECIDED_KEY)).run();
  });

  test("参加しておらず、まだ決めていない家にだけ出す", () => {
    expect(rankingInvite()).toBe(true);
  });

  test("印を足す前から参加している家には出さない", () => {
    orm()
      .insert(rankingLink)
      .values({
        id: 1,
        token: TOKEN_A,
        slot: 0,
        next_at: now(),
        joined_at: now(),
      })
      .run();
    expect(rankingInvite()).toBe(false);
  });

  test("参加したら出さず、やめたあとも出さない", async () => {
    await join();
    expect(rankingInvite()).toBe(false);
    await leave();
    expect(rankingState()).toEqual({ state: "off" });
    expect(rankingInvite()).toBe(false);
  });

  test("参加しないを選んだら、何も送らずに出さない", async () => {
    await decline();
    expect(received).toHaveLength(0);
    expect(rankingState()).toEqual({ state: "off" });
    expect(rankingInvite()).toBe(false);
  });

  test("参加できなかったときは決めたことにせず、また出す", async () => {
    reply = () => new Response("boom", { status: 503 });
    expect((await join()).ok).toBe(false);
    expect(rankingInvite()).toBe(true);
  });

  test("参加しないを押すまでにほかの端末で参加していたら、参加したままにする", async () => {
    await join();
    received = [];
    await decline();
    expect(received).toHaveLength(0);
    expect(rankingState().state).toBe("on");
  });
});

describe("順位を見る", () => {
  /** 番組表に番組を 1 つ入れる (予約は入れない)。返すのは番組の ID */
  function addProgram(
    station: Station,
    event: number,
    options: { startsIn?: number; at?: number; name?: string } = {},
  ): number {
    const s = STATIONS[station];
    const start = options.at ?? now() + (options.startsIn ?? 2 * HOUR);
    const id = programKey(s.network, s.service, event, s.type);
    orm()
      .insert(programs)
      .values({
        id,
        service_id: serviceKey(s.network, s.service, s.type),
        network_id: s.network,
        event_id: event,
        start_at: start,
        end_at: start + 30 * MINUTE,
        name: options.name ?? `手元の番組 ${event}`,
        genres: [7],
        is_free: true,
        updated_at: now(),
      })
      .run();
    return id;
  }

  /** hub の順位の 1 件 */
  function entry(
    rank: number,
    votes: number,
    airings: {
      network_id: number;
      service_id: number;
      event_id: number;
      startsIn?: number;
      /** 始まりの時刻。あれば `startsIn` より先に使う */
      at?: number;
      /** 長さ (分)。省くと 30 分 */
      minutes?: number;
      service_name?: string;
      region?: string | null;
    }[],
    affiliation: string | null = null,
  ) {
    return {
      rank,
      votes,
      name: `hub の番組 ${rank}`,
      genres: [7],
      affiliation,
      airings: airings.map((a) => ({
        network_id: a.network_id,
        service_id: a.service_id,
        event_id: a.event_id,
        start_at: isoJst(a.at ?? now() + (a.startsIn ?? 2 * HOUR)),
        end_at: isoJst(
          (a.at ?? now() + (a.startsIn ?? 2 * HOUR)) +
            (a.minutes ?? 30) * MINUTE,
        ),
        service_name: a.service_name ?? "hub の局",
        region: a.region ?? null,
      })),
    };
  }

  function views(): Received[] {
    return received.filter((r) => r.method === "GET" && r.path === "/ranking");
  }

  async function view() {
    const result = await rankingView();
    if (result === null) throw new Error("参加していません");
    return result;
  }

  test("参加していなければ null で、hub を呼ばない", () => {
    expect(rankingView()).toBeNull();
    expect(received).toHaveLength(0);
  });

  test("受信できる局の放送は手元の番組の行に、受信できない局の放送は hub の局名と地域のまま出す", async () => {
    const local = addProgram("bs11", 501);
    // hub が返す始まりと期待値に同じ時刻を使う。now() を読み直すと、その間に秒が進むことがある
    const awayAt = now() + 3 * HOUR;
    rankingBody = {
      v: 1,
      generated_at: isoJst(now()),
      entries: [
        entry(1, 120, [
          {
            network_id: 32736,
            service_id: 1024,
            event_id: 777,
            service_name: "NHK総合1・東京",
            region: "関東広域",
            at: awayAt,
          },
        ]),
        entry(2, 60, [{ network_id: 4, service_id: 211, event_id: 501 }]),
      ],
    };
    await join();
    const result = await view();
    expect(views()).toHaveLength(1);
    expect(views()[0]!.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(views()[0]!.search).toBe("?limit=50");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 順位は hub のまま。受信できない番組を飛ばして振り直さない
    expect(result.rows.map((r) => r.rank)).toEqual([1, 2]);
    const [away, mine] = result.rows;
    expect(away!.program).toBeNull();
    expect(away!.away).toEqual({
      name: "hub の番組 1",
      service_name: "NHK総合1・東京",
      region: "関東広域",
      affiliation: null,
      others: 0,
      start_at: Math.floor(awayAt / 1000) * 1000,
    });
    expect(mine!.away).toBeNull();
    expect(mine!.votes).toBe(60);
    expect(mine!.program).toMatchObject({
      id: local,
      name: "手元の番組 501",
      service_name: "BS11イレブン",
      reservation_id: null,
    });
    // 画面に渡す行には、局の種別と service_id を入れない (検索の結果の行と同じ形)
    expect(mine!.program).not.toHaveProperty("service_type");
    expect(mine!.program).not.toHaveProperty("service_sid");
  });

  test("放送中と終わった番組も出し、行の状態と、終わった番組の再生できる録画を添える", async () => {
    const onAir = addProgram("bs11", 511, { startsIn: -10 * MINUTE });
    const ended = addProgram("bs11", 512, { startsIn: -3 * HOUR });
    const missed = addProgram("bs11", 513, { startsIn: -5 * HOUR });
    const at = now();
    orm()
      .insert(recordings)
      .values({
        program_id: ended,
        service_id: serviceKey(4, 211, "BS"),
        name: "手元の番組 512",
        start_at: at - 3 * HOUR,
        end_at: at - 3 * HOUR + 30 * MINUTE,
        finished_at: at - 2 * HOUR,
        created_at: at,
        updated_at: at,
      })
      .run();
    const recording = orm().select().from(recordings).get()!.id;
    rankingBody = {
      v: 1,
      entries: [
        entry(1, 40, [
          {
            network_id: 4,
            service_id: 211,
            event_id: 512,
            startsIn: -3 * HOUR,
          },
        ]),
        entry(2, 30, [
          {
            network_id: 4,
            service_id: 211,
            event_id: 511,
            startsIn: -10 * MINUTE,
          },
        ]),
        entry(3, 20, [
          {
            network_id: 4,
            service_id: 211,
            event_id: 513,
            startsIn: -5 * HOUR,
          },
        ]),
        // 受信できない局で終わった番組も、終わって 24 時間までは出す
        entry(4, 10, [
          { network_id: 4, service_id: 999, event_id: 1, startsIn: -20 * HOUR },
        ]),
      ],
    };
    await join();
    const result = await view();
    if (!result.ok) throw new Error("読めませんでした");
    expect(
      result.rows.map((r) => [
        r.rank,
        r.state,
        r.program?.id ?? null,
        r.recording,
      ]),
    ).toEqual([
      [1, "ended", ended, recording],
      [2, "onair", onAir, null],
      [3, "ended", missed, null],
      [4, "ended", null, null],
    ]);
  });

  test("同じ放送を BS とケーブルの再送信で受けていたら、BS の局の行にする", async () => {
    // 同じ放送なので始まりも同じ。別々に now() を読むと、先に入れたほうがミリ秒だけ早く始まることがある
    const at = now() + 2 * HOUR;
    addProgram("catvBs", 502, { at });
    const bs = addProgram("bs11", 502, { at });
    rankingBody = {
      v: 1,
      entries: [
        entry(1, 30, [{ network_id: 4, service_id: 211, event_id: 502 }]),
      ],
    };
    await join();
    const result = await view();
    expect(result.ok && result.rows[0]!.program?.id).toBe(bs);
  });

  test("一覧から外れた局は受信できない局として出し、終わって 24 時間を過ぎていて手元に無い番組は出さない", async () => {
    addProgram("mx", 503);
    orm()
      .update(services)
      .set({ listed: false })
      .where(eq(services.name, "TOKYO MX1"))
      .run();
    rankingBody = {
      v: 1,
      entries: [
        entry(1, 50, [
          {
            network_id: STATIONS.mx.network,
            service_id: STATIONS.mx.service,
            event_id: 503,
            service_name: "TOKYO MX1",
          },
        ]),
        entry(2, 40, [
          { network_id: 4, service_id: 999, event_id: 1, startsIn: -25 * HOUR },
        ]),
      ],
    };
    await join();
    const result = await view();
    if (!result.ok) throw new Error("読めませんでした");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.program).toBeNull();
    expect(result.rows[0]!.away?.service_name).toBe("TOKYO MX1");
  });

  test("地域をまたいでまとめた番組は、受信できる局の放送があればその行にし、無ければ系列とほかの地域の数を出す", async () => {
    const at = now() + 2 * HOUR;
    const local = addProgram("mbs", 601, { at });
    const tbs = {
      network_id: 32736,
      service_id: 1048,
      service_name: "TBS",
      region: "関東広域",
      at,
    };
    const cbc = {
      network_id: 32704,
      service_id: 3096,
      service_name: "CBC",
      region: "中京広域",
      at: at + 5 * MINUTE,
    };
    rankingBody = {
      v: 1,
      entries: [
        entry(
          1,
          20,
          [
            { ...tbs, event_id: 601 },
            {
              network_id: STATIONS.mbs.network,
              service_id: STATIONS.mbs.service,
              event_id: 601,
              service_name: "MBS毎日放送",
              region: "近畿広域",
              at,
            },
          ],
          "TBS 系",
        ),
        entry(
          2,
          15,
          [
            { ...tbs, event_id: 602 },
            { ...cbc, event_id: 602 },
            { ...tbs, service_id: 1049, event_id: 603 },
          ],
          "TBS 系",
        ),
      ],
    };
    await join();
    const result = await view();
    if (!result.ok) throw new Error("読めませんでした");
    const [mine, away] = result.rows;
    expect(mine!.program?.id).toBe(local);
    expect(away!.program).toBeNull();
    // 始まりの早い関東広域の放送を出し、ほかの地域 (同じ地域の 2 つ目は数えない) の数を添える
    expect(away!.away).toMatchObject({
      service_name: "TBS",
      region: "関東広域",
      affiliation: "TBS 系",
      others: 1,
    });
  });

  test("受け取った順位は 10 分ためておき、行の予約の状態はその都度引き直す", async () => {
    const local = addProgram("bs11", 504);
    rankingBody = {
      v: 1,
      entries: [
        entry(1, 10, [{ network_id: 4, service_id: 211, event_id: 504 }]),
      ],
    };
    await join();
    await view();
    const at = now();
    orm()
      .insert(reservations)
      .values({
        program_id: local,
        rule_id: null,
        service_id: serviceKey(4, 211, "BS"),
        name: "手元の番組 504",
        start_at: at + 2 * HOUR,
        end_at: at + 2 * HOUR + 30 * MINUTE,
        manual: true,
        state: "scheduled",
        created_at: at,
        updated_at: at,
      })
      .run();
    // ためた順位がまだ新しければ、Promise ではなくその場で返す (画面が「読み込んでいます…」を挟まない)
    const again = rankingView();
    expect(again).not.toBeInstanceOf(Promise);
    expect(views()).toHaveLength(1);
    const held = again as Awaited<ReturnType<typeof view>>;
    expect(held.ok && held.rows[0]!.program?.reservation_id).not.toBeNull();

    // 10 分たてば hub を呼び直す
    await rankingView(now() + VIEW_FRESH + 1);
    expect(views()).toHaveLength(2);
  });

  test("hub に届かなければ読めないと返し、1 分は呼び直さない", async () => {
    await join();
    reply = (r) =>
      r.path === "/ranking"
        ? new Response("down", { status: 503 })
        : defaultReply(r);
    expect(await view()).toEqual({ ok: false });
    expect(rankingView()).toEqual({ ok: false });
    expect(views()).toHaveLength(1);
    reply = defaultReply;
    expect(await rankingView(now() + VIEW_RETRY + 1)).toEqual({
      ok: true,
      rows: [],
    });
    expect(views()).toHaveLength(2);
  });

  test("hub に接続できないときも読めないと返す", async () => {
    await join();
    const before = config.hubUrl;
    config.hubUrl = "http://127.0.0.1:1";
    try {
      expect(await view()).toEqual({ ok: false });
    } finally {
      config.hubUrl = before;
    }
  });

  test("少し前に受け取った順位があれば、届かなくなっても 1 時間は出し続ける", async () => {
    rankingBody = {
      v: 1,
      entries: [
        entry(1, 10, [{ network_id: 4, service_id: 999, event_id: 9 }]),
      ],
    };
    await join();
    await view();
    reply = (r) =>
      r.path === "/ranking"
        ? new Response("down", { status: 503 })
        : defaultReply(r);
    const stale = await rankingView(now() + VIEW_FRESH + 1);
    expect(stale !== null && stale.ok && stale.rows).toHaveLength(1);
    expect(views()).toHaveLength(2);
    expect(VIEW_STALE).toBeGreaterThan(VIEW_FRESH);
  });

  test("7 日送っていない (403) なら、送ってから見直す", async () => {
    await join();
    let refused = 0;
    reply = (r) => {
      if (r.path === "/ranking" && refused === 0) {
        refused++;
        return Response.json({ error: "inactive" }, { status: 403 });
      }
      return defaultReply(r);
    };
    const sentBefore = votesSent().length;
    expect(await view()).toEqual({ ok: true, rows: [] });
    expect(votesSent().length).toBe(sentBefore + 1);
    expect(views()).toHaveLength(2);
  });

  test("hub がトークンを断ったら (401)、取り直して送ってから新しいトークンで見直す", async () => {
    await join();
    reply = (r) =>
      r.auth === `Bearer ${TOKEN_A}` && r.path !== "/ranking/tokens"
        ? Response.json({ error: "invalid_token" }, { status: 401 })
        : defaultReply(r);
    expect(await view()).toEqual({ ok: true, rows: [] });
    expect(views().at(-1)!.auth).toBe(`Bearer ${TOKEN_B}`);
  });

  test("形が違っても読める欄は使い、entries が無ければ読めないと返す", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      rankingBody = {
        v: 2,
        entries: [
          { rank: "1" },
          entry(2, 10, [{ network_id: 4, service_id: 999, event_id: 9 }]),
        ],
      };
      await join();
      const read = await view();
      expect(read.ok && read.rows.map((r) => r.rank)).toEqual([2]);
      dropRankingView();
      rankingBody = { v: 1 };
      expect(await view()).toEqual({ ok: false });
    } finally {
      warn.mockRestore();
    }
  });

  test("やめてすぐ参加し直したら、前のトークンで呼んでいる途中の返事を待たない", async () => {
    await join();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    reply = async (r) => {
      if (r.path === "/ranking" && r.auth === `Bearer ${TOKEN_A}`) {
        await gate;
        return new Response("down", { status: 503 });
      }
      return defaultReply(r);
    };
    const old = rankingView();
    await leave();
    await join();
    const fresh = await view();
    expect(fresh).toEqual({ ok: true, rows: [] });
    expect(views().at(-1)!.auth).toBe(`Bearer ${TOKEN_B}`);
    release();
    await old;
    // 前のトークンの返事は、いまの参加の順位としてためない
    expect(rankingView()).toEqual({ ok: true, rows: [] });
  });

  test("やめたら null に戻り、ためた順位も捨てる", async () => {
    rankingBody = {
      v: 1,
      entries: [
        entry(1, 10, [{ network_id: 4, service_id: 999, event_id: 9 }]),
      ],
    };
    await join();
    await view();
    await leave();
    expect(rankingView()).toBeNull();
    rankingBody = { v: 1, entries: [] };
    await join();
    expect(await view()).toEqual({ ok: true, rows: [] });
  });
});

describe("録った・観た", () => {
  const { liveWatching, flushLive, timeshiftPlayed, settleEnded } = watch;
  const bsService = serviceKey(4, 211, "BS");

  /** 番組表に番組だけを入れる。返すのは番組の ID */
  function program(event: number, start: number, minutes = 30): number {
    const id = programKey(4, 211, event, "BS");
    orm()
      .insert(programs)
      .values({
        id,
        service_id: bsService,
        network_id: 4,
        event_id: event,
        start_at: start,
        end_at: start + minutes * MINUTE,
        name: `番組 ${event}`,
        genres: [7],
        is_free: true,
        updated_at: now(),
      })
      .run();
    return id;
  }

  function recording(programId: number, start: number, failed = false) {
    return orm()
      .insert(recordings)
      .values({
        program_id: programId,
        service_id: bsService,
        name: "録画",
        start_at: start,
        end_at: start + 30 * MINUTE,
        finished_at: start + 30 * MINUTE,
        error: failed ? "失敗" : null,
        created_at: start,
        updated_at: start,
      })
      .returning({ id: recordings.id })
      .get().id;
  }

  function kindsAt(at: number): Record<number, string[]> {
    return Object.fromEntries(
      currentVotes(at).map((c) => [c.vote.event_id, c.vote.kinds]),
    );
  }

  beforeEach(() => {
    orm().delete(rankingWatched).run();
    watch.resetWatchForTest();
  });

  test("ライブは局ごとに観ていた時間を番組で切り分け、5 分を超えた番組だけを、終わってから送る", async () => {
    await join();
    const start = now() - 2 * HOUR;
    program(801, start);
    program(802, start + 30 * MINUTE);
    // 801 の終わり 4 分前から 802 の 6 分目まで。同じ局のセッションが 2 つあっても時間は 1 つ
    liveWatching(bsService, true, start + 26 * MINUTE);
    liveWatching(bsService, true, start + 27 * MINUTE);
    liveWatching(bsService, false, start + 28 * MINUTE);
    flushLive(start + 33 * MINUTE);
    liveWatching(bsService, false, start + 36 * MINUTE);
    const rows = orm().select().from(rankingWatched).all();
    expect(
      Object.fromEntries(rows.map((r) => [r.event_id, r.live_ms])),
    ).toEqual({ 801: 4 * MINUTE, 802: 6 * MINUTE });
    // 802 が放送中のうちは送らない。終わってから live だけを送る (801 は 4 分なので送らない)
    expect(kindsAt(start + 40 * MINUTE)).toEqual({});
    expect(kindsAt(start + 70 * MINUTE)).toEqual({ 802: ["live"] });
  });

  test("10 分より短い番組は、長さの半分で観たことにする", async () => {
    await join();
    const start = now() - HOUR;
    program(803, start, 6);
    liveWatching(bsService, true, start);
    liveWatching(bsService, false, start + 3 * MINUTE);
    expect(kindsAt(now())).toEqual({ 803: ["live"] });
  });

  test("参加していなければ何も貯めない", () => {
    const start = now() - HOUR;
    program(804, start);
    liveWatching(bsService, true, start);
    liveWatching(bsService, false, start + 20 * MINUTE);
    expect(orm().select().from(rankingWatched).all()).toHaveLength(0);
  });

  test("録画の再生は進んだ分を経った時間までだけ足し、間が空いた・戻った・7 日を過ぎた再生は数えない", async () => {
    await join();
    const start = now() - 3 * HOUR;
    const id = recording(program(805, start), start);
    const at = now();
    timeshiftPlayed(id, 0, at);
    // 15 秒で 15 秒進む
    timeshiftPlayed(id, 15, at + 15_000);
    // 早送りで 15 秒に 100 秒進んでも、足すのは 15 秒
    timeshiftPlayed(id, 115, at + 30_000);
    // 戻した
    timeshiftPlayed(id, 50, at + 45_000);
    // 間が空いた (閉じてから開き直した)
    timeshiftPlayed(id, 300, at + 5 * MINUTE);
    const row = orm().select().from(rankingWatched).get()!;
    expect(row.timeshift_ms).toBe(30_000);
    expect(row.recording_id).toBe(id);

    // 番組表から番組が消えても、写した行から放送に戻して足す
    orm().delete(programs).run();
    let t = at + 6 * MINUTE;
    let position = 0;
    timeshiftPlayed(id, position, t);
    for (let i = 0; i < 20; i++)
      timeshiftPlayed(id, (position += 15), (t += 15_000));
    expect(orm().select().from(rankingWatched).get()!.timeshift_ms).toBe(
      30_000 + 300_000,
    );
    expect(kindsAt(t)).toEqual({ 805: ["timeshift"] });

    // 放送が終わって 7 日を過ぎた再生は数えない
    const late = start + 30 * MINUTE + 7 * 24 * HOUR + MINUTE;
    timeshiftPlayed(id, 0, late);
    timeshiftPlayed(id, 15, late + 15_000);
    expect(orm().select().from(rankingWatched).get()!.timeshift_ms).toBe(
      330_000,
    );
  });

  test("終わった放送は予約と録画を写し、番組表から消えても予約を送り続ける。失敗した録画は入れない", async () => {
    await join();
    const reservedEvent = reserve("bs11", {
      startsIn: -2 * HOUR,
      started: true,
    });
    const ok = programKey(4, 211, reservedEvent, "BS");
    recording(ok, now() - 2 * HOUR);
    const failed = program(806, now() - 3 * HOUR);
    recording(failed, now() - 3 * HOUR, true);
    // 放送中の予約は reserved だけ
    const onAir = reserve("bs11", { startsIn: -10 * MINUTE });
    settleEnded();
    expect(kindsAt(now())).toEqual({
      [reservedEvent]: ["reserved", "recorded"],
      [onAir]: ["reserved"],
    });
    orm().delete(reservations).run();
    orm().delete(programs).run();
    expect(kindsAt(now())).toEqual({
      [reservedEvent]: ["reserved", "recorded"],
    });

    // 終わって 8 日近くたったら送らず、控えも消す
    const later = now() + 8 * 24 * HOUR;
    settleEnded(later);
    expect(kindsAt(later)).toEqual({});
    expect(orm().select().from(rankingWatched).all()).toHaveLength(0);
  });

  test("送るときに終わった放送の種類を足し、オフにしたら控えを全部消す", async () => {
    await join();
    const event = reserve("bs11", { startsIn: -2 * HOUR, started: true });
    recording(programKey(4, 211, event, "BS"), now() - 2 * HOUR);
    received = [];
    orm()
      .update(rankingLink)
      .set({ next_at: now() - 1 })
      .run();
    await sendIfDue();
    const add = lastBody().add.find((a) => a["event_id"] === event);
    expect(add?.["kinds"]).toEqual(["reserved", "recorded"]);
    expect(orm().select().from(rankingWatched).all()).toHaveLength(1);
    await leave();
    expect(orm().select().from(rankingWatched).all()).toHaveLength(0);
  });
});
