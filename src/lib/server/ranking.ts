/**
 * **予約数ランキングに参加する** (世帯で 1 つ。設定の「連携」の「予約数ランキング」)。
 * 家ごとの予約を denpa-hub で数え、よく予約されている番組の順位を返してもらう。決まりは denpa-hub の docs/ranking.md。
 *
 * 1. オンにする (`join`): hub の `POST /ranking/tokens` でトークンを受け取り、DB に置く (`ranking_link`)。すぐ 1 回目を送る
 * 2. 6 時間ごとに送る (`sendIfDue`): まだ始まっていない地上波・BS・CS の予約 (予約済みと競合) と、前に送った控え
 *    (`ranking_sent`) を比べ、差分を `POST /ranking/votes` の `add`・`remove` で送る。送る時刻は家ごとにずらし、毎回 ±15 分揺らす
 * 3. オフにする (`leave`): 控えにある予約を全部 `remove` で送ってから `DELETE /ranking/tokens/self` を呼び、手元の行を消す。
 *    hub に届かなくても手元は消す (hub に残った票は放送が終われば消える)
 * 4. 順位を見る (`rankingView`): 検索を言葉なしで開いたときの節「予約の多い番組」。`GET /ranking` の返事を 10 分ためておき、
 *    番組ごとに手元の番組表の放送と突き合わせる。受信できる局に無い番組は、hub の局名と地域のまま渡す
 *
 * 送るのは番組の識別・時刻・番組名・局名・ジャンルと、ルールの予約か手の予約かだけ。家のアドレス・利用者の名前・
 * ルールの中身・予約した時刻は送らない。トークンと送った番組の一覧は記録に書かない (書くのは件数だけ)
 */
import { createHash } from "node:crypto";

import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { ALL_CHANNEL_TYPES, type ChannelType, origin } from "../types";
import { config, userAgent } from "./config";
import { now, orm } from "./db";
import {
  programs,
  rankingLink,
  rankingSent,
  reservations,
  services,
  TO_RECORD_STATES,
} from "./schema";
import { programRows, withoutService } from "./search";

const HOUR = 60 * 60_000;
/** 送る間隔。予約した時刻を 6 時間の幅でしかわからないようにする (docs/ranking.md「送る時刻」) */
export const SEND_EVERY = 6 * HOUR;
/** 毎回の送る時刻の揺らぎ (±)。全部の家が同じ時刻に送らないようにする */
export const JITTER = 15 * 60_000;
/** 1 回に送る `add` の上限 (hub と同じ)。超えた分は次の回に回す */
export const MAX_ADD = 2000;
/** 1 回に送る `remove` の上限 (hub と同じ) */
export const MAX_REMOVE = 5000;
/**
 * 送る番組の始まりの先の端。hub は 9 日先までを受けるので、時計のずれを見込んで少し手前で切る。
 * 外れた番組は、近付いてから次の回で送る
 */
const HORIZON = 9 * 24 * HOUR - 30 * 60_000;
/** 番組名・局名の上限 (hub と同じ。UTF-16 の文字数) */
const MAX_NAME = 120;
const MAX_SERVICE_NAME = 40;
/** 番組の長さの上限 (秒。hub と同じ) */
const MAX_DURATION = 24 * 60 * 60;
/** hub を待つ上限 (ms) */
const HUB_TIMEOUT = 20_000;
/** 予約が始まったかを見る間隔 (ms。runtime.ts が呼ぶ) */
export const CHECK_EVERY = 60_000;

/** 放送の識別。`network_id` は original_network_id */
export interface AiringId {
  network_id: number;
  service_id: number;
  event_id: number;
}

/** `add` の 1 件 (hub の `POST /ranking/votes`) */
export interface Vote extends AiringId {
  /** 番組の始まり。日本時間の ISO 8601 */
  start_at: string;
  /** 番組の長さ (秒) */
  duration: number;
  name: string;
  service_name: string;
  /** ジャンルの大分類 (ARIB の lv1) */
  genres: number[];
  kind: "manual" | "rule";
}

