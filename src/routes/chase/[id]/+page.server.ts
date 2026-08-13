import { error, redirect } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * 追っかけ再生 ([issue #16](https://github.com/danything/denpa/issues/16))。
 * **録画中の録画**を、いま録れているところまで観る画面。
 *
 * 生TSはブラウザで読めないので (MPEG-2)、観るのはライブと同じ器 —
 * サーバが焼き直して WebSocket で運ぶ (`server/live.ts` の `openChase`)。
 */
export const load: PageServerLoad = ({ params }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id)) error(404, '録画が見つかりません');

    const rec = queryOne<{
        id: number;
        name: string;
        service_name: string;
        start_at: number;
        end_at: number;
        finished_at: number | null;
        library_path: string | null;
        ts_path: string | null;
        resume_ms: number | null;
        deleted_at: number | null;
    }>(
        `SELECT id, name, service_name, start_at, end_at, finished_at,
                library_path, ts_path, resume_ms, deleted_at
         FROM recordings WHERE id = ?`,
        id,
    );
    if (rec === undefined || rec.deleted_at !== null) error(404, '録画が見つかりません');
    // 焼き上がっているなら普通の視聴画面へ。あちらはシークも字幕も揃っている
    if (rec.library_path !== null) redirect(302, `/watch/${rec.id}`);
    if (rec.ts_path === null) error(404, 'まだ何も録れていません');

    return {
        rec: {
            id: rec.id,
            name: rec.name,
            service_name: rec.service_name,
            start_at: rec.start_at,
            end_at: rec.end_at,
            finished: rec.finished_at !== null,
            // 前に途中まで観ていたら、そこから (観る画面の続き再生と同じ理屈)
            resumeSec: rec.resume_ms === null ? 0 : rec.resume_ms / 1000,
        },
    };
};
