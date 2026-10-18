/**
 * **設定の節の並び。** 左の一覧 (`routes/settings/+layout.svelte`) はこの順に出す。
 * 節ごとに `/settings/<slug>` の画面があり、フォームと保存 (actions) もその画面が持つ。
 *
 * 並びはよく触る順: 録画のしかた → 受信 (入れたときと困ったとき) → 視聴 → 連携 → その他。
 * 広い画面で `/settings` を開くと先頭の節へ移る (`FIRST_SECTION`)
 */
export const SETTINGS_GROUPS = [
    { label: '録画', sections: [{ slug: 'recording', label: '録画のしかた' }] },
    {
        label: '受信',
        sections: [
            { slug: 'tuners', label: 'チューナー' },
            { slug: 'channels', label: 'チャンネル' },
            { slug: 'logos', label: 'ロゴ' },
        ],
    },
    {
        label: '視聴',
        sections: [
            { slug: 'broadcast', label: 'データ放送' },
            { slug: 'browser', label: 'この端末' },
        ],
    },
    {
        label: '連携',
        sections: [
            { slug: 'notifications', label: '通知' },
            { slug: 'tv', label: 'テレビのアプリ' },
        ],
    },
    { label: 'その他', sections: [{ slug: 'migrate', label: 'EPGStation からの引き継ぎ' }] },
] as const;

export type SettingsSlug = (typeof SETTINGS_GROUPS)[number]['sections'][number]['slug'];

export const FIRST_SECTION: SettingsSlug = 'recording';

/** 節の名前。画面のタイトルに使う */
export function sectionLabel(slug: string): string | null {
    for (const group of SETTINGS_GROUPS) {
        for (const section of group.sections) if (section.slug === slug) return section.label;
    }
    return null;
}
