import { error, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { orm } from '#lib/server/db.js';
import { relative } from '#lib/server/paths.js';
import { recordings } from '#lib/server/schema.js';
import type { PageServerLoad } from './$types';

/**
 * 追っかけ再生 ([issue #16](https://github.com/danything/denpa/issues/16))。
 * **録画中の録画**を、いま録れているところまで観る画面。
 *
 * 元のTSはブラウザで読めないので (MPEG-2)、観るのはライブと同じプレイヤー —
 * サーバが再エンコードして WebSocket で運ぶ (`server/live.ts` の `openChase`)。
 */
export const load: PageServerLoad = ({ params, url }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id)) error(404, '録画が見つかりません');

    const rec = orm().select().from(recordings).where(eq(recordings.id, id)).get();
    if (rec === undefined) error(404, '録画が見つかりません');
    if (rec.deleted_at !== null) error(410, 'この録画は削除されています');
    /*
     * **追っかけは録っている最中だけ。** 録り終えたら観る画面へ — エンコード済みがあればそれを、まだなら
     * 元の TS をサーバがその場で変換して流す (`server/playback.ts`)。CM飛ばし・チャプターもそちらで揃う
     */
    if (rec.library_path !== null || rec.finished_at !== null)
        redirect(302, relative(url, `/watch/${rec.id}`));
    if (rec.ts_path === null) error(404, 'まだ何も録画されていません');

    return {
        rec: {
            id: rec.id,
            // 右の番組の中身を番組表から引き直すのに使う (観る画面と同じ)
            program_id: rec.program_id,
            name: rec.name,
            service_name: rec.service_name,
            start_at: rec.start_at,
            end_at: rec.end_at,
            // 前に途中まで観ていたら、そこから (観る画面の続き再生と同じ理屈)
            resumeSec: rec.resume_ms === null ? 0 : rec.resume_ms / 1000,
            description: rec.description,
            genre_detail: rec.genre_detail,
            audios: rec.audios,
            extended: rec.extended,
        },
    };
};
