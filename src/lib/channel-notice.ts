/**
 * **局が無いときの案内** (録画・番組表・ライブの上に出す1行。`ChannelNotice.svelte`)。
 *
 * 入れたばかりでスキャンをしていないと、番組表もライブも空のまま何も起きない。
 * 何をすればいいのかを、その画面で言う。閉じるボタンは置かない — スキャンして局が入れば消える。
 *
 * **出すのは、どの種別にも局が無いときだけ。** 地上波が無いときにも出していた頃は、
 * アンテナが衛星だけの家では消えない案内になっていた。種別ごとの空きは番組表が表の場所で言う
 * (`guide/+page.svelte` の `typeEmpty`)
 */
export type ChannelNotice = "all";

/** いま選局できる局の数 (種別ごと。`server/epg.ts` の `serviceCounts`) */
type ServiceCounts = Record<string, number>;

export function channelNotice(counts: ServiceCounts): ChannelNotice | null {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return total === 0 ? "all" : null;
}

export const CHANNEL_NOTICE_TEXT: Record<ChannelNotice, string> = {
  all: "チャンネルがありません。チャンネルスキャンをしてください",
};
