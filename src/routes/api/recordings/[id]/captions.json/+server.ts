import { error, json } from '@sveltejs/kit';
import { pagesFromMkv } from '#lib/server/captions.js';
import { config } from '#lib/server/config.js';
import { recordingOr404 } from '#lib/server/recording.js';
import { run } from '#lib/server/stream.js';

/**
 * 録画の字幕を**文字の配置**で渡す (docs/api.md)。観る画面がライブと同じやり方で描く
 * (`components/player/caption-draw.ts`)。
 *
 * 焼いたもの (mkv) に入っている放送の字幕そのもの (`S_ARIBSUB`) を抜いて、サーバで解く。
 * 抜くのは `captions.sup` と同じく速い (動画を舐めるだけ)。**前に焼いた録画は絵 (PGS) が
 * 入っている**ので 404 を返し、画面はそちらの口 (`captions.sup`) へ回る。
 */

/** 待ち時間の上限。壊れたファイルで居座らせない */
const TIMEOUT = 30_000;

/** 溜める量の上限。字幕の筋だけなら1時間で数百KB。壊れたファイルで膨らんでもここで止める */
const LIMIT = 32 * 1024 * 1024;

export async function GET({ params }) {
    const recording = recordingOr404(params.id);
    if (recording.library_path === null) error(404, '字幕がありません');

    const parts: Uint8Array[] = [];
    let size = 0;
    const { code } = await run(
        [
            config.ffmpeg,
            '-v',
            'error',
            '-i',
            recording.library_path,
            // 字幕1本だけ。**解かずに写す** (解くのは denpa)
            '-map',
            '0:s:0',
            '-c:s',
            'copy',
            '-f',
            'matroska',
            'pipe:1',
        ],
        {
            timeoutMs: TIMEOUT,
            onStdout: (chunk) => {
                if (size + chunk.length > LIMIT) return;
                parts.push(chunk);
                size += chunk.length;
            },
        },
    );
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    // 字幕を持たない番組のほうが多い (ffmpeg は「その筋は無い」で降りる)
    if (code !== 0 || out.length === 0) error(404, '字幕がありません');
    const pages = pagesFromMkv(out);
    if (pages === null) error(404, '文字の字幕がありません (絵の字幕は captions.sup)');

    return json(pages, {
        // 同じファイルなら中身は変わらない。焼き直せばパスごと変わる
        headers: { 'Cache-Control': 'private, max-age=3600' },
    });
}
