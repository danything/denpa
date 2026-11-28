/**
 * **番組ランキングに送る「録った・観た」を数える** (`ranking.ts` が送る。決まりは denpa-hub の docs/ranking.md「送る中身」)。
 * 参加している間だけ、放送ごとに `ranking_watched` に貯める。送るのは放送が終わってから。
 *
 * - ライブ (`live`): 局ごとに、映像を観ている人のいるセッションが 1 つ以上あった時間を、番組表の番組の時刻で切り分けて足す (`liveWatching`)。
 *   同じ家で何人が観ても、同じ局のセッションがいくつあっても 1 つの時間。字幕だけを受けている人・追っかけ・先回りで開いただけのものは数えない
 * - タイムシフト (`timeshift`): 観る画面と追っかけが 15 秒ごとに送る再生位置 (`POST /api/recordings/<id>/resume`) から、
 *   前の位置から進んだ分を、経った時間までだけ足す (`timeshiftPlayed`)。放送が終わって 7 日以内の再生だけ
 * - 予約 (`reserved`) と録った (`recorded`): 放送が終わってから送る前に、予約と録画から写す (`settleEnded`)。番組表から番組が消えても
 *   (終わって 1 日) 送った組を保つため
 *
 * 家の住所・観た時刻・観た長さは hub に送らない。送るのは、長さが決まりを超えたかどうか (`kindsOf`) だけ
 */
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte } from "drizzle-orm";

import { origin } from "../types";
import { now, orm } from "./db";
import {
  programs,
  rankingLink,
  rankingWatched,
  recordings,
  reservations,
  services,
  TO_RECORD_STATES,
} from "./schema";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 「観た」とみなす長さ。10 分より短い番組は長さの半分 (hub の決まり。局を次々に変えて通り過ぎた番組を数えないため) */
const WATCHED = 5 * MINUTE;
/** タイムシフトを数える間 (放送が終わってから)。テレビの視聴率のタイムシフトの数え方 (7 日 = 168 時間) に合わせる */
const TIMESHIFT_WITHIN = 7 * DAY;
/**
 * 終わった放送を送る間 (放送が終わってから)。hub は終わって 8 日までを受けるので、時計のずれと送る時刻の揺らぎを見込んで手前で切る。
 * 7 日のタイムシフトを、6 時間ごとの送信で送り切れる幅
 */
const SEND_AFTER_END = 8 * DAY - 2 * HOUR;
/**
 * 終わったとみなすまでの余裕。hub は終わっていない放送の「観た」を断るので、時計のずれを見込んで少し待つ
 */
export const ENDED_MARGIN = 5 * MINUTE;
/** 再生位置を続けて受けたとみなす間。15 秒ごとに送るので、2 回落ちても続きとして数える */
const RESUME_GAP = 50_000;

/** 参加しているか。参加していなければ何も貯めない */
function joined(): boolean {
  return (
    orm().select({ id: rankingLink.id }).from(rankingLink).get() !== undefined
  );
}

/** 地上波・BS・CS の局か。ケーブルは元の放送が地上波・BS・CS のもの (パススルー・再送信) だけ (`ranking.ts` と同じ) */
export function countedService(type: string, networkId: number): boolean {
  if (type === "SKY") return false;
  const from = origin(networkId);
  return from === "GR" || from === "BS" || from === "CS";
}

/** 「観た」に要る長さ (ms) */
function watchedEnough(durationMs: number): number {
  return Math.min(WATCHED, durationMs / 2);
}

/** `ranking_watched` に写す、番組表の番組 1 つの中身 */
interface ProgramFacts {
  network_id: number;
  service_id: number;
  event_id: number;
  start_at: number;
  end_at: number;
  name: string;
  service_name: string;
  genres: number[];
}

const programFacts = {
  network_id: programs.network_id,
  service_id: services.service_id,
  event_id: programs.event_id,
  start_at: programs.start_at,
  end_at: programs.end_at,
  name: programs.name,
  service_name: services.name,
  genres: programs.genres,
  type: services.type,
};

type FactsRow = Omit<ProgramFacts, "genres"> & {
  genres: number[] | null;
  type: string;
};

/** 番組表の番組 1 つを、`ranking_watched` の行の形にする。数えない局の番組なら null */
function factsOf(row: FactsRow): ProgramFacts | null {
  if (!countedService(row.type, row.network_id)) return null;
  return {
    network_id: row.network_id,
    service_id: row.service_id,
    event_id: row.event_id,
    start_at: row.start_at,
    end_at: row.end_at,
    name: row.name,
    service_name: row.service_name,
    genres: row.genres ?? [],
  };
}

