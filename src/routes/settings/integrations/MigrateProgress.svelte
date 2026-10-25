<script lang="ts">
  import "@anyblades/blades/layered/components/accordion";
  import JobProgress from "#lib/components/JobProgress.svelte";
  import { stateLabel } from "#lib/format.js";
  import type { MigrateStatus } from "#lib/server/migrate.js";

  /**
   * 引き継ぎの進み具合と記録。EPGStation と EDCB の節が同じものを出す
   * (進み具合はサーバに1つだけ。`from` の合う節にだけ出す)。
   * EDCB は録画を持ってこないので、録画の件数は出さない (`recordings`)
   */
  let { migrate, recordings }: { migrate: MigrateStatus; recordings: boolean } =
    $props();

  const done = $derived(migrate.imported + migrate.skipped + migrate.missing);
</script>

<div
  class="progress-block"
  data-testid="migrate-progress"
  data-state={migrate.state}
>
  <div class="cluster small">
    <span class="tag" data-testid="migrate-state">
      {stateLabel(migrate.state)}
    </span>
    <span class="tag">{migrate.apply ? "取り込み" : "下見 (変更なし)"}</span>
    {#if migrate.move}
      <span class="tag">移動</span>
    {/if}
    {#if recordings}
      <span>
        新規 {migrate.imported} 件 / 取り込み済み {migrate.skipped} 件 / ファイル無し
        {migrate.missing}
        件
      </span>
    {/if}
    <span data-testid="migrate-rules">
      ルール {migrate.rules.imported} 件 / 対象外 {migrate.rules.skipped} 件
    </span>
    <span data-testid="migrate-reservations">
      予約 {migrate.reservations.imported} 件 / 対象外 {migrate.reservations
        .skipped} 件
    </span>
    <span data-testid="migrate-history">
      録画の履歴 {migrate.history.imported} 件 / 取り込み済み {migrate.history
        .skipped} 件
    </span>
  </div>

  {#if recordings && migrate.total > 0}
    <JobProgress {done} total={migrate.total}>
      {#if migrate.current}— {migrate.current}{/if}
    </JobProgress>
  {/if}

  {#if migrate.error}
    <div class="notice error" data-testid="migrate-error">
      {migrate.error}
    </div>
  {/if}

  {#if migrate.log.length > 0}
    <details class="log">
      <summary class="small">ログ ({migrate.log.length} 行)</summary>
      <pre data-testid="migrate-log">{migrate.log.join("\n")}</pre>
    </details>
  {/if}
</div>
