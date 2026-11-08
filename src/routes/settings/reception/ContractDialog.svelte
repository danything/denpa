<script lang="ts">
  import "@anyblades/blades/components/modal";
  import "@anyblades/blades/content/table";
  import { deserialize } from "$app/forms";
  import { untrack } from "svelte";
  import RefreshCw from "~icons/lucide/refresh-cw";
  import ShieldCheck from "~icons/lucide/shield-check";
  import X from "~icons/lucide/x";

  import { fullDate, SERVICE_TYPE_LABEL } from "#lib/format.js";
  import type { ContractRow } from "#lib/server/contracts.js";

  let {
    open,
    cardId,
    initialContracts = [],
    onclose,
  }: {
    open: boolean;
    cardId: string | null;
    initialContracts: ContractRow[];
    onclose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let box = $state<HTMLElement | null>(null);

  /** 表の行。持ち主の値から始め、確かめ直したらその答えで置き換える */
  let contracts = $derived(initialContracts);
  /** 動いている操作 (同時に動かさない)。局ごとの復号は `decode:<局の ID>` */
  let busy = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);
  /** まとめて確かめた結果 */
  let resultMessage = $state<string | null>(null);

  /** まだ確かめていない局があるか (まとめて確かめるボタン) */
  const hasUnverified = $derived(
    contracts.some((row) => row.status === "unverified"),
  );

  /**
   * action を呼び、答えの `contracts` で表を置き換える。失敗したらサーバの言葉 (無ければ `failed`) を出す。
   * `done` は成功した答えから結果の 1 行を作る
   */
  async function run(
    key: string,
    action: string,
    failed: string,
    form = new FormData(),
    done?: (payload: Record<string, unknown>) => string | null,
  ): Promise<void> {
    if (busy !== null) return;
    busy = key;
    errorMessage = null;
    resultMessage = null;
    try {
      const res = await fetch(`?/${action}`, { method: "POST", body: form });
      const data = deserialize(await res.text());
      const answer =
        data.type === "success" || data.type === "failure"
          ? data.data
          : undefined;
      const payload: Record<string, unknown> = answer ?? {};
      const rows = payload["contracts"];
      if (data.type === "success" && Array.isArray(rows)) {
        contracts = rows as ContractRow[];
        resultMessage = done?.(payload) ?? null;
      } else {
        const message = payload["message"];
        errorMessage = message ? String(message) : failed;
      }
    } catch (err) {
      errorMessage = String(err);
    } finally {
      busy = null;
    }
  }

  function checkContracts(): Promise<void> {
    return run("check", "checkContracts", "契約を確認できませんでした");
  }

  function testUnverified(): Promise<void> {
    return run(
      "unverified",
      "testDecodeUnverified",
      "復号を確かめられませんでした",
      undefined,
      (payload) => {
        const tested = Number(payload["tested"] ?? 0);
        const skipped = Number(payload["skipped"] ?? 0);
        const parts: string[] = [];
        if (tested > 0) parts.push(`${tested} 局の復号を確かめました`);
        if (skipped > 0)
          parts.push(
            `${skipped} 局は、いま有料の番組を流していないなどの理由で確かめられませんでした`,
          );
        return parts.join("。") || null;
      },
    );
  }

  function testDecode(serviceId: number): Promise<void> {
    const form = new FormData();
    form.append("serviceId", String(serviceId));
    return run(
      `decode:${serviceId}`,
      "testDecode",
      "復号を確かめられませんでした",
      form,
    );
  }

  $effect(() => {
    const shouldOpen = open;
    const element = dialog;
    if (element === null) return;
    untrack(() => {
      if (shouldOpen) {
        if (!element.open) {
          element.showModal();
          box?.focus();
        }
      } else {
        if (element.open) element.close();
      }
    });
  });
</script>

<dialog
  bind:this={dialog}
  {onclose}
  aria-labelledby="contract-dialog-title"
  data-testid="contract-dialog"
