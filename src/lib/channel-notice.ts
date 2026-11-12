/**
 * **チャンネルのお知らせ。** 閉じるボタンは置かず、元のことが片付けば消える。出し方は、中身があるかで 2 つに分ける。
 *
 * - **画面が空になるわけ** (`ChannelNotice`) は、録画・番組表・ライブの上に 1 行で出す (`ChannelNotice.svelte`)。
 *   局が無いので中身も無く、1 行が中身の場所を取らない。その画面ですることを言う
 *   - `agent` … エージェントが 1 台も無い。設定の「受信」の「エージェントを追加」へ案内する。登録すると、スキャンへの案内に替わる
 *   - `all` … どの種別にも局が無い。スキャンへ案内する。スキャンして局が入れば消える
 *   - `undecodable` … 局はあるが、どれもスクランブルを復号できず、番組表もスクランブルされていて読めない (スカパー！プレミアムの局と、
 *     B-CAS 以外の方式でスクランブルされたケーブルの局だけ)。番組表とライブに出す局が無いわけを言う。番組表に出せる局が入れば消える
 * - **中身が動いている間に起きたこと** (`ChannelAlertKind`) は、ヘッダーの印に畳む (`ChannelAlert.svelte`)。
 *   中身の上に 1 行を足さない。どの画面にも出す (スマホの形は設定の入口の印。`routes/+layout.svelte`)
 *   - `changed` … 放送の一覧が変わり、受信できるチャンネルを書き換えた (`server/lineup-follow.ts`)。文は書き換えた中身で、
 *     設定の「受信」を開くか 24 時間たつと消える
 *   - `ground` … 地上波のチャンネルを続けて選局できない・局の顔ぶれがスキャンの結果と違う (`server/ground-watch.ts`)。
 *     スキャンし直すか、ライブ・録画・番組表の取得がそのチャンネルを選局できれば消える
 */
export type ChannelNotice = "agent" | "all" | "undecodable";

/** ヘッダーの印に畳むお知らせ (`server/channel-alert.ts` が渡す) */
export type ChannelAlertKind = "changed" | "ground";

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
  /** 登録したエージェントの数 (`server/agents.ts` の `agentCount`) */
  agents = 1,
): ChannelNotice | null {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (total > 0) return null;
  if (agents === 0) return "agent";
  return listed === 0 ? "all" : "undecodable";
}

export const CHANNEL_NOTICE_TEXT: Record<ChannelNotice, string> = {
  agent: "エージェントがありません。エージェントを追加してください",
  all: "チャンネルがありません。チャンネルスキャンをしてください",
  undecodable:
    "受信できる局は、どれもスクランブルを復号できないため、番組表とライブに出せません",
};

/**
 * 文の後ろのボタン。局が無いときの 1 行も印の文も、設定の「受信」の「チャンネル」へ行く。
 * エージェントが無いときだけ「エージェント」へ (`CHANNEL_NOTICE_SECTION`)
 */
export const CHANNEL_NOTICE_ACTION: Record<
  ChannelNotice | ChannelAlertKind,
  string
> = {
  agent: "追加へ",
  all: "スキャンへ",
  undecodable: "確認",
  changed: "確認",
  ground: "スキャンへ",
};

/** 印の読み上げ (ヘッダーの印と、スマホの形の設定の入口の印) */
export const CHANNEL_ALERT_LABEL: Record<ChannelAlertKind, string> = {
  changed: "チャンネルを書き換えたお知らせ",
  ground: "地上波のチャンネルのお知らせ",
};

/** 局が無いときの 1 行のボタンの行き先 (設定の「受信」の節) */
export const CHANNEL_NOTICE_SECTION: Record<ChannelNotice, string> = {
  agent: "agents",
  all: "channels",
  undecodable: "channels",
};
