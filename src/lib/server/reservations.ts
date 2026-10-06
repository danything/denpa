import { and, desc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Reservation, ReservationState } from '../types';
import { now, orm } from './db';
import { stopRecording } from './recorder';
import { resolveConflicts } from './scheduler';
import { programs, recordings, reservationState, reservations } from './schema';
import { settings } from './settings';

/** 手動予約。ルール由来の予約が既にあれば手動扱いに昇格させて優先度を上げる */
export async function reserve(programId: number): Promise<Reservation> {
    const program = orm().select().from(programs).where(eq(programs.id, programId)).get();
    if (program === undefined) throw new Error(`番組 ${programId} が見つかりません`);

    const at = now();
    // 終わった番組を予約しても録れない。予約表に並べても取り消す手間が増えるだけ
    if (program.end_at <= at) throw new Error('この番組は放送が終わっています');
    // 手動で入れたものはルール由来 (既定 1) より上。**予約どうしだけの物差し**
    const priority = 2;
    // 録画のしかたは全体で1つ。「焼くか否か」だけ予約時に固定する。
    // 焼き方の細目 (生TSを残すか・CMの扱い・コーデック) は焼くときに settings を見る
    const encode = settings().encode;

    orm()
        .insert(reservations)
        .values({
            program_id: program.id,
            rule_id: null,
            service_id: program.service_id,
            name: program.name,
            description: program.description,
            start_at: program.start_at,
            end_at: program.end_at,
            priority,
            manual: true,
            encode,
            state: 'scheduled',
            created_at: at,
            updated_at: at,
        })
        .onConflictDoUpdate({
            target: reservations.program_id,
            set: {
                manual: true,
                priority: sql`excluded.priority`,
                encode: sql`excluded.encode`,
                state: sql`CASE WHEN ${reservations.state} = 'canceled' THEN 'scheduled' ELSE ${reservations.state} END`,
                // 取り消しを解いたので、印も消す
                canceled_by: null,
                updated_at: sql`excluded.updated_at`,
            },
        })
        .run();

    await resolveConflicts();
    return orm().select().from(reservations).where(eq(reservations.program_id, programId)).get()!;
}

/**
 * 取り消した予約を戻す。
 *
 * ルールが作った予約を手で取り消すと、以後ルールは作り直さない
 * (`INSERT OR IGNORE` と、放送単位で当てる `rules.canceledBroadcasts` が弾く)。
 * 気が変わったときに戻す道がここ。
 */
export async function restore(reservationId: number): Promise<void> {
    const reservation = byId(reservationId);
    if (reservation === undefined) throw new Error('予約が見つかりません');
    if (reservation.state !== 'canceled') throw new Error('取り消した予約ではありません');
    if (reservation.end_at <= now()) throw new Error('この番組は放送が終わっています');

    orm()
        .update(reservations)
        .set({ state: 'scheduled', canceled_by: null, updated_at: now() })
        .where(eq(reservations.id, reservationId))
        .run();
    await resolveConflicts();
}

function byId(reservationId: number): Reservation | undefined {
    return orm().select().from(reservations).where(eq(reservations.id, reservationId)).get();
}

/**
 * 予約の取り消し。録画中なら止めて、そこまでの分は録画済みとして残す
 * (途中まででも見たいことがあるのでファイルは捨てない)。
 */
export async function cancel(reservationId: number): Promise<void> {
    const reservation = byId(reservationId);
    if (reservation === undefined) return;

    // 録っている最中なら止める。掴んでいるかどうかを知っているのは録画の行のほう
    const recording = orm()
        .select({ id: recordings.id })
        .from(recordings)
        .where(and(eq(recordings.reservation_id, reservationId), eq(recordings.state, 'recording')))
        .get();
    if (recording !== undefined) stopRecording(recording.id);

    // 人が押した印。**この放送にはルールが二度と立てない** (rules.ts の canceledBroadcasts)
    orm()
        .update(reservations)
        .set({ state: 'canceled', canceled_by: 'user', updated_at: now() })
        .where(eq(reservations.id, reservationId))
        .run();
    await resolveConflicts();
}

/** {@link recordAiring} の答え。断ったときは HTTP の状態と、そのまま出せる文言を持つ */
export type RecordAiring =
    | { ok: true; programId: number; name: string; state: ReservationState }
    | { ok: false; status: 400 | 404; message: string };

/**
 * **局でいま流れている番組を録る** (ライブの録画ボタンと、アプリの `POST /api/services/<id>/record`)。
 *
 * 番組表からいま流れている番組を引いて、手動予約と同じ道 ({@link reserve}) に乗せる。
 * 既に始まっている番組の予約は次のスケジューラ周期 (数秒) でそのまま録りはじめる。
 * 既に予約済み・録画中なら upsert されるだけで、二重には録らない (予約は program_id で1本)。
 *
 * **画面とアプリで同じものを使う。** 番組の引き方や断り方が口ごとにずれると、
 * 片方でだけ録れない番組が出る
 */
export async function recordAiring(serviceId: number, at = now()): Promise<RecordAiring> {
    const program = orm()
        .select({ id: programs.id, name: programs.name })
        .from(programs)
        .where(and(eq(programs.service_id, serviceId), lte(programs.start_at, at), gt(programs.end_at, at)))
        .orderBy(desc(programs.start_at))
        .limit(1)
        .get();
    if (program === undefined) {
        return { ok: false, status: 404, message: 'いま流れている番組が番組表に見つかりません' };
    }
    try {
        await reserve(program.id);
    } catch (error) {
        return { ok: false, status: 400, message: error instanceof Error ? error.message : String(error) };
    }
    // 競合で弾かれたかは予約のあとでしか分からない。番組表と同じ物差しで読む
    const state = reservationStates([program.id]).get(program.id) ?? 'scheduled';
    return { ok: true, programId: program.id, name: program.name, state };
}

/**
 * **番組ごとの予約の状態** (番組表のマスと同じ物差し `reservationState`)。
 * 取り消したものと、予約の無い番組は入らない。
 *
 * 録画の状態は録画の行から引く — 予約側は録り始めた時刻しか持たないので、
 * `reservations.state` だけでは録画中と録り終えたものの見分けがつかない
 */
export function reservationStates(programIds: number[]): Map<number, ReservationState> {
    if (programIds.length === 0) return new Map();
    const r = alias(reservations, 'r');
    const rec = alias(recordings, 'rec');
    const rows = orm()
        .select({ programId: r.program_id, state: reservationState(r, rec) })
        .from(r)
        // 録り直すと同じ番組に複数ぶら下がる。いちばん新しい現存分だけ見る (番組表と同じ)
        .leftJoin(
            rec,
            eq(
                rec.id,
                sql`(SELECT id FROM recordings WHERE program_id = ${r.program_id} AND deleted_at IS NULL ORDER BY id DESC LIMIT 1)`,
            ),
        )
        .where(and(inArray(r.program_id, programIds), ne(r.state, 'canceled')))
        .all();
    return new Map(rows.map((row) => [row.programId, row.state]));
}
