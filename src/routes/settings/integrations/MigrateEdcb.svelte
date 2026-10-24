<script lang="ts">
  import "@anyblades/blades/layered/components/accordion";
  import { submitting } from "#lib/actions.js";
  import CheckRow from "#lib/components/CheckRow.svelte";
  import Lead from "#lib/components/Lead.svelte";

  import type { PageData } from "./$types";
  import MigrateProgress from "./MigrateProgress.svelte";

  let { data }: { data: PageData } = $props();

  const migrate = $derived(data.migrate.status);
</script>

<!-- EPGStation の節と同じ作り。進み具合はサーバに1つだけなので、EDCB を走らせたときだけここに出す -->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>EDCB からの引き継ぎ</h2>
    </div>
    <Lead>
      EDCB (EpgTimer) から<strong>ルール・手動予約・録画の履歴</strong
      >を取り込みます
      {#snippet more()}
        <p>
          EDCB の設定フォルダ (<code>Setting</code>) にある
          <code>EpgAutoAdd.txt</code>・<code>Reserve.txt</code>・<code
            >RecInfo2.txt</code
          >・<code>RecInfo.txt</code> を読みます。フォルダは denpa のサーバから見える場所に写してください。録画のファイルは取り込みません。
        </p>
        <p>
          何度実行しても、取り込み済みのものは飛ばします。ルールによる予約は、取り込んだルールから
          denpa が作り直します。
        </p>
      {/snippet}
    </Lead>

    <!-- 実行の条件なので、変えても保存しない。「実行」で送る -->
    <form method="POST" action="?/migrateEdcb" use:submitting class="fields">
      <label class="field">
        <span class="field-label">設定フォルダ</span>
        <input
          name="dir"
          value={data.migrate.edcbDir}
          class="mono"
          placeholder="/edcb/Setting"
          autocomplete="off"
          spellcheck="false"
          data-testid="edcb-dir"
        />
        <span class="hint">
          サーバから見えるパス。EDCB で保存先 (<code>Common.ini</code> の
          <code>DataSavePath</code>) を変えていれば、そのフォルダ
        </span>
      </label>
      <CheckRow
        name="apply"
        checked={false}
        testid="edcb-apply"
        title="取り込む"
        hint="外したままなら下見だけで、何も変えません"
        detail="何が取り込まれるかを表示するだけで、データベースに触りません。"
      />
      <div>
        <button
          type="submit"
          class="small"
          disabled={migrate.state === "running"}
          data-testid="edcb-run"
        >
          {migrate.state === "running" ? "実行中…" : "実行"}
        </button>
      </div>
    </form>

    {#if migrate.state !== "idle" && migrate.from === "edcb"}
      <MigrateProgress {migrate} recordings={false} />
    {/if}
  </section>
</div>
