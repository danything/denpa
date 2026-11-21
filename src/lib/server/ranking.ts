/**
 * **番組ランキングに参加する** (世帯で 1 つ。設定の「連携」の「番組ランキング」)。
 * 家ごとの予約とライブの視聴を denpa-hub で家の数として数え、人気の番組の順位を返してもらう。決まりは denpa-hub の docs/ranking.md。
 * 録画・ライブ・タイムシフトの家の数は、hub が番組ごとの集計として残し、外部に示すことがある (設定の説明に書く)。
 *
 * 1. オンにする (`join`): hub の `POST /ranking/tokens` でトークンを受け取り、DB に置く (`ranking_link`)。すぐ 1 回目を送る
 * 2. 6 時間ごとに送る (`sendIfDue`): 終わっていない地上波・BS・CS の予約 (予約済みと競合。録画中も) と、終わった放送の予約・ライブ・録画・
 *    タイムシフトの控え (`ranking_watched`。`ranking-watch.ts`) から作ったいまの中身と、前に送った控え (`ranking_sent`) を比べ、
 *    差分を `POST /ranking/votes` の `add`・`remove` で送る。送る時刻は家ごとにずらし、毎回 ±15 分揺らす
 * 3. 参加するかを聞く (`rankingInvite`): 参加しておらず、まだ決めていない (`rankingDecided` が無い) 家には、検索の節「人気の番組」の場所に
 *    案内を出す。「参加」は `join`、「参加しない」は `decline`。参加した・参加しないを選んだ・オフにしたら `rankingDecided` を置き、二度と聞かない
 * 4. オフにする (`leave`): 控えにある放送を全部 `remove` で送ってから `DELETE /ranking/tokens/self` を呼び、手元の行を消す。
 *    hub に届かなくても手元は消す (hub に残った票は数が決まれば消える)
 * 5. 順位を見る (`rankingView`): 検索を言葉なしで開いたときの節「人気の番組」。`GET /ranking` の返事を 10 分ためておき、
 *    番組ごとに手元の番組表の放送と突き合わせる。これから・放送中・終わった番組を混ぜて、hub の順位のまま出す。
 *    受信できる局に無い番組は、hub の局名と地域のまま渡す
 *
 * 送るのは番組の識別・時刻・番組名・局名・ジャンルと、その放送をどうしたか (`kinds`) だけ。家のアドレス・利用者の名前・
 * ルールの中身・予約した時刻は送らない。トークンと送った番組の一覧は記録に書かない (書くのは件数だけ)
 */
import { createHash } from "node:crypto";

import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";

import { config, userAgent } from "./config";
import { now, orm } from "./db";
import { typeRank } from "./epg";
import {
  countedService,
  ENDED_MARGIN,
  endedRows,
  forgetWatched,
  kindsOf,
  settleEnded,
} from "./ranking-watch";
import {
  programs,
  rankingLink,
  rankingSent,
  recordings,
  reservations,
  services,
  TO_RECORD_STATES,
} from "./schema";
import { programRows, withoutService } from "./search";
import { store, stored } from "./settings";

const HOUR = 60 * 60_000;
/** 送る間隔。予約した時刻を 6 時間の幅でしかわからないようにする (docs/ranking.md「送る時刻」) */
export const SEND_EVERY = 6 * HOUR;
/** 毎回の送る時刻の揺らぎ (±)。全部の家が同じ時刻に送らないようにする */
export const JITTER = 15 * 60_000;
/** 1 回に送る `add` の上限 (hub と同じ)。超えた分は次の回に回す */
export const MAX_ADD = 2000;
/** 1 回に送る `remove` の上限 (hub と同じ) */
const MAX_REMOVE = 5000;
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
/** 送る時刻が来たかを見る間隔 (ms。runtime.ts が呼ぶ) */
export const CHECK_EVERY = 60_000;

/** 放送の識別。`network_id` は original_network_id */
interface AiringId {
  network_id: number;
  service_id: number;
  event_id: number;
}

/** `add` の 1 件 (hub の `POST /ranking/votes`) */
interface Vote extends AiringId {
  /** 番組の始まり。日本時間の ISO 8601 */
  start_at: string;
  /** 番組の長さ (秒) */
  duration: number;
  name: string;
  service_name: string;
  /** ジャンルの大分類 (ARIB の lv1) */
  genres: number[];
  /** その放送をどうしたか。送り直すと hub は組を置き換える (docs/ranking.md「送る中身」) */
  kinds: Kind[];
}

