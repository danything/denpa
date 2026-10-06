import { error, json } from '@sveltejs/kit';
import { recordAiring } from '#lib/server/reservations.js';

/**
 * **いま流れている番組を録る** (画面の外のもの向けの口。docs/api.md)。
 *
 * テレビのアプリの「録画」ボタン。画面のライブの録画ボタン (`live?/record`) と同じ道
 * (`recordAiring`) で、予約は番組ごとに1本なので何度押しても二重には録らない。
 * 番組表にいまの番組が無ければ 404、予約できなければ 400 (どちらも `message` に理由)
 */
export async function POST({ params }) {
    const serviceId = Number(params.serviceId);
    if (!Number.isInteger(serviceId)) error(400, '局IDが不正です');

    const result = await recordAiring(serviceId);
    if (!result.ok) error(result.status, result.message);
    return json({
        recorded: result.name,
        programId: result.programId,
        // 競合で弾かれたときは false (チューナーが足りない)。予約そのものは残る
        reserved: result.state === 'scheduled' || result.state === 'recording',
    });
}
