import { error, json } from '@sveltejs/kit';
import { queryOne } from '$lib/server/db';
import { sidecarPaths } from '$lib/server/metadata';
import { loadRecordedBml } from '$lib/server/recorded-bml';
import type { Recording } from '$lib/types';

/**
 * 録画のデータ放送 (再生位置つきの変化ログ)。**d ボタンで開いたときに読む。**
 *
 * 焼くときに元TSから取り出してサイドカーへ置いてある (`server/recorded-bml.ts`)。
 * ここは録画IDから場所を引いて、そのまま JSON で配るだけ。持っていない録画
 * (データ放送の無い局・古い録画) は空を返す — 画面はそれで「出せない」を出す。
 */
export function GET({ params }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) error(400, '録画IDが不正です');

    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ? AND deleted_at IS NULL', id);
    if (recording === undefined) error(404, '録画が見つかりません');
    // サイドカーは主 (library_path) の隣。焼き上がっていなければ持っていない
    if (recording.library_path === null) return json([]);

    return json(loadRecordedBml(sidecarPaths(recording.library_path).dataBroadcast));
}
