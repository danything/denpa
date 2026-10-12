/**
 * 録画を**落とす**ときの口。
 *
 * 押した瞬間に**期限付きの署名URL** (`server/share.ts` の `?token=`) を作り、
 * そこへ遷移して落とす。遷移先は添付 (`Content-Disposition`) なので画面は動かない。
 *
 * 以前はベーシック認証の資格情報を URL に埋めていた (ブラウザはページの認証を
 * ダウンロードに引き継がないため)。それだと**パスワードがダウンロード履歴と
 * URL欄に残り続ける** — 期限付きなら履歴に残っても24時間で腐る。
 * リンクを固定で `href` に置けなくなる (押されてから作る) のが引き換え。
 *
 * 観るほうはブラウザでそのまま再生するので (`routes/watch/[id]`)、ここに
 * 残っているのはダウンロードだけ。外部プレイヤーへ渡す口 (`denpa://`) は廃止済み。
 */
import { resolve } from '$app/paths';
import type { FileSource } from './source';

/**
 * 期限付きのリンクを作る (`api/recordings/<id>/share`)。作れなければ (断られた・繋がらない) null。
 * 落とす口と「再生リンクをコピー」で使う
 */
export async function mintShareLink(
    id: number,
    source?: FileSource,
): Promise<{ url: string; expiresAt: number } | null> {
    const query = source === undefined ? '' : `?source=${source}`;
    try {
        const res = await fetch(resolve(`api/recordings/${id}/share${query}`), { method: 'POST' });
        if (!res.ok) return null;
        return (await res.json()) as { url: string; expiresAt: number };
    } catch {
        return null;
    }
}

export async function startDownload(id: number, source?: FileSource): Promise<boolean> {
    const link = await mintShareLink(id, source);
    if (link === null) return false;
    location.href = `${link.url}&download=1`;
    return true;
}
