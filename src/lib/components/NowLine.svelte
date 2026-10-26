<script lang="ts">
  /**
   * **「いま」の線** (いまの境目。名前だけで、目に見える線は引かない)。ホームの一覧 (`home/TimelineHeading`) と番組表で同じ見た目にする:
   * 赤い点と赤い太字の時刻。ホームは地に置いてすぐ後ろに一言を続け、番組表は時刻を操作の層のカプセルに乗せる。
   * 中身には線を引かない (docs/design.md)。
   *
   * - `inline` (ホーム) … 時刻 (地に置く) と控えた字の一言 (`status`) を左から1行に並べる。幅が足りなければ一言を短い形 (`status.short`) に替え、それでも入らなければ「…」で切る (折り返さない)
   * - `overlay` (番組表) … 時刻のカプセルだけを時の列のいまの位置に置き、左端に貼り付ける (`sticky`)。表を横切る線は引かない
   *   (過ぎた所はマスを沈めて見せる)。目に見えるのは分だけ (時は同じ時の列に出ている。読み上げには時まで渡す)。
   *   時の数字の上に乗るので、カプセルの面で読ませる
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
    ><span class="visually-hidden">いま </span>{#if layout === "overlay"}<span
        class="visually-hidden">{time.slice(0, 3)}</span
      >{time.slice(3)}{:else}{time}{/if}{#if shown}<span class="visually-hidden"
        >、</span
      >{/if}</span
  >
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
  /*
     * 赤い点と赤い太字の時刻。字は淡い地の上で読める濃さの側 (`--dp-rec-text`)。
     * ホームの一覧では地に置く (貼り付かないので浮かせない。左は日付の字にそろえる)。番組表では時の数字の上に重なるので、操作の層のカプセルに乗せる (下の `.overlay`)
     */
  .now-time {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.125rem 0.75rem;
    color: var(--dp-rec-text);
    font-weight: var(--dp-weight-bold);
    white-space: nowrap;
  }
  /* 「いま」の印の赤い点 (カレンダーの今日の点と同じ赤) */
  .now-time::before {
    content: "";
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--dp-rec);
  }

  /* ---- 1行に並べる (ホーム) ---- */
  .inline {
    container-type: inline-size;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  /* 左の余白は日付の字にそろえるため。右は空けず、一言をすぐ続ける */
  .inline .now-time {
    flex-shrink: 0;
    padding-right: 0;
    font-size: var(--now-time-size, 0.875rem);
  }
  /* 一言は時刻のすぐ後ろに控えた字で (補足なので、時刻ほど目立たせない) */
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

  /* ---- 時の列に置く (番組表)。表を横切る線は引かず、過ぎた所はマスを沈めて見せる (番組表の `.program` の背景の覆い) ---- */
  .overlay {
    position: relative;
    pointer-events: none;
  }
  /*
     * 高さの半分だけ上げる (`translateY(-50%)`)。字の大きさが変わっても、いまの位置の真ん中に乗る。
     * `sticky` (`left: 0`) で横に流しても左端に残る
     */
  .overlay .now-time {
    position: sticky;
    left: 0;
    z-index: 1;
    display: flex;
    justify-content: center;
    width: fit-content;
    padding: 0 0.25rem;
    border-radius: var(--dp-radius-full);
    background: var(--dp-float);
    box-shadow: var(--dp-shadow-pop);
    transform: translateY(-50%);
    font-size: 0.6875rem;
    line-height: 1rem;
  }
  /* 時の列の幅に収めるため、点は付けない */
  .overlay .now-time::before {
    display: none;
  }
</style>