>
  <!-- 幕を押したら閉じる (`app.css` の `.modal-backdrop`) -->
  <button
    type="button"
    class="modal-backdrop"
    tabindex="-1"
    aria-label="閉じる"
    onclick={() => dialog?.close()}
  ></button>
  <article class="modal-box modal-box-wide" bind:this={box} tabindex="-1">
    <button
      type="button"
      class="ghost icon small modal-close"
      onclick={() => dialog?.close()}
      aria-label="閉じる"
      data-testid="contract-close"
    >
      <X aria-hidden="true" />
    </button>
    <h2 id="contract-dialog-title">有料契約の確認</h2>
    <p class="small muted intro">
      {#if cardId}
        <span class="mono">B-CAS: {cardId}</span><br />
      {/if}
      カードにある契約の情報 (CA 契約情報) から、局ごとの契約と有効期限を出します。
      選局しないので、チューナーは使いません。「復号を確かめる」は、その局を受信して復号できるかを確かめます。
      カードに聞けない局は、復号を確かめるか、有料の番組を録るまで「確かめていない」のままです。
      「確かめていない局の復号を確かめる」は、そうした局をチャンネルごとに 1 回の選局でまとめて確かめます。
    </p>

    {#if errorMessage}
      <div class="notice error small" role="alert">
        {errorMessage}
      </div>
    {/if}
    {#if resultMessage}
      <div class="notice info small" role="status">
        {resultMessage}
      </div>
    {/if}

    {#if contracts.length === 0}
      <p class="small muted empty">
        有料の局が無いか、その局の番組表をまだ集めていません
      </p>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>局</th>
              <th>チャンネル</th>
              <th>契約</th>
              <th>有効期限</th>
              <th>復号</th>
            </tr>
          </thead>
          <tbody>
            {#each contracts as row (row.serviceId)}
              <tr>
                <td class="name-cell">
                  <strong>{row.serviceName}</strong>
                </td>
                <td class="nowrap">
                  {SERVICE_TYPE_LABEL[row.type] ?? row.type}
                  <span class="mono">{row.channel}</span>
                </td>
                <td>
                  {#if row.status === "subscribed"}
                    <span class="tag success">契約中</span>
                  {:else if row.status === "expired"}
                    <span class="tag">期限切れ</span>
                  {:else if row.status === "unsubscribed"}
                    <span class="tag muted">未契約</span>
                  {:else}
                    <span class="tag warning">確かめていない</span>
                  {/if}
                </td>
                <td class="nowrap num">
                  {row.validUntil ? fullDate(row.validUntil) : "—"}
                </td>
                <td
                  ><div class="decode-cell">
                    {#if row.decodeOk === true}
                      <span class="tag success">復号できました</span>
                    {:else if row.decodeOk === false}
                      <span class="tag error">復号できませんでした</span>
                    {/if}
                    <button
                      type="button"
                      class="ghost small"
                      disabled={busy !== null}
                      onclick={() => testDecode(row.serviceId)}
                      data-testid="btn-test-decode-{row.serviceId}"
                    >
                      <ShieldCheck aria-hidden="true" />
                      {busy === `decode:${row.serviceId}`
                        ? "確かめています…"
                        : "復号を確かめる"}
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- 押すものは右下 (docs/design.md の「メニュー・ダイアログ・検索の候補」) -->
    <footer class="modal-actions">
      <button
        type="button"
        class="secondary"
        disabled={busy !== null || !hasUnverified}
        onclick={testUnverified}
        data-testid="btn-test-decode-unverified"
      >
        <ShieldCheck aria-hidden="true" />
        {busy === "unverified"
          ? "確かめています…"
          : "確かめていない局の復号を確かめる"}
      </button>
      <button
        type="button"
        class="secondary"
        disabled={busy !== null}
        onclick={checkContracts}
        data-testid="btn-check-contracts"
      >
        <RefreshCw aria-hidden="true" />
        {busy === "check" ? "確認しています…" : "契約を確認し直す"}
      </button>
    </footer>
  </article>
</dialog>

<style>
  /* 表を並べるので、ほかの窓より広い */
  .modal-box-wide {
    max-width: 48rem;
  }
  .intro {
    margin: var(--dp-space-1) 0 var(--dp-space-4);
  }
  table {
    width: 100%;
    font-size: var(--dp-text-sm);
  }
  th,
  td {
    vertical-align: middle;
  }
  .name-cell {
    white-space: nowrap;
  }
  .decode-cell {
    display: flex;
    align-items: center;
    gap: var(--dp-space-2);
    white-space: nowrap;
  }
  .decode-cell button {
    margin: 0;
  }
  .empty {
    margin: var(--dp-space-4) 0;
    text-align: center;
  }
</style>