/**
 * 放送をどうしたか。`reserved` = 予約した (録画中・録り終えたあとも)。
 * `live`・`recorded`・`timeshift` (ライブで観た・録った・録画で観た) は放送が終わってから送る
 */
type Kind = "reserved" | "live" | "recorded" | "timeshift";

/** 送る放送 1 件と、控えに書く始まりと終わりの時刻 (unix ms) */
export interface Candidate {
  vote: Vote;
  startMs: number;
  endMs: number;
}

/** 前に送った控えの 1 行 */
interface SentRow extends AiringId {
  start_at: number;
  end_at: number;
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

/** 送る 1 件を作る。長さ・番組名・局名が hub の決まりに合わなければ null */
function candidateOf(
  row: {
    network_id: number;
    service_id: number;
    event_id: number;
    start_at: number;
    end_at: number;
    name: string;
    service_name: string;
    genres: number[] | null;
  },
  kinds: Kind[],
): Candidate | null {
  const duration = Math.round((row.end_at - row.start_at) / 1000);
  if (duration < 1 || duration > MAX_DURATION) return null;
  const name = clip(row.name, MAX_NAME);
  const serviceName = clip(row.service_name, MAX_SERVICE_NAME);
  if (name === "" || serviceName === "") return null;
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
    kinds,
  };
  return { vote, startMs: row.start_at, endMs: row.end_at };
}

/**
 * **いま送るもの。** 終わっていない予約 (予約済みと競合。録画中も) は `reserved` だけで、終わった放送は予約・ライブ・録画・タイムシフトの
 * 控え (`ranking_watched`) から種類の組を作る (`ranking-watch.kindsOf`)。どちらも地上波・BS・CS の局のもので、有料放送の番組も送る。
 * 同じ放送を 2 つの局 (BS と、ケーブルの再送信の BS) で予約していたら 1 件にする (hub は家の数で数える)
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
    })
    .from(reservations)
    .innerJoin(programs, eq(programs.id, reservations.program_id))
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(
      and(
        inArray(reservations.state, TO_RECORD_STATES),
        gt(programs.end_at, at - ENDED_MARGIN),
        lte(programs.start_at, at + HORIZON),
      ),
    )
    .all();
  const votes = new Map<string, Candidate>();
  for (const row of rows) {
    if (!countedService(row.type, row.network_id)) continue;
    const candidate = candidateOf(row, ["reserved"]);
    if (candidate === null || votes.has(keyOf(candidate.vote))) continue;
    votes.set(keyOf(candidate.vote), candidate);
  }
  for (const row of endedRows(at)) {
    const kinds = kindsOf(row);
    if (kinds.length === 0) continue;
    const candidate = candidateOf(row, kinds);
    if (candidate !== null) votes.set(keyOf(candidate.vote), candidate);
  }
  return [...votes.values()];
}

/** 送る差分 */
interface Plan {
  /** 新しい放送と、中身が変わった放送 (始まりの早い順に `MAX_ADD` 件まで) */
  add: Candidate[];
  /** 前に送ったが、いまは送る条件から外れた放送 (`MAX_REMOVE` 件まで) */
  remove: AiringId[];
  /** 控えにあるが終わった放送。hub には送らず、控えから消す (終わった放送の数は、終わったあとの操作で減らさない) */
  drop: AiringId[];
}

/** いま送るもの (`currentVotes`) と控えを比べて、送る差分を作る */
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
    // 終わりを持たない行 (列を足す前) は、前のバージョンと同じく始まりで見る
    if ((row.end_at > 0 ? row.end_at : row.start_at) <= at) drop.push(id);
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
type RankingState =
  | { state: "off" }
  | {
      state: "on";
      sentAt: number | null;
      /** 最後の送信が届かなかったか、hub がランキングを受け付けていなかった */
      failure: "unreachable" | "disabled" | null;
    };

/**
 * **参加するかを決めた印** (設定の表の `rankingDecided`。値は見ない)。参加した・参加しないを選んだ・オフにしたときに置く。
 * 参加できなかったとき (hub に届かない・受け付けていない) は置かない。印を足す前のバージョンでオフだった家は、
 * 既定のオフのままの家と自分でオフにした家を見分けられないので、どちらも「まだ決めていない」とする
 */
export const DECIDED_KEY = "rankingDecided";