/** 送る予約 1 件と、控えに書く始まりの時刻 (unix ms) */
export interface Candidate {
  vote: Vote;
  startMs: number;
}

/** 前に送った控えの 1 行 */
export interface SentRow extends AiringId {
  start_at: number;
  digest: string;
}

export function keyOf(id: AiringId): string {
  return `${id.network_id}:${id.service_id}:${id.event_id}`;
}

const JST = 9 * HOUR;

/** 日本時間の ISO 8601 (`2026-11-20T21:00:00+09:00`)。秒より下は落とす */
export function isoJst(ms: number): string {
  return `${new Date(ms + JST).toISOString().slice(0, 19)}+09:00`;
}

/** 前後の空白と制御文字を落とし、`max` 文字に切る (サロゲートペアを半分にしない) */
export function clip(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  let value = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (value.length > max) {
    value = value.slice(0, max);
    const last = value.charCodeAt(value.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) value = value.slice(0, -1);
    value = value.trimEnd();
  }
  return value;
}

/** 送った中身の要約。控えと比べて、変わったものだけ送り直す */
export function digest(vote: Vote): string {
  return createHash("sha256").update(JSON.stringify(vote)).digest("hex");
}

/** 地上波・BS・CS の局か。ケーブルは元の放送が地上波・BS・CS のもの (パススルー・再送信) だけ */
export function countedService(type: string, networkId: number): boolean {
  if (type === "SKY") return false;
  const from = origin(networkId);
  return from === "GR" || from === "BS" || from === "CS";
}

/**
 * **いま送る予約。** まだ始まっていない、予約済みか競合の予約のうち、地上波・BS・CS の局のもの。有料放送の番組も送る。
 * 同じ放送を 2 つの局 (BS と、ケーブルの再送信の BS) で予約していたら 1 件にし、手の予約を取る
 */
export function currentVotes(at = now()): Candidate[] {
  const rows = orm()
    .select({
      network_id: programs.network_id,
      service_id: services.service_id,
      event_id: programs.event_id,
      type: services.type,
      start_at: programs.start_at,
      end_at: programs.end_at,
      name: programs.name,
      genres: programs.genres,
      service_name: services.name,
      manual: reservations.manual,
    })
    .from(reservations)
    .innerJoin(programs, eq(programs.id, reservations.program_id))
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(
      and(
        inArray(reservations.state, TO_RECORD_STATES),
        isNull(reservations.started_at),
        gt(programs.start_at, at),
        lte(programs.start_at, at + HORIZON),
      ),
    )
    .all();
  const votes = new Map<string, Candidate>();
  for (const row of rows) {
    if (!countedService(row.type, row.network_id)) continue;
    const duration = Math.round((row.end_at - row.start_at) / 1000);
    if (duration < 1 || duration > MAX_DURATION) continue;
    const name = clip(row.name, MAX_NAME);
    const serviceName = clip(row.service_name, MAX_SERVICE_NAME);
    if (name === "" || serviceName === "") continue;
    const vote: Vote = {
      network_id: row.network_id,
      service_id: row.service_id,
      event_id: row.event_id,
      start_at: isoJst(row.start_at),
      duration,
      name,
      service_name: serviceName,
      genres: [...new Set(row.genres ?? [])]
        .filter((g) => Number.isInteger(g) && g >= 0 && g <= 15)
        .slice(0, 16),
      kind: row.manual ? "manual" : "rule",
    };
    const key = keyOf(vote);
    const before = votes.get(key);
    if (before !== undefined && before.vote.kind === "manual") continue;
    votes.set(key, { vote, startMs: row.start_at });
  }
  return [...votes.values()];
}

/** 送る差分 */
export interface Plan {
  /** 新しい予約と、中身が変わった予約 (始まりの早い順に `MAX_ADD` 件まで) */
  add: Candidate[];
  /** 前に送ったが、いまは送る条件から外れた予約 (`MAX_REMOVE` 件まで) */
  remove: AiringId[];
  /** 控えにあるが始まった番組。hub には送らず、控えから消す */
  drop: AiringId[];
}

