import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import { eq } from "drizzle-orm";

/**
 * 予約数ランキングに送るもの (`ranking.ts`)。外の hub には繋がず、偽の hub で受けた本文を見る。
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
}
let received: Received[] = [];
/** 偽の hub の返事。`path` ごとに差し替える */
let reply: (request: Received) => Response;
/** 偽の hub が出すトークン (出すたびに次へ進む) */
let tokens: string[] = [];

function defaultReply(request: Received): Response {
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
  currentVotes,
  digest,
  isoJst,
  join,
  leave,
  nextSendAt,
  plan,
  rankingState,
  sendIfDue,
} = ranking;
const { now, orm } = await import("./db");
const { programs, rankingLink, rankingSent, reservations, services } =
  await import("./schema");
const { programKey, serviceKey } = await import("./tuner");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 局。`type` が CATV ならケーブルで受けた局 */
const STATIONS = {
  bs11: { network: 4, service: 211, type: "BS", name: "BS11イレブン" },
  mx: { network: 32391, service: 23608, type: "GR", name: "TOKYO MX1" },
  cs: { network: 7, service: 333, type: "CS", name: "AT-X" },
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
  const start = now() + (options.startsIn ?? 2 * HOUR);
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
  orm().delete(programs).run();
  addServices();
  received = [];
  tokens = [TOKEN_A, TOKEN_B];
  reply = defaultReply;
});

describe("送る中身", () => {
  test("まだ始まっていない地上波・BS・CS の予約済みと競合を、有料放送も送る", () => {
    const bs = reserve("bs11", { manual: false });
    const gr = reserve("mx", { state: "conflict" });
    const pay = reserve("cs", { free: false });
    reserve("bs11", { state: "skipped" });
    reserve("bs11", { state: "canceled" });
    reserve("bs11", { started: true });
    reserve("bs11", { startsIn: -10 * MINUTE });
    reserve("catvOwn");
    reserve("sky");
    const events = currentVotes()
      .map((c) => c.vote.event_id)
      .sort();
    expect(events).toEqual([bs, gr, pay].sort());
  });

  test("1 件の形は hub の add と同じ。家のアドレスやルールの中身は入らない", () => {
    const start = now() + 3 * HOUR;
    const event = reserve("bs11", {
      startsIn: start - now(),
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
      kind: "rule",
    });
    expect(Object.keys(only!.vote).sort()).toEqual(
      [
        "duration",
        "event_id",
        "genres",
        "kind",
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

  test("同じ放送を BS とケーブルの再送信で予約していたら 1 件にし、手の予約を取る", () => {
    reserve("bs11", { event: 77, manual: false });
    reserve("catvBs", { event: 77, manual: true });
    const votes = currentVotes();
    expect(votes).toHaveLength(1);
    expect(votes[0]!.vote.kind).toBe("manual");
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
  function sentRow(event: number, startAt: number, d: string) {
    return {
      network_id: 4,
      service_id: 211,
      event_id: event,
      start_at: startAt,
      digest: d,
    };
  }

  test("送っていないもの・中身が変わったものを add、外れたものを remove、始まったものは控えから消すだけ", () => {
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
        // もう始まった番組
        sentRow(9002, at - HOUR, "x"),
      ],
      at,
    );
    expect(result.add.map((c) => c.vote.event_id)).toEqual([b]);
    expect(result.remove).toEqual([
      { network_id: 4, service_id: 211, event_id: 9001 },
    ]);
    expect(result.drop).toEqual([
      { network_id: 4, service_id: 211, event_id: 9002 },
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
        kind: "manual" as const,
      },
      startMs: now() + (MAX_ADD + 5 - i) * MINUTE,
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
        "denpa-hub が予約数ランキングを受け付けていないため、参加できませんでした",
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
