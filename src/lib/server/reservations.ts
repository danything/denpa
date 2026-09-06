import { and, eq, sql } from 'drizzle-orm';
import type { Reservation } from '../types';
import { now, orm } from './db';
import { stopRecording } from './recorder';
import { resolveConflicts } from './scheduler';
import { programs, recordings, reservations } from './schema';
import { settings } from './settings';

/** 手動予約。ルール由来の予約が既にあれば手動扱いに昇格させて優先度を上げる */
export async function reserve(
    programId: number,
    options: {
        priority?: number;
        encode?: boolean;
    } = {},
): Promise<Reservation> {
    const program = orm().select().from(programs).where(eq(programs.id, programId)).get();
    if (program === undefined) throw new Error(`番組 ${programId} が見つかりません`);

    const at = now();
    // 終わった番組を予約しても録れない。予約表に並べても取り消す手間が増えるだけ
    if (program.end_at <= at) throw new Error('この番組は放送が終わっています');
    // 手動で入れたものはルール由来 (既定 1) より上。**予約どうしだけの物差し**
    const priority = options.priority ?? 2;
    // 録画のしかたは全体で1つ。「焼くか否か」だけ予約時に固定する (指定が無ければ設定の値)。
    // 焼き方の細目 (生TSを残すか・CMの扱い・コーデック) は焼くときに settings を見る
    const encode = (options.encode ?? settings().encode) ? 1 : 0;

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
            manual: 1,
            encode,
            state: 'scheduled',
            created_at: at,
            updated_at: at,
        })
        .onConflictDoUpdate({
            target: reservations.program_id,
            set: {
                manual: 1,
                priority: sql`excluded.priority`,
                encode: sql`excluded.encode`,
                state: sql`CASE WHEN ${reservations.state} = 'canceled' THEN 'scheduled' ELSE ${reservations.state} END`,
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
 * (`INSERT OR IGNORE` が同じ番組を弾く)。気が変わったときに戻す道がここ。
 */
export async function restore(reservationId: number): Promise<void> {
    const reservation = byId(reservationId);
    if (reservation === undefined) throw new Error('予約が見つかりません');
    if (reservation.state !== 'canceled') throw new Error('取り消した予約ではありません');
    if (reservation.end_at <= now()) throw new Error('この番組は放送が終わっています');

    orm()
        .update(reservations)
        .set({ state: 'scheduled', updated_at: now() })
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

    orm()
        .update(reservations)
        .set({ state: 'canceled', updated_at: now() })
        .where(eq(reservations.id, reservationId))
        .run();
    await resolveConflicts();
}