/** いまの予約と控えを比べて、送る差分を作る */
export function plan(current: Candidate[], sent: SentRow[], at = now()): Plan {
  const sentByKey = new Map(sent.map((row) => [keyOf(row), row]));
  const currentKeys = new Set(current.map((c) => keyOf(c.vote)));
  const add = current
    .filter((c) => sentByKey.get(keyOf(c.vote))?.digest !== digest(c.vote))
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, MAX_ADD);
  const remove: AiringId[] = [];
  const drop: AiringId[] = [];
  for (const row of sent) {
    if (currentKeys.has(keyOf(row))) continue;
    const id = idOf(row);
    if (row.start_at <= at) drop.push(id);
    else if (remove.length < MAX_REMOVE) remove.push(id);
  }
  return { add, remove, drop };
}

function idOf(id: AiringId): AiringId {
  return {
    network_id: id.network_id,
    service_id: id.service_id,
    event_id: id.event_id,
  };
}

/**
 * **次に送る時刻。** 6 時間ごとの `slot` の位置のうち、`after` から揺らぎの幅より後の最初のものに、±15 分の揺らぎを足す。
 * どう揺れても `after` より後で、続けて送る間は 5.5〜6.5 時間になる
 */
export function nextSendAt(
  slot: number,
  after: number,
  random: () => number = Math.random,
): number {
  const base =
    Math.floor((after + JITTER - slot) / SEND_EVERY) * SEND_EVERY +
    slot +
    SEND_EVERY;
  return base + Math.round((random() * 2 - 1) * JITTER);
}

// ---- hub とのやり取り ----

type HubResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number | null };

async function hub(
  method: "GET" | "POST" | "DELETE",
  path: string,
  token: string | null,
  body?: unknown,
  timeout = HUB_TIMEOUT,
): Promise<HubResult> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": userAgent(),
  };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${config.hubUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return { ok: false, status: null };
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, status: res.status, body: parsed };
}

/** hub からトークンを受け取る。受け取れなければ、断られたときの HTTP の状態 (届かなければ null) */
async function issueToken(): Promise<
  { token: string } | { status: number | null }
