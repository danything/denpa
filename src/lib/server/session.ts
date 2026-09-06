/**
 * ログインの控え。
 *
 * **DBに持ちます。** 署名した Cookie に中身を入れる手もありますが、それだと
 * 「この端末だけ切る」ができません。DBに1行あるだけなら消せます。
 * 他のものと同じ SQLite なので、置き場が増えるわけでもありません。
 */

import { eq, lte } from 'drizzle-orm';
import { config } from './config';
import { now, orm } from './db';
import { randomToken } from './oidc';
import { sessions } from './schema';

/** Cookie の名前。`__Host-` は http のときに付けられないので素の名前にする */
export const COOKIE = 'denpa_session';
/** ログインの途中 (state / nonce / verifier) を預ける先。callback で使って捨てる */
export const PENDING_COOKIE = 'denpa_login';
/** 途中で放り出されたログインを片付けるまで */
export const PENDING_TTL = 10 * 60;

/** 控えのうち、認証に要るぶん (作った時刻は要らない) */
export type Session = Pick<typeof sessions.$inferSelect, 'id' | 'subject' | 'name' | 'expires_at'>;

export function create(subject: string, name: string): Session {
    const id = randomToken();
    const at = now();
    const expiresAt = at + config.oidcSessionTtl;
    orm().insert(sessions).values({ id, subject, name, created_at: at, expires_at: expiresAt }).run();
    return { id, subject, name, expires_at: expiresAt };
}

/** 生きている控えだけ返す。切れていれば null (行はここでは消さない) */
export function find(id: string | undefined): Session | null {
    if (id === undefined || id === '') return null;
    const row = orm()
        .select({
            id: sessions.id,
            subject: sessions.subject,
            name: sessions.name,
            expires_at: sessions.expires_at,
        })
        .from(sessions)
        .where(eq(sessions.id, id))
        .get();
    if (row === undefined) return null;
    return row.expires_at > now() ? row : null;
}

export function destroy(id: string | undefined): void {
    if (id === undefined || id === '') return;
    orm().delete(sessions).where(eq(sessions.id, id)).run();
}

/** 切れた控えを片付ける。消し忘れても害は無いが、溜め続ける理由も無い */
export function prune(): number {
    // 消した行を返させて数える (bun の `.run()` は型の上では変更数を返さない)
    return orm().delete(sessions).where(lte(sessions.expires_at, now())).returning({ id: sessions.id }).all()
        .length;
}
