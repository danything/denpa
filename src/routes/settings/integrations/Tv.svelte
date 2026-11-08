<script lang="ts">
  import { arming } from "#lib/arming.svelte.js";
  import ArmedDelete from "#lib/components/ArmedDelete.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import { dateTime } from "#lib/format.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  /** 取消は 2 回押させる (削除と同じ `arming`)。取り消したテレビはペアリングし直しになり、戻せない */
  const revoking = arming('[data-testid^="device-revoke"]');
</script>

<svelte:window onclick={revoking.stand} />

<!--
    テレビのアプリ (danything/denpa-tv) に渡したアクセストークン。家の外から OIDC 越しに使うテレビは
    QR でペアリングしてアクセストークンを持つ (信頼するネットワークの中なら要らない)。
    なくしたテレビ・手放したテレビはここで止める
-->
<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>テレビのアプリ</h2>
    </div>
    <Lead
      >QR
      でペアリングしたテレビです。取り消すと、そのテレビはペアリングし直しになります</Lead
    >
    <!-- 使ってよいのは同じ世帯の中だけ (README「使ってよい範囲」・docs/auth.md) -->
    <Lead
      >ログインのアカウントもペアリングするテレビも、同じ世帯の人の分だけにしてください</Lead
    >
    {#if data.devices.length === 0}
      <p class="small muted">まだありません</p>
    {:else}
      <div class="item-list">
        {#each data.devices as device (device.id)}
          <div class="device item" data-testid="device-row">
            <div class="grow">
              <div><strong>{device.name}</strong></div>
              <div class="small muted">
                ペアリング {dateTime(device.created_at)}・最後に使った
                {device.last_used_at === null
                  ? "まだ"
                  : dateTime(device.last_used_at)}
              </div>
            </div>
            <div class="row-actions">
              <ArmedDelete
                deleting={revoking}
                armKey={device.id}
                action="?/revokeDevice"
                fields={{ id: device.id }}
                class="small"
                testid="device-revoke"
                label="取消"
                confirmLabel="取消を確定"
              />
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  /* 1 件が 2 行あるので件の面 (`app.css` の `.item`) に乗せ、並べ方は `.item-list` (docs/design.md の「何行かある一覧」) */
  .device {
    display: flex;
    align-items: center;
    gap: var(--dp-space-3);
    min-height: var(--dp-item-h);
    padding: var(--dp-space-2) var(--dp-space-3);
  }
</style>
