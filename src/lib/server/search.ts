import { and, desc, eq, getTableColumns, gt, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { type AnySQLiteColumn, alias } from 'drizzle-orm/sqlite-core';
import { globTerms, likePieces } from '../fold';
import type { ReservationState, Rule } from '../types';
import { now, orm } from './db';
import { compile, haystack, matchesCompiled } from './rules';
import { programs, recordings, reservationState, reservations, rules as ruleTable, services } from './schema';
import { searchable } from './title';

/**
 * **検索** (結果の画面 `/search?q=` と、打つそばから出す `/api/search`)。番組表・録画・予約・ルールを
 * 1つの言葉で探す。
 *
 * 読み方はどこも同じ: 空白で区切った語を**すべて**含むもの (AND)。全角と半角、大文字と小文字、
 * 外字と昔の書き方は揃えて比べる (`title.searchable`)。
 *
 * **SQL で減らしてから JS で当てる。** `GLOB` に掛けられる語 (`fold.globTerms`) で候補を減らし、
 * 当てるのは揃えた文字列。外字に寄せた字 (「吉」) のように SQL に掛けられない語も、JS のほうで当たる。
 *
 * **要るぶんだけ読む。** 当たった行を全部読んでから切っていた頃は、1字の言葉 (番組表の何千行に当たる) でも
 * 打つたびに全部を読んでいた。いまは並べた順に少しずつ読み (`gather`)、上限に1つ足したぶんが揃ったら止める。
 * 件数が要るとき (結果の画面) は `count(*)` で数える。SQL の絞り込みが JS の当て方と同じになる言葉 (`exact`)
 * なら行を読まずに数え、そうでない言葉 (外字に寄せた字を含む) だけ全部読んで数える
 */

/** 探す言葉の長さの上限 (文字数)。番組名を丸ごと貼っても収まり、打つたびに長い言葉で4つの節を引かせない */
export const MAX_QUERY = 100;

/**
 * URL の `q` を探す言葉にする。前後の空白を落とし、**長すぎる分は切る** (断らない。貼った番組名の
 * 後ろが少し欠けても、前のほうで当たる)。文字で数えるので、外字 (𠮷) の途中で切れない
 */
export function searchQuery(raw: string | null | undefined): string {
    const q = (raw ?? '').trim();
    const chars = [...q];
    return chars.length <= MAX_QUERY ? q : chars.slice(0, MAX_QUERY).join('').trimEnd();
}

/** 語に分ける。空なら空の並び (何も探さない) */
export function searchWords(q: string): string[] {
    return searchable(q).split(/\s+/).filter(Boolean);
}

/** 揃えた文字列が語をすべて含むか */
export function hasAll(words: string[], ...texts: (string | null | undefined)[]): boolean {
    const text = searchable(texts.filter((t) => t != null).join(' '));
    return words.every((word) => text.includes(word));
}

/** SQL の前絞り。掛けられる語が無ければ何も絞らない (undefined) */
function narrow(words: string[], columns: AnySQLiteColumn[]): SQL | undefined {
    const terms = globTerms(words);
    if (terms.length === 0) return undefined;
    return and(...terms.map((term) => or(...columns.map((column) => sql`${column} GLOB ${term}`))));
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
            return pieces.length === 1 && pieces[0] === word && globTerms([word]).length === 1;
        })
    );
}

/**
 * 1つの節の結果。`rows` は先頭から `limit` 件まで、`more` はその先にもあるか。
 * `total` は件数を頼んだとき (`count`) は当たった数、頼まなければ読んだぶんの数 (多くても `limit + 1`)
 */
export interface Section<T> {
    total: number;
    rows: T[];
    more: boolean;
}

export interface SearchOptions {
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
    return { total, rows: found.slice(0, limit), more: found.length > limit || total > limit };
}

/** 件数を数える (`count(*)`) */
const counted = (row: { n: number } | undefined): number => Number(row?.n ?? 0);

/**
 * **これからの放送** (番組表)。番組名と概要に当てる。判定はルールと同じもの
 * (`rules.matchesCompiled`)。終わっていない番組 (いま放送中も含む) だけ、始まる順。
 * 有料放送も出す — 探しているのは人で、録るかどうかはその人が決める
 */
export function searchPrograms(q: string, options: SearchOptions) {
    const words = searchWords(q);
    const rule: Rule = {
        id: 0,
        name: '',
        keyword: q,
        ignore_keyword: '',
        search_fields: 'name,description',
        service_ids: null,
        service_types: null,
        genres: null,
        enabled: true,
        priority: 1,
        dedupe: false,
        source: null,
        created_at: 0,
    };
    const compiled = compile(rule);
    const r = alias(reservations, 'r');
    const {
        audios: _a,
        video_type: _v,
        video_resolution: _r,
        extended: _e,
        ...light
    } = getTableColumns(programs);
    const where = and(gt(programs.end_at, now()), narrow(words, [programs.name, programs.description]));
    const page = (offset: number, size: number) =>
        words.length === 0
            ? []
            : orm()
                  .select({
                      ...light,
                      service_name: services.name,
                      service_type: services.type,
                      has_logo: services.has_logo,
                      reservation_id: r.id,
                      reservation_state: r.state,
                  })
                  .from(programs)
                  .innerJoin(services, eq(services.id, programs.service_id))
                  .leftJoin(
                      r,
                      and(
                          eq(r.program_id, programs.id),
                          inArray(r.state, ['scheduled', 'conflict', 'skipped']),
                      ),
                  )
                  .where(where)
                  .orderBy(programs.start_at, programs.id)
                  .limit(size)
                  .offset(offset)
                  .all();
    const result = section(
        words,
        options,
        page,
        (program) =>
            matchesCompiled(compiled, program, program.service_type, false, (fields) =>
                haystack({ ...program, extended: null }, fields),
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
    return { ...result, rows: result.rows.map(({ service_type: _t, ...program }) => program) };
}

/**
 * **録画**。番組名・シリーズ・副題・局名に当てる。消したものは出さない。新しい順
 */
export function searchRecordings(q: string, options: SearchOptions) {
    const words = searchWords(q);
    const where = and(
        isNull(recordings.deleted_at),
        narrow(words, [recordings.name, recordings.series, recordings.subtitle, recordings.service_name]),
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
        (rec) => hasAll(words, rec.name, rec.series, rec.subtitle, rec.service_name),
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
    const r = alias(reservations, 'r');
    const rec = alias(recordings, 'rec');
    const where = and(
        or(
            and(inArray(r.state, ['scheduled', 'conflict', 'skipped']), isNull(r.started_at)),
            eq(rec.state, 'recording'),
        ),
        gt(r.end_at, now()),
        narrow(words, [r.name, services.name]),
    );
    const latest = sql`(SELECT id FROM recordings WHERE reservation_id = ${r.id} ORDER BY id DESC LIMIT 1)`;
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
    const result = section(
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
    return { ...result, rows: result.rows.map((row) => ({ ...row, state: row.state as ReservationState })) };
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
                  .filter((rule) => hasAll(words, rule.name, rule.keyword, rule.ignore_keyword));
    const rows = found.slice(0, options.limit).map((rule) => ({
        ...rule,
        reservations: counted(
            orm()
                .select({ n: sql<number>`count(*)` })
                .from(reservations)
                .where(
                    and(
                        eq(reservations.rule_id, rule.id),
                        inArray(reservations.state, ['scheduled', 'conflict']),
                        isNull(reservations.started_at),
                    ),
                )
                .get(),
        ),
    }));
    return { total: found.length, rows, more: found.length > options.limit };
}
