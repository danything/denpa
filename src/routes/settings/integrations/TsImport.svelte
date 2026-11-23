<script lang="ts">
  import "@anyblades/blades/components/accordion";
  import { submitting } from "#lib/actions.js";
  import CheckRow from "#lib/components/CheckRow.svelte";
  import JobProgress from "#lib/components/JobProgress.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import { stateLabel } from "#lib/format.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const job = $derived(data.tsImport.status);
  const roots = $derived(data.tsImport.roots);
  const done = $derived(
    job.imported + job.skipped + job.overlap + job.unreadable + job.failed,
  );
</script>

<!-- 引き継ぎの節と同じ作り (下見 → 取り込み)。ファイルは元の場所に置いたまま使う -->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>録画ファイルの取り込み</h2>
    </div>
    <Lead>
      ほかのソフトで録った TS (<code>.ts</code>・<code>.m2ts</code>) を、<strong
        >元の場所に置いたまま</strong
      >録画に加えます
      {#snippet more()}
        <p>
          TS の中の番組の情報 (局・番組名・放送の時刻)
          を読んで登録し、エンコードの設定どおりにエンコードします。読めないものはファイルの名前と更新時刻で登録します。
        </p>
        <p>
          ファイルは写さず、動かさず、消しません。denpa
          で録画を削除しても、元のファイルは残ります。<strong
            >元のフォルダを消したり動かしたりすると、エンコードしていない録画は観られなくなります。</strong
          >エンコードしたものは保存先に置くので観られます。
        </p>
        <p>
          何度実行しても、取り込み済みのファイルと、同じ番組の録画がもうあるものは飛ばします。中断したものは続きから入ります。
        </p>
      {/snippet}
    </Lead>

    {#if roots.length === 0}
      <p class="muted small" data-testid="ts-import-disabled">
        サーバの環境変数 <code>IMPORT_DIRS</code>
        に取り込むフォルダを書くと使えます。
      </p>
    {:else}
      <!-- 実行の条件なので保存しない。フォルダは入れたものに戻す (`defaultValue`。EPGStation の URL と同じ) -->
      <form method="POST" action="?/tsImport" use:submitting class="fields">
        <label class="field">
          <span class="field-label">取り込むフォルダ</span>
          <input
            name="folder"
            value={data.tsImport.folder}
            defaultValue={data.tsImport.folder}
            class="mono"
            autocomplete="off"
            spellcheck="false"
            data-testid="ts-import-folder"
          />
          <span class="hint">
            サーバから見た場所。<code>{roots.join("、")}</code> とその下のフォルダを指せます
            (サブフォルダも見ます)
          </span>
        </label>
        <CheckRow
          name="apply"
          checked={false}
          testid="ts-import-apply"
          title="取り込む"
          hint="オフのままなら下見だけで、何も変えません"
          detail="何が取り込まれるかを表示するだけで、データベースに触りません。"
        />
        <div class="cluster">
          <button
            type="submit"
            class="small"
            disabled={job.state === "running"}
            data-testid="ts-import-run"
          >
            {job.state === "running" ? "実行中…" : "実行"}
          </button>
          {#if job.state === "running"}
            <!-- 入れ終えたファイルは残るので、次の実行で続きから入る -->
            <button
              type="submit"
              class="small outline danger"
              formaction="?/tsImportCancel"
              data-testid="ts-import-cancel">中断</button
            >
          {/if}
        </div>
      </form>
    {/if}

    {#if job.state !== "idle"}
      <div
        class="progress-block"
        data-testid="ts-import-progress"
        data-state={job.state}
      >
        <div class="cluster small">
          <span class="tag" data-testid="ts-import-state">
            {job.state === "canceled" ? "中断" : stateLabel(job.state)}
          </span>
          <span class="muted">{job.apply ? "取り込み" : "下見 (変更なし)"}</span
          >
          <span data-testid="ts-import-counts">
            新規 {job.imported} 件 / 取り込み済み {job.skipped} 件 / 同じ番組あり
            {job.overlap} 件 / 対象外 {job.unreadable} 件 / 失敗 {job.failed} 件
          </span>
        </div>
        {#if job.total > 0}
          <JobProgress
            {done}
            total={job.total}
            running={job.state === "running"}
          >
            {#if job.current}・{job.current}{/if}
          </JobProgress>
        {/if}
        {#if job.error}
          <div class="notice error" data-testid="ts-import-error">
            {job.error}
          </div>
        {/if}
        {#if job.log.length > 0}
          <details class="log">
            <summary class="small">ログ ({job.log.length} 行)</summary>
            <pre data-testid="ts-import-log">{job.log.join("\n")}</pre>
          </details>
        {/if}
      </div>
    {/if}
  </section>
</div>
