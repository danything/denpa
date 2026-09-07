import { and, eq, getTableColumns, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Reservation } from '../types';
import { config } from './config';
import { assign, whole } from './conflict';
import { affected, now, orm } from './db';
import { emit } from './events';
import {
    activeRecordingIds,
    failStrayRecordings,
    recordingUntil,
    startRecording,
    stopRecording,
} from './recorder';
import { recordings, reservations, services } from './schema';
import { isDraining } from './shutdown';
import { type AgentTuner, getTuners } from './tuner';

interface Candidate extends Reservation {
    type: string;
    channel: string;
}

/**
 * チャンネル種別ごとのチューナー本数。エージェントに繋がらないときは
 * 「制限なし」を返し、予約を勝手に conflict にしない(実際に録画が始まるときに
 * あちらが弾くので、予約表を壊すより実行時に失敗させるほうが害が小さい)。
 */
export async function tunerCapacity(): Promise<Map<string, number>> {
    const capacity = new Map<string, number>();
    let tuners: AgentTuner[];
    try {
        tuners = await getTuners();
    } catch {
        return capacity;
    }
    for (const tuner of tuners) {
        if (tuner.disabled) continue;
        for (const type of tuner.types) {
            capacity.set(type, (capacity.get(type) ?? 0) + 1);
        }
    }
    return capacity;
}

export async function resolveConflicts(): Promise<{ accepted: number; rejected: number }> {
    const capacity = await tunerCapacity();
    const candidates: Candidate[] = orm()
        .select({ ...getTableColumns(reservations), type: services.type, channel: services.channel })
        .from(reservations)
        .innerJoin(services, eq(services.id, reservations.service_id))
        .where(
            and(
                inArray(reservations.state, ['scheduled', 'conflict']),
                // 録り始めたものは数え直さない。掴む本数はもう決まっている
                isNull(reservations.started_at),
                gt(reservations.end_at, now()),
            ),
        )
        .orderBy(reservations.start_at)
        .all();

    // 前後のマージンぶんチューナーを掴む時間は延びる。予約表と実行時のズレを無くすため
    // 同じ物差しで数える
    const { accepted, rejected } = assign(candidates, capacity, {
        start: config.startMargin,
        end: config.endMargin,
    });

    const at = now();
    orm().transaction((tx) => {
        for (const a of accepted) {
            tx.update(reservations)
                .set({ state: 'scheduled', conflict_reason: null, updated_at: at })
                .where(and(eq(reservations.id, a.reservation.id), eq(reservations.state, 'conflict')))
                .run();
            /*
             * **譲ったぶんを覚える。** 丸ごと入ったものは NULL に戻す —
             * 前の回で削られていても、相手が消えれば丸ごと録れるようになる
             */
            const from = whole(a) ? null : a.from;
            const to = whole(a) ? null : a.to;
            tx.update(reservations)
                .set({ record_from: from, record_to: to, updated_at: at })
                .where(
                    and(
                        eq(reservations.id, a.reservation.id),
                        or(
                            sql`${reservations.record_from} IS NOT ${from}`,
                            sql`${reservations.record_to} IS NOT ${to}`,
                        ),
                    ),
                )
                .run();
        }
        for (const r of rejected) {
            tx.update(reservations)
                .set({ state: 'conflict', conflict_reason: r.reason, updated_at: at })
                .where(and(eq(reservations.id, r.reservation.id), eq(reservations.state, 'scheduled')))
                .run();
        }
    });
    emit('reservations');

    return { accepted: accepted.length, rejected: rejected.length };
}

/**
 * 1秒ごとに呼ばれる本体。開始時刻に達した予約を録画に移し、終了時刻を過ぎた録画を止める。
 * 状態遷移は全てここに集約し、recorder.ts はストリームの読み書きだけに専念させる。
 */
