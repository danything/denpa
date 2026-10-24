<script lang="ts">
  import type { Snippet } from "svelte";
  import { time } from "#lib/format.js";

  /**
   * 操作バーの中の読みもの (二段。3画面で同じ形)。上の段は時間帯・局・番組名、下の段は画面ごとの状態 (位置・遅延など)。
   * 幅は操作バーの余りぜんぶで、入りきらないぶんは番組名だけが後ろから切れる。狭い枠では下の段を短くし (`.long` を省く)、
   * スマホの縦 (`data-narrow`) では上の段を省く (映像のすぐ下に出ている)
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
    /** タイトルの前に置くラベル (観る画面の「端末」など) */
    badge?: Snippet;
    /** 下の段。位置・遅延など、画面ごとの読みもの */
    status?: Snippet;
  } = $props();
</script>

<div class="info">
  <div class="top">
    {#if badge}{@render badge()}{/if}
    <!-- 中黒の両側は同じ空き (`.sep`。文字の空白だと Svelte が `{/if}` の前を詰めた) -->
    <span class="keep">
      {#if range !== null}<span data-testid={rangeTestid}
          >{time(range.start)} 〜 {time(range.end)}</span
        ><span class="sep">・</span>{/if}<span class="broadcast">{service}</span
      >
    </span>
    {#if title !== null && title !== ""}
      <span class="truncate">
        <span class="sep lead">・</span><span
          class="broadcast"
          data-testid={titleTestid}>{title}</span
        >
      </span>
    {/if}
  </div>

  <div class="status truncate">
    {#if status}{@render status()}{/if}
  </div>
</div>

<style>
  .info {
    min-width: 0;
    flex: 1 1 0;
    padding: 0 0.5rem;
    line-height: 1.25;
    color: var(--dp-on-video-soft);
  }
  .top {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    overflow: hidden;
    font-size: var(--dp-text-sm);
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
     * 上の段を省くのは、スマホの縦 (舞台の `data-narrow`) だけ。
     * 低い窓で畳んだとき (高さで `compact`) や縦の全画面では、右の列が映像の横に
     * あるか見えないので、番組名はここでしか読めない
     */
  :global(.stage[data-narrow]) .top {
    display: none;
  }
  .status {
    font-size: var(--dp-text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--dp-on-video-muted);
  }
</style>
