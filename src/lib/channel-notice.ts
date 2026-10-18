/**
 * **局が無いときの案内** (録画・番組表・ライブの上に出す1行。`ChannelNotice.svelte`)。
 *
 * 入れたばかりで地上波のスキャンをしていないと、番組表もライブも空のまま何も起きない。
 * 何をすればいいのかを、その画面で言う。閉じるボタンは置かない — スキャンして局が入れば消える。
 *
 * - `all` … どの種別にも局が無い (入れたばかり・チューナーが見つからない)
 * - `gr` … 地上波だけ無い (衛星は番組表の取得で先に局が入ることがある)
 */
export type ChannelNotice = 'all' | 'gr';

/** いま選局できる局の数 (種別ごと。`server/epg.ts` の `serviceCounts`) */
export type ServiceCounts = Record<string, number>;

export function channelNotice(counts: ServiceCounts): ChannelNotice | null {
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (total === 0) return 'all';
    return (counts['GR'] ?? 0) === 0 ? 'gr' : null;
}

export const CHANNEL_NOTICE_TEXT: Record<ChannelNotice, string> = {
    all: 'チャンネルがありません。チャンネルスキャンをしてください',
    gr: '地上波のチャンネルがありません。チャンネルスキャンをしてください',
};