> {
  const result = await hub("POST", "/ranking/tokens", null);
  if (!result.ok) return { status: result.status };
  const token = (result.body as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return { status: result.status };
  return { token };
}

/** hub の返事を、記録に書く短い形にする (本文は書かない) */
function describe(status: number | null): string {
  return status === null ? "hub に届きません" : `HTTP ${status}`;
}

// ---- 状態 ----

function link() {
  return orm().select().from(rankingLink).get();
}

/** 設定の画面に出す状態 */
export type RankingState =
  | { state: "off" }
  | {
      state: "on";
      sentAt: number | null;
      /** 最後の送信が届かなかったか、hub がランキングを受け付けていなかった */
      failure: "unreachable" | "disabled" | null;
    };

export function rankingState(): RankingState {
  const row = link();
  if (row === undefined) return { state: "off" };
  return { state: "on", sentAt: row.sent_at, failure: row.failure ?? null };
}

/**
 * hub とのやり取りを 1 本ずつにする。送っている途中にオフにされても、送り終えてから取り消す
 * (取り消したあとで送り終えた票が残らないように)
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

// ---- 送る ----

/** 差分を送る。401 ならトークンを取り直し、控えを空にして全部送り直す */
async function sendNow(at: number): Promise<void> {
  const row = link();
  if (row === undefined) return;
  let token = row.token;
  let sent = orm().select().from(rankingSent).all();
  let current = currentVotes(at);
  let diff = plan(current, sent, at);
  let result = await postVotes(token, diff);
  if (!result.ok && result.status === 401) {
    const issued = await issueToken();
    if ("token" in issued) {
      token = issued.token;
      orm().transaction((tx) => {
        tx.update(rankingLink).set({ token }).run();
        tx.delete(rankingSent).run();
      });
      console.log(
        "[ranking] hub がトークンを断ったので、取り直して送り直します",
      );
      sent = [];
      current = currentVotes(at);
      diff = plan(current, sent, at);
      result = await postVotes(token, diff);
    }
  }
  const next = nextSendAt(row.slot, now());
  // 送っている間にオフにされた・入り直された (別のトークン) なら、何も書かない
  const still = link();
  if (still === undefined || still.joined_at !== row.joined_at) return;
  if (!result.ok) {
    const failure = result.status === 404 ? "disabled" : "unreachable";
    orm()
      .update(rankingLink)
      .set({ failed_at: at, failure, next_at: next })
      .run();
    console.warn(
      `[ranking] 予約を送れませんでした (${describe(result.status)})。次の送信で再試行します`,
    );
    return;
  }
  orm().transaction((tx) => {
    for (const id of [...diff.remove, ...diff.drop]) {
      tx.delete(rankingSent)
        .where(
          and(
            eq(rankingSent.network_id, id.network_id),
            eq(rankingSent.service_id, id.service_id),
            eq(rankingSent.event_id, id.event_id),
          ),
        )
        .run();
    }
    for (const { vote, startMs } of diff.add) {
      const values = {
        network_id: vote.network_id,
        service_id: vote.service_id,
        event_id: vote.event_id,
        start_at: startMs,
        digest: digest(vote),
      };
      tx.insert(rankingSent)
        .values(values)
        .onConflictDoUpdate({
          target: [
            rankingSent.network_id,
            rankingSent.service_id,
            rankingSent.event_id,
          ],
          set: { start_at: values.start_at, digest: values.digest },
        })
        .run();
    }
    tx.update(rankingLink)
      .set({ sent_at: at, failed_at: null, failure: null, next_at: next })
      .run();
  });
  const rejected = (result.body as { rejected?: unknown } | null)?.rejected;
  console.log(
    `[ranking] 予約を送りました (追加 ${diff.add.length} 件・取り消し ${diff.remove.length} 件` +
      `${typeof rejected === "number" && rejected > 0 ? `・hub が受けなかったもの ${rejected} 件` : ""})`,
  );
}

function postVotes(
  token: string,
  diff: Pick<Plan, "add" | "remove">,
): Promise<HubResult> {
  return hub("POST", "/ranking/votes", token, {
    v: 1,
    add: diff.add.map((c) => c.vote),
    remove: diff.remove,
  });
}

/** 送る時刻が来ていれば送る (runtime.ts が `CHECK_EVERY` ごとに呼ぶ) */
export function sendIfDue(at = now()): Promise<void> {
  const row = link();
  if (row === undefined || row.next_at > at) return Promise.resolve();
  return serial(async () => {
    // 待っている間にほかが送った・オフにされた
    const current = link();
    if (current === undefined || current.next_at > now()) return;
    await sendNow(now());
  });
}

// ---- オン・オフ ----

/** オンにできなかったわけ (設定の画面にそのまま出す) */
export const JOIN_ERRORS = {
  unreachable: "denpa-hub に届かないため、参加できませんでした",
  disabled:
    "denpa-hub が予約数ランキングを受け付けていないため、参加できませんでした",
} as const;

/**
 * **オンにする。** hub からトークンを受け取って置き、すぐ 1 回目を送る。受け取れなければ何も置かない。
 * 1 回目が届かなくてもオンのまま (次の回にまとめて送る)
 */
export function join(
  random: () => number = Math.random,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return serial(async () => {
    if (link() !== undefined) return { ok: true } as const;
    const issued = await issueToken();
    if (!("token" in issued)) {
      console.warn(
        `[ranking] トークンを受け取れませんでした (${describe(issued.status)})`,
      );
      return {
        ok: false,
        message:
          issued.status === 404
            ? JOIN_ERRORS.disabled
            : JOIN_ERRORS.unreachable,
      } as const;
    }
    const at = now();
    orm().transaction((tx) => {
      tx.delete(rankingSent).run();
      tx.insert(rankingLink)
        .values({
          id: 1,
          token: issued.token,
          slot: Math.floor(random() * SEND_EVERY),
          next_at: at,
          joined_at: at,
        })
        .run();
    });
    dropRankingView();
    console.log("[ranking] 予約数ランキングに参加しました");
    await sendNow(at);
    return { ok: true } as const;
  });
}

/**
 * **オフにする。** 控えにある予約を `remove` で送って取り消し、トークンを消してもらう。
 * hub に届かなくても手元は消す。届いたかを返す
 */
export function leave(): Promise<{ reached: boolean }> {
  return serial(async () => {
    const row = link();
    if (row === undefined) return { reached: true };
    const at = now();
    const ids = orm()
      .select()
      .from(rankingSent)
      .where(gt(rankingSent.start_at, at))
      .all()
      .map(idOf);
    let reached = true;
    for (let i = 0; i < ids.length && reached; i += MAX_REMOVE) {
      const result = await postVotes(row.token, {
        add: [],
        remove: ids.slice(i, i + MAX_REMOVE),
      });
      // トークンがもう無い (401)・hub がランキングをやめた (404) なら、取り消す票も無い
      if (!result.ok && result.status !== 401 && result.status !== 404)
        reached = false;
    }
    if (reached) {
      const result = await hub("DELETE", "/ranking/tokens/self", row.token);
      if (!result.ok && result.status !== 401 && result.status !== 404)
        reached = false;
    }
    orm().transaction((tx) => {
      tx.delete(rankingSent).run();
      tx.delete(rankingLink).run();
    });
    dropRankingView();
    console.log(
      reached
        ? "[ranking] 予約数ランキングへの参加をやめました"
        : "[ranking] 予約数ランキングへの参加をやめました。hub に届かなかったため、送った票は放送が終わると hub から消えます",
    );
    return { reached };
  });
}

// ---- 順位を見る ----

/** 受け取る順位の数。画面は先頭の 5 件を出し、「もっと見る」でここまで広げる (docs/ranking.md「出す件数」) */
export const VIEW_LIMIT = 50;
/** 受け取った順位をためておく間。hub は順位を 10 分ごとに作り直す */
export const VIEW_FRESH = 10 * 60_000;
/** 受け取れなかったあと、次に hub を呼ぶまでの間。検索を開くたびに hub を待たせない */
export const VIEW_RETRY = 60_000;
/** 受け取れなかったとき、前に受け取った順位を出し続ける上限 */
export const VIEW_STALE = HOUR;
/** 順位を待つ上限 (ms)。画面は待たずに出し、節だけあとから埋める */
const VIEW_TIMEOUT = 5_000;

/** hub の順位の放送 1 つ (`GET /ranking` の `airings`) */
export interface HubAiring extends AiringId {
  /** 始まり (unix ms) */
  start_at: number;
  service_name: string;
  /** 地上波の放送の地域の名前。hub が地域の表を持つまでは null */
  region: string | null;
}

/** hub の順位の 1 件 (`GET /ranking` の `entries`) */
export interface HubEntry {
  rank: number;
  /** 重みを掛けて 5 の倍数に切り下げた数 */
  votes: number;
  name: string;
  airings: HubAiring[];
}

type ProgramRow = ReturnType<ReturnType<typeof programRows>["all"]>[number];

/** 画面に渡す番組の行。検索の結果の「これからの放送」と同じ形 */
export type RankedProgram = Omit<ProgramRow, "service_type" | "service_sid">;

/**
 * 節の 1 行。受信できる局に放送があれば `program` (行から予約・取消・詳細)、
 * 無ければ `away` (hub が返した名前と局名と地域。予約のボタンも詳細も出さない)
 */
export type RankedRow = { rank: number; votes: number } & (
  | { program: RankedProgram; away: null }
  | {
      program: null;
      away: {
        name: string;
        service_name: string;
        region: string | null;
        start_at: number;
      };
    }
);

/** 節の中身。hub に届かない・断られたときは `ok: false` (「いまはランキングを読めません」) */
export type RankingView = { ok: true; rows: RankedRow[] } | { ok: false };

let warnedShape = false;

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

/**
 * hub の返事を読む。形が違っても読める欄は使い、記録に 1 度だけ書く (hub と denpa のバージョンのずれ)。
 * `entries` が無ければ読めなかったとして null
 */
export function readEntries(body: unknown): HubEntry[] | null {
  const top = body as { v?: unknown; entries?: unknown } | null;
  const warn = (what: string) => {
    if (warnedShape) return;
    warnedShape = true;
    console.warn(
      `[ranking] hub の順位の形が違います (${what})。denpa と hub のバージョンが合っていないかもしれません。読める欄だけを使います`,
    );
  };
  if (top?.v !== 1) warn(`v=${String(top?.v)}`);
  if (!Array.isArray(top?.entries)) {
    warn("entries がありません");
    return null;
  }
  const entries: HubEntry[] = [];
  for (const raw of top.entries as unknown[]) {
    const entry = raw as Partial<Record<keyof HubEntry, unknown>> | null;
    if (
      !isInt(entry?.rank) ||
      typeof entry.votes !== "number" ||
      typeof entry.name !== "string" ||
      !Array.isArray(entry.airings)
    ) {
      warn("読めない順位があります");
      continue;
    }
    const airings: HubAiring[] = [];
    for (const item of entry.airings as unknown[]) {
      const a = item as Partial<Record<keyof HubAiring, unknown>> | null;
      const start =
        typeof a?.start_at === "string" ? Date.parse(a.start_at) : NaN;
      if (
        !isInt(a?.network_id) ||
        !isInt(a.service_id) ||
        !isInt(a.event_id) ||
        !Number.isFinite(start) ||
        typeof a.service_name !== "string"
      ) {
        warn("読めない放送があります");
        continue;
      }
      airings.push({
        network_id: a.network_id,
        service_id: a.service_id,
        event_id: a.event_id,
        start_at: start,
        service_name: a.service_name,
        region: typeof a.region === "string" ? a.region : null,
      });
    }
    if (airings.length === 0) continue;
    entries.push({
      rank: entry.rank,
      votes: entry.votes,
      name: entry.name,
      airings,
    });
  }
  return entries;
}

/** 種別の並び (番組表と同じ)。同じ放送を 2 つの局で受けているとき、地上波・BS・CS の局を先に選ぶ */
function typeOrder(type: string): number {
  const at = ALL_CHANNEL_TYPES.indexOf(type as ChannelType);
  return at < 0 ? ALL_CHANNEL_TYPES.length : at;
}

/**
 * **手元の番組表と突き合わせる。** 番組ごとに、受信できる局 (一覧に出している局) にある終わっていない放送を選ぶ。
 * いくつかあれば始まりの早いもの。無ければ、まだ始まっていない放送のうち早いものを、受信できない局の行にする。
 * 順位は hub のまま (受信できない番組を飛ばして振り直さない)。どの放送も始まっていて手元に無い番組は出さない
 */
export function matchEntries(entries: HubEntry[], at = now()): RankedRow[] {
  const events = [
    ...new Set(entries.flatMap((e) => e.airings.map((a) => a.event_id))),
  ];
  const local = new Map<string, ProgramRow[]>();
  if (events.length > 0) {
    const rows = programRows(
      and(
        eq(services.listed, true),
        gt(programs.end_at, at),
        inArray(programs.event_id, events),
      ),
    ).all();
    for (const row of rows) {
      const key = keyOf({
        network_id: row.network_id,
        service_id: row.service_sid,
        event_id: row.event_id,
      });
      local.set(key, [...(local.get(key) ?? []), row]);
    }
  }
  const out: RankedRow[] = [];
  for (const entry of entries) {
    const found = entry.airings
      .flatMap((a) => local.get(keyOf(a)) ?? [])
      .sort(
        (a, b) =>
          a.start_at - b.start_at ||
          typeOrder(a.service_type) - typeOrder(b.service_type),
      )[0];
    if (found !== undefined) {
      out.push({
        rank: entry.rank,
        votes: entry.votes,
        program: withoutService(found),
        away: null,
      });
      continue;
    }
    const away = entry.airings
      .filter((a) => a.start_at > at)
      .sort((a, b) => a.start_at - b.start_at)[0];
    if (away === undefined) continue;
    out.push({
      rank: entry.rank,
      votes: entry.votes,
      program: null,
      away: {
        name: entry.name,
        service_name: away.service_name,
        region: away.region,
        start_at: away.start_at,
      },
    });
  }
  return out;
}

/** 受け取った順位 (読めなかったときは null) と、次に hub を呼ぶ時刻。参加した時刻ごとに持つ */
let held: {
  joinedAt: number;
  entries: HubEntry[] | null;
  fetchedAt: number;
  until: number;
} | null = null;
let pending: Promise<HubEntry[] | null> | null = null;

/** ためた順位を捨てる。参加したとき・やめたとき (と単体テスト) */
export function dropRankingView(): void {
  held = null;
}

/**
 * hub から順位を受け取る。401 (トークンが hub から消えた)・403 (7 日送っていない) なら、送ってから 1 度だけ見直す
 * (送る処理は 401 を受けるとトークンを取り直す)
 */
async function fetchEntries(): Promise<HubEntry[] | null> {
  let row = link();
  if (row === undefined) return null;
  const path = `/ranking?limit=${VIEW_LIMIT}`;
  let result = await hub("GET", path, row.token, undefined, VIEW_TIMEOUT);
  if (!result.ok && (result.status === 401 || result.status === 403)) {
    await serial(() => sendNow(now()));
    row = link();
    if (row === undefined) return null;
    result = await hub("GET", path, row.token, undefined, VIEW_TIMEOUT);
  }
  if (!result.ok) {
    console.warn(
      `[ranking] 順位を受け取れませんでした (${describe(result.status)})`,
    );
    return null;
  }
  return readEntries(result.body);
}

/** hub を呼ぶのは同時に 1 回だけ。受け取ったらためる */
function refresh(joinedAt: number): Promise<HubEntry[] | null> {
  pending ??= fetchEntries()
    .catch((error: unknown) => {
      console.warn("[ranking] 順位を受け取れませんでした", error);
      return null;
    })
    .then((entries) => {
      const at = now();
      // 待っている間にやめた・参加し直したなら、ためない
      if (link()?.joined_at !== joinedAt) return entries;
      const before = held?.joinedAt === joinedAt ? held : null;
      if (entries !== null)
        held = { joinedAt, entries, fetchedAt: at, until: at + VIEW_FRESH };
      else if (before?.entries != null && at - before.fetchedAt < VIEW_STALE)
        // 少し前に受け取った順位があれば、それを出し続ける
        held = { ...before, until: at + VIEW_RETRY };
      else
        held = {
          joinedAt,
          entries: null,
          fetchedAt: at,
          until: at + VIEW_RETRY,
        };
      return held.entries;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

function present(entries: HubEntry[] | null, at: number): RankingView {
  return entries === null
    ? { ok: false }
    : { ok: true, rows: matchEntries(entries, at) };
}

/**
 * **検索を言葉なしで開いたときの節「予約の多い番組」** (docs/screens.md)。参加していなければ null (節を出さない)。
 * ためた順位がまだ新しければその場で返し、古ければ hub を呼ぶ Promise を返す (画面は待たずに出し、節だけあとから埋める)。
 * 突き合わせは毎回し直すので、予約・取消のあとの読み直しでも行の状態はいまのもの
 */
export function rankingView(
  at = now(),
): RankingView | Promise<RankingView> | null {
  const row = link();
  if (row === undefined) return null;
  if (held?.joinedAt === row.joined_at && at < held.until)
    return present(held.entries, at);
  return refresh(row.joined_at).then((entries) => present(entries, now()));
}
