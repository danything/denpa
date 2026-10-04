import { publicBase } from '#lib/server/paths.js';
import { xspf } from '#lib/server/playlist.js';
import { recordingOr404 } from '#lib/server/recording.js';
import { shareUrls } from '#lib/server/share.js';
import { markedTitle } from '#lib/server/title.js';
import { parseFileSource } from '#lib/source.js';

/**
 * 録画を**続きの位置から**指す XSPF。続きから始めさせたいプレイヤーに、ファイルの
 * URL の代わりに渡す (共有リンクの `playlist`。経緯は `server/playlist.ts`)。
 *
 * 中の `<location>` は同じ録画のファイルの口で、**資格 (`?token=`) と名指し
 * (`?source=`) はこの URL から写す** — プレイリストを開けた相手はファイルも
 * 開ける。位置は取りに来た瞬間の `resume_ms` (観る画面が 15 秒おきに置いて
 * いくもの)。無ければ頭から。
 *
 * 尻の `[name]` はファイルの口と同じく読み捨てる (見出しの役は `<title>` に
 * 移るので、ここは URL の見た目だけ)。資格は hooks (`isFilePath` + share.ts)
 */
export function GET({ params, url, request }) {
    const recording = recordingOr404(params.id);
    const source = parseFileSource(url.searchParams.get('source'));
    const body = xspf({
        title: markedTitle(recording.name) || String(recording.id),
        location: shareUrls(
            recording,
            publicBase(url, request.headers),
            url.searchParams.get('token'),
            source,
        ).file,
        startSeconds: (recording.resume_ms ?? 0) / 1000,
    });
    return new Response(body, {
        headers: {
            'content-type': 'application/xspf+xml; charset=utf-8',
            // 位置はそのつど違う。テレビにも途中の箱にも持たせない
            'cache-control': 'no-store',
        },
    });
}