export async function tick(): Promise<void> {
    const at = now();

    // 止めるほうを先にやる。次の番組が始まるときに前の録画がまだチューナーを
    // 掴んでいると、本数が足りない環境で後続が丸ごと録れない
    for (const id of activeRecordingIds()) {
        const rec = orm()
            .select({ end_at: recordings.end_at, record_to: recordings.record_to })
            .from(recordings)
            .where(eq(recordings.id, id))
            .get();
        if (rec === undefined) continue;
        // 尻を譲っているならそこで離す (`record_to`)。次の録画がそこから掴む
        if (at >= recordingUntil(rec)) stopRecording(id);
    }

    /*
     * **持ち主の居ない「録画中」を畳む** (`failStrayRecordings`)。畳む間もなく殺されると
     * (k3s ごと落ちた等) DB の行だけが録画中で残り、予約の一覧に居座って録画の一覧には
     * 出てこない。起動時の拾い直しでは、そのとき放送中だったものを録り直しに行った先で
     * また殺されると畳めないので、見回りでも同じ片付けをする
     */
    if (failStrayRecordings(at) > 0) {
        emit('recordings');
        emit('reservations');
    }

    // 始まらないまま終わってしまった予約を片付ける。
    // アプリが止まっていた間に放送が終わったものがここに残り続けていた
    const expired = affected(
        orm()
            .update(reservations)
            .set({ state: 'missed', updated_at: at })
            .where(
                and(
                    inArray(reservations.state, ['scheduled', 'conflict']),
                    isNull(reservations.started_at),
                    lte(reservations.end_at, at),
                ),
            ),
    );
    if (expired > 0) emit('reservations');

    /*
     * **止められている最中でも始める。**
     *
     * 始めないでいた頃は、**居座っている間に始まる録画の頭が丸ごと落ちて**
     * いた。居座りは「いま走っている録画が終わるまで」続くので、落ちる幅は
     * 最長で番組1本ぶん — 実機では 00:00 の番組が 29秒、19:54 の番組が
     * **9分42秒**欠けた (どちらも、その時刻にちょうど入れ替えが降りていた)。
     *
     * 始めれば居座りはそのぶん伸びるが、**Pod はどのみち残っている**ので
     * 新しく待たせるものは無い。伸びすぎない歯止めは既にある —
     * `SHUTDOWN_WAIT` (6時間) を過ぎれば `runtime.ts` が降ろす。そこで
     * 切れた録画は追記で開いてあるので、次の Pod が続きから録る
     */
    /*
     * **譲ったぶんがあれば、そちらを見る** (`record_from`)。チューナーの取り合いで
     * 頭を譲った予約は、番組の始まりに起こしても掴めない — 相手がまだ掴んでいる
     */
    const due = orm()
        .select()
        .from(reservations)
        .where(
            and(
                eq(reservations.state, 'scheduled'),
                isNull(reservations.started_at),
                lte(
                    sql`COALESCE(${reservations.record_from}, ${reservations.start_at} - ${config.startMargin})`,
                    at,
                ),
                gt(sql`COALESCE(${reservations.record_to}, ${reservations.end_at})`, at),
            ),
        )
        .all();
    // 5秒ごとに言わない。**始めるものがあるときだけ**
    if (due.length > 0 && isDraining()) {
        console.log(`[録画] 止まる途中ですが ${due.length} 件始めます (頭を落とさないため)`);
    }

    for (const reservation of due) {
        /*
         * 録り始めた時刻を先に立ててから開始する。tick が重なっても二重に開始しない。
         * 状態の文字列を 'recording' に進めていた頃と同じ鍵の掛け方だが、
         * こちらは録画の行と食い違いようがない (録り始めたかどうかは事実ひとつ)
         */
        const claimed = orm()
            .update(reservations)
            .set({ started_at: at, updated_at: at })
            .where(
                and(
                    eq(reservations.id, reservation.id),
                    isNull(reservations.started_at),
                    eq(reservations.state, 'scheduled'),
                ),
            )
            .returning({ id: reservations.id })
            .get();
        if (claimed === undefined) continue;
        await startRecording(reservation);
    }
}
