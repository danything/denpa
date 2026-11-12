/**
 * **カードの契約の状態の決め方** (`card_contracts` の 1 行から)。契約を確かめる所 (`contracts.ts`) と、
 * 有料の局をどのエージェントに振り分けるかを決める所 (`agent-cards.ts`) が同じ決め方を使う。
 * どちらからも読めるよう、選局 (`tuner.ts`) に頼らないここに置く
 */

export type ContractState = "subscribed" | "unsubscribed" | "expired";

/**
 * **復号テストで確かめた契約を信じる長さ (31 日)。** 番組表に契約の情報 (0xCB) が無い局はカードに聞けないので、
 * 復号できたことだけが手がかりになる。CS の月額は月ごとに切れるので、確かめてから 1 か月を過ぎたら確かめ直すまで録らない。
 * 有料の番組を復号できて録れたら、確かめた日を新しくする (`contracts.noteDecoded`)。録画が復号できずに終わったときは、31 日を待たずに下げる (`contracts.noteStillScrambled`)
 */
export const DECODE_VALID_MS = 31 * 86_400_000;

/** 復号テストで確かめた契約が、まだ信じられる新しさか */
export function freshDecode(
  decodedAt: number | null | undefined,
  now = Date.now(),
): boolean {
  return decodedAt != null && now - decodedAt < DECODE_VALID_MS;
}

/**
 * **ダイアログに出す契約の状態。** `ContractState` に、まだ確かめていない (`unverified`) を足したもの。
 * 行が無い局と、カードが答えておらず (`code` が無い)、新しい復号の結果も無い局が `unverified`。
 * `subscribed` は、`contracts.paidAllowed` が録ってよいとする局と同じ
 */
export type ContractStatus = ContractState | "unverified";

/** 行から、ダイアログに出す状態を決める (`ContractStatus`) */
export function contractStatus(
  row: {
    state: ContractState;
    code: number | null;
    decodeOk: boolean | null;
    decodedAt: number | null;
  },
  now = Date.now(),
): ContractStatus {
  // カードが答えた局は、その答えのまま
  if (row.code !== null) return row.state;
  if (row.state === "subscribed" && freshDecode(row.decodedAt, now))
    return "subscribed";
  // 復号を試して掛かったままだった局は未契約。31 日を過ぎた結果しか無い局と、試していない局は確かめていない
  return row.decodeOk === false ? "unsubscribed" : "unverified";
}
