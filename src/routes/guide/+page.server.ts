import { fail } from '@sveltejs/kit';
import { and, eq, gt, gte, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { channelNotice } from '#lib/channel-notice.js';
import { orm } from '#lib/server/db.js';
import {
    airing,
    CURRENT_SERVICES,
    SERVICE_ORDER,
    serviceCounts,
    watchableServices,
} from '#lib/server/epg.js';
import { cancel, reserve } from '#lib/server/reservations.js';
import {
    programs as programTable,
    recordings,
    reservationState,
    reservations,
    services as serviceTable,
} from '#lib/server/schema.js';
import { mainOf, SUBCHANNELS_COOKIE, storedSubchannels } from '#lib/subchannels.js';
import type { ChannelType, Program, Recording, ReservationState, Service } from '#lib/types.js';
import { CHANNEL_TYPES } from '#lib/types.js';

const HOUR = 60 * 60 * 1000;
/**
 * 日本の番組表の慣習に合わせ、1日は 4:00 から翌 4:00 まで。
 * 深夜番組が翌日側に送られると探しにくいため。
 */
const DAY_START_HOUR = 4;
const WINDOW_HOURS = 24;

/** その時刻が属する放送日の 4:00 (ローカル時刻) */
function broadcastDayStart(at: number): number {
    const d = new Date(at);
    if (d.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
    d.setHours(DAY_START_HOUR, 0, 0, 0);
    return d.getTime();
}

/**
 * 表に出す 1 マスぶん。**番組の全列は持たない。**
 *
 * 出演者やあらすじ (`extended`)、音声 (`audios`)、ジャンルの中分類
 * (`genre_detail`) は詳細を開いたときにしか使わないのに、BS の 24 時間ぶん
 * (2,171 件) で応答 1.43 MB のうち 41% を占めていた。しかも前日・翌日の先読み
 * (`preloadData`) が同じ形の応答をもう 2 つ取るので、開くたびに約 10 MB。
 * 詳細は開いた 1 件だけ `/api/programs/<id>` で取る (予約・録画の一覧と同じ経路)
 */
interface GridProgram
    extends Pick<
        Program,
        'id' | 'service_id' | 'start_at' | 'end_at' | 'name' | 'description' | 'genres' | 'copy_never'
    > {
    reservation_state: ReservationState | null;
    /**
     * その番組で録れたもの。番組表から詳細を開いたときに、そのまま再生できるようにする。
     * 録画一覧まで戻って同じ番組を探し直させないため
     */
    recording_id: number | null;
    /** 録画そのものが失敗していれば再生のボタンを出さない (一覧の `hasFile` と同じ) */
    recording_state: Recording['state'] | null;
    /** 配信は library_path ?? ts_path を返すので、どちらかがあれば開ける */
    library_path: string | null;
    ts_path: string | null;
}

/**
 * 表の中身。**外枠より後から流す** (SvelteKit の streaming)。
 *
 * 種別のタブ・日送りは URL だけで描けるのに、いちばん重い表を待って
 * いたせいで**画面ごと出てこなかった**。外枠を先に出して、表のところだけ
 * 読み込み中にしておけば、放送波を選び直すのも日を送るのも待たずにできる。
 *
 * **一度譲ってから引く。** SQLite の読みは同期なので、譲らずに引くと `load` が
 * 返る前に引き終わり、外枠だけ先に出す意味が無くなる (後から流れるのは、`load` が
 * 返った時点でまだ片が付いていない promise だけ)。
 *
 * **転んでも投げ返さない。** 流して返すぶんの拒否は `load` の外で起きるので
 * SvelteKit のエラー画面にはならず、受け損ねると骨組みのまま永久に止まる。
 * そのうえ**誰も受け取らない拒否**になって画面と関係のないところで落ちる —
 * 画面側で受けようにも、拒否は外枠を組むより先に届くことがあり、先読みしたぶん
 * (前日・翌日) に至っては誰も読まない。**理由を中身として返す**ほうが確実で、
 * 本当の理由もサーバのログに残せる (画面へ渡るのは短い一行だけ)
 */
async function gridOf(type: ChannelType, start: number, end: number) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
        return readGrid(type, start, end);
    } catch (error) {
        console.error('[guide] 番組表を組めませんでした', error);
        return { programs: [], services: [], failed: String(error) };
    }
}

function readGrid(type: ChannelType, start: number, end: number) {
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
            id: p.id,
            service_id: p.service_id,
            start_at: p.start_at,
            end_at: p.end_at,
            name: p.name,
            // マスに 1 行だけ出す。詳細でしか使わない列は上の GridProgram のとおり持たない
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
        .all();

    /*
     * 放送していない局は出さない (終わったチャンネル)。**放送局ごとに決める** —
     * どれか1つが放送していれば揃って残し、サブの列を立てるかは画面が決める
     * (分割放送のある日だけ。`#lib/subchannels.ts`)
     */
    const main = mainOf(services);
    const alive = new Set(airing(services, programs).map((service) => main.get(service.id)));
    return {
        programs,
        services: services.filter((service) => alive.has(main.get(service.id))),
        /** 組めなかった理由。組めていれば null */
        failed: null as string | null,
    };
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
function daysOf(type: ChannelType, today: number) {
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

/**
 * 時間×チャンネルのグリッドを返す。並びを眺めて選ぶとき用
 * (言葉で探すのはサイト全体の検索 `/search` に寄せてある)
 */
export function load({ url, cookies }) {
    const type = (CHANNEL_TYPES.find((t) => t === url.searchParams.get('type')) ?? 'GR') as ChannelType;

    // 既定は今日の放送日。めくるときだけ start が付く
    const requested = Number(url.searchParams.get('start'));
    const start = broadcastDayStart(Number.isFinite(requested) && requested > 0 ? requested : Date.now());
    const end = start + WINDOW_HOURS * HOUR;

    /*
     * 局の数 (種別ごと)。選んでいる種別に局が無ければ、表の真ん中にスキャンの案内を出す。
     * そのときは上の案内 (`+layout.svelte`) を出さない — 同じことを2度言わない
     */
    const counts = serviceCounts();
    const typeEmpty = (counts[type] ?? 0) === 0;
    const today = broadcastDayStart(Date.now());

    return {
        // ここまでが外枠。URL と設定だけで決まるので、表を待たずに描ける
        type,
        start,
        hours: WINDOW_HOURS,
        /** 今日の放送日の 4:00。日付の並びの先頭 */
        today,
        /** 日付の並び (`daysOf`)。索引を引くだけなので、表を待たずに描ける */
        days: daysOf(type, today),
        // 詳細の「視聴」を出すかどうか。決め方はライブ画面と揃えてある (watchableServices)
        watchable: watchableServices(Date.now()),
        /** サブチャンネルも出すか (`#lib/subchannels.ts`)。端末ごとに覚える */
        subchannels: storedSubchannels(cookies.get(SUBCHANNELS_COOKIE)),
        /** 表の中身。**promise のまま渡して、後から流す** */
        grid: gridOf(type, start, end),
        typeEmpty,
        channelNotice: typeEmpty ? null : channelNotice(counts),
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
     * 録画のしかた(エンコードするか・元のTSを残すか)はここでは選ばせない。
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
