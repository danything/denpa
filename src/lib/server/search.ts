import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { globTerms, likePieces } from "../fold";
import type { ReservationState, Rule } from "../types";
import { pendingCaptionIndex } from "./caption-index";
import { captionHits, captionMatch, captionTerms } from "./caption-key";
import { now, orm } from "./db";
import { tsHeadOf } from "./recording";
import { ANY_PAID, compile, haystack, matchesCompiled } from "./rules";
import {
  activeEncodeJobId,
  CAPTION_FTS,
  captionLines,
  HELD_STATES,
  latestReservationRecordingId,
  programs,
  recordings,
  reservations,
  reservationState,
  rules as ruleTable,
  services,
  TO_RECORD_STATES,
} from "./schema";
import { searchable } from "./title";

/**
 * **検索** (結果の画面 `/search?q=` と、打つそばから出す `/api/search`)。番組表・録画・予約・ルールを
 * 1 つの言葉で探す。録画の字幕 (`searchCaptions`) は結果の画面と `/api/search/captions` だけ。
 *
 * 読み方はどこも同じで、空白で区切った語を**すべて**含むもの (AND)。全角と半角、大文字と小文字、
 * 外字と昔の書き方は揃えて比べる (`title.searchable`)。
 *
 * **SQL で減らしてから JS で当てる。** `GLOB` に掛けられる語 (`fold.globTerms`) で候補を減らし、
 * 当てるのは揃えた文字列。外字に寄せた字 (「吉」) のように SQL に掛けられない語も、JS のほうで当たる。
 *
 * **要るぶんだけ読む。** 当たった行を全部読んでから切ると、1 字の言葉 (番組表の何千行に当たる) でも
 * 打つたびに全部を読む。並べた順に少しずつ読み (`gather`)、上限に 1 つ足したぶんが揃ったら止める。
 * 件数が要るとき (結果の画面) は `count(*)` で数える。SQL の絞り込みが JS の当て方と同じになる言葉 (`exact`)
 * なら行を読まずに数え、そうでない言葉 (外字に寄せた字を含む) だけ全部読んで数える
 */

/** 探す言葉の長さの上限 (文字数)。番組名を丸ごと貼っても収まり、打つたびに長い言葉で 4 つの節を引かせない */
export const MAX_QUERY = 100;

/**
 * URL の `q` を探す言葉にする。前後の空白を落とし、**長すぎる分は切る** (断らない。貼った番組名の
 * 後ろが少し欠けても、前のほうで当たる)。文字で数えるので、外字 (𠮷) の途中で切れない
 */
export function searchQuery(raw: string | null | undefined): string {
  const q = (raw ?? "").trim();
  const chars = [...q];
  return chars.length <= MAX_QUERY
    ? q
    : chars.slice(0, MAX_QUERY).join("").trimEnd();
}

/** 語に分ける。空なら空の並び (何も探さない) */
export function searchWords(q: string): string[] {
  return searchable(q).split(/\s+/).filter(Boolean);
}

/** 揃えた文字列が語をすべて含むか */
export function hasAll(
  words: string[],
  ...texts: (string | null | undefined)[]
): boolean {
  const text = searchable(texts.filter((t) => t != null).join(" "));
  return words.every((word) => text.includes(word));
}

/** SQL の前絞り。掛けられる語が無ければ何も絞らない (undefined) */
function narrow(words: string[], columns: AnySQLiteColumn[]): SQL | undefined {
  const terms = globTerms(words);
  if (terms.length === 0) return undefined;
  return and(
    ...terms.map((term) =>
      or(...columns.map((column) => sql`${column} GLOB ${term}`)),
    ),
  );
}

/**
 * SQL の前絞りが JS の当て方と同じになるか。語がどれも切れ端に分かれず (外字に寄せた字が絡まない)、
 * まるごと `GLOB` に掛けられるときだけ。同じなら `count(*)` がそのまま件数になる
 */
export function exact(words: string[]): boolean {
  return (
    words.length > 0 &&
    words.every((word) => {
      const pieces = likePieces(word);
      return (
        pieces.length === 1 &&
        pieces[0] === word &&
        globTerms([word]).length === 1
      );
    })
  );
}

/**
 * 1 つの節の結果。`rows` は先頭から `limit` 件まで、`more` はその先にもあるか。
 * `total` は件数を求めたとき (`count`) は当たった数、求めなければ読んだぶんの数 (多くても `limit + 1`)
 */
interface Section<T> {
  total: number;
  rows: T[];
  more: boolean;
}

