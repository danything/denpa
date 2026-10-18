import {
    type AnyColumn,
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
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { globTerms } from '../fold';
import type { ReservationState, Rule } from '../types';
import { now, orm } from './db';
import { compile, haystack, matchesCompiled } from './rules';
import { programs, recordings, reservationState, reservations, rules as ruleTable, services } from './schema';
import { searchable } from './title';

/**
 * **検索** (`/search?q=`)。番組表・録画・予約・ルールを1つの言葉で探す。
 *
 * 読み方はどこも同じ: 空白で区切った語を**すべて**含むもの (AND)。全角と半角、大文字と小文字、
 * 外字と昔の書き方は揃えて比べる (`title.searchable`)。
 *
 * **SQL で減らしてから JS で当てる。** `GLOB` に掛けられる語 (`fold.globTerms`) で候補を減らし、
 * 当てるのは揃えた文字列。外字に寄せた字 (「吉」) のように SQL に掛けられない語も、JS のほうで当たる
 */

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
function narrow(words: string[], columns: AnyColumn[]): SQL | undefined {
    const terms = globTerms(words);
    if (terms.length === 0) return undefined;
    return and(...terms.map((term) => or(...columns.map((column) => sql`${column} GLOB ${term}`))));
}

/** 1つの節の結果。`total` は当たった数で、`rows` は先頭から `limit` 件まで */
export interface Section<T> {
    total: number;
    rows: T[];
}

function cut<T>(rows: T[], limit: number): Section<T> {
    return { total: rows.length, rows: rows.slice(0, limit) };
}

/**
 * **これからの放送** (番組表)。番組名と概要に当てる。判定はルールと同じもの
 * (`rules.matchesCompiled`)。終わっていない番組 (いま放送中も含む) だけ。
 * 有料放送も出す — 探しているのは人で、録るかどうかはその人が決める
 */
export function searchPrograms(q: string, limit: number) {
    const words = searchWords(q);
    if (words.length === 0) return cut([], limit);
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
    const rows = orm()
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
            and(eq(r.program_id, programs.id), inArray(r.state, ['scheduled', 'conflict', 'skipped'])),
        )
        .where(and(gt(programs.end_at, now()), narrow(words, [programs.name, programs.description])))
        .orderBy(programs.start_at)
        .all()
        .filter((program) =>
            matchesCompiled(compiled, program, program.service_type, false, (fields) =>
                haystack({ ...program, extended: null }, fields),
            ),
        )
        .map(({ service_type: _t, ...program }) => program);
    return cut(rows, limit);
}

/**
 * **録画**。番組名・シリーズ・副題・局名に当てる (ホームの `?q=` と同じ範囲)。
 * 消したものは出さない。新しい順
 */
export function searchRecordings(q: string, limit: number) {
    const words = searchWords(q);
    if (words.length === 0) return cut([], limit);
    const columns = [recordings.name, recordings.series, recordings.subtitle, recordings.service_name];
    const rows = orm()
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
        .where(and(isNull(recordings.deleted_at), narrow(words, columns)))
        .orderBy(desc(recordings.start_at))
        .all()
        .filter((rec) => hasAll(words, rec.name, rec.series, rec.subtitle, rec.service_name))
        // 配信は library_path ?? ts_path を返す。どちらも無ければ観られない (パスそのものは画面に渡さない)
        .map(({ ts_path, library_path, ...rec }) => ({
            ...rec,
            has_file: (library_path ?? ts_path) !== null,
        }));
    return cut(rows, limit);
}

/**
 * **予約**。まだ録っていないものと、いま録っているもの。番組名と局名に当てる
 * (予約はシリーズ・副題を持たない)。放送の近い順
 */
export function searchReservations(q: string, limit: number) {
    const words = searchWords(q);
    if (words.length === 0) return cut([], limit);
    const r = alias(reservations, 'r');
    const rec = alias(recordings, 'rec');
    const rows = orm()
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
            recording_id: sql<number | null>`CASE WHEN ${rec.state} = 'recording' THEN ${rec.id} END`,
        })
        .from(r)
        .innerJoin(services, eq(services.id, r.service_id))
        .leftJoin(ruleTable, eq(ruleTable.id, r.rule_id))
        .leftJoin(
            rec,
            eq(
                rec.id,
                sql`(SELECT id FROM recordings WHERE reservation_id = ${r.id} ORDER BY id DESC LIMIT 1)`,
            ),
        )
        .where(
            and(
                or(
                    and(inArray(r.state, ['scheduled', 'conflict', 'skipped']), isNull(r.started_at)),
                    eq(rec.state, 'recording'),
                ),
                gt(r.end_at, now()),
                narrow(words, [r.name, services.name]),
            ),
        )
        .orderBy(r.start_at)
        .all()
        .filter((row) => hasAll(words, row.name, row.service_name))
        .map((row) => ({ ...row, state: row.state as ReservationState }));
    return cut(rows, limit);
}

/** **ルール**。名前・キーワード・除外キーワードに当てる。新しい順 (ルール画面の一覧と同じ) */
export function searchRules(q: string, limit: number) {
    const words = searchWords(q);
    if (words.length === 0) return cut([], limit);
    const rows = orm()
        .select({
            id: ruleTable.id,
            name: ruleTable.name,
            keyword: ruleTable.keyword,
            ignore_keyword: ruleTable.ignore_keyword,
            enabled: ruleTable.enabled,
            priority: ruleTable.priority,
            reservations: sql<number>`(SELECT COUNT(*) FROM ${reservations}
                 WHERE ${reservations.rule_id} = ${ruleTable.id}
                   AND ${reservations.state} IN ('scheduled', 'conflict')
                   AND ${reservations.started_at} IS NULL)`.mapWith(Number),
        })
        .from(ruleTable)
        .orderBy(desc(ruleTable.id))
        .all()
        .filter((rule) => hasAll(words, rule.name, rule.keyword, rule.ignore_keyword));
    return cut(rows, limit);
}
