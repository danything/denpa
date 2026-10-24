<script lang="ts">
  import ArrowRight from "~icons/lucide/arrow-right";

  /**
   * 表示の切り替え (まとめて表示・完了した予約も表示・削除済みも表示・ファイルと照合)。
   * オン・オフの印 (`aria-checked`) 付き。頭の1行の「⋯」(`TimelineBar`) とサイドバーの「表示」(`HomeAside`) の中身
   */
  import { submitting } from "#lib/actions.js";
  import Icon from "#lib/components/player/Icon.svelte";

  import type { ViewControls } from "./context";

  let {
    grouped,
    setGrouped,
    finishedHref,
    deletedHref,
    showFinished,
    showDeleted,
    done = () => {},
    variant = "menu",
  }: ViewControls & {
    /** 照合を送り終えたあとにすること (メニューを閉じる) */
    done?: () => void;
    /** 「⋯」の中 (`menu`) か、サイドバーの並び (`list`) か。形と読み上げの役割だけが変わる */
    variant?: "menu" | "list";
  } = $props();
  const item = $derived(
    variant === "menu" ? "menu-item view-item" : "side-item view-item",
  );
  const role = $derived(variant === "menu" ? "menuitemcheckbox" : "switch");
</script>

<!--
    入っているかはスイッチで見せる。「⋯」の中では押したら閉じる (一覧が変わるのを見せる)。
    照合は切り替えではないのでスイッチを付けない
-->
{#snippet toggle(label: string, on: boolean)}
  <span>{label}</span>
  <span class="s-switch" class:on aria-hidden="true"></span>
{/snippet}

<button
  type="button"
  {role}
  class={item}
  aria-checked={grouped}
  onclick={() => setGrouped(!grouped)}
  data-testid="recordings-group-toggle"
>
  {@render toggle("まとめて表示", grouped)}
</button>
<!-- URL で切り替えるのでリンク -->
<a {role} class={item} aria-checked={showFinished} href={finishedHref}>
  {@render toggle("完了した予約も表示", showFinished)}
</a>
<a {role} class={item} aria-checked={showDeleted} href={deletedHref}>
  {@render toggle("削除済みも表示", showDeleted)}
</a>
<!-- 照合は送り終えてから閉じる (先に閉じると、結果の通知が出る前に消える。押している間は回る印) -->
<form
  method="POST"
  action="?/reconcile"
  class="menu-form"
  use:submitting={() => async (options) => {
    await options.update();
    done();
  }}
>
  <button
    type="submit"
    role={variant === "menu" ? "menuitem" : undefined}
    class={item}
    data-keep-open
    data-testid="reconcile-button"
  >
    <span>ファイルと照合</span>
    {#if variant === "list"}<Icon icon={ArrowRight} size="size-4" />{/if}
  </button>
</form>