interface SearchOptions {
  limit: number;
  /** 当たった数も数えるか。結果の画面だけ。打つそばから出すぶんは数えない */
  count?: boolean;
}

/**
 * 並べた順に少しずつ読み、`keep` に当たったものを `want` 件まで集める
 */
function gather<T>(
  page: (offset: number, size: number) => T[],
  keep: (row: T) => boolean,
  want: number,
): T[] {
  const size = Number.isFinite(want) ? Math.max(64, want * 4) : 2000;
  const found: T[] = [];
  for (let offset = 0; ; offset += size) {
    const rows = page(offset, size);
    for (const row of rows) {
      if (keep(row)) found.push(row);
      if (found.length >= want) return found;
    }
    if (rows.length < size) return found;
  }
}

/** `gather` と件数から節を組む */
function section<T>(
  words: string[],
  options: SearchOptions,
  page: (offset: number, size: number) => T[],
  keep: (row: T) => boolean,
  countAll: () => number,
): Section<T> {
  const { limit, count = false } = options;
  // 外字に寄せた字を含む言葉は SQL で数えられないので、全部読んで数える (めったに無い)
  const all = count && !exact(words);
  const found = gather(page, keep, all ? Number.POSITIVE_INFINITY : limit + 1);
  const total = !count || all ? found.length : countAll();
  return {
    total,
    rows: found.slice(0, limit),
    more: found.length > limit || total > limit,
  };
}

/** 件数を数える (`count(*)`) */
const counted = (row: { n: number } | undefined): number => Number(row?.n ?? 0);

/**
 * **これからの放送の行** (番組表の番組と、立っている予約)。検索の結果と、人気の番組の節 (`ranking.ts`) で同じ形にする。
 * 大きな欄 (音声・映像・拡張の説明) は読まない。`service_type`・`service_sid` (局の service_id) は画面に渡す前に外す (`withoutService`)
 */
export function programRows(where: SQL | undefined) {
  const r = alias(reservations, "r");
  const rec = alias(recordings, "rec");
  const {
    audios: _a,
    video_type: _v,
    video_resolution: _r,
    extended: _e,
    ...light
  } = getTableColumns(programs);
  return orm()
    .select({
      ...light,
      service_name: services.name,
      service_type: services.type,
      service_sid: services.service_id,
      has_logo: services.has_logo,
      reservation_id: r.id,
      // 番組表のマスと同じ物差し (`reservationState`)。r.state のままでは録画中も「予約済み」に見える
      reservation_state: sql<ReservationState | null>`CASE WHEN ${r.id} IS NULL THEN NULL ELSE ${reservationState(r, rec)} END`,
    })
    .from(programs)
    .innerJoin(services, eq(services.id, programs.service_id))
    .leftJoin(
      r,
      and(eq(r.program_id, programs.id), inArray(r.state, HELD_STATES)),
    )
    .leftJoin(rec, eq(rec.id, latestReservationRecordingId(r.id)))
    .where(where);
}

/**
 * **これからの放送** (番組表)。番組名と概要に当てる。判定はルールと同じもの
 * (`rules.matchesCompiled`)。終わっていない番組 (いま放送中も含む) だけ、始まる順。
 * 有料放送も出す。探しているのは人で、録るかどうかはその人が決める
 */
export function searchPrograms(q: string, options: SearchOptions) {
  const words = searchWords(q);
  const rule: Rule = {
    id: 0,
    name: "",
    keyword: q,
    ignore_keyword: "",
    search_fields: "name,description",
    service_ids: null,
    service_types: null,
    genres: null,
    time_from: null,
    time_to: null,
    weekdays: null,
    enabled: true,
    priority: 1,
    dedupe: false,
    skip_earlier: false,
    source: null,
    created_at: 0,
    decided_at: 0,
  };
  const compiled = compile(rule);
  const where = and(
    gt(programs.end_at, now()),
    // 世帯で隠した局 (`services.hidden`) の番組は出さない。番組表とライブにも出ていない
    eq(services.hidden, false),
    narrow(words, [programs.name, programs.description]),
  );
  const page = (offset: number, size: number) =>
    words.length === 0
      ? []
      : programRows(where)
          .orderBy(programs.start_at, programs.id)
          .limit(size)
          .offset(offset)
          .all();
  const result = section(
    words,
    options,
    page,
    (program) =>
      matchesCompiled(
        compiled,
        program,
        program.service_type,
        ANY_PAID,
        (fields) => haystack({ ...program, extended: null }, fields),
      ),
    () =>
      counted(
        orm()
          .select({ n: sql<number>`count(*)` })
          .from(programs)
          .innerJoin(services, eq(services.id, programs.service_id))
          .where(where)
          .get(),
      ),
  );
  return {
    ...result,
    rows: result.rows.map(withoutService),
  };
}

