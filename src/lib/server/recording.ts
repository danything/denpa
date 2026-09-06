import { error } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import type { Recording } from '../types';
import { orm } from './db';
import { recordings } from './schema';

/**
 * `/api/recordings/<id>` 系の前置き。id を確かめて行を引く。
 * 数字でなければ 400、無ければ 404 をここで投げるので、呼ぶ側は
 * 在る前提で書ける (同じ4行を8本のルートが書いていた)。
 *
 * @param deleted 消した行も引くか。**既定は引かない** — 観る・落とす口が
 *   消したものを返さないように。削除 API だけは「もう消えている」を
 *   見分けたいので true で呼ぶ
 */
/** フォームの `id` から録画を引く (画面のアクション用)。無ければ undefined。消した行も引く */
export function recordingFromForm(form: FormData): Recording | undefined {
    const id = Number(form.get('id'));
    if (!Number.isFinite(id)) return undefined;
    return orm().select().from(recordings).where(eq(recordings.id, id)).get();
}

export function recordingOr404(idLike: string, deleted = false): Recording {
    const id = Number(idLike);
    if (!Number.isFinite(id)) error(400, '録画IDが不正です');
    const recording = orm()
        .select()
        .from(recordings)
        .where(deleted ? eq(recordings.id, id) : and(eq(recordings.id, id), isNull(recordings.deleted_at)))
        .get();
    if (recording === undefined) error(404, '録画が見つかりません');
    return recording;
}
