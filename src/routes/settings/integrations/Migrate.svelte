<script lang="ts">
  import { submitting } from "#lib/actions.js";
  import CheckRow from "#lib/components/CheckRow.svelte";
  import Lead from "#lib/components/Lead.svelte";

  import type { PageData } from "./$types";
  import MigrateProgress from "./MigrateProgress.svelte";

  let { data }: { data: PageData } = $props();

  const migrate = $derived(data.migrate.status);
  /** EPGStation の取り込みが走っている間だけ「中断」を出す (EDCB は数秒で終わるので止めない) */
  const runningHere = $derived(
    migrate.state === "running" && migrate.from === "epgstation",
  );
</script>

<!-- **たまにしか触らないもの。** 引っ越しのときだけ使う -->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>EPGStation からの引き継ぎ</h2>
    </div>
    <Lead>
      EPGStation (v2・v3) から<strong>ルール・手動予約・録画</strong
      >を取り込みます
      {#snippet more()}
        <p>
          EPGStation の API から読み、録画のファイルも API
          で取ってきます。録画は denpa
          のフォルダ構成に置き直し、番組情報とサムネイルも作ります。EPGStation
          側のファイルは消しません。
        </p>
        <p>
          何度実行しても、取り込み済みのものは飛ばします。中断したものは続きから取ります。ルールによる予約は、取り込んだルールから
          denpa が作り直します。
        </p>
      {/snippet}
    </Lead>

    <!--
      実行の条件なので、変えても保存しない。「実行」で送る。送ったあとフォームは戻る (「取り込む」は外れる) が、
      URL は入れたものに戻す (`defaultValue`。値が変わらないと `value` は入れ直されず、空に戻っていた)
    -->
    <form method="POST" action="?/migrate" use:submitting class="fields">
      <label class="field">
        <span class="field-label">EPGStation の URL</span>
        <input
          name="url"
          value={data.migrate.epgstationUrl}
          defaultValue={data.migrate.epgstationUrl}
          class="mono"
          placeholder="http://epgstation:8888"
          autocomplete="off"
          spellcheck="false"
          data-testid="epgstation-url"
        />
        <span class="hint">
          denpa のサーバから届く URL。サブディレクトリも含めて書きます。Basic
          認証があれば <code>http://ユーザー:パスワード@…</code> の形で。保存はしません
        </span>
      </label>
      <CheckRow
        name="apply"
        checked={false}
        testid="migrate-apply"
        title="取り込む"
        hint="外したままなら下見だけで、何も変えません"
        detail="何が取り込まれるか、取ってくる大きさと置き場の空きを表示するだけで、ファイルにもデータベースにも触りません。"
      />
      <div class="cluster">
        <button
          type="submit"
          class="small"
          disabled={migrate.state === "running"}
          data-testid="migrate-run"
        >
          {migrate.state === "running" ? "実行中…" : "実行"}
        </button>
        {#if runningHere}
          <!-- 書きかけは残るので、次の実行で続きから取る -->
          <button
            type="submit"
            class="small outline danger"
            formaction="?/migrateCancel"
            data-testid="migrate-cancel">中断</button
          >
        {/if}
      </div>
    </form>

    {#if migrate.state !== "idle" && migrate.from === "epgstation"}
      <MigrateProgress {migrate} recordings />
    {/if}
  </section>
</div>