/** 画面に渡す前に、行から局の種別と service_id を外す (`programRows`) */
export function withoutService<
  T extends { service_type: unknown; service_sid: unknown },
>({ service_type: _t, service_sid: _s, ...program }: T) {
  return program;
}

/**
 * **録画**。番組名・シリーズ・副題・局名に当てる。消したものは出さない。新しい順
 */
export function searchRecordings(q: string, options: SearchOptions) {
  const words = searchWords(q);
  const where = and(
    isNull(recordings.deleted_at),
    narrow(words, [
      recordings.name,
      recordings.series,
      recordings.subtitle,
      recordings.service_name,
    ]),
  );
  const page = (offset: number, size: number) =>
    words.length === 0
      ? []
      : orm()
          .select({
            id: recordings.id,
            program_id: recordings.program_id,
            name: recordings.name,
            series: recordings.series,
            subtitle: recordings.subtitle,
            description: recordings.description,
            service_id: recordings.service_id,
            service_name: recordings.service_name,
            start_at: recordings.start_at,
            end_at: recordings.end_at,
            duration_ms: recordings.duration_ms,
            state: recordings.state,
            finished_at: recordings.finished_at,
            ts_path: recordings.ts_path,
            library_path: recordings.library_path,
            watched_at: recordings.watched_at,
            has_logo: services.has_logo,
            // エンコード中か。動いている間は削除を出さない (ホームの行と同じ。裏の ffmpeg が元の TS を読んでいる)
            job_id: activeEncodeJobId(recordings.id),
          })
          .from(recordings)
          .leftJoin(services, eq(services.id, recordings.service_id))
          .where(where)
          .orderBy(desc(recordings.start_at), desc(recordings.id))
          .limit(size)
          .offset(offset)
          .all();
  const result = section(
    words,
    options,
    page,
    (rec) =>
      hasAll(words, rec.name, rec.series, rec.subtitle, rec.service_name),
    () =>
      counted(
        orm()
          .select({ n: sql<number>`count(*)` })
          .from(recordings)
          .where(where)
          .get(),
      ),
  );
  // 配信は library_path ?? ts_path を返す。どちらも無ければ観られない (パスそのものは画面に渡さない)
  return {
    ...result,
    rows: result.rows.map(({ ts_path, library_path, ...rec }) => ({
      ...rec,
      has_file: (library_path ?? ts_path) !== null,
    })),
  };
}

/**
 * **予約**。まだ録っていないものと、いま録っているもの。番組名と局名に当てる
 * (予約はシリーズ・副題を持たない)。放送の近い順
 */
export function searchReservations(q: string, options: SearchOptions) {
  const words = searchWords(q);
  const r = alias(reservations, "r");
  const rec = alias(recordings, "rec");
  const where = and(
    or(
      and(inArray(r.state, TO_RECORD_STATES), isNull(r.started_at)),
      // 録画しない予約 (コピー禁止の番組と、録り始めてから同じ回と分かってやめた `recorder.skipDuplicate`。後者は録り始めた時刻が入っている)
      eq(r.state, "skipped"),
      eq(rec.state, "recording"),
    ),
    gt(r.end_at, now()),
    narrow(words, [r.name, services.name]),
  );
  const latest = latestReservationRecordingId(r.id);
  const page = (offset: number, size: number) =>
    words.length === 0
      ? []
      : orm()
          .select({
            id: r.id,
            program_id: r.program_id,
            name: r.name,
            description: r.description,
            service_id: r.service_id,
            service_name: services.name,
            has_logo: services.has_logo,
            start_at: r.start_at,
            end_at: r.end_at,
            manual: r.manual,
            rule_id: r.rule_id,
            rule_name: ruleTable.name,
            state: reservationState(r, rec),
            recording_id: sql<
              number | null
            >`CASE WHEN ${rec.state} = 'recording' THEN ${rec.id} END`,
          })
          .from(r)
          .innerJoin(services, eq(services.id, r.service_id))
          .leftJoin(ruleTable, eq(ruleTable.id, r.rule_id))
          .leftJoin(rec, eq(rec.id, latest))
          .where(where)
          .orderBy(r.start_at, r.id)
          .limit(size)
          .offset(offset)
          .all();
  return section(
    words,
    options,
    page,
    (row) => hasAll(words, row.name, row.service_name),
    () =>
      counted(
        orm()
          .select({ n: sql<number>`count(*)` })
          .from(r)
          .innerJoin(services, eq(services.id, r.service_id))
          .leftJoin(rec, eq(rec.id, latest))
          .where(where)
          .get(),
      ),
  );
}

