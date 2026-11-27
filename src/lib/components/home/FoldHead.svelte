<script lang="ts">
  import ChevronRight from "~icons/lucide/chevron-right";

  /**
   * **たたんだ予約の見出し** (新しい順で表示のとき。`#lib/timeline.ts` の `LineOptions.fold`)。押すと開く・閉じる。
   * 番組の見出し (`GroupHead`) と同じ形と同じ開け閉めの印にする。開いているかは覚えない (読み直すとたたむ)
   */
  import Icon from "#lib/components/player/Icon.svelte";

  import { home } from "./context";

  let { count, open }: { count: number; open: boolean } = $props();
  const ctx = home();
</script>

<button
  type="button"
  class="group-head fold-head item"
  aria-expanded={open}
  onclick={() => ctx.toggleFold()}
  data-testid="reservations-fold"
>
  <span class="group-chevron" class:open aria-hidden="true">
    <Icon icon={ChevronRight} size="size-4" />
  </span>
  <span class="row-body">
    <span class="title-line">
      <span class="row-name">これからの予約</span>
      <span class="tiny muted num nowrap" data-testid="reservations-fold-count"
        >{count} 件</span
      >
    </span>
  </span>
</button>
