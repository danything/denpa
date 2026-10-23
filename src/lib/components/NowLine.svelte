<script lang="ts">
  /**
   * **「いま」の線。** ホームの一覧 (`home/TimelineHeading`) と番組表で同じ見た目にする:
   * 赤い太字の時刻と、細い赤い線。塗った丸い札は使わない。
   *
   * - `inline` (ホーム) … 赤い点・時刻・残りの幅を埋める線・控えた字の一言 (`status`。右端) を1行に並べる。
   *   字の下には線を引かない。幅が足りなければ一言を短い形 (`status.short`) に替え、それでも入らなければ「…」で切る (折り返さない)
   * - `overlay` (番組表) … 線は枠の上端。時刻は左端に貼り付き (`sticky`)、線をまたいで乗る。
   *   下のマスや時の数字の上に乗るので、時刻だけ地の色を敷く
   *
   * 読み上げは「いま 18:01、次の録画まで 3時間59分」。短い形は目に見えるだけで、読み上げはいつも長い形
   */
  import type { HTMLAttributes } from "svelte/elements";
  import type { NowStatus } from "#lib/format.js";

  let {
    time,
    status = null,
    layout = "inline",
    heading = false,
    labelWidth,
    element = $bindable(null),
    class: className = "",
    ...rest
  }: {
    /** 時刻の字 (`time(clock)`) */
    time: string;
    /** 時刻の後ろに添える一言 (`inline` だけ) */
    status?: NowStatus | null;
    layout?: "inline" | "overlay";
    /** `h2` にする (見出し移動でここへ来られる) */
    heading?: boolean;
    /** 時刻の幅 (`overlay` で時刻の列にそろえる) */
    labelWidth?: string;
    element?: HTMLElement | null;
    class?: string;
  } & HTMLAttributes<HTMLElement> = $props();

  const shown = $derived(layout === "inline" ? status : null);
</script>

<!-- 「いま」と読み点は読み上げにだけ渡す -->
<svelte:element
  this={heading ? "h2" : "div"}
  bind:this={element}
  class="now-line {layout} {className}"
  {...rest}
>
  <span class="now-time num" style:width={labelWidth}
    ><span class="visually-hidden">いま </span>{time}{#if shown}<span
        class="visually-hidden">、</span
      >{/if}</span
  >
  {#if layout === "inline"}<span class="now-rule" aria-hidden="true"
    ></span>{/if}
  {#if shown}
    <span class="now-status">
      <span class="now-full">{shown.text}</span><span
        class="now-short"
        aria-hidden="true">{shown.short}</span
      >
    </span>
  {/if}
</svelte:element>

<style>
  .now-line {
    margin: 0;
    font-size: inherit;
    font-weight: var(--dp-weight);
  }
  .now-time {
    color: var(--dp-rec);
    font-weight: var(--dp-weight-bold);
    white-space: nowrap;
  }

  /* ---- 1行に並べる (ホーム) ---- */
  .inline {
    container-type: inline-size;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 1.25rem;
    /* 時刻の左端を行の時刻にそろえる (行の内側の余白。`home.css` が渡す) */
    padding-inline-start: var(--now-inset, 0);
  }
  .inline .now-time {
    flex-shrink: 0;
    font-size: var(--now-time-size, 0.875rem);
  }
  /* 線の頭の赤い点 (「いま」の印。カレンダーの今日の点と同じ赤) */
  /* 時刻の左の余白に置く (時刻の左端は行の時刻にそろえたまま) */
  .inline {
    position: relative;
  }
  .inline::before {
    content: "";
    position: absolute;
    top: 50%;
    left: max(0px, calc(var(--now-inset, 0px) - 0.625rem));
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--dp-rec);
    transform: translateY(-50%);
  }
  /* 一言は控えた字で右端に (補足なので、時刻と線ほど目立たせない) */
  .now-status {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--dp-muted);
    font-size: 0.8125rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .now-short {
    display: none;
  }
  .now-rule {
    flex: 1 1 0%;
    min-width: 1rem;
    height: 1px;
    background: var(--dp-rec);
  }
  /* 狭いと短い形 (「次まで 3:59」)。長い形は読み上げにだけ残す */
  @container (max-width: 19rem) {
    .now-full {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .now-short {
      display: inline;
    }
  }

  /* ---- 枠の上端に引く (番組表) ---- */
  .overlay {
    position: relative;
    pointer-events: none;
    border-top: 1px solid var(--dp-rec);
  }
  /*
     * `block` にして高さの半分だけ上げる (`translateY(-50%)`)。字の大きさが変わっても線の上に乗る。
     * `sticky` (`left: 0`) で横に流しても左端に残る
     */
  .overlay .now-time {
    position: sticky;
    left: 0;
    z-index: 1;
    display: block;
    transform: translateY(-50%);
    background: var(--dp-bg);
    text-align: center;
    font-size: 0.6875rem;
    line-height: 1rem;
  }
</style>