/**
 * **ルール**。名前・キーワード・除外キーワードに当てる。新しい順 (ルール画面の一覧と同じ)。
 * ルールは多くても数百なので全部読んで当てる (件数もそのまま)。予約の数は出す行にだけ数える
 */
export function searchRules(q: string, options: SearchOptions) {
  const words = searchWords(q);
  const found =
    words.length === 0
      ? []
      : orm()
          .select({
            id: ruleTable.id,
            name: ruleTable.name,
            keyword: ruleTable.keyword,
            ignore_keyword: ruleTable.ignore_keyword,
            enabled: ruleTable.enabled,
            priority: ruleTable.priority,
          })
          .from(ruleTable)
          .orderBy(desc(ruleTable.id))
          .all()
          .filter((rule) =>
            hasAll(words, rule.name, rule.keyword, rule.ignore_keyword),
          );
  const rows = found.slice(0, options.limit).map((rule) => ({
    ...rule,
    reservations: counted(
      orm()
        .select({ n: sql<number>`count(*)` })
        .from(reservations)
        .where(
          and(
            eq(reservations.rule_id, rule.id),
            inArray(reservations.state, TO_RECORD_STATES),
            isNull(reservations.started_at),
          ),
        )
        .get(),
    ),
  }));
  return { total: found.length, rows, more: found.length > options.limit };
}

/** 録画の字幕で当たった 1 か所 (`searchCaptions`) */
export interface CaptionHit {
  /** 番組の始めからの秒 (観る画面の `?at=` と同じ。切り抜きの「この場面から観る」と同じ物差し) */
  at: number;
  /** 字幕の 1 枚の文字 (`caption-words.captionWords`。行の間に空白) */
  text: string;
  /** `text` の中の当たった所 ([始め, 終わり)。UTF-16 の位置) */
  marks: [number, number][];
  /** 同じ言語の 1 つ前と 1 つ後の 1 枚。無ければ空 */
  before: string;
  after: string;
  /** 字幕の第何言語か */
  language: number;
}

/** 1 本の録画で見せる当たりの数 */
export const CAPTION_HITS = 3;
/** 同じ録画の当たりをまとめる間 (ms)。1 文が何枚にも分かれて出る字幕で、同じ語が続けて当たる */
const CAPTION_GAP = 10_000;
/** 1 回に読む当たりの行の数と、読む行の上限。よく出る語でも、ここで止める (100 万行で 2 万行を読んで 90 ms ほど) */
const CAPTION_BATCH = 500;
const CAPTION_SCAN = 20_000;

/**
 * **録画の字幕** (`caption-index.ts` のインデックス)。字幕に語がすべて入っている録画を、新しい順 (録画の ID の大きい順) に返す。
 *
 * - インデックスを行の ID の大きい順に少しずつ読む。行の ID の上位は録画の ID なので、録画が `limit` 本を超えたところで止められる
 *   (その手前の録画の当たりは全部読んである)。読む行は `CAPTION_SCAN` まで。超えたら `more` を立て、最後の録画の `hits_total` は目安になる
 * - 当たった行は、揃えた文字が語をそのまま含むかで確かめ直す (`caption-key.captionHits`)。当たった所はその位置で返す
 * - 同じ録画で `CAPTION_GAP` より近い当たりは 1 つにまとめる。見せるのは時刻の順に先頭の `CAPTION_HITS` か所
 * - 語がどれも 1 字なら探さず、`short` を立てる (2 字ずつ区切って入れているので、1 字では引けない)
 * - `total` は当たった録画の数で、`limit` を超えたら `limit` (`more` が立つ)
 */
