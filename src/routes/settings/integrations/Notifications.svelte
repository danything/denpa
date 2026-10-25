<script lang="ts">
  import { submitting } from "#lib/actions.js";
  import { arming } from "#lib/arming.svelte.js";
  import ActionButton from "#lib/components/ActionButton.svelte";
  import ArmedDelete from "#lib/components/ArmedDelete.svelte";
  import Lead from "#lib/components/Lead.svelte";
  import { dateTime } from "#lib/format.js";
  import { EVENT_LABEL } from "#lib/webhook-events.js";

  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  /** 通知先の削除は2回押させる (録画・ルールと同じ。[arming.svelte.ts](../../../lib/arming.svelte.ts)) */
  const deleting = arming('[data-testid^="webhook-delete"]');
</script>

<svelte:window onclick={deleting.stand} />

<div class="sections readable">
  <section class="section">
    <div class="section-head">
      <h2>通知</h2>
    </div>
    <Lead>
      録画の開始・完了・失敗などを外部に通知します
      {#snippet more()}
        <p>
          Discord や Slack の Incoming Webhook の URL をそのまま入れられます。
        </p>
        <p>
          録画の失敗は画面を開くまで気づけないので、せめて「録画失敗」は送っておくと安心です。
        </p>
      {/snippet}
    </Lead>

    <!-- 新しく足す操作なので「追加」のボタンのまま (その場では保存しない) -->
    <form
      method="POST"
      action="?/addWebhook"
      use:submitting
      class="fields setting-rows"
    >
      <label class="field">
        <span class="field-label">URL</span>
        <input name="url" placeholder="https://..." data-testid="webhook-url" />
      </label>
      <div class="field">
        <span class="field-label">送る通知</span>
        <div class="events" data-testid="webhook-events">
          {#each data.events as event (event)}
            <label class="check">
              <input type="checkbox" name="events" value={event} />
              <span class="small">{EVENT_LABEL[event]}</span>
            </label>
          {/each}
        </div>
        <span class="hint">1つも選ばなければ全部送ります</span>
      </div>
      <!-- 欄と同じ右の列に置く (`.field` の中身は右の列) -->
      <div class="field">
        <div>
          <button type="submit" class="small" data-testid="webhook-add"
            >追加</button
          >
        </div>
      </div>
    </form>

    {#if data.webhooks.length > 0}
      <!--
                1件を URL・送る通知・直近の結果・ボタン の順に縦に積む。幅がいくらでも横には出ない
                (URL だけは `text-overflow: ellipsis` で止める)
            -->
      <div class="rows">
        {#each data.webhooks as webhook (webhook.id)}
          <div class="row webhook item" data-testid="webhook-row">
            <div class="url-line">
              <span class="tag {webhook.enabled ? 'success' : ''}">
                {webhook.enabled ? "有効" : "無効"}
              </span>
              <span class="truncate mono tiny">{webhook.url}</span>
            </div>
            <div class="small">
              <span class="muted">送る通知:</span>
              {webhook.events.length === 0
                ? "すべて"
                : webhook.events.map((e) => EVENT_LABEL[e] ?? e).join("・")}
            </div>
            <div class="small">
              <span class="muted">直近の結果:</span>
              {#if webhook.last_sent_at}
                <span class={webhook.last_status === "ok" ? "" : "text-error"}>
                  {webhook.last_status === "ok" ? "成功" : webhook.last_status}
                </span>
                <span class="muted tiny">
                  {dateTime(webhook.last_sent_at)}
                </span>
              {:else}
                <span class="muted">未送信</span>
              {/if}
            </div>
            <div class="cluster row-actions">
              <ActionButton
                action="?/testWebhook"
                fields={{ id: webhook.id }}
                class="small secondary"
                testid="webhook-test"
              >
                テスト送信
              </ActionButton>
              <ActionButton
                action="?/toggleWebhook"
                fields={{ id: webhook.id }}
                class="small secondary"
                testid="webhook-toggle"
              >
                {webhook.enabled ? "無効化" : "有効化"}
              </ActionButton>
              <!-- 押し間違い防止に2回押させる (録画・ルールの削除と同じ) -->
              <ArmedDelete
                {deleting}
                armKey={webhook.id}
                action="?/deleteWebhook"
                fields={{ id: webhook.id }}
                class="small"
                testid="webhook-delete"
              />
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  /* 1 件が 3〜4 行あるので件の面 (`app.css` の `.item`) に乗せ、件の間は余白 (docs/design.md の「何行かある一覧」) */
  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--dp-list-gap);
  }
  .events {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin-top: 0.25rem;
  }
  .webhook {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
  }
  .url-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .url-line .tag {
    flex-shrink: 0;
  }
</style>
