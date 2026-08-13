import { error } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { recordingOr404 } from '$lib/server/recording';

/**
 * 字幕の絵 (PGS) を渡す。**ブラウザが自分で解いて重ねる。**
 *
 * 焼いたものに入っている字幕は PGS で、ブラウザに復号器がありません。文字に
 * 直して `<track>` に渡す道も通しましたが、**放送どおりには出ません** —
 * 左右の位置も、背景の箱も、外字も落ちる。ライブ (`/live`) が絵を canvas に
 * 重ねているのと**同じやり方**にするため、絵のまま渡して denpa 自身に解かせます
 * (解くのは `src/lib/pgs.ts` の `readSup`)。
 *
 * ## 入れ物から直に抜く。**隣に置かない**
 *
 * 焼くときに作った `.sup` を動画の隣に残す手もありますが、抜くのが**速い**ので
 * その必要がありませんでした。実測 (動画を丸ごと舐めた上で):
 *
 * | 動画 | かかった時間 | 字幕 |
 * | --- | --- | --- |
 * | 287MB | 144ms | 6.3MB |
 * | 188MB | 502ms | 4.6MB |
 * | 324MB | 986ms | 7.1MB |
 * | 字幕なし | 11ms | (エラーで返る) |
 *
 * 置かないほうが良いことが3つあります。**動画1本につき6MBを積まない**、
 * **焼き直しのたびに揃え直さなくていい**、そして**この仕組みより前に焼いた
 * 録画でもそのまま出る** (入れ物には最初から入っているため)。
 */

/** 待ち時間の上限。壊れたファイルで居座らせない */
const TIMEOUT = 30_000;

export async function GET({ params }) {
    const recording = recordingOr404(params.id);
    if (recording.library_path === null) error(404, '字幕がありません');

    let out: Uint8Array;
    let code = 1;
    try {
        const proc = Bun.spawn(
            [
                config.ffmpeg,
                '-v',
                'error',
                '-i',
                recording.library_path,
                // 字幕1本だけ。**焼き直さない** (入っているものをそのまま出す)
                '-map',
                '0:s:0',
                '-c:s',
                'copy',
                '-f',
                'sup',
                'pipe:1',
            ],
            { stdout: 'pipe', stderr: 'ignore' },
        );
        const timer = setTimeout(() => proc.kill(), TIMEOUT);
        out = new Uint8Array(await new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer());
        code = await proc.exited;
        clearTimeout(timer);
    } catch {
        error(404, '字幕を取り出せませんでした');
    }

    /*
     * **字幕を持たない番組のほうが多い。** そのとき ffmpeg は「その筋は無い」と
     * 言って降りる (実機で exit 234)。画面は字幕のボタンを出さないだけ
     */
    if (code !== 0 || out.length === 0) error(404, '字幕がありません');

    return new Response(out.buffer as ArrayBuffer, {
        headers: {
            'Content-Type': 'application/x-pgs',
            'Content-Length': String(out.length),
            // 同じファイルなら中身は変わらない。焼き直せばパスごと変わる
            'Cache-Control': 'private, max-age=3600',
        },
    });
}
