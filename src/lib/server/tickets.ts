/**
 * WebSocket に繋ぐための使い捨ての札。
 *
 * **ブラウザは WebSocket の握手に `Authorization` を付けてくれない。** 画面が
 * 画面に入れていても、そこから張る WebSocket は素通しで届いてしまう。
 * チューナーを掴む口をそのまま開けておくわけにはいかない。
 *
 * そこで、**認証を通った画面だけが取れる札**を1枚配り、それを URL に付けて
 * 繋いでもらう。札の発行 (`/api/live/ticket`) は普通の HTTP なので、
 * OIDC も信頼したネットワークも**そのまま効く**。
 *
 * **1回使ったら消す。** URL は履歴にもログにも残るので、残しておくと拾った人が
 * 繋げてしまう。寿命も短くしてある (取ってすぐ繋ぐだけの用なので、これで足りる)。
 */

/** 札の寿命。取ってすぐ繋ぐだけなので短くてよい */
const LIFETIME = 30_000;

/**
 * 札で許すこと。**住所を見られるのは札を取るときだけ**なので、そこで決めて札に持たせる。
 *
 * WebSocket の口 (`server.js` の `Bun.serve`) からも接続元は見えるが、前段 (Traefik) が
 * 居る構成ではそれは前段の住所で、本当の接続元はヘッダにしか無い。そのヘッダを
 * 読み分けているのは SvelteKit の側 (`ADDRESS_HEADER`) なので、判断もそちらに寄せる
 */
export interface Grant {
    /**
     * **焼かずに生の TS を送ってよいか** (docs/stream.md §5.5)。LAN から来たときだけ
     * (`auth.onLan`)。1局 15〜17 Mbit/s を宅外へ流さないため
     */
    raw: boolean;
}

const issued = new Map<string, { until: number; grant: Grant }>();

/** 期限切れを片付ける。**配るときと使うときに掃く** (別に走らせるほどの量ではない) */
function sweep(at: number): void {
    for (const [token, held] of issued) {
        if (held.until <= at) issued.delete(token);
    }
}

/** 1枚配る */
export function issue(grant: Grant = { raw: false }, at: number = Date.now()): string {
    sweep(at);
    const token = crypto.randomUUID();
    issued.set(token, { until: at + LIFETIME, grant });
    return token;
}

/** 使う。**使えるのは1回だけ**。使えなければ null */
export function redeem(token: string | null, at: number = Date.now()): Grant | null {
    if (token === null) return null;
    sweep(at);
    const held = issued.get(token);
    if (held === undefined) return null;
    issued.delete(token);
    return held.grant;
}
