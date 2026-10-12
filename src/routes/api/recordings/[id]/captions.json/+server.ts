import { error, json } from '@sveltejs/kit';
import { pagesFromMkv } from '#lib/server/captions.js';
import { config } from '#lib/server/config.js';
import { captionArgs } from '#lib/server/playback.js';
import { recordingOr404 } from '#lib/server/recording.js';
import { run } from '#lib/server/stream.js';

/**
 * 録画の字幕を**文字の配置**で渡す (docs/api.md)。観る画面がライブと同じやり方で描く
 * (`components/player/caption-draw.ts`)。
 *
 * 焼いたもの (mkv) に入っている放送の字幕そのもの (`S_ARIBSUB`) を抜いて、サーバで解く。
 * 抜くのは速い (動画を舐めるだけ。実測 0.1〜1秒)。**ずっと前に焼いた録画は絵 (PGS) が
 * 入っている**ことがあり、それは読まずに 404 を返す (字幕なし)。生TSが残っていれば、焼き直すと
 * ARIB の字幕が入る。
 *
 * **まだ焼けていない録画は元の TS から抜く** (`playback.captionArgs`)。時刻は観る画面の物差し
 * (TS の頭を 0) に揃える。TS は丸ごと舐めるので焼いたものより時間がかかる (1 時間の BS で 7GB)
 */

/** 待ち時間の上限。壊れたファイルで居座らせない。元の TS は大きいぶん長く待つ */
const TIMEOUT = 30_000;
const TIMEOUT_TS = 300_000;

/** 溜める量の上限。字幕の筋だけなら1時間で数百KB。壊れたファイルで膨らんでもここで止める */
const LIMIT = 32 * 1024 * 1024;

export async function GET({ params }) {
    const recording = recordingOr404(params.id);
    const args = await captionArgs(recording);
    if (args === null) error(404, '字幕がありません');

    const parts: Uint8Array[] = [];
    let size = 0;
    const { code } = await run([config.ffmpeg, ...args.argv], {
        timeoutMs: args.ts ? TIMEOUT_TS : TIMEOUT,
        onStdout: (chunk) => {
            if (size + chunk.length > LIMIT) return;
            parts.push(chunk);
            size += chunk.length;
        },
    });
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    // 字幕を持たない番組のほうが多い (ffmpeg は「その筋は無い」で降りる)
    if (code !== 0 || out.length === 0) error(404, '字幕がありません');
    const pages = pagesFromMkv(out);
    if (pages === null) error(404, '字幕がありません (画像の字幕 (PGS) には対応していません)');

    return json(pages, {
        // 同じファイルなら中身は変わらない。焼き直せばパスごと変わる。元の TS は焼き上がると物差しが変わる
        headers: { 'Cache-Control': args.ts ? 'no-store' : 'private, max-age=3600' },
    });
}