/** 行を作るか書き換える。番組の時刻と名前はいまの番組表のものにし、足すものは足す */
function upsert(
  facts: ProgramFacts,
  add: {
    reserved?: boolean;
    recorded?: boolean;
    recording_id?: number;
    live_ms?: number;
    timeshift_ms?: number;
  },
): void {
  const row = orm()
    .select()
    .from(rankingWatched)
    .where(
      and(
        eq(rankingWatched.network_id, facts.network_id),
        eq(rankingWatched.service_id, facts.service_id),
        eq(rankingWatched.event_id, facts.event_id),
      ),
    )
    .get();
  if (row === undefined) {
    orm()
      .insert(rankingWatched)
      .values({
        ...facts,
        reserved: add.reserved ?? false,
        recorded: add.recorded ?? false,
        recording_id: add.recording_id ?? null,
        live_ms: add.live_ms ?? 0,
        timeshift_ms: add.timeshift_ms ?? 0,
      })
      .run();
    return;
  }
  orm()
    .update(rankingWatched)
    .set({
      ...facts,
      reserved: row.reserved || (add.reserved ?? false),
      recorded: row.recorded || (add.recorded ?? false),
      recording_id: add.recording_id ?? row.recording_id,
      live_ms: row.live_ms + (add.live_ms ?? 0),
      timeshift_ms: row.timeshift_ms + (add.timeshift_ms ?? 0),
    })
    .where(
      and(
        eq(rankingWatched.network_id, facts.network_id),
        eq(rankingWatched.service_id, facts.service_id),
        eq(rankingWatched.event_id, facts.event_id),
      ),
    )
    .run();
}

// ---- ライブ ----

/** 局 (`services.id`) ごとの、映像を観ている人のいるセッションの数と、まだ足していない時間の始まり */
const watching = new Map<number, { sessions: number; since: number }>();

/**
 * **ライブのセッションの、映像を観ている人の有る無しが変わった** (`live.ts` の `Session`)。
 * 局ごとに数え、0 になったら、観ていた時間を番組ごとに足す
 */
export function liveWatching(serviceId: number, on: boolean, at = now()): void {
  const held = watching.get(serviceId);
  if (on) {
    if (held === undefined) watching.set(serviceId, { sessions: 1, since: at });
    else held.sessions++;
    return;
  }
  if (held === undefined) return;
  held.sessions--;
  if (held.sessions > 0) return;
  watching.delete(serviceId);
  addLive(serviceId, held.since, at);
}

/**
 * **観ている最中の時間を足す** (`runtime.ts` が 1 分ごとに呼ぶ)。長く観ている間にサーバが止まっても、それまでの分を残すため。
 * 番組が替わった分も、ここで前の番組に足される
 */
export function flushLive(at = now()): void {
  for (const [serviceId, held] of watching) {
    if (at <= held.since) continue;
    addLive(serviceId, held.since, at);
    held.since = at;
  }
}

/** `from`〜`to` に観ていた時間を、その局の番組表の番組の時刻で切り分けて足す */
function addLive(serviceId: number, from: number, to: number): void {
  if (to <= from || !joined()) return;
  const rows = orm()
    .select(programFacts)
    .from(programs)
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(
      and(
        eq(programs.service_id, serviceId),
        lt(programs.start_at, to),
        gt(programs.end_at, from),
      ),
    )
    .all();
  for (const row of rows) {
    const facts = factsOf(row);
    if (facts === null) continue;
    const overlap = Math.min(to, row.end_at) - Math.max(from, row.start_at);
    if (overlap > 0) upsert(facts, { live_ms: overlap });
  }
}

// ---- タイムシフト ----

/** 録画ごとの、前に受けた再生位置 (秒) と時刻 */
const played = new Map<number, { position: number; at: number }>();

/**
 * **録画の再生位置を受けた** (`POST /api/recordings/<id>/resume`)。前の位置から進んだ分を、経った時間までだけ足す
 * (早送りと飛ばした分は数えない)。前の位置が無い・間が空いた・戻ったときは足さない
 */
