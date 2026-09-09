import { fail } from '@sveltejs/kit';
import { and, eq, getTableColumns, gt, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { orm } from '$lib/server/db';
import { airing, CURRENT_SERVICES, SERVICE_ORDER, watchableServices } from '$lib/server/epg';
import { cancel, reserve } from '$lib/server/reservations';
import {
    programs as programTable,
    recordings,
    reservationState,
    reservations,
    services as serviceTable,
} from '$lib/server/schema';
import type { ChannelType, Program, ReservationState, Service } from '$lib/types';

const HOUR = 60 * 60 * 1000;
/**
 * 日本の番組表の慣習に合わせ、1日は 4:00 から翌 4:00 まで。
 * 深夜番組が翌日側に送られると探しにくいため。
 */
const DAY_START_HOUR = 4;
const WINDOW_HOURS = 24;
const TYPES: ChannelType[] = ['GR', 'BS', 'CS'];

/** その時刻が属する放送日の 4:00 (ローカル時刻) */
function broadcastDayStart(at: number): number {
    const d = new Date(at);
    if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
    d.setHours(DAY_START_HOUR, 0, 0, 0);
    return d.getTime();
}

interface GridProgram extends Program {
    reservation_state: ReservationState | null;
    /**
     * その番組で録れたもの。番組表から詳細を開いたときに、そのまま再生できるようにする。
     * 録画一覧まで戻って同じ番組を探し直させないため
     */
    recording_id: number | null;
    /** 配信は library_path ?? ts_path を返すので、どちらかがあれば開ける */
    library_path: string | null;
    ts_path: string | null;
}

/**
 * 番組表は2つの見せ方をする。
 * キーワードなし: 時間×チャンネルのグリッド。並びを眺めて選ぶとき用
 * キーワードあり: 全チャンネル横断のリスト。探しているものが決まっているとき用
 */
export async function load({ url }) {
    const type = (TYPES.find((t) => t === url.searchParams.get('type')) ?? 'GR') as ChannelType;

    // 既定は今日の放送日。めくるときだけ start が付く
    const requested = Number(url.searchParams.get('start'));
    const start = broadcastDayStart(Number.isFinite(requested) && requested > 0 ? requested : Date.now());
    const end = start + WINDOW_HOURS * HOUR;

    // テレビと同じ並びにする (SERVICE_ORDER)。
    // 取り残しの局は出さない (CURRENT_SERVICES)。出すと番組表に空の列が並ぶ
    const services: Service[] = orm()
        .select()
        .from(serviceTable)
        .where(and(eq(serviceTable.type, type), sql.raw(CURRENT_SERVICES)))
        .orderBy(sql.raw(SERVICE_ORDER))
        .all();
    const p = alias(programTable, 'p');
    const r = alias(reservations, 'r');
    const rec = alias(recordings, 'rec');
    const programs: GridProgram[] = orm()
        .select({
            ...getTableColumns(p),
            /*
             * 予約の状態は録画の行から引く (reservationState)。r.state をそのまま
             * 出していた頃は、録り終えた番組が「予約済み」のまま並び、
             * 取消ボタンまで出ていた (予約側は録り始めた時刻しか持たないため)
             */
            reservation_state: sql<ReservationState | null>`CASE WHEN ${r.id} IS NULL THEN NULL ELSE ${reservationState(r, rec)} END`,
            recording_id: rec.id,
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
        .all();

    // 詳細の「視聴」を出すかどうか。決め方はライブ画面と揃えてある (watchableServices)
    const watchable = watchableServices(Date.now());

    return {
        type,
        start,
        hours: WINDOW_HOURS,
        programs,
        watchable,
        // 放送していない局は出さない (終わったチャンネル・相乗り中のサブチャンネル)
        services: airing(services, programs),
    };
}

export const actions = {
    /** 番組表から予約を止める。予約一覧まで行かずに済むように */
    cancel: async ({ request }) => {
        const form = await request.formData();
        const programId = Number(form.get('programId'));
        if (!Number.isFinite(programId)) return fail(400, { message: '番組IDが不正です' });
        const reservation = orm()
            .select({ id: reservations.id })
            .from(reservations)
            .where(and(eq(reservations.program_id, programId), ne(reservations.state, 'canceled')))
            .get();
        if (reservation === undefined) return fail(404, { message: '予約が見つかりません' });
        await cancel(reservation.id);
        return { success: true };
    },

    /**
     * 番組表から予約する。
     *
     * 録画のしかた(エンコードするか・生TSを残すか)はここでは選ばせない。
     * 設定画面の1箇所で決める (docs/app.md)。番組ごとに変えたくなることが
     * 実際にはほとんど無いのに、同じ選択肢が予約・ルール・設定の3箇所にあると
     * 「どれで決まったのか」が分からなくなる
     */
    reserve: async ({ request }) => {
        const form = await request.formData();
        const programId = Number(form.get('programId'));
        if (!Number.isFinite(programId)) return fail(400, { message: '番組IDが不正です' });
        try {
            await reserve(programId);
        } catch (error) {
            return fail(400, { message: String(error) });
        }
        return { success: true };
    },
};
