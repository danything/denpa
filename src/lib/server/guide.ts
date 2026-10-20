import { and, eq, gt, gte, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { mainOf, splitOf } from '../subchannels';
import type { ChannelType, GridProgram, ReservationState, Service } from '../types';
import { orm } from './db';
import { airing, CURRENT_SERVICES, SERVICE_ORDER } from './epg';
import {
    programs as programTable,
    recordings,
    reservationState,
    reservations,
    services as serviceTable,
} from './schema';

/**
 * 番組表の中身を引くところ。**局の並びと番組を分けて引く。**
 *
 * 局の並び (`stationsOf`) は外枠と一緒に返して、局名の行と時刻の列を先に描く
 * (`guide/+page.server.ts`)。番組 (`programsOf`) は画面が `/api/guide` から後で取る
 */

export const HOUR = 60 * 60 * 1000;
/**
 * 日本の番組表の慣習に合わせ、1日は 4:00 から翌 4:00 まで。
 * 深夜番組が翌日側に送られると探しにくいため。
 */
const DAY_START_HOUR = 4;
export const WINDOW_HOURS = 24;

/** その時刻が属する放送日の 4:00 (ローカル時刻) */
export function broadcastDayStart(at: number): number {
    const d = new Date(at);
    if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
    d.setHours(DAY_START_HOUR, 0, 0, 0);
    return d.getTime();
}

/** 頼まれた時刻 (URL の `start`) の放送日。無い・読めないときは今日 */
export function requestedDay(raw: string | null): number {
    const requested = Number(raw);
    return broadcastDayStart(Number.isFinite(requested) && requested > 0 ? requested : Date.now());
}

/**
 * 表に出す局と、分割放送のあるサブチャンネル。
 *
 * **放送していない局は出さない** (終わったチャンネル)。放送局ごとに決める —
 * どれか1つが放送していれば揃って残し、サブの列を立てるかは画面が決める
 * (分割放送のある日だけ。`#lib/subchannels.ts`)。
 *
 * 決めるには番組の名前と時刻が要るが、引くのはその4列だけ (予約・録画を結ばない)。
 * 番組そのもの (`programsOf`) より軽いので、外枠と一緒に返せる
 */
export function stationsOf(
    type: ChannelType,
    start: number,
    end: number,
): { services: Service[]; split: number[] } {
    // テレビと同じ並びにする (SERVICE_ORDER)。
    // 取り残しの局は出さない (CURRENT_SERVICES)。出すと番組表に空の列が並ぶ
    const services: Service[] = orm()
        .select()
        .from(serviceTable)
        .where(and(eq(serviceTable.type, type), sql.raw(CURRENT_SERVICES)))
        .orderBy(sql.raw(SERVICE_ORDER))
        .all();
    const slots = orm()
        .select({
            service_id: programTable.service_id,
            start_at: programTable.start_at,
            end_at: programTable.end_at,
            name: programTable.name,
        })
        .from(programTable)
        .innerJoin(serviceTable, eq(serviceTable.id, programTable.service_id))
        .where(
            and(eq(serviceTable.type, type), lt(programTable.start_at, end), gt(programTable.end_at, start)),
        )
        .all();
    const main = mainOf(services);
    const alive = new Set(airing(services, slots).map((service) => main.get(service.id)));
    const shown = services.filter((service) => alive.has(main.get(service.id)));
    return { services: shown, split: [...splitOf(slots, main).keys()] };
}

/** 表のマスに置く番組。並びは始まりの時刻順 (画面は朝の側から少しずつ描く) */
export function programsOf(type: ChannelType, start: number, end: number): GridProgram[] {
    const p = alias(programTable, 'p');
    const r = alias(reservations, 'r');
    const rec = alias(recordings, 'rec');
    return (
        orm()
            .select({
                id: p.id,
                service_id: p.service_id,
                start_at: p.start_at,
                end_at: p.end_at,
                name: p.name,
                // マスに 1 行だけ出す。詳細でしか使わない列は GridProgram のとおり持たない
                description: p.description,
                // マスの色はジャンル (大分類) で決める
                genres: p.genres,
                // コピー禁止の番組はマスに小さく添える (録らない。`format.COPY_NEVER_REASON`)
                copy_never: p.copy_never,
                /*
                 * 予約の状態は録画の行から引く (reservationState)。r.state をそのまま
                 * 出していた頃は、録り終えた番組が「予約済み」のまま並び、
                 * 取消ボタンまで出ていた (予約側は録り始めた時刻しか持たないため)
                 */
                reservation_state: sql<ReservationState | null>`CASE WHEN ${r.id} IS NULL THEN NULL ELSE ${reservationState(r, rec)} END`,
                recording_id: rec.id,
                recording_state: rec.state,
                library_path: rec.library_path,
                ts_path: rec.ts_path,
            })
            .from(p)
            .innerJoin(serviceTable, eq(serviceTable.id, p.service_id))
            .leftJoin(r, and(eq(r.program_id, p.id), ne(r.state, 'canceled')))
            // 録り直すと同じ番組に複数ぶら下がる。いちばん新しい現存分だけ見る
            .leftJoin(
                rec,
                eq(
                    rec.id,
                    sql`(SELECT id FROM recordings WHERE program_id = ${p.id} AND deleted_at IS NULL ORDER BY id DESC LIMIT 1)`,
                ),
            )
            .where(and(eq(serviceTable.type, type), lt(p.start_at, end), gt(p.end_at, start)))
            .orderBy(p.start_at)
            .all()
    );
}

/** 日付の並びに出す日数 (今日を含む)。番組表はおよそ1週間先まで届く */
const STRIP_DAYS = 8;
/** 番組表が1週間より先まで届いていても、並べるのはここまで */
const STRIP_MAX_DAYS = 15;
/** 前の日を並べるのはここまで (番組表は録り終えた番組もしばらく残る) */
const STRIP_PAST_DAYS = 7;

/** その放送日から `n` 日ずらした放送日の 4:00。夏時間のある地域でも日で数える */
function shiftDay(start: number, n: number): number {
    const d = new Date(start);
    d.setDate(d.getDate() + n);
    return d.getTime();
}

/** その放送日 (4:00〜翌4:00) に始まる番組があるか。始まりの時刻の索引 (`programs_time`) で範囲を引くだけ */
function hasPrograms(type: ChannelType, start: number): boolean {
    const row = orm()
        .select({ id: programTable.id })
        .from(programTable)
        .innerJoin(serviceTable, eq(serviceTable.id, programTable.service_id))
        .where(
            and(
                eq(serviceTable.type, type),
                gte(programTable.start_at, start),
                lt(programTable.start_at, shiftDay(start, 1)),
            ),
        )
        .limit(1)
        .get();
    return row !== undefined;
}

/**
 * 日付の並び。**番組の無い日も並べて、押せなくする** (並びの幅が日によって変わらない)。
 * 届いている最後の日が1週間より先なら、そこまで伸ばす。
 * **前の日も、番組が残っている日だけ今日の左に並べる** (遡るのは番組の無い日に当たるまで。`STRIP_PAST_DAYS` 日まで)。
 * 「←」1つで前の日へ送るより、どこまで戻れるかが見える
 */
export function daysOf(type: ChannelType, today: number) {
    const days = Array.from({ length: STRIP_DAYS }, (_, i) => {
        const start = shiftDay(today, i);
        return { start, has: hasPrograms(type, start) };
    });
    // 1週間より先にも届いていれば、届いている日まで伸ばす
    while (days.length < STRIP_MAX_DAYS) {
        const start = shiftDay(today, days.length);
        if (!hasPrograms(type, start)) break;
        days.push({ start, has: true });
    }
    for (let back = 1; back <= STRIP_PAST_DAYS; back++) {
        const start = shiftDay(today, -back);
        if (!hasPrograms(type, start)) break;
        days.unshift({ start, has: true });
    }
    return days;
}
