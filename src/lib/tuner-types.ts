import type { ChannelType } from "./types";

/**
 * 機材がその種別を受けられるか。`receivable` はエージェントが見つけた機材の種別 (`GET /denpa/tuners` の `receivable`)。
 *
 * **分からなければ (null・古いエージェントで無い) 受けられるものとして扱う。** 手で書いたデバイスや抜いてある機材は
 * エージェントにも分からないので、選局の時点で断られるまで任せる
 */
export function receives(
  receivable: readonly ChannelType[] | null | undefined,
  type: ChannelType,
): boolean {
  return receivable === null || receivable === undefined
    ? true
    : receivable.includes(type);
}

/**
 * 選んだ種別のうち、機材が受けられないもの。
 * BS/CS 専用の受信機に GR を入れて保存すると、その台に割り振られた地上波の選局が全部断られる (#2386) ので、
 * 設定の保存 (`tuners.server.ts`) はこれが空でなければ断る
 */
export function unreceivable(
  types: readonly ChannelType[],
  receivable: readonly ChannelType[] | null | undefined,
): ChannelType[] {
  return types.filter((type) => !receives(receivable, type));
}
