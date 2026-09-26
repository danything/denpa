import { json } from '@sveltejs/kit';
import { mayStreamRaw } from '$lib/server/auth';
import { issue } from '$lib/server/tickets';

/**
 * ライブ視聴の WebSocket に繋ぐための札を1枚配る。
 *
 * **ここは普通の HTTP なので、認証がそのまま効く** (`hooks.server.ts`)。
 * WebSocket の握手にはブラウザが `Authorization` を付けてくれないため、
 * 認証を通れることをここで示してもらってから繋いでもらう (`tickets.ts`)。
 *
 * **生で送ってよいか (LAN か) もここで決めて札に持たせる** (`Grant`)。本当の接続元が
 * 読めるのはこちら側だけ (前段が居るとヘッダにしか無い)。画面にも返すのは、
 * 断られると分かっているのに復号器 (500KB) を取りに行かせないため
 */
export function POST({ getClientAddress }) {
    let address = '';
    try {
        address = getClientAddress();
    } catch {
        // 読めなければ生にしない (hooks と同じく、分からないほうを通さない)
    }
    const raw = mayStreamRaw(address);
    return json({ ticket: issue({ raw }), raw });
}
