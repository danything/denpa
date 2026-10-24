<script lang="ts">
  import "@anyblades/blades/layered/components/accordion";
  import { submitting } from "#lib/actions.js";
  import CheckRow from "#lib/components/CheckRow.svelte";
  import JobProgress from "#lib/components/JobProgress.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import { stateLabel } from "#lib/format.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const migrate = $derived(data.migrate.status);
  const done = $derived(migrate.imported + migrate.skipped + migrate.missing);
</script>

<!-- **たまにしか触らないもの。** 引っ越しのときだけ使う -->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>EPGStation からの引き継ぎ</h2>
    </div>
    <Lead>
      EPGStation から<strong>ルール・手動予約・録画</strong>を取り込みます
      {#snippet more()}
        <p>
          EPGStation のデータベースから読みます。録画は denpa
          のフォルダ構成に置き直し、 番組情報とサムネイルも作ります。
        </p>
        <p>
          何度実行しても、取り込み済みのものは飛ばします。ルールによる予約は、取り込んだルールから
          denpa が作り直します。
        </p>
      {/snippet}
    </Lead>

    {#if !data.migrate.available}
      <div class="notice warning" data-testid="migrate-unavailable">
        引き継ぎ元 <code>{data.migrate.source}</code> が見つかりません。denpa の Pod
        に EPGStation の録画PVCをマウントしてください。
      </div>
    {:else}
      <!-- 実行の条件なので、変えても保存しない。「実行」で送る -->
      <form method="POST" action="?/migrate" use:submitting class="fields">
        <CheckRow
          name="apply"
          checked={false}
          testid="migrate-apply"
          title="取り込む"
          hint="外したままなら下見だけで、何も変えません"
          detail="何が取り込まれるかを表示するだけで、ファイルにもデータベースにも触りません。"
        />
        <CheckRow
          name="move"
          checked={false}
          title="コピーではなく移動する"
          hint="空き容量が足りないときだけ移動にしてください"
          detail="既定はコピーです。中身を確かめてから EPGStation 側を消せます。"
        />
        <div>
          <button
            type="submit"
            class="small"
            disabled={migrate.state === "running"}
            data-testid="migrate-run"
          >
            {migrate.state === "running" ? "実行中…" : "実行"}
          </button>
        </div>
      </form>
    {/if}

    {#if migrate.state !== "idle"}
      <div
        class="progress-block"
        data-testid="migrate-progress"
        data-state={migrate.state}
      >
        <div class="cluster small">
          <span class="tag" data-testid="migrate-state">
            {stateLabel(migrate.state)}
          </span>
          <span class="tag"
            >{migrate.apply ? "取り込み" : "下見 (変更なし)"}</span
          >
          {#if migrate.move}
            <span class="tag">移動</span>
          {/if}
          <span>
            新規 {migrate.imported} 件 / 取り込み済み {migrate.skipped} 件 / ファイル無し
            {migrate.missing}
            件
          </span>
          <span>
            ルール {migrate.rules.imported} 件 / 対象外 {migrate.rules.skipped} 件
          </span>
          <span>
            予約 {migrate.reservations.imported} 件 / 対象外 {migrate
              .reservations.skipped} 件
          </span>
        </div>

        {#if migrate.total > 0}
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
            <summary class="small bold">
              ログ ({migrate.log.length} 行)
            </summary>
            <pre data-testid="migrate-log">{migrate.log.join("\n")}</pre>
          </details>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  /* 記録はコードと同じ淡い面 (枠は付けない) */
  .log {
    border-radius: var(--dp-radius);
    background: var(--dp-subtle);
  }
  .log summary {
    padding: 0.5rem 1rem;
  }
  .log pre {
    max-height: 16rem;
    overflow: auto;
    margin: 0;
    padding: 0 1rem 0.75rem;
    font-size: var(--dp-text-xs);
  }
</style>
