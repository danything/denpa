import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { database, now, queryOne } from './db';

/**
 * 期限付きの再生リンク。
 *
 * 出先のプレイヤー (テレビの VLC など) に渡すための、時間で切れるURLを作る。
 * ベーシック認証入りのURLでも再生自体はできるが、**プレイヤーはURLを履歴に
 * 保存する** — 他人の機器に恒久パスワードを置いてくることになる。期限付きなら
 * 残っても切れたゴミにしかならない。
 *
 * 署名は HMAC-SHA256、鍵はDBに1つ (無ければ作る)。**録画IDを署名に練り込む**
 * ので、1本ぶんのリンクを別の録画に使い回すことはできない。控えは持たない —
 * 発行済みのリンクは期限まで生きる。全部を今すぐ切りたければ鍵の行
 * (`settings.shareSecret`) を消せば良い (次の発行で作り直される)。
 */

/** リンクの寿命。観るのに十分で、置き忘れても翌日には腐る長さ */
export const SHARE_TTL = 24 * 60 * 60 * 1000;

/** 署名の鍵。**ベーシック認証とは別** — パスワードを作り直しても発行済みのリンクは生きる */
function secret(): string {
    const stored = queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = 'shareSecret'`)?.value;
    if (stored !== undefined && stored !== '') return stored;
    const made = randomBytes(32).toString('hex');
    database()
        .prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES ('shareSecret', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(made, now());
    return made;
}

function sign(recordingId: number, expiresAt: number): string {
    return createHmac('sha256', secret()).update(`file:${recordingId}:${expiresAt}`).digest('hex');
}

/** トークンは `<期限ms>.<署名>`。URLに素で置ける文字だけ */
export function mintShareToken(
    recordingId: number,
    at: number = Date.now(),
): { token: string; expiresAt: number } {
    const expiresAt = at + SHARE_TTL;
    return { token: `${expiresAt}.${sign(recordingId, expiresAt)}`, expiresAt };
}

export function verifyShareToken(
    recordingId: number,
    token: string | null,
    at: number = Date.now(),
): boolean {
    if (token === null || token === '') return false;
    const dot = token.indexOf('.');
    if (dot === -1) return false;
    const expiresAt = Number(token.slice(0, dot));
    if (!Number.isFinite(expiresAt) || expiresAt <= at) return false;

    const given = Buffer.from(token.slice(dot + 1), 'utf8');
    const wanted = Buffer.from(sign(recordingId, expiresAt), 'utf8');
    // 比較は一定時間で。文字ごとの比較は、当たった長さが応答時間に漏れる
    return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * 認証 (hooks) から呼ぶ入口。**効くのはファイルの口だけ。**
 *
 * トークンで開くのは「この録画を期限まで観られる」だけで、画面にも他の API にも
 * 手は届かない。パスの録画IDと署名の中のIDが同じときだけ通る。
 */
export function shareTokenAllows(pathname: string, searchParams: URLSearchParams): boolean {
    const m = pathname.match(/^\/api\/recordings\/(\d+)\/file$/);
    if (m === null) return false;
    return verifyShareToken(Number(m[1]), searchParams.get('token'));
}
