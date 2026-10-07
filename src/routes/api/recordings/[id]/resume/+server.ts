import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { now, orm } from '#lib/server/db.js';
import { emit } from '#lib/server/events.js';
import { recordingOr404 } from '#lib/server/recording.js';
import { recordings } from '#lib/server/schema.js';
import { RESUME_EDGE, resumePoint, watchedToEnd } from '#lib/ts/watch.js';

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
 * 代わりに**観終えた時刻を書く** (`watched_at`)。一覧の「未視聴」の印はこれで外れる
 *
 * ## 知らせは出さない
 *
 * 15秒おきに呼ばれるので、`emit('recordings')` すると一覧が繋いでいる人の
 * 画面がそのたびに書き換わる。観た位置は開いたときに読めば足りる (画面も
 * `GET /api/recordings` の `resumeMs` も)ので、誰にも伝える必要が無い。
 * **観終えた1回だけは出す** — 未視聴の印が外れるのは一覧の見た目が変わること
 */
export async function POST({ params, request }) {
    const recording = recordingOr404(params.id);

    let at: unknown;
    let length: unknown;
    try {
        ({ at, length } = await request.json());
    } catch {
        error(400, 'リクエストの本文を読めませんでした');
    }
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) error(400, '位置が不正です');

    const seconds = typeof length === 'number' && Number.isFinite(length) ? length : 0;
    const keep = resumePoint(at, seconds);
    // 観直して途中で止めても観終えたまま。消すのは「未視聴に戻す」だけ
    const finished = recording.watched_at === null && watchedToEnd(at, seconds);

    orm()
        .update(recordings)
        .set({
            resume_ms: keep === null ? null : Math.round(keep * 1000),
            ...(finished ? { watched_at: now() } : {}),
            updated_at: now(),
        })
        .where(eq(recordings.id, recording.id))
        .run();
    if (finished) emit('recordings');

    return Response.json({ resume: keep, edge: RESUME_EDGE });
}
