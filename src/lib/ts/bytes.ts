/**
 * バイト列の細かい道具。**中身の意味は持たない。** 繋ぐのはここ1つで済ませる (別名で書き直さない)
 */

/**
 * バイト列を1本に繋ぐ。
 *
 * **1本しかないときは写しません。** 分割された記述子を繋ぎ直すところ
 * ([eit.ts](eit.ts)) では、繋ぐ必要のないほうが多数です
 */
export function joinBytes(parts: Uint8Array[]): Uint8Array {
    if (parts.length === 1) return parts[0]!;
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
