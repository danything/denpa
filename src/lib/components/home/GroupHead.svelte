<script lang="ts">
  import ChevronRight from "~icons/lucide/chevron-right";

  /**
   * **番組の見出し** (まとめて表示)。押すと開く・閉じる。本物の button なので、Tab で辿れて Enter / Space で開く。
   * 同じ番組でも線の上 (録画) と下 (予約) で別の見出し (`#lib/timeline.ts`)
   */
  import Icon from "#lib/components/player/Icon.svelte";
  import { dateTime } from "#lib/format.js";
  import type { SeriesGroup } from "#lib/grouping.js";

  import { home, type Item } from "./context";
  import Poster from "./Poster.svelte";

  let {
    group,
    zone,
    open,
  }: { group: SeriesGroup<Item>; zone: "future" | "past"; open: boolean } =
    $props();
  const ctx = home();

  const posterRec = $derived(
    group.items.findLast(
      (item) =>
        item.kind === "rec" &&
        item.rec.library_path !== null &&
        item.rec.deleted_at === null,
    ),
  );
  const fresh = $derived(
    group.items.filter((item) => item.kind === "rec" && ctx.unwatched(item.rec))
      .length,
  );
  const next = $derived(
    zone === "future" ? (group.items[0] ?? group.newest) : group.newest,
  );
</script>

<button
  type="button"
  class="group-head item"
  aria-expanded={open}
  onclick={() => ctx.toggleGroup(zone, group.group)}
  data-testid="recording-group"
  data-zone={zone}
  data-group={group.group}
  data-group-rows={group.items.map((item) => item.key).join(" ")}
>
  <span class="group-chevron" class:open aria-hidden="true">
    <Icon icon={ChevronRight} size="size-4" />
  </span>
  <span class="t-thumb" aria-hidden="true">
    {#if posterRec?.kind === "rec"}
      <Poster id={posterRec.rec.id} />
    {/if}
  </span>
  <span class="row-body">
    <span class="cluster title-line">
      <span class="tiny muted num nowrap" data-testid="recording-group-count"
        >{group.items.length}本</span
      >
      {#if fresh > 0}
        <span class="group-unwatched tiny">
          <span class="fresh-dot" aria-hidden="true"></span>未視聴{fresh}
        </span>
      {/if}
      <span class="row-name broadcast" data-testid="recording-group-name"
        >{group.name}</span
      >
    </span>
    <span class="row-meta num">
      {zone === "future"
        ? `次 ${dateTime(next.at)}`
        : `最新 ${dateTime(group.newest.at)}`}
    </span>
  </span>
</button>
<!--
    開いた番組の頭に「ルールを作る」。見出しは開閉のボタンなので中には入れられない (押せる場所が入れ子になる)。
    元は録画ならいちばん新しい録画、予約なら次の回の番組
-->
{#if open}
  {@const recSource = group.items.findLast((item) => item.kind === "rec")}
  {@const href =
    recSource?.kind === "rec"
      ? ctx.ruleFrom("recording", recSource.rec.id)
      : next.kind === "res" && next.res.program_id !== null
        ? ctx.ruleFrom("program", next.res.program_id)
        : null}
  {#if href !== null}
    <div class="group-tools">
      <a class="button small secondary outline" {href} data-testid="group-rule"
        >ルールを作る</a
      >
    </div>
  {/if}
{/if}
