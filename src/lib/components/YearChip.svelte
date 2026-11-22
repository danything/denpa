<script lang="ts">
  import X from "~icons/lucide/x";

  import NewYearMark from "./NewYearMark.svelte";
  import Icon from "./player/Icon.svelte";

  /**
   * **「denpa の 1 年」のチップ** (1 月 1〜7 日、録画の一覧の上。docs/screens.md「季節の演出」)。
   * 押すと去年の数のダイアログ (`YearDialog`) を開き、✕ で閉じるとその年はどの端末にも出さない (`Shell.svelte`)
   */
  let {
    year,
    onopen,
    ondismiss,
  }: {
    /** 数える年 (去年) */
    year: number;
    onopen: () => void;
    ondismiss: () => void;
  } = $props();
</script>

<div class="year-chip" data-testid="year-chip">
  <button
    type="button"
    class="open"
    onclick={onopen}
    data-testid="year-chip-open"
  >
    <NewYearMark testid="year-chip-mark" />
    <span>denpa の {year} 年</span>
  </button>
  <button
    type="button"
    class="ghost xs close"
    onclick={ondismiss}
    aria-label="「denpa の {year} 年」を閉じる"
    data-testid="year-chip-close"
  >
    <Icon icon={X} size="size-4" />
  </button>
</div>

<style>
  /* 淡い面のカプセル (ページの中の通知と同じ `--dp-subtle`)。押せるのは字の所と ✕ */
  .year-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--dp-space-1);
    padding-inline-end: var(--dp-space-1);
    border-radius: var(--dp-radius-full);
    background: var(--dp-subtle);
  }
  .open {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: var(--dp-space-2);
    min-height: var(--dp-btn-h-sm);
    padding-inline: var(--dp-space-3) var(--dp-space-1);
    border-radius: var(--dp-radius-full);
    font-weight: 700;
    cursor: pointer;
  }
  .open:focus-visible {
    outline: 2px solid var(--pico-primary);
    outline-offset: 2px;
  }
  .open :global(.new-year-mark) {
    width: 1.25rem;
    height: 1.25rem;
  }
  .close {
    flex: none;
  }
</style>
