/**
 * 録画を**落とす**ときのURLの組み立て。
 *
 * 観るほうはブラウザでそのまま再生するので (`routes/watch/[id]`)、ここに
 * 残っているのはダウンロードだけです。**外部プレイヤーへ渡す口 (`denpa://`) は
 * 廃止しました** — 焼いたものはブラウザが読めるので、渡す先が要らなくなりました。
 */

/**
 * ベーシック認証の資格情報を URL に埋める。
 *
 * **ブラウザはページの認証をダウンロードに引き継ぎません。** 素のURLだと
 * 401 になって落ちてこないので、URL に入れるしかありません
 * (プレイヤーに貼るときも同じ理由で要ります)。
 *
 * **この画面まで来られている時点で持っている人**なので、URL の中に見えていても
 * 増える危険はありません (画面も守られています。docs/auth.md)。
 */
export function withCredentials(url: string, credentials?: { user: string; password: string }): string {
    if (credentials === undefined) return url;
    return url.replace(
        /^(https?:\/\/)/,
        `$1${encodeURIComponent(credentials.user)}:${encodeURIComponent(credentials.password)}@`,
    );
}