function decided(): void {
  store(DECIDED_KEY, "1");
}

/**
 * **参加するかの案内を出すか。** 参加しておらず、まだ決めていない家だけ。参加している家には、
 * 印を足す前に参加した家も含めて出さない (`ranking_link` に行がある)
 */
export function rankingInvite(): boolean {
  return link() === undefined && stored(DECIDED_KEY) === undefined;
}

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
  // 終わった放送の予約と録画を、番組表から消える前に控えに写す
  settleEnded(at);
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
      `[ranking] 送れませんでした (${describe(result.status)})。次の送信で再試行します`,
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
    for (const { vote, startMs, endMs } of diff.add) {
      const values = {
        network_id: vote.network_id,
        service_id: vote.service_id,
        event_id: vote.event_id,
        start_at: startMs,
        end_at: endMs,
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
          set: {
            start_at: values.start_at,
            end_at: values.end_at,
            digest: values.digest,
          },
        })
        .run();
    }
    tx.update(rankingLink)
      .set({ sent_at: at, failed_at: null, failure: null, next_at: next })
      .run();
  });
  const rejected = (result.body as { rejected?: unknown } | null)?.rejected;
  console.log(
    `[ranking] 送りました (追加 ${diff.add.length} 件・取り消し ${diff.remove.length} 件` +
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
const JOIN_ERRORS = {
  unreachable: "denpa-hub に届かないため、参加できませんでした",
  disabled:
    "denpa-hub が番組ランキングを受け付けていないため、参加できませんでした",
} as const;

/**
 * **オンにする。** hub からトークンを受け取って置き、すぐ 1 回目を送る。受け取れなければ何も置かない。
 * 1 回目が届かなくてもオンのまま (次の回にまとめて送る)
 */
export function join(
  random: () => number = Math.random,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return serial(async () => {
    if (link() !== undefined) {
      decided();
      return { ok: true } as const;
    }
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
    forgetWatched();
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
    decided();
    dropRankingView();
    console.log("[ranking] 番組ランキングに参加しました");
    await sendNow(at);
    return { ok: true } as const;
  });
}

/**
 * **オフにする。** 控えにある放送を `remove` で送って取り消し、トークンを消してもらう。
 * hub に届かなくても手元は消す。届いたかを返す
 */
export function leave(): Promise<{ reached: boolean }> {
  return serial(async () => {
    decided();
    const row = link();
    if (row === undefined) return { reached: true };
    const ids = orm().select().from(rankingSent).all().map(idOf);
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
    forgetWatched();
    dropRankingView();
    console.log(
      reached
        ? "[ranking] 番組ランキングへの参加をやめました"
        : "[ranking] 番組ランキングへの参加をやめました。hub に届かなかったため、送った票は数が決まると hub から消えます",
    );
    return { reached };
  });
}

/**
 * **参加しないと決める** (案内の「参加しない」)。何も送らず、決めた印だけ置く。
 * 押すまでにほかの端末で参加していたら何もしない (やめるのは設定のスイッチから)
 */
export function decline(): Promise<void> {
  return serial(async () => {
    if (link() === undefined) decided();
  });
}

// ---- 順位を見る ----

/** 受け取る順位の数。画面は先頭の 5 件を出し、「もっと見る」でここまで広げる (docs/ranking.md「出す件数」) */
export const VIEW_LIMIT = 50;
/** 受け取った順位をためておく間。hub は順位を毎時 0 分に作り直す。手元の番組表との突き合わせは検索を開くたびにし直す */
export const VIEW_FRESH = 10 * 60_000;
/** 受け取れなかったあと、次に hub を呼ぶまでの間。検索を開くたびに hub を待たせない */
export const VIEW_RETRY = 60_000;
/** 受け取れなかったとき、前に受け取った順位を出し続ける上限 */
export const VIEW_STALE = HOUR;
/** 順位を待つ上限 (ms)。画面は待たずに出し、節だけあとから埋める */
const VIEW_TIMEOUT = 5_000;

/** 一覧に出す、終わった番組の幅。hub と同じ (終わって 24 時間以内)。手元の番組表も終わって 1 日は残る (`config.programRetention`) */
const VIEW_AFTER_END = 24 * HOUR;

/** hub の順位の放送 1 つ (`GET /ranking` の `airings`) */
interface HubAiring extends AiringId {
  /** 始まり (unix ms) */
  start_at: number;
  /** 終わり (unix ms)。前のバージョンの hub は返さないので、そのときは始まりと同じにする (これからの放送しか返さなかったため) */
  end_at: number;
  service_name: string;
  /** 地上波の放送の地域の名前 (「関東広域」)。BS・CS と、hub の地域の表に無い地域は null */
  region: string | null;
}

/** hub の順位の 1 件 (`GET /ranking` の `entries`) */
interface HubEntry {
  rank: number;
  /** 予約した家とライブで観た家を合わせた家の数を、5 の倍数に切り下げたもの */
  votes: number;
  name: string;
  /** 地上波の系列の名前 (「TBS 系」)。独立局と BS・CS は null */
  affiliation: string | null;
  airings: HubAiring[];
}

type ProgramRow = ReturnType<ReturnType<typeof programRows>["all"]>[number];

/** 画面に渡す番組の行。検索の結果の「これからの放送」と同じ形 */
type RankedProgram = Omit<ProgramRow, "service_type" | "service_sid">;

/** 放送の状態。行の 2 段目の先頭とボタンを変える (これから = 予約・取消、放送中 = 観る、終わった = 再生) */
export type AiringState = "upcoming" | "onair" | "ended";

function stateOf(startAt: number, endAt: number, at: number): AiringState {
  if (endAt <= at) return "ended";
  return startAt <= at ? "onair" : "upcoming";
}

/**
 * 節の 1 行。受信できる局に放送があれば `program` (行から予約・取消・観る・再生・詳細)、
 * 無ければ `away` (hub が返した名前と局名と地域。ボタンも詳細も出さない)。
 * 系列のある地上波の番組は、局名の代わりに系列と、ほかに放送する地域の数 (`others`) を出す (「TBS 系・関東広域ほか 12 地域」)
 */
type RankedRow = { rank: number; votes: number; state: AiringState } & (
  | {
      program: RankedProgram;
      /** 終わった番組の、再生できる録画 (録画中・録り終えたもの)。無ければ null */
      recording: number | null;
      away: null;
    }
  | {
      program: null;
      recording: null;
      away: {
        name: string;
        service_name: string;
        region: string | null;
        /** 地上波の系列の名前。あれば局名の代わりに出す */
        affiliation: string | null;
        /** `region` のほかに、この番組を放送する (した) 地域の数 */
        others: number;
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
function readEntries(body: unknown): HubEntry[] | null {
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
      const end = typeof a?.end_at === "string" ? Date.parse(a.end_at) : NaN;
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
        end_at: Number.isFinite(end) ? end : start,
        service_name: a.service_name,
        region: typeof a.region === "string" ? a.region : null,
      });
    }
    if (airings.length === 0) continue;
    entries.push({
      rank: entry.rank,
      votes: entry.votes,
      name: entry.name,
      affiliation:
        typeof entry.affiliation === "string" ? entry.affiliation : null,
      airings,
    });
  }
  return entries;
}

