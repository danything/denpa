/**
 * バイト列の細かい道具。**中身の意味は持たない。** 繋ぐ・読むのはここで済ませる (別名で書き直さない)
 */

/** バイト列を新しい1本に繋ぐ (いつも写す。`Blob` などへ渡せる `ArrayBuffer` の上に作る) */
export function concatBytes(
  parts: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
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

/**
 * バイト列を1本に繋ぐ。
 *
 * **1本しかないときは写しません。** 分割された記述子を繋ぎ直すところ
 * ([eit.ts](eit.ts)) では、繋ぐ必要のないほうが多数です
 */
export function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  return parts.length === 1 ? parts[0]! : concatBytes(parts);
}

/** 大きい桁が先の 16 ビット */
export function u16(data: Uint8Array, at: number): number {
  return (data[at]! << 8) | data[at + 1]!;
}

/** 大きい桁が先の 24 ビット */
export function u24(data: Uint8Array, at: number): number {
  return (data[at]! << 16) | u16(data, at + 1);
}

/** 大きい桁が先の 32 ビット (符号なし) */
export function u32(data: Uint8Array, at: number): number {
  return (
    ((data[at]! << 24) |
      (data[at + 1]! << 16) |
      (data[at + 2]! << 8) |
      data[at + 3]!) >>>
    0
  );
}

/** `length` バイトをそのまま1字ずつの文字列に (MP4 の箱の種別・PNG の塊の名前・言語の符号) */
export function ascii(data: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...data.subarray(at, at + length));
}
