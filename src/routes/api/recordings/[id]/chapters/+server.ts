import { error } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { queryOne } from '$lib/server/db';
import { parseChapters } from '$lib/ts/watch';
import type { Recording } from '$lib/types';

/**
 * 焼いたものに入っているチャプターを返す。**CM飛ばしの行き先。**
 *
 * ## DB ではなくファイルから読む
 *
 * `recordings.cm_ranges` にも検出した位置は残っているが、**焼き上がりと
 * 食い違うことがある**:
 *
 * - CMを**切って**焼いたものは、切ったぶんだけ後ろが前に詰まっている
 * - 引き継いだ録画 (EPGStation) は denpa が検出していないので `cm_ranges` が空。
 *   それでもチャプターは入っている
 *
 * **入っているものを読めば、どれも同じ扱いで済む。**
 *
 * ## 待たせない
 *
 * `-show_chapters` は見出しだけを読むので、中身を舐めない。実機の30分ものでも
 * 一瞬で返る。**開くたびに呼ぶ**ので、録画ごとに控えを持つほどではない
 * (ファイルが焼き直されたら中身も変わる)。
 */

/** 待ち時間の上限。壊れたファイルで居座らせない */
const TIMEOUT = 15_000;

export async function GET({ params }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(400, '録画IDが不正です');

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL', id);
    if (recording === undefined) error(404, '録画が見つかりません');
    /*
     * **観るのは焼いたものだけ。** 生TSにチャプターは入らない (入れ物が持てない)
     * ので、まだ焼けていない録画では空を返す — 画面はチャプター送りを出さない
     */
    if (recording.library_path === null) return Response.json({ chapters: [] });

    /*
     * **読めなくても空を返す。** ffprobe が居ない・ファイルが壊れている・
     * そもそもチャプターが無い、のどれでも画面のすることは同じ (送りを出さない)。
     * ここで転ぶと、**観られるはずの録画が観られなくなる**
     */
    let out = '';
    try {
        const proc = Bun.spawn(
            [
                config.ffprobe,
                '-v',
                'error',
                '-show_chapters',
                '-print_format',
                'json',
                recording.library_path,
            ],
            { stdout: 'pipe', stderr: 'ignore' },
        );
        const timer = setTimeout(() => proc.kill(), TIMEOUT);
        out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
        await proc.exited;
        clearTimeout(timer);
    } catch {
        out = '';
    }

    return Response.json(
        { chapters: parseChapters(out) },
        // 同じファイルなら中身は変わらない。焼き直せばパスごと変わる
        { headers: { 'Cache-Control': 'private, max-age=3600' } },
    );
}