/**
 * 番組の放送のうち、行に出すものを選ぶ。終わっていない放送があれば始まりの早いもの、全部終わっていれば終わりの遅いもの
 * (同じ番組を BS で続けて流したときなど、いちばん近いものを出す)
 */
function pick<T>(
  items: T[],
  startOf: (item: T) => number,
  endOf: (item: T) => number,
  at: number,
  tie: (a: T, b: T) => number = () => 0,
): T | undefined {
  const open = items
    .filter((item) => endOf(item) > at)
    .sort((a, b) => startOf(a) - startOf(b) || tie(a, b));
  if (open.length > 0) return open[0];
  return [...items].sort((a, b) => endOf(b) - endOf(a) || tie(a, b))[0];
}

/** 終わった番組の、再生できる録画 (番組ごとに新しいもの)。録画中のものは観る画面が追っかけへ送る */
function playableRecordings(programIds: number[]): Map<number, number> {
  const found = new Map<number, number>();
  if (programIds.length === 0) return found;
  const rows = orm()
    .select({ id: recordings.id, program_id: recordings.program_id })
    .from(recordings)
    .where(
      and(
        inArray(recordings.program_id, programIds),
        inArray(recordings.state, ["recording", "recorded", "available"]),
      ),
    )
    .orderBy(desc(recordings.id))
    .all();
  for (const row of rows)
    if (row.program_id !== null && !found.has(row.program_id))
      found.set(row.program_id, row.id);
  return found;
}

