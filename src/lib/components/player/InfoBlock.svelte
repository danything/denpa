<script lang="ts">
    import type { Snippet } from 'svelte';
    import { time } from '$lib/format';

    /**
     * 帯の中の読みもの (二段)。**3画面 (ライブ・観る・追っかけ) で同じ形。**
     *
     * 上の段が「いつ・どこの・何」(時間帯 ・ 局 ・ 番組名)、下の段が画面ごとの
     * 状態 (位置・遅延など)。別々に書いていた頃は、追っかけだけ時間帯が無く、
     * 局と番組の並びも他と違っていた — 画面を移ると読む場所を探し直すことになる。
     *
     * 幅は帯の余りぜんぶ (`flex: 1 1 0`)。入りきらないぶんは**番組名だけが**
     * 後ろから切れる (時間帯と局は縮めない。どちらも短くて、切れると読めない)。
     */
    let {
        range = null,
        service,
        title = null,
        titleTestid,
        badge,
        status,
    }: {
        /** 番組の時間帯。無ければ出さない (ライブで番組表が引けていないとき) */
        range?: { start: number; end: number } | null;
        /** 局の名前 */
        service: string;
        /** 番組名 */
        title?: string | null;
        titleTestid?: string;
        /** 題名の前に置く札 (観る画面の「端末」など) */
        badge?: Snippet;
        /** 下の段。位置・遅延など、画面ごとの読みもの */
        status?: Snippet;
    } = $props();
</script>

<div class="info">
    <div class="top">
        {#if badge}{@render badge()}{/if}
        <span class="keep">
            {#if range !== null}{time(range.start)} 〜 {time(range.end)} ・ {/if}{service}
        </span>
        {#if title !== null && title !== ''}
            <span class="cut">
                ・ <span data-testid={titleTestid}>{title}</span>
            </span>
        {/if}
    </div>

    <div class="status cut">
        {#if status}{@render status()}{/if}
    </div>
</div>

<style>
    .info {
        min-width: 0;
        flex: 1 1 0;
        padding: 0 0.5rem;
        line-height: 1.25;
        color: rgb(255 255 255 / 0.8);
    }
    .top {
        display: flex;
        align-items: baseline;
        gap: 0.375rem;
        overflow: hidden;
        font-size: 0.875rem;
        white-space: nowrap;
    }
    .keep {
        flex-shrink: 0;
    }
    .cut {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .status {
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
        color: rgb(255 255 255 / 0.6);
    }
</style>
