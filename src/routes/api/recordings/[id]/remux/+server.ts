import { error } from '@sveltejs/kit';
import { recordingOr404 } from '#lib/server/recording.js';
import { remuxStream } from '#lib/server/remux.js';

/**
 * **焼いたものを fMP4 に詰め替えて流す** (#503)。そのまま読めないブラウザ (iPhone の Safari で
 * H.264 の録画) の観る画面が MSE に流し込む (`remux-player.ts`)。
 *
 * `?source=` は `encoded` (既定) / `alt`、`?from=<秒>` で頭からの位置 (シークは頼み直す)、
 * `?audio=<n>` で入れ物の中の何本目の音声か。作り方は `server/remux.ts`
 */
export function GET({ params, url }) {
    const recording = recordingOr404(params.id);
    const path = url.searchParams.get('source') === 'alt' ? recording.alt_path : recording.library_path;
    if (path === null) error(404, 'ファイルがありません');
    const from = Number(url.searchParams.get('from') ?? 0);
    const audio = Number(url.searchParams.get('audio') ?? 0);
    return new Response(
        remuxStream(
            path,
            Number.isFinite(from) ? Math.max(0, from) : 0,
            Number.isInteger(audio) && audio >= 0 ? audio : 0,
        ),
        { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } },
    );
}
