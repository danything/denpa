import { xspf } from '$lib/server/playlist';
import { recordingOr404 } from '$lib/server/recording';
import { shareUrls } from '$lib/server/share';
import { displayTitle } from '$lib/server/title';
import { parseFileSource } from '$lib/source';

/**
 * 録画を**続きの位置から**指す XSPF。テレビの VLC へ飛ばすときに、ファイルの
 * URL の代わりに渡す (`+page.svelte` の `playOnTv`。経緯は `server/playlist.ts`)。
 *
 * 中の `<location>` は同じ録画のファイルの口で、**資格 (`?token=`) と名指し
 * (`?source=`) はこの URL から写す** — プレイリストを開けた相手はファイルも
 * 開ける。位置は取りに来た瞬間の `resume_ms` (観る画面が 15 秒おきに置いて
 * いくもの)。無ければ頭から。
 *
 * 尻の `[name]` はファイルの口と同じく読み捨てる (見出しの役は `<title>` に
 * 移るので、ここは URL の見た目だけ)。資格は hooks (`isFilePath` + share.ts)
 */
export function GET({ params, url }) {
    const recording = recordingOr404(params.id);
    const source = parseFileSource(url.searchParams.get('source'));
    /*
     * 中のファイルの URL も**取りに来るたびに別物**にする。VLC は 1 曲ごとの URL で
     * 再生位置を覚えるので、同じなら `start-time` より自分の覚えが勝って末尾から
     * 始まりかねない (`+page.svelte` の `freshForVlc` と同じ理由)
     */
    const location = new URL(shareUrls(recording, url.origin, url.searchParams.get('token'), source).file);
    location.searchParams.set('play', String(Date.now()));
    const body = xspf({
        title: displayTitle(recording.name) || String(recording.id),
        location: location.toString(),
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