export function timeshiftPlayed(
  recordingId: number,
  position: number,
  at = now(),
): void {
  const before = played.get(recordingId);
  played.set(recordingId, { position, at });
  // 開いたままの録画が貯まりすぎないよう、古いものは捨てる (続きとして数えない間を過ぎたもの)
  if (played.size > 64)
    for (const [id, p] of played) if (at - p.at > RESUME_GAP) played.delete(id);
  if (before === undefined || at - before.at > RESUME_GAP) return;
  const advanced = Math.min(
    (position - before.position) * 1000,
    at - before.at,
  );
  if (advanced <= 0 || !joined()) return;
  const facts = airingOfRecording(recordingId);
  if (facts === null || at > facts.end_at + TIMESHIFT_WITHIN) return;
  upsert(facts, { timeshift_ms: advanced, recording_id: recordingId });
}

/** 録画の放送。番組表に番組があればそこから、無ければ前に写した行から。どちらも無ければ null (送れない) */
function airingOfRecording(recordingId: number): ProgramFacts | null {
  const row = orm()
    .select(programFacts)
    .from(recordings)
    .innerJoin(programs, eq(programs.id, recordings.program_id))
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(eq(recordings.id, recordingId))
    .get();
  if (row !== undefined) return factsOf(row);
  const kept = orm()
    .select()
    .from(rankingWatched)
    .where(eq(rankingWatched.recording_id, recordingId))
    .get();
  if (kept === undefined) return null;
  return {
    network_id: kept.network_id,
    service_id: kept.service_id,
    event_id: kept.event_id,
    start_at: kept.start_at,
    end_at: kept.end_at,
    name: kept.name,
    service_name: kept.service_name,
    genres: kept.genres,
  };
}

// ---- 終わった放送 ----

/**
 * **終わった放送の予約と録画を写す** (`ranking.ts` が送る前に呼ぶ)。番組表に番組が残っている間に (終わって 1 日)、
 * 予約 (予約済みと競合) と、録り終えた録画 (失敗したものは入れない) を `ranking_watched` に書く。
 * 終わって送る間を過ぎた行は消す
 */
export function settleEnded(at = now()): void {
  const ended = at - ENDED_MARGIN;
  const since = at - SEND_AFTER_END;
  const reserved = orm()
    .select(programFacts)
    .from(reservations)
    .innerJoin(programs, eq(programs.id, reservations.program_id))
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(
      and(
        inArray(reservations.state, TO_RECORD_STATES),
        lte(programs.end_at, ended),
        gt(programs.end_at, since),
      ),
    )
    .all();
  const recorded = orm()
    .select({ ...programFacts, recording: recordings.id })
    .from(recordings)
    .innerJoin(programs, eq(programs.id, recordings.program_id))
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(
      and(
        isNotNull(recordings.finished_at),
        isNull(recordings.error),
        lte(programs.end_at, ended),
        gt(programs.end_at, since),
      ),
    )
    .all();
  orm().transaction(() => {
    for (const row of reserved) {
      const facts = factsOf(row);
      if (facts !== null) upsert(facts, { reserved: true });
    }
    for (const row of recorded) {
      const facts = factsOf(row);
      if (facts !== null)
        upsert(facts, { recorded: true, recording_id: row.recording });
    }
    orm().delete(rankingWatched).where(lte(rankingWatched.end_at, since)).run();
  });
}

/** 終わった放送の行から、送る種類の組を決める。どれにも当たらなければ空 */
export function kindsOf(row: {
  start_at: number;
  end_at: number;
  reserved: boolean;
  recorded: boolean;
  live_ms: number;
  timeshift_ms: number;
}): ("reserved" | "live" | "recorded" | "timeshift")[] {
  const need = watchedEnough(row.end_at - row.start_at);
  const kinds: ("reserved" | "live" | "recorded" | "timeshift")[] = [];
  if (row.reserved) kinds.push("reserved");
  if (row.live_ms >= need) kinds.push("live");
  if (row.recorded) kinds.push("recorded");
  if (row.timeshift_ms >= need) kinds.push("timeshift");
  return kinds;
}

/** 送る終わった放送の行 (終わって `ENDED_MARGIN` を過ぎ、送る間の中のもの) */
export function endedRows(at = now()) {
  return orm()
    .select()
    .from(rankingWatched)
    .where(
      and(
        lte(rankingWatched.end_at, at - ENDED_MARGIN),
        gt(rankingWatched.end_at, at - SEND_AFTER_END),
      ),
    )
    .all();
}

/** やめたとき・入り直したとき。貯めた行と、測っている途中のものを捨てる */
export function forgetWatched(): void {
  orm().delete(rankingWatched).run();
  played.clear();
  for (const held of watching.values()) held.since = now();
}

/** 単体テスト用。測っている途中のものを捨てる */
export function resetWatchForTest(): void {
  watching.clear();
  played.clear();
}
