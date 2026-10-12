/**
 * 録画を**落とす**ときの入口。
 *
 * ファイルのエンドポイント (`api/recordings/<id>/file`) へ遷移して落とす。遷移先は添付
 * (`Content-Disposition`、`?download=1`) なので画面は動かない。資格は画面と同じ
 * (信頼したネットワークか、ログインの控えの Cookie) で、URL には何も埋めない。
 *
 * **遷移する前に HEAD で確かめる。** 断られた (ログインが切れた・録画が消えた) まま遷移すると、
 * 添付でない答え (401 の JSON など) にページごと移ってしまう。HEAD はヘッダーだけ答え、
 * 再エンコードも起こさない (`file/+server.ts`)。
 *
 * 観るほうはブラウザでそのまま再生するので (`routes/watch/[id]`)、ここに
 * 残っているのはダウンロードだけ。
 */
import { resolve } from '$app/paths';
import type { FileSource } from './source';

/** 落とし始めたら true。断られた・繋がらないときは遷移せずに false */
export async function startDownload(id: number, source?: FileSource): Promise<boolean> {
    const query = new URLSearchParams();
    if (source !== undefined) query.set('source', source);
    query.set('download', '1');
    const url = `${resolve(`api/recordings/${id}/file`)}?${query}`;
    try {
        const res = await fetch(url, { method: 'HEAD' });
        if (!res.ok) return false;
    } catch {
        return false;
    }
    location.href = url;
    return true;
}
