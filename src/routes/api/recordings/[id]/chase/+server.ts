import { error } from '@sveltejs/kit';
import { chaseStream } from '#lib/server/live.js';

/**
 * **追っかけ再生を HTTP で流す** (画面の外のもの向けの口。docs/api.md)。テレビのアプリが、
 * 録画中 (と焼き上がる前) の録画を観るのに使う。
 *
 * `?codec=` は `h264` (既定) / `av1` / `raw`。`h264` と `av1` は画面の追っかけと同じ焼き直しの
 * fMP4、`raw` は焼かずに生TS (MPEG-2) をそのまま。`?from=<秒>` で頭からの位置を選ぶ
 * (シークは頼み直す)。伸びているファイルを追い読みし、録り終えて尻まで読んだら閉じる
 * (`live.ts` の `chaseStream`)
 */
export function GET({ params, url }) {
    const id = Number(params.id);
    if (!Number.isInteger(id)) error(400, '録画IDが不正です');
    const asked = url.searchParams.get('codec');
    const codec = asked === 'av1' || asked === 'raw' ? asked : 'h264';
    const from = Number(url.searchParams.get('from') ?? 0);
    const stream = chaseStream(id, codec, Number.isFinite(from) ? Math.max(0, from) : 0);
    if (stream === null) error(404, '録画がないか、まだ何も録れていません');
    return new Response(stream, {
        headers: {
            'Content-Type': codec === 'raw' ? 'video/mp2t' : 'video/mp4',
            'Cache-Control': 'no-store',
        },
    });
}
