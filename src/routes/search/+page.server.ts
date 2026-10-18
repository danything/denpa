import { fail } from '@sveltejs/kit';
import { and, eq, inArray } from 'drizzle-orm';
import { now, orm } from '#lib/server/db.js';
import { watchableServices } from '#lib/server/epg.js';
import { deleteRecordingFiles } from '#lib/server/files.js';
import { recordingFromForm } from '#lib/server/recording.js';
import { cancel, reserve } from '#lib/server/reservations.js';
import { programs, reservations, services } from '#lib/server/schema.js';
import {
    searchPrograms,
    searchQuery,
    searchRecordings,
    searchReservations,
    searchRules,
} from '#lib/server/search.js';

/**
 * `?program=<番組ID>` で開く番組。ヘッダーの候補 (`SearchField`) から番組や予約を選ぶと、
 * 結果の画面を開いてその番組の詳細を出す (番組表には番組を名指しで開く URL が無いため)
 */
function focusOf(url: URL) {
    const id = Number(url.searchParams.get('program'));
    if (!url.searchParams.has('program') || !Number.isInteger(id)) return null;
    return (
        orm()
            .select({
                id: programs.id,
                name: programs.name,
                description: programs.description,
                service_id: programs.service_id,
                service_name: services.name,
                start_at: programs.start_at,
                end_at: programs.end_at,
                copy_never: programs.copy_never,
                reservation_id: reservations.id,
            })
            .from(programs)
            .innerJoin(services, eq(services.id, programs.service_id))
            .leftJoin(
                reservations,
                and(
                    eq(reservations.program_id, programs.id),
                    inArray(reservations.state, ['scheduled', 'conflict', 'skipped']),
                ),
            )
            .where(eq(programs.id, id))
            .get() ?? null
    );
}

/**
 * 1つの節に渡す上限。画面は先頭の数件だけ出し、「もっと見る」でここまで広げる。
 * これより多いときは件数だけ本当の数を出し、言葉を足してもらう
 */
const LIMIT = 100;

/**
 * **検索の結果** (`/search?q=`)。GET なので URL をそのまま人に渡せる。
 * 番組表・録画・予約・ルールを1度に引き、節ごとに件数と先頭を返す (`#lib/server/search.ts`)
 */
export function load({ url }) {
    const q = searchQuery(url.searchParams.get('q'));
    const options = { limit: LIMIT, count: true };
    return {
        q,
        programs: searchPrograms(q, options),
        recordings: searchRecordings(q, options),
        reservations: searchReservations(q, options),
        rules: searchRules(q, options),
        /** 詳細を開いておく番組 (`?program=`)。無ければ null */
        focus: focusOf(url),
        limit: LIMIT,
        // 詳細の「視聴」を出すかどうか。決め方は番組表と揃えてある (watchableServices)
        watchable: watchableServices(now()),
    };
}

export const actions = {
    /** 番組を予約する。録画のしかたは設定画面の1箇所で決める (番組表の予約と同じ) */
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

    /** 予約を取り消す。ルールが立てた予約でも作り直されない (戻すのはホームの「戻す」) */
    cancel: async ({ request }) => {
        const form = await request.formData();
        const id = Number(form.get('reservationId'));
        if (!Number.isFinite(id)) return fail(400, { message: '予約IDが不正です' });
        await cancel(id);
        return { success: true };
    },

    /** 録画を消す (ホームの行の削除と同じ) */
    delete: async ({ request }) => {
        const recording = recordingFromForm(await request.formData());
        if (recording === undefined) return fail(400, { message: '録画が見つかりません' });
        deleteRecordingFiles(recording, '手動削除');
        return { success: true };
    },
};
