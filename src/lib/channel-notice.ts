/**
 * **チャンネルのお知らせ** (録画・番組表・ライブの上に出す 1 行。`ChannelNotice.svelte`)。閉じるボタンは置かず、
 * 元のことが片付けば消える。
 *
 * - `all` … どの種別にも局が無い。スキャンへ案内する。スキャンして局が入れば消える
 * - `undecodable` … 局はあるが、どれもスクランブルを復号できず、番組表もスクランブルされていて読めない (スカパー！プレミアムの局と、
 *   B-CAS 以外の方式でスクランブルされたケーブルの局だけ)。番組表とライブに出す局が無いわけを言う。番組表に出せる局が入れば消える
 * - `changed` … 放送の一覧が変わり、受信できるチャンネルを書き換えた (`server/lineup-follow.ts`)。文は書き換えた中身で、
 *   設定の「受信」を開くか 24 時間たつと消える
 * - `ground` … 地上波のチャンネルを続けて選局できない・局の顔ぶれがスキャンの結果と違う (`server/ground-watch.ts`)。
 *   スキャンし直すと消える
 */
export type ChannelNotice = "all" | "undecodable" | "changed" | "ground";

/** いま選局できる局のうち、番組表に出す局の数 (種別ごと。`server/epg.ts` の `serviceCounts`) */
type ServiceCounts = Record<string, number>;

/**
 * 局が無いときの案内を出すか。入れたばかりでスキャンをしていないと、番組表もライブも空のまま何も起きない。
 * 何をすればいいのかを、その画面で言う。
 *
 * **出すのは、番組表に出せる局 (番組表を読める局。復号できる局はいつも読める) がどの種別にも無いときだけ。** 地上波が無いときにも出していた頃は、
 * アンテナが衛星だけの家では消えない案内になっていた。種別ごとの空きは番組表が表の場所で言う
 * (`guide/+page.svelte` の `typeEmpty`)。
 * 局が 1 つも無ければスキャンへ案内し (`all`)、番組表に出せない局だけがあればそのわけを言う (`undecodable`)。
 * `listed` は復号できない局も入れた局の数 (`server/epg.ts` の `listedServices`)
 */
export function channelNotice(
  counts: ServiceCounts,
  listed: number,
): ChannelNotice | null {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total > 0) return null;
  return listed === 0 ? "all" : "undecodable";
}

export const CHANNEL_NOTICE_TEXT: Record<ChannelNotice, string> = {
  all: "チャンネルがありません。チャンネルスキャンをしてください",
  undecodable:
    "受信できる局は、どれもスクランブルを復号できないため、番組表とライブに出せません",
  changed:
    "チャンネルが放送で変わったため、受信できるチャンネルを書き換えました",
  ground:
    "地上波のチャンネルが受信できるチャンネルと違います。地上波をスキャンし直してください",
};

/** 文の後ろのボタン。どれも設定の「受信」の「チャンネル」へ行く */
export const CHANNEL_NOTICE_ACTION: Record<ChannelNotice, string> = {
  all: "スキャンへ",
  undecodable: "確認",
  changed: "確認",
  ground: "スキャンへ",
};
