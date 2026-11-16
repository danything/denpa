/**
 * **`getIRDID(type)` に返す B-CAS カードの番号** (`DataBroadcast` の `irdId`)。種別 5 だけに、カードの番号 (10 進 16 桁の 48 ビットの数。
 * `server/agent-cards.ts` の `cardIdOf`) を 16 進 12 桁 (大文字) にして返す。ほかの種別と、番号が無い・読めないときは null。
 * この形式は規格の本文では確かめていない (ほかの実装が実際の放送で確かめたもの。文書は 10 進のままだと数として読めない)
 */
export function irdIdOf(type: number, cardId: string | null): string | null {
  if (type !== 5 || cardId === null || !/^\d{1,16}$/.test(cardId)) return null;
  const value = BigInt(cardId);
  if (value >> 48n !== 0n) return null;
  return value.toString(16).toUpperCase().padStart(12, "0");
}
