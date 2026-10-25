<script lang="ts">
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
          EpgTimerSrv に TCP で繋いで読みます (EpgTimerNW と同じ方法)。先に
          EpgTimer の設定で「ネットワーク接続を許可する」を入れ、アクセス制御に
          denpa の IP
          を足してください。録画のファイルと、録画済みの一覧から消した回は取り込みません。
        </p>
        <p>
          何度実行しても、取り込み済みのものは飛ばします。ルールによる予約は、取り込んだルールから
          denpa が作り直します。
        </p>
      {/snippet}
    </Lead>

    <!--
      実行の条件なので、変えても保存しない。「実行」で送る。送ったあとも宛先は入れたものに戻す
      (`defaultValue`。EPGStation の URL と同じ)
    -->
    <form method="POST" action="?/migrateEdcb" use:submitting class="fields">
      <label class="field">
        <span class="field-label">EpgTimerSrv の宛先</span>
        <input
          name="target"
          value={data.migrate.edcbTarget}
          defaultValue={data.migrate.edcbTarget}
          class="mono"
          placeholder="192.168.1.10:4510"
          autocomplete="off"
          spellcheck="false"
          data-testid="edcb-target"
        />
        <span class="hint">
          IP とポート (既定 4510)。denpa を wslc で動かしているなら、Windows
          の「vEthernet (Default Switch)」の IP。保存はしません
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
