import { createHash } from 'node:crypto';
import { database, now, queryOne } from './db';
import { settings } from './settings';

/**
 * テレビの VLC に URL を渡して再生させる。
 *
 * VLC for Android (3.6+) の「リモートアクセス」は端末内に Web サーバを立てる
 * (既定はポート 8080、HTTP)。相手の作りはソースで確かめてある
 * (vlc-android の RemoteAccessRouting.kt / RemoteAccessOTP.kt):
 *
 * - **ペアリングは2段。** `POST /code` で挑戦文字列 (challenge) をもらうと、
 *   テレビの画面に6桁のコードが出る (60秒で切れる)。コードは平文では送らず、
 *   `sha256hex(コード + challenge)` を `POST /verify-code` の `code` に入れる
 * - 通ると **302 + `Set-Cookie: user_session=...`**。この Cookie が合鍵で、
 *   リリース版の寿命は約1年・使うたびに延びる。DB に控えて使い回す (vlc_sessions)
 * - 再生は **`GET /play?id=0&path=<URL>`** + Cookie。`id` は入口の門番なだけで、
 *   `path` があればそちらが勝つ (中身は見られない)。200 = 再生開始
 * - **映像はVLCが前に出ていないと 403** (「Play in background」系の設定を
 *   入れていない限り)。そのまま使い手への案内にする
 *
 * HTTPS (8443) は自己署名なので使わない。渡す再生URLは期限付きリンク (share.ts) —
 * VLC はストリーム履歴にURLを残すので、恒久パスワードを入れない。
 */

export interface VlcTarget {
    name: string;
    host: string;
    paired: boolean;
}

/** 相手の応答をこれ以上待たない。LAN の機器なので、遅い=居ない */
const TIMEOUT_MS = 5000;

/** `名前=ホスト:ポート` のカンマ区切りを読む。ポート略なら VLC の既定 8080 */
export function parseTargets(text: string): { name: string; host: string }[] {
    const out: { name: string; host: string }[] = [];
    for (const part of text.split(',')) {
        const trimmed = part.trim();
        if (trimmed === '') continue;
        const eq = trimmed.indexOf('=');
        const name = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
        const host = (eq === -1 ? trimmed : trimmed.slice(eq + 1).trim()).replace(/^https?:\/\//, '');
        // ホスト名が空 (':8080' だけ等) の崩れは黙って飛ばす
        if (host.split(':')[0] === '') continue;
        out.push({ name: name === '' ? host : name, host: host.includes(':') ? host : `${host}:8080` });
    }
    return out;
}

function storedCookie(host: string): string | null {
    return (
        queryOne<{ cookie: string }>('SELECT cookie FROM vlc_sessions WHERE host = ?', host)?.cookie ?? null
    );
}

export function targets(): VlcTarget[] {
    return parseTargets(settings().vlcTargets).map((t) => ({
        ...t,
        paired: storedCookie(t.host) !== null,
    }));
}

/** ペアリング途中の challenge。テレビにコードが出ている間だけ意味を持つので、控えはメモリで足りる */
const challenges = new Map<string, string>();

export type VlcFailure =
    | { ok: false; reason: 'unreachable'; message: string }
    | { ok: false; reason: 'unpaired'; message: string }
    | { ok: false; reason: 'foreground'; message: string }
    | { ok: false; reason: 'rejected'; message: string };

export type VlcResult = { ok: true } | VlcFailure;

function unreachable(host: string): VlcFailure {
    return {
        ok: false,
        reason: 'unreachable',
        message: `テレビの VLC (${host}) に繋がりません。VLC を開いてリモートアクセスが動いているか確かめてください`,
    };
}

/**
 * ペアリングを始める。**この呼び出しでテレビの画面に6桁のコードが出る。**
 * もらった challenge は verify で使うので控えておく。
 */
export async function startPairing(host: string): Promise<VlcResult> {
    let challenge: string;
    try {
        const res = await fetch(`http://${host}/code`, {
            method: 'POST',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, reason: 'rejected', message: `VLC が断りました (${res.status})` };
        challenge = (await res.text()).trim();
    } catch {
        return unreachable(host);
    }
    if (challenge === '')
        return { ok: false, reason: 'rejected', message: 'VLC が挑戦文字列を返しませんでした' };
    challenges.set(host, challenge);
    return { ok: true };
}

/** 画面に出たコードで仕上げる。通ったら合鍵 (Cookie) をDBに控える */
export async function completePairing(host: string, code: string): Promise<VlcResult> {
    const challenge = challenges.get(host);
    if (challenge === undefined) {
        return {
            ok: false,
            reason: 'rejected',
            message: 'ペアリングを始め直してください (挑戦文字列がありません)',
        };
    }

    // コードは平文では渡らない。sha256hex(コード + challenge) を送る (VLC 側と同じ計算)
    const salted = createHash('sha256').update(`${code.trim()}${challenge}`).digest('hex');
    let res: Response;
    try {
        res = await fetch(`http://${host}/verify-code`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code: salted }),
            redirect: 'manual', // 302 の Set-Cookie を取るので、ついて行かない
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        return unreachable(host);
    }

    const cookie = res.headers.get('set-cookie')?.match(/user_session=[^;]+/)?.[0] ?? null;
    if (cookie === null) {
        // 間違ったコードも 302 で返る (行き先がエラー画面なだけ)。Cookie の有無で見分ける
        const flooded = res.status === 429;
        return {
            ok: false,
            reason: 'rejected',
            message: flooded
                ? '試しすぎました。少し待ってからやり直してください'
                : 'コードが違うか、期限 (60秒) が切れています。ペアリングを始め直してください',
        };
    }

    challenges.delete(host);
    database()
        .prepare(
            `INSERT INTO vlc_sessions (host, cookie, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(host) DO UPDATE SET cookie = excluded.cookie, updated_at = excluded.updated_at`,
        )
        .run(host, cookie, now());
    return { ok: true };
}

/** URL を渡して再生させる。VLC が合鍵を忘れていたら控えを捨てて「ペアリングし直し」を返す */
export async function play(host: string, mediaUrl: string): Promise<VlcResult> {
    const cookie = storedCookie(host);
    if (cookie === null) {
        return { ok: false, reason: 'unpaired', message: 'まだペアリングしていません' };
    }

    let res: Response;
    try {
        // id=0 は門番向けのダミー。path があればそちらで再生される (先頭のコメント参照)
        res = await fetch(`http://${host}/play?id=0&path=${encodeURIComponent(mediaUrl)}`, {
            headers: { cookie },
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        return unreachable(host);
    }

    if (res.ok) return { ok: true };
    if (res.status === 403) {
        return {
            ok: false,
            reason: 'foreground',
            message:
                'テレビ側で VLC を画面に出してから、もう一度押してください (映像は前面でしか始められません)',
        };
    }
    if (res.status === 401 || res.status === 302) {
        // 合鍵が切れている (VLC を入れ直した等)。控えを持ち続けても通らない
        database().prepare('DELETE FROM vlc_sessions WHERE host = ?').run(host);
        return {
            ok: false,
            reason: 'unpaired',
            message: 'ペアリングが切れています。もう一度ペアリングしてください',
        };
    }
    return { ok: false, reason: 'rejected', message: `VLC が断りました (${res.status})` };
}
