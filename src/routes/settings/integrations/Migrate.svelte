<script lang="ts">
  import { submitting } from "#lib/actions.js";
  import CheckRow from "#lib/components/CheckRow.svelte";
  import Lead from "#lib/components/Lead.svelte";

  import type { PageData } from "./$types";
  import MigrateProgress from "./MigrateProgress.svelte";

  let { data }: { data: PageData } = $props();

  const migrate = $derived(data.migrate.status);
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
          のフォルダ構成に置き直し、番組情報とサムネイルも作ります。
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

    {#if migrate.state !== "idle" && migrate.from === "epgstation"}
      <MigrateProgress {migrate} recordings />
    {/if}
  </section>
</div>
