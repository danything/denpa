import { error } from '@sveltejs/kit';
import { captionForm } from '#lib/server/captions.js';
import { liveCaptions } from '#lib/server/live.js';

/**
 * **生のライブの字幕をアプリへ流す** (docs/api.md)。`live?codec=raw` を観ているアプリが、
 * 字幕を放送の PTS のまま受け取って映像に重ねる (ブラウザの生の道と同じもの。stream.md §5.5)。
 *
 * いま流している生のセッションに脇から乗るだけ (`live.ts` の `liveCaptions`)。
 * 乗る先が無ければ 404 — 映像を開いてから頼む
 */
export function GET({ params, url }) {
    const serviceId = Number(params.serviceId);
    if (!Number.isInteger(serviceId)) error(400, '局IDが不正です');
    const stream = liveCaptions(serviceId, captionForm(url));
    if (stream === null) error(404, 'その局を生で流していません');
    return new Response(stream, {
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
    });
}
