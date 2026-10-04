import { error } from '@sveltejs/kit';
import { recordingCaptions } from '#lib/server/live.js';

/**
 * **録画の字幕をアプリへ流す** (docs/api.md)。生TS (`chase?codec=raw` と `file?source=ts`) を
 * 観ているアプリが、字幕の絵を放送の PTS のまま受け取って映像に重ねる。`?from=<秒>` は映像を
 * 頼んだ位置と同じもの (シークしたら頼み直す)。読み方は `live.ts` の `recordingCaptions`
 */
export function GET({ params, url }) {
    const id = Number(params.id);
    if (!Number.isInteger(id)) error(400, '録画IDが不正です');
    const from = Number(url.searchParams.get('from') ?? 0);
    const stream = recordingCaptions(id, Number.isFinite(from) ? Math.max(0, from) : 0);
    if (stream === null) error(404, '録画がないか、生TSがありません');
    return new Response(stream, {
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
    });
}
