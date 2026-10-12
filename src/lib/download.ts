/**
 * 録画を**落とす**ときの入口。
 *
 * ファイルのエンドポイント (`api/recordings/<id>/file`) へ遷移して落とす。遷移先は添付
 * (`Content-Disposition`、`?download=1`) なので画面は動かない。資格は画面と同じ
 * (信頼したネットワークか、ログインの控えの Cookie) で、URL には何も埋めない。
 *
 * 観るほうはブラウザでそのまま再生するので (`routes/watch/[id]`)、ここに
 * 残っているのはダウンロードだけ。
 */
import { resolve } from '$app/paths';
import type { FileSource } from './source';

export function startDownload(id: number, source?: FileSource): void {
    const query = new URLSearchParams();
    if (source !== undefined) query.set('source', source);
    query.set('download', '1');
    location.href = `${resolve(`api/recordings/${id}/file`)}?${query}`;
}
