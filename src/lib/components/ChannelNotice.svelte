<script lang="ts">
    import { CHANNEL_NOTICE_TEXT, type ChannelNotice } from '#lib/channel-notice.js';
    import { resolve } from '$app/paths';

    /**
     * 局が無いときの案内と、スキャンへのリンク (`#lib/channel-notice.ts`)。
     *
     * - `bar` … 画面の上に貼る1行 (録画・番組表・ライブ。`+layout.svelte`)。閉じるボタンは無い
     * - `center` … 空の番組表の真ん中に置く。文とボタンを縦に積む
     */
    let {
        kind,
        variant = 'bar',
        text = CHANNEL_NOTICE_TEXT[kind],
    }: {
        kind: ChannelNotice;
        variant?: 'bar' | 'center';
        /** 文を言い替えるとき (番組表で、選んでいる種別の名前を入れる) */
        text?: string;
    } = $props();
</script>

<div class="channel-notice {variant}" role="status" data-testid="channel-notice" data-kind={kind}>
    <p>{text}</p>
    <a
        href={resolve('settings/channels')}
        class="button small {variant === 'bar' ? 'secondary outline' : ''}"
        data-testid="channel-notice-scan">スキャンへ</a
    >
</div>

<style>
    .channel-notice {
        display: flex;
        align-items: center;
        gap: var(--dp-space-2) var(--dp-space-3);
    }
    .channel-notice p {
        margin: 0;
    }
    /*
     * **枠で囲まない、画面の幅いっぱいの1行。** ヘッダーの下に貼り、下の細い線で中身と分ける。
     * 地の色は案内 (info) をごく薄く。狭い画面で文が長ければ折り返し、ボタンは右に残す
     */
    .bar {
        justify-content: space-between;
        padding: 0.375rem 1rem;
        border-bottom: 1px solid var(--dp-line);
        background: color-mix(in srgb, var(--dp-info) 8%, var(--dp-surface));
        color: var(--dp-info-text);
        font-size: var(--dp-text-sm);
    }
    @media (min-width: 768px) {
        .bar {
            padding-inline: 1.5rem;
        }
    }
    .bar .button {
        flex-shrink: 0;
        margin: 0;
        padding-block: 0.15rem;
    }
    .center {
        flex-direction: column;
        justify-content: center;
        gap: var(--dp-space-3);
        text-align: center;
    }
    .center p {
        color: var(--dp-muted);
    }
</style>
