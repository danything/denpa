/**
 * **http の Hybridcast のアプリを、denpa の https 越しに読ませる** ([docs/stream.md](../../../docs/stream.md#hybridcast))。
 *
 * NHK のアプリは `http://hc.nhk.or.jp/` にあり、そこは https に応じない。denpa の画面は https なので、アプリの
 * script・画像・CSS はブラウザに Mixed Content として止められる。アプリを開くときに合言葉を出し、
 * `/api/bml/hc/<合言葉>/<経路>` をアプリの配信元の同じ経路へ中継する (`routes/api/bml/hc`)。
 *
 * - **合言葉が許可証。** アプリは使い捨てのオリジンの iframe にいて、そこからの読み込みにはログインの cookie が付かない。
 *   だから中継の側はログインを見ない (`auth.ts` の `OPEN_PATHS`)。合言葉は推測できない乱数で、配信元 1 つに結びつき、
 *   `TTL` で切れる。出すのはログインした人にだけ (`POST /api/bml/hc`)
 * - 覚えておくのはプロセスの中だけ。再起動したら、開き直せば出し直す
 */

import { randomBytes } from 'node:crypto';

/** 合言葉の寿命 (ms)。番組 1 本を見終えるくらい */
const TTL = 6 * 60 * 60 * 1000;
/** 覚えておく数の上限。超えたら古いほうから捨てる (開くたびに出すので、溜め込まない) */
const MOST = 64;

interface Grant {
    origin: string;
    until: number;
}

const grants = new Map<string, Grant>();

/** 合言葉の形 (`routes/api/bml/hc` と `auth.ts` の `OPEN_PATHS` が同じ形で受ける) */
export const TOKEN = /^[0-9a-f]{32}$/;

/** `origin` (http://host[:port]) へ中継する合言葉を出す */
export function grant(origin: string, now = Date.now()): string {
    for (const [token, entry] of grants) if (entry.until <= now) grants.delete(token);
    while (grants.size >= MOST) {
        const oldest = grants.keys().next().value;
        if (oldest === undefined) break;
        grants.delete(oldest);
    }
    const token = randomBytes(16).toString('hex');
    grants.set(token, { origin, until: now + TTL });
    return token;
}

/** 合言葉の配信元。知らない・切れた合言葉は null */
export function originOf(token: string, now = Date.now()): string | null {
    const entry = grants.get(token);
    if (entry === undefined) return null;
    if (entry.until <= now) {
        grants.delete(token);
        return null;
    }
    return entry.origin;
}

/** テストで覚えたものを捨てる */
export function forgetGrants(): void {
    grants.clear();
}
