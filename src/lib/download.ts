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
import type { FileSource } from './source';

export async function startDownload(id: number, source?: FileSource): Promise<boolean> {
    const query = source === undefined ? '' : `?source=${source}`;
    try {
        const res = await fetch(`/api/recordings/${id}/share${query}`, { method: 'POST' });
        if (!res.ok) return false;
        const { url } = (await res.json()) as { url: string };
        location.href = `${url}&download=1`;
        return true;
    } catch {
        return false;
    }
}
