<script lang="ts">
  /**
   * **一覧の頭の細い1行** (サイドバーの無い幅 = 1000px 未満だけ。スマホでは下のタブのすぐ上に貼り付く)。絞り込みのチップ (件数付き。1回押せば絞れる。
   * 横に流せる) と、見てほしいこと (競合・失敗・録り逃し・CM の判定) のうち件数のあるものを注意の色のチップで。
   * 右の「⋯」に状態 (エンコード・空き。押せない頭) と表示の切り替え。
   * 広い画面では同じものをサイドバー (`HomeAside`) に置き、この行は出さない
   */
  import { MediaQuery } from "svelte/reactivity";
  import Menu from "#lib/components/Menu.svelte";
  import Icon from "#lib/components/player/Icon.svelte";
  import { ATTENTION_FILTERS, FILTERS, type Filter } from "#lib/timeline.js";
  import Ellipsis from "~icons/lucide/ellipsis";
  import TriangleAlert from "~icons/lucide/triangle-alert";
  import type { Rec } from "./context";
  import HomeState from "./HomeState.svelte";
  import ViewList from "./ViewList.svelte";

  let {
    filter,
    setFilter,
    counts,
    grouped,
    setGrouped,
    finishedHref,
    deletedHref,
    showFinished,
    showDeleted,
    capacity,
    encoding,
  }: {
    filter: Filter;
    /** 絞り込みを替える (見ていた行をその場に残す。`routes/+page.svelte`) */
    setFilter: (next: Filter) => void;
    counts: Record<Filter, number>;
    grouped: boolean;
    setGrouped: (on: boolean) => void;
    finishedHref: string;
    deletedHref: string;
    showFinished: boolean;
    showDeleted: boolean;
    /** 空きと、あと何時間録れるか (`disk.capacity`)。読めなければ null */
    capacity: { free: string; hours: string | null } | null;
    /** エンコードを待っている・している録画 */
    encoding: Rec[];
  } = $props();

  let viewOpen = $state(false);
  /** スマホ (下のタブがある幅) ではこの行は下に貼り付くので、メニューは上に開く */
  const phone = new MediaQuery("max-width: 639.98px");
  /** 見てほしいことのチップ。件数のあるものだけ (選んでいるものは 0 件でも残す。外せるように) */
  const attention = $derived(
    ATTENTION_FILTERS.filter((f) => counts[f.id] > 0 || filter === f.id),
  );
</script>

<div class="t-toolbar" data-testid="timeline-toolbar">
  <div class="t-chips" role="group" aria-label="絞り込み">
    {#each FILTERS as f (f.id)}
      <button
        type="button"
        class="t-chip"
        aria-pressed={filter === f.id}
        onclick={() => setFilter(f.id)}
        data-testid="filter-chip"
        data-filter={f.id}
      >
        {f.label}<span class="num" data-testid="filter-count"
          >{counts[f.id]}</span
        >
      </button>
    {/each}
    {#each attention as f (f.id)}
      <!-- 見てほしいこと。押すとそれで絞り、もう一度押すと「すべて」に戻る -->
      <button
        type="button"
        class="t-chip warn"
        aria-pressed={filter === f.id}
        onclick={() => setFilter(filter === f.id ? "all" : f.id)}
        data-testid="filter-chip"
        data-filter={f.id}
      >
        <Icon icon={TriangleAlert} size="size-4" />{f.label}<span
          class="num"
          data-testid="filter-count">{counts[f.id]}</span
        >
      </button>
    {/each}
  </div>

  <Menu
    bind:open={viewOpen}
    side={phone.current ? "top" : "bottom"}
    align="end"
    class="view-menu"
    testid="view-menu"
  >
    {#snippet trigger(props)}
      <button
        {...props}
        type="button"
        class="ghost icon t-more"
        title="状態と表示の切り替え"
        data-testid="view-toggle"
      >
        <Icon icon={Ellipsis} size="size-5" /><span class="visually-hidden"
          >状態と表示の切り替え</span
        >
        {#if grouped || showDeleted || showFinished}<span
            class="view-dot"
            aria-hidden="true"
          ></span>{/if}
      </button>
    {/snippet}
    <!-- 状態は押せない頭 (サイドバーの無い幅でも読めるように) -->
    {#if encoding.length > 0 || capacity !== null}
      <div class="menu-head">
        <HomeState {encoding} {capacity} where="menu" />
      </div>
    {/if}
    <ViewList
      {grouped}
      {setGrouped}
      {finishedHref}
      {deletedHref}
      {showFinished}
      {showDeleted}
      done={() => (viewOpen = false)}
    />
  </Menu>
</div>
