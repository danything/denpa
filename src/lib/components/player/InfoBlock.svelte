<script lang="ts">
    import type { Snippet } from 'svelte';
    import { time } from '#lib/format.js';

    /**
     * 帯の中の読みもの (二段)。**3画面 (ライブ・観る・追っかけ) で同じ形。**
     *
     * 上の段が「いつ・どこの・何」(時間帯 ・ 局 ・ 番組名)、下の段が画面ごとの
     * 状態 (位置・遅延など)。別々に書いていた頃は、追っかけだけ時間帯が無く、
     * 局と番組の並びも他と違っていた — 画面を移ると読む場所を探し直すことになる。
     *
     * 幅は帯の余りぜんぶ (`flex: 1 1 0`)。入りきらないぶんは**番組名だけが**
     * 後ろから切れる (時間帯と局は縮めない。どちらも短くて、切れると読めない)。
     *
     * **狭い枠 (スマホの縦) では、下の段だけを押すものの上の一行に出す**
     * (`PlayerStage` の `data-compact` で一行に、`data-under` で上の段を省く)。押すものの間に挟むと 360px 幅では
     * 数十 px しか残らず、位置も番組名も「23:0…」で切れていた。番組名・局・
     * 時間帯は、その幅では絵のすぐ下 (右の列が畳まれて下に来る) に出ているので、
     * 帯では位置と遅れだけを読ませる
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
        <!--
            **中黒の両側は同じ空き** (`.sep`)。文字の空白で書いていた頃は、`{/if}` の前の空白を
            Svelte が詰めて「19:00 ・局名」と後ろだけ詰まっていた。局名と番組名の間は
            並びの隙間 (`gap`) が前を受け持つ
        -->
        <span class="keep">
            {#if range !== null}{time(range.start)} 〜 {time(range.end)}<span class="sep">・</span>{/if}<span
                class="broadcast">{service}</span
            >
        </span>
        {#if title !== null && title !== ''}
            <span class="cut">
                <span class="sep lead">・</span><span class="broadcast" data-testid={titleTestid}>{title}</span>
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
    /* 並びの隙間 (`gap`) と同じ幅 */
    .sep {
        margin-inline: 0.375rem;
    }
    .sep.lead {
        margin-inline-start: 0;
    }
    .cut {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    :global(.stage[data-compact]) .info {
        order: -1;
        flex: 1 1 100%;
        padding: 0 0.25rem;
    }
    /*
     * 上の段を省くのは、帯を絵の下に出しているとき (スマホの縦。`data-under`) だけ。
     * 低い窓で畳んだとき (高さで `compact`) や縦の全画面では、右の列が絵の横に
     * あるか見えないので、番組名はここでしか読めない
     */
    :global(.stage[data-under]) .top {
        display: none;
    }
    .status {
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
        color: rgb(255 255 255 / 0.6);
    }
</style>
