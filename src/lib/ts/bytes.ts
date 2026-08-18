/**
 * バイト列の細かい道具。**中身の意味は持たない。**
 *
 * 同じ「繋ぐ」を字幕 (PGS)・番組表 (EIT)・偽の TS (synth)・ロゴの PNG で
 * 別々に書いていました。どれも同じ形なのに名前だけ違っていて
 * (`concat` / `stream` / `joinBytes`)、探しても見つからないので、また書かれる
 */

/**
 * バイト列を1本に繋ぐ。
 *
 * **1本しかないときは写しません。** 分割された記述子を繋ぎ直すところ
 * ([eit.ts](eit.ts)) では、繋ぐ必要のないほうが多数です
 */
export function joinBytes(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0];
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
