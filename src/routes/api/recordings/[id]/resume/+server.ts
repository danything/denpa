import { error } from '@sveltejs/kit';
import { database, now, queryOne } from '$lib/server/db';
import { RESUME_EDGE, resumePoint } from '$lib/ts/watch';
import type { Recording } from '$lib/types';

/**
 * どこまで観たかを覚える。**続きから観るためだけの目印。**
 *
 * 端末ではなく DB に置きます。居間のタブレットで観たものを机の PC で
 * 続けられるのが狙いで、`localStorage` に持たせるとそれができない。
 *
 * ## 観終えたら消す
 *
 * 末尾まで来たものに目印を残すと、**次に開いたときエンドロールから始まる**。
 * 端に来たぶんは消して、頭から出し直す (境目は `ts/watch.ts`)。
 *
 * ## 知らせは出さない
 *
 * 数十秒おきに呼ばれるので、`emit('recordings')` すると一覧が繋いでいる人の
 * 画面がそのたびに書き換わる。**観た位置は一覧に出していない**ので、
 * 誰にも伝える必要が無い
 */
export async function POST({ params, request }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(400, '録画IDが不正です');

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL', id);
    if (recording === undefined) error(404, '録画が見つかりません');

    let at: unknown;
    let length: unknown;
    try {
        ({ at, length } = await request.json());
    } catch {
        error(400, '本文を読めませんでした');
    }
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) error(400, '位置が不正です');

    const seconds = typeof length === 'number' && Number.isFinite(length) ? length : 0;
    const keep = resumePoint(at, seconds);

    database()
        .prepare('UPDATE recordings SET resume_ms = ?, updated_at = ? WHERE id = ?')
        .run(keep === null ? null : Math.round(keep * 1000), now(), id);

    return Response.json({ resume: keep, edge: RESUME_EDGE });
}
