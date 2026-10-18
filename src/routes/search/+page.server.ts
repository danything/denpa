import { fail } from '@sveltejs/kit';
import { now } from '#lib/server/db.js';
import { watchableServices } from '#lib/server/epg.js';
import { deleteRecordingFiles } from '#lib/server/files.js';
import { recordingFromForm } from '#lib/server/recording.js';
import { cancel, reserve } from '#lib/server/reservations.js';
import { searchPrograms, searchRecordings, searchReservations, searchRules } from '#lib/server/search.js';

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
    const q = (url.searchParams.get('q') ?? '').trim();
    return {
        q,
        programs: searchPrograms(q, LIMIT),
        recordings: searchRecordings(q, LIMIT),
        reservations: searchReservations(q, LIMIT),
        rules: searchRules(q, LIMIT),
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
