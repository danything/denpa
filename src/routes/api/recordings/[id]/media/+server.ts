import { recordingOr404 } from '#lib/server/recording.js';
import { probeMedia } from '#lib/server/remux.js';

/**
 * 焼いたファイルの中身 (映像・音声の codecs、音声トラックの名前、尺)。**観る画面が、そのまま
 * 渡すか詰め替えるかを決めるのに使う** (`ts/remux.ts` の `pickPlayback`)。
 *
 * 主 (`encoded`) と、両方焼いた録画ではもう一方 (`alt`) も。読めなかったものは codecs が null
 */
export async function GET({ params }) {
    const recording = recordingOr404(params.id);
    const files = await Promise.all([
        ...(recording.library_path === null ? [] : [probeMedia('encoded', recording.library_path)]),
        ...(recording.alt_path === null ? [] : [probeMedia('alt', recording.alt_path)]),
    ]);
    return Response.json({ files }, { headers: { 'Cache-Control': 'no-store' } });
}
