import { error } from '@sveltejs/kit';
import { liveCaptions } from '#lib/server/live.js';

/**
 * **変換しないライブの字幕をアプリへ流す** (docs/api.md)。`live?codec=raw` を観ているアプリが、
 * 字幕 (文字の配置) を放送の PTS のまま受け取って映像に重ねる (ブラウザで変換せずに観るときと同じもの。stream.md#放送そのままmpeg-2を送る)。
 *
 * いま変換せずに流しているセッションに脇から乗るだけ (`live.ts` の `liveCaptions`)。
 * 乗る先が無ければ 404 — 映像を開いてからリクエストする
 */
export function GET({ params }) {
    const serviceId = Number(params.serviceId);
    if (!Number.isInteger(serviceId)) error(400, '局IDが不正です');
    const stream = liveCaptions(serviceId);
    if (stream === null) error(404, 'その局はいまライブで流していません');
    return new Response(stream, {
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
    });
}
