import type { ChannelType } from "./types";

/**
 * 機材が分からなければ受けられるものとして扱わない種別。CATV (ケーブル。J.83C・TSMF) と SKY (スカパー！プレミアム。J.83B) は、
 * 選局できるのがエージェントが直に持つ IT930x の機材 (`it930x:`) だけで、エージェントはその機材にはいつも `receivable` を返す
 */
const DETECTED_ONLY: readonly ChannelType[] = ["SKY", "CATV"];

/**
 * 機材がその種別を受けられるか。`receivable` はエージェントが見つけた機材の種別 (`GET /denpa/tuners` の `receivable`)。
 *
 * **分からなければ (null・古いエージェントで無い) 地上波・BS・CS は受けられるものとして扱う。** 手で書いたデバイスや抜いてある機材は
 * エージェントにも分からないので、選局の時点で断られるまで任せる。
 * **CATV と SKY は、`receivable` にその種別がある機材だけが受けられる** (`DETECTED_ONLY`)
 */
export function receives(
  receivable: readonly ChannelType[] | null | undefined,
  type: ChannelType,
): boolean {
  return receivable === null || receivable === undefined
    ? !DETECTED_ONLY.includes(type)
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
 * 受信の設定に足して並べる種別 (`types.ts` の `shownTypes`)。CATV と SKY のうち、受けられる機材か、その種別を選んだチューナーが
 * 1 台でもあるもの。選んだチューナーでも並べるのは、並べないと保存のたびにその種別が外れるため (送るのは並べた欄だけ)
 */
export function extraTypes(
  tuners: readonly {
    types: readonly ChannelType[];
    receivable?: readonly ChannelType[] | null | undefined;
  }[],
): ChannelType[] {
  return DETECTED_ONLY.filter((type) =>
    tuners.some(
      (tuner) =>
        tuner.types.includes(type) || (tuner.receivable ?? []).includes(type),
    ),
  );
}