export function searchCaptions(q: string, options: { limit: number }) {
  const { limit } = options;
  const keys = captionTerms(searchWords(q));
  const empty = { total: 0, rows: [], more: false, short: false };
  if (keys.length === 0) return { ...empty, pending: 0 };
  const pending = pendingCaptionIndex();
  const match = captionMatch(keys);
  if (match === null) return { ...empty, short: true, pending };

  /** 録画ごとの当たり (読んだ順 = 録画の新しい順) */
  const found = new Map<
    number,
    {
      id: number;
      at_ms: number;
      language: number;
      text: string;
      marks: [number, number][];
    }[]
  >();
  let before = Number.MAX_SAFE_INTEGER;
  let read = 0;
  let exhausted = false;
  while (found.size <= limit) {
    if (read >= CAPTION_SCAN) break;
    let ids: number[];
    try {
      ids = orm()
        .all<{ id: number }>(
          sql`SELECT rowid AS id FROM ${sql.raw(CAPTION_FTS)} WHERE ${sql.raw(CAPTION_FTS)} MATCH ${match} AND rowid < ${before} ORDER BY rowid DESC LIMIT ${CAPTION_BATCH}`,
        )
        .map((row) => row.id);
    } catch (error) {
      // FTS5 が読めない式 (揃えた語に、SQLite が語の字と読まない字だけが残ったなど)。当たりなしにする
      console.warn(`[search] 字幕を探せませんでした: ${error}`);
      ids = [];
    }
    if (ids.length === 0) {
      exhausted = true;
      break;
    }
    read += ids.length;
    before = ids.at(-1)!;
    const lines = orm()
      .select({
        id: captionLines.id,
        recording_id: captionLines.recording_id,
        at_ms: captionLines.at_ms,
        language: captionLines.language,
        text: captionLines.text,
      })
      .from(captionLines)
      .innerJoin(recordings, eq(recordings.id, captionLines.recording_id))
      .where(and(inArray(captionLines.id, ids), isNull(recordings.deleted_at)))
      .orderBy(desc(captionLines.id))
      .all();
    for (const line of lines) {
      const marks = captionHits(line.text, keys);
      if (marks === null) continue;
      const list = found.get(line.recording_id) ?? [];
      found.set(line.recording_id, list);
      list.push({ ...line, marks });
    }
  }
  const more = found.size > limit || (!exhausted && read >= CAPTION_SCAN);
  const ids = [...found.keys()].slice(0, limit);
  if (ids.length === 0) return { ...empty, more, pending };

  const rows = orm()
    .select({
      id: recordings.id,
      name: recordings.name,
      service_id: recordings.service_id,
      service_name: recordings.service_name,
      has_logo: services.has_logo,
      start_at: recordings.start_at,
      end_at: recordings.end_at,
      duration_ms: recordings.duration_ms,
      state: recordings.state,
      finished_at: recordings.finished_at,
      ts_path: recordings.ts_path,
      library_path: recordings.library_path,
      ts_head: recordings.ts_head,
      record_from: recordings.record_from,
    })
    .from(recordings)
    .leftJoin(services, eq(services.id, recordings.service_id))
    .where(inArray(recordings.id, ids))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));

  /** 同じ録画・同じ言語の、その時刻の 1 つ前か後の 1 枚 */
  const neighbor = (
    recordingId: number,
    language: number,
    atMs: number,
    id: number,
    after: boolean,
  ): string =>
    orm()
      .select({ text: captionLines.text })
      .from(captionLines)
      .where(
        and(
          eq(captionLines.recording_id, recordingId),
          eq(captionLines.language, language),
          after
            ? sql`(${captionLines.at_ms}, ${captionLines.id}) > (${atMs}, ${id})`
            : sql`(${captionLines.at_ms}, ${captionLines.id}) < (${atMs}, ${id})`,
        ),
      )
      .orderBy(
        after ? captionLines.at_ms : desc(captionLines.at_ms),
        after ? captionLines.id : desc(captionLines.id),
      )
      .limit(1)
      .get()?.text ?? "";

  return {
    total: ids.length,
    more,
    short: false,
    pending,
    rows: ids.flatMap((id) => {
      const rec = byId.get(id);
      if (rec === undefined) return [];
      const lines = found.get(id)!.sort((a, b) => a.at_ms - b.at_ms);
      const kept: typeof lines = [];
      for (const line of lines) {
        const last = kept.at(-1);
        if (last !== undefined && line.at_ms - last.at_ms < CAPTION_GAP)
          continue;
        kept.push(line);
      }
      // 番組の始めからの秒。録画の物差し (元の TS) の位置に、元の TS の先頭の放送時刻を足して、番組の始まりを引く
      const offset = tsHeadOf(rec) - rec.start_at;
      const hits: CaptionHit[] = kept.slice(0, CAPTION_HITS).map((line) => ({
        at: Math.max(0, Math.round((line.at_ms + offset) / 100) / 10),
        text: line.text,
        marks: line.marks,
        before: neighbor(id, line.language, line.at_ms, line.id, false),
        after: neighbor(id, line.language, line.at_ms, line.id, true),
        language: line.language,
      }));
      const {
        ts_path,
        library_path,
        ts_head: _h,
        record_from: _f,
        ...shown
      } = rec;
      return [
        {
          ...shown,
          has_file: (library_path ?? ts_path) !== null,
          hits_total: kept.length,
          hits,
        },
      ];
    }),
  };
}
