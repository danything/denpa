import { error, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { orm } from '$lib/server/db';
import { recordings } from '$lib/server/schema';
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

    const rec = orm().select().from(recordings).where(eq(recordings.id, id)).get();
    if (rec === undefined || rec.deleted_at !== null) error(404, '録画が見つかりません');
    // 焼き上がっているなら普通の視聴画面へ。あちらはシークも字幕も揃っている
    if (rec.library_path !== null) redirect(302, `/watch/${rec.id}`);
    if (rec.ts_path === null) error(404, 'まだ何も録れていません');

    return {
        rec: {
            id: rec.id,
            // 右の番組の中身を番組表から引き直すのに使う (観る画面と同じ)
            program_id: rec.program_id,
            name: rec.name,
            service_name: rec.service_name,
            start_at: rec.start_at,
            end_at: rec.end_at,
            finished: rec.finished_at !== null,
            // 前に途中まで観ていたら、そこから (観る画面の続き再生と同じ理屈)
            resumeSec: rec.resume_ms === null ? 0 : rec.resume_ms / 1000,
            description: rec.description,
            genre_detail: rec.genre_detail,
            audios: rec.audios,
        },
    };
};
