import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { FileSource } from '$lib/source';
import { fileRecordingId } from './auth';
import { orm } from './db';
import { shareLinks } from './schema';
import { displayTitle } from './title';

/**
 * 期限付きの再生リンク。
 *
 * 出先のプレイヤー (テレビの VLC など) に渡すための、時間で切れるURLを作る。
 * 恒久の資格情報入りのURLでも再生自体はできるが、**プレイヤーはURLを履歴に
 * 保存する** — 他人の機器に恒久パスワードを置いてくることになる。期限付きなら
 * 残っても切れたゴミにしかならない。
 *
 * 控えはDBに持つ (`share_links`)。**1録画につき現役のリンクは1本**で、期限内に
 * もう一度発行すると同じトークンのまま期限だけ延びる — テレビの履歴に残った
 * URLが、使い続けているかぎり切れない。以前は HMAC の署名だけで控え無しに
 * していたが、期限がトークンに焼き付いてしまい、延ばすにはURLごと変える
 * しかなかった (履歴のURLは死ぬ)。全部を今すぐ切りたければ `share_links` の
 * 行を消せば良い。
 */

/** リンクの寿命。観るのに十分で、置き忘れても翌日には腐る長さ */
export const SHARE_TTL = 24 * 60 * 60 * 1000;

/**
 * リンクを発行する。**生きているものが有ればそれを返し、期限を延ばす。**
 * トークンは当て推量できない乱数 (128bit)。URLに素で置ける文字だけ
 */
export function mintShareToken(
    recordingId: number,
    at: number = Date.now(),
): { token: string; expiresAt: number } {
    const expiresAt = at + SHARE_TTL;
    const db = orm();
    // 腐った控えはこの機会に片付ける (発行のたびで十分。行数は録画の数が上限)
    db.delete(shareLinks).where(lte(shareLinks.expires_at, at)).run();
    const living = livingToken(recordingId, at);
    if (living !== undefined) {
        db.update(shareLinks)
            .set({ expires_at: expiresAt })
            .where(eq(shareLinks.recording_id, recordingId))
            .run();
        return { token: living.token, expiresAt };
    }
    const token = randomBytes(16).toString('hex');
    db.insert(shareLinks)
        .values({ recording_id: recordingId, token, expires_at: expiresAt })
        .onConflictDoUpdate({
            target: shareLinks.recording_id,
            set: { token: sql`excluded.token`, expires_at: sql`excluded.expires_at` },
        })
        .run();
    return { token, expiresAt };
}

/** 期限の切れていない控え */
function livingToken(recordingId: number, at: number): { token: string } | undefined {
    return orm()
        .select({ token: shareLinks.token })
        .from(shareLinks)
        .where(and(eq(shareLinks.recording_id, recordingId), gt(shareLinks.expires_at, at)))
        .get();
}

export function verifyShareToken(
    recordingId: number,
    token: string | null,
    at: number = Date.now(),
): boolean {
    if (token === null || token === '') return false;
    const living = livingToken(recordingId, at);
    if (living === undefined) return false;
    const given = Buffer.from(token, 'utf8');
    const wanted = Buffer.from(living.token, 'utf8');
    // 比較は一定時間で。文字ごとの比較は、当たった長さが応答時間に漏れる
    return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * 認証 (hooks) から呼ぶ入口。**効くのはファイルの口だけ。**
 *
 * トークンで開くのは「この録画を期限まで観られる」だけで、画面にも他の API にも
 * 手は届かない。パスの録画IDの控えと突き合わせるので、1本ぶんのリンクを
 * 別の録画に使い回すことはできない。
 */
export function shareTokenAllows(pathname: string, searchParams: URLSearchParams): boolean {
    const id = fileRecordingId(pathname);
    return id !== null && verifyShareToken(id, searchParams.get('token'));
}

/**
 * 再生リンクの形。**ファイルそのもの**と、それを**続きの位置から指す XSPF** の2本。
 *
 * **URL の尻に番組名を置く** (`/file/<番組名>.mkv`)。テレビの VLC (Android) は
 * 再生画面の見出しに **URL の最後の区切りから拡張子を除いたもの** を出す
 * (vlc-android の VideoPlayerActivity / MediaWrapper.getTitle を確認)。入れ物の
 * title は履歴や通知にしか回らず、見出しには効かない。名前の区切りは
 * サーバでは読み捨てる (`file/[name]/+server.ts`) — 資格はトークンだけ。
 * `source` の名指しはクエリに焼き込む (テレビごとのコーデック設定の実現手段)。
 * プレイリストのほう (`playlist/[name]/+server.ts`) は、その中身にファイルの
 * URL を同じ資格で書く
 */
export function shareUrls(
    recording: { id: number; name: string },
    origin: string,
    token: string | null,
    source: FileSource | null,
): { file: string; playlist: string } {
    const query = new URLSearchParams();
    if (token !== null && token !== '') query.set('token', token);
    if (source !== null) query.set('source', source);
    const qs = query.size === 0 ? '' : `?${query}`;
    // 名前の中の区切り文字はパスの段を増やすので寄せておく。見た目だけの部分なので厳密でなくてよい
    const label = displayTitle(recording.name).replace(/[/\\]/g, '／') || String(recording.id);
    const base = `${origin}/api/recordings/${recording.id}`;
    // 拡張子は中身に合わせる (生TSは録画と同じ `.m2ts` — `.ts` は TypeScript と紛れる)
    return {
        file: `${base}/file/${encodeURIComponent(`${label}.${source === 'ts' ? 'm2ts' : 'mkv'}`)}${qs}`,
        playlist: `${base}/playlist/${encodeURIComponent(`${label}.xspf`)}${qs}`,
    };
}
