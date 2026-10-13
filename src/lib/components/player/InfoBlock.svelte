<script lang="ts">
    import type { Snippet } from 'svelte';
    import { time } from '#lib/format.js';

    /**
     * 操作バーの中の読みもの (二段)。**3画面 (ライブ・観る・追っかけ) で同じ形。**
     *
     * 上の段が「いつ・どこの・何」(時間帯 ・ 局 ・ 番組名)、下の段が画面ごとの
     * 状態 (位置・遅延など)。別々に書いていた頃は、追っかけだけ時間帯が無く、
     * 局と番組の並びも他と違っていた — 画面を移ると読む場所を探し直すことになる。
     *
     * 幅は操作バーの余りぜんぶ (`flex: 1 1 0`)。入りきらないぶんは**番組名だけが**
     * 後ろから切れる (時間帯と局は縮めない。どちらも短くて、切れると読めない)。
     *
     * **狭い枠 (スマホの縦) でも押すものの間に置き、下の段を短くする** (`.long` を省く。下の style)。
     * 上の段は操作バーを映像の下に出すとき (`data-under`) は省く — 番組名・局・時間帯は、その幅では
     * 映像のすぐ下 (右の列が畳まれて下に来る) に出ている。
     *
     * 以前は押すものの上に一行を取っていた。押すものを全部並べたまま間に挟むと 360px 幅では
     * 数十 px しか残らず、「23:0…」で切れていたため。いまは狭い枠で毎回使うものだけを残す
     * (`Extras`) ので、320px でも時刻が入る。一行を取ると操作バーが二段になり、映像の下を余計に使っていた
     */
    let {
        range = null,
        service,
        title = null,
        titleTestid,
        rangeTestid,
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
        /** 時間帯の目印 (試験が終わりの時刻を読む) */
        rangeTestid?: string;
        /** 題名の前に置くラベル (観る画面の「端末」など) */
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
            {#if range !== null}<span data-testid={rangeTestid}>{time(range.start)} 〜 {time(range.end)}</span><span class="sep">・</span>{/if}<span
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
        padding: 0 0.25rem;
    }
    /* 狭い枠では時間帯・局も縮める (押すものの間の幅しか無い。全画面の縦など、上の段を出すとき) */
    :global(.stage[data-compact]) .keep {
        flex-shrink: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    /*
     * **狭い枠では読みものを短くする。** 画面側は、省いてよいところ (残り・チャプター名など) を
     * `.long` で包み、時刻は `.clock` で包む。時刻の「 / 」の空きも詰める
     * (文字は変えないので、「0:31 / 1:00:00」を読むテストはそのまま)。
     * 省いたところは読み上げにも出ない (チャプター名はシークバーの読み上げに入っている)
     */
    :global(.stage[data-compact]) .status :global(.long) {
        display: none;
    }
    :global(.stage[data-compact]) .status :global(.clock) {
        word-spacing: -0.2em;
    }
    /*
     * 上の段を省くのは、操作バーを映像の下に出しているとき (スマホの縦。`data-under`) だけ。
     * 低い窓で畳んだとき (高さで `compact`) や縦の全画面では、右の列が映像の横に
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
