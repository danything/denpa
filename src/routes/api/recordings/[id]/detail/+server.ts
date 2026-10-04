import { json } from '@sveltejs/kit';
import { recordingOr404 } from '#lib/server/recording.js';
import { displayTitle } from '#lib/server/title.js';

/**
 * **番組の中身** (テレビのアプリの詳細で出す。docs/api.md)。
 *
 * 状態の口 (`GET /api/recordings/<id>`) とは分ける。あちらは追っかけ再生の画面が
 * 知らせのたびに読みに来るので、長い詳細 (出演者など) を混ぜると毎回重くなる。
 * 一覧 (`GET /api/recordings`) に入れないのも同じ理由。
 *
 * 説明は録り始めに `recordings` へ写してあるので、番組表から消えた録画でも出る
 */
export function GET({ params }) {
    const recording = recordingOr404(params.id);
    return json({
        id: recording.id,
        title: displayTitle(recording.name),
        name: recording.name,
        description: recording.description,
        extended: recording.extended ?? {},
    });
}
