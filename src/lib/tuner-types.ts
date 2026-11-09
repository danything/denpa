import type { ChannelType } from "./types";

/**
 * 機材がその種別を受けられるか。`receivable` はエージェントが見つけた機材の種別 (`GET /denpa/tuners` の `receivable`)。
 *
 * **分からなければ (null・古いエージェントで無い) 地上波・BS・CS は受けられるものとして扱う。** 手で書いたデバイスや抜いてある機材は
 * エージェントにも分からないので、選局の時点で断られるまで任せる。
 * **SKY (スカパー！プレミアム) は、`receivable` に SKY がある機材だけが受けられる。** J.83B を選局できるのはエージェントが
 * 直に持つ IT930x の機材 (`it930x:`) だけで、エージェントはその機材にはいつも `receivable` を返す
 */
export function receives(
  receivable: readonly ChannelType[] | null | undefined,
  type: ChannelType,
): boolean {
  return receivable === null || receivable === undefined
    ? type !== "SKY"
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

/**
 * 受信の設定に SKY を並べるか (`types.ts` の `shownTypes`)。SKY を受けられる機材か、SKY を選んだチューナーが 1 台でもあれば並べる。
 * 選んだチューナーでも並べるのは、並べないと保存のたびに SKY が外れるため (送るのは並べた欄だけ)
 */
export function showsSky(
  tuners: readonly {
    types: readonly ChannelType[];
    receivable?: readonly ChannelType[] | null | undefined;
  }[],
): boolean {
  return tuners.some(
    (tuner) =>
      tuner.types.includes("SKY") || (tuner.receivable ?? []).includes("SKY"),
  );
}