/**
 * **手元の番組表と突き合わせる。** 番組ごとに、受信できる局 (一覧に出している局) にある、終わって 24 時間以内の放送を選ぶ (`pick`)。
 * 無ければ hub の放送から同じ決め方で選び、受信できない局の行にする。
 * 順位は hub のまま (受信できない番組を飛ばして振り直さない)。どの放送も終わって 24 時間を過ぎていて手元に無い番組は出さない
 */
function matchEntries(entries: HubEntry[], at = now()): RankedRow[] {
  const since = at - VIEW_AFTER_END;
  const events = [
    ...new Set(entries.flatMap((e) => e.airings.map((a) => a.event_id))),
  ];
  const local = new Map<string, ProgramRow[]>();
  if (events.length > 0) {
    const rows = programRows(
      and(
        eq(services.listed, true),
        gt(programs.end_at, since),
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
  const matched = entries.map((entry) => ({
    entry,
    found: pick(
      entry.airings.flatMap((a) => local.get(keyOf(a)) ?? []),
      (p) => p.start_at,
      (p) => p.end_at,
      at,
      // 同じ放送を 2 つの局で受けているときは、地上波・BS・CS の局を先に選ぶ (種別の並びは番組表と同じ)
      (a, b) => typeRank(a.service_type) - typeRank(b.service_type),
    ),
  }));
  const played = playableRecordings(
    matched.flatMap(({ found }) =>
      found !== undefined && found.end_at <= at ? [found.id] : [],
    ),
  );
  const out: RankedRow[] = [];
  for (const { entry, found } of matched) {
    if (found !== undefined) {
      const state = stateOf(found.start_at, found.end_at, at);
      out.push({
        rank: entry.rank,
        votes: entry.votes,
        state,
        program: withoutService(found),
        recording: state === "ended" ? (played.get(found.id) ?? null) : null,
        away: null,
      });
      continue;
    }
    const shown = entry.airings.filter((a) => a.end_at > since);
    const away = pick(
      shown,
      (a) => a.start_at,
      (a) => a.end_at,
      at,
    );
    if (away === undefined) continue;
    out.push({
      rank: entry.rank,
      votes: entry.votes,
      state: stateOf(away.start_at, away.end_at, at),
      program: null,
      recording: null,
      away: {
        name: entry.name,
        service_name: away.service_name,
        region: away.region,
        affiliation: entry.affiliation,
        others: new Set(
          shown
            .map((a) => a.region)
            .filter((r) => r !== null && r !== away.region),
        ).size,
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
let pending: {
  joinedAt: number;
  entries: Promise<HubEntry[] | null>;
} | null = null;

/** ためた順位を捨てる。参加したとき・やめたとき (と単体テスト) */
export function dropRankingView(): void {
  held = null;
}

/**
 * hub から順位を受け取る。401 (トークンが hub から消えた)・403 (7 日送っていない) なら、差分を送ってから
 * もう 1 度だけ `GET /ranking` を呼ぶ (送る処理は 401 を受けるとトークンを取り直す)
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

/** hub を呼ぶのは、同じ参加の間は同時に 1 回だけ。受け取ったらためる */
function refresh(joinedAt: number): Promise<HubEntry[] | null> {
  // やめてすぐ参加し直したときは、前のトークンで呼んでいる途中のものを待たない
  if (pending?.joinedAt === joinedAt) return pending.entries;
  const entries = fetchEntries()
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
      if (pending?.entries === entries) pending = null;
    });
  pending = { joinedAt, entries };
  return entries;
}

/** 突き合わせた行にする。突き合わせで DB の読み出しが失敗しても、節は「読めません」にするだけで画面は止めない */
function present(entries: HubEntry[] | null, at: number): RankingView {
  if (entries === null) return { ok: false };
  try {
    return { ok: true, rows: matchEntries(entries, at) };
  } catch (error) {
    console.warn("[ranking] 順位を番組表と突き合わせられませんでした", error);
    return { ok: false };
  }
}

/**
 * **検索を言葉なしで開いたときの節「人気の番組」** (docs/screens.md)。参加していなければ null (節を出さない)。
 * ためた順位がまだ新しければその場で返し、古ければ hub を呼ぶ Promise を返す (画面は待たずに出し、節だけあとから埋める)。
 * 突き合わせは毎回し直すので、予約・取消のあとに読み込み直しても行の状態はいまのもの
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
