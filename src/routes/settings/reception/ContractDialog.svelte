<script lang="ts">
  import "@anyblades/blades/components/modal";
  import "@anyblades/blades/content/table";
  import { deserialize } from "$app/forms";
  import { untrack } from "svelte";
  import RefreshCw from "~icons/lucide/refresh-cw";
  import ShieldCheck from "~icons/lucide/shield-check";
  import X from "~icons/lucide/x";

  import type { ContractRow, DecodeTestResult } from "#lib/server/contracts.js";

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

  let contracts = $state<ContractRow[]>([]);
  let checking = $state(false);
  let testingAll = $state(false);
  let testingServiceId = $state<number | null>(null);
  let errorMessage = $state<string | null>(null);
  let infoMessage = $state<string | null>(null);

  /** 契約の確認か復号テストの最中 (同時に動かさない) */
  const isBusy = $derived(checking || testingAll || testingServiceId !== null);

  $effect(() => {
    contracts = initialContracts;
  });

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

  function formatDate(ms: number | null): string {
    if (!ms) return "—";
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  }

  async function handleCheckContracts() {
    if (isBusy) return;
    checking = true;
    errorMessage = null;
    try {
      const res = await fetch("?/checkContracts", {
        method: "POST",
        body: new FormData(),
      });
      const data = deserialize(await res.text());
      const payload =
        data.type === "success" || data.type === "failure"
          ? (data.data as Record<string, unknown> | undefined)
          : undefined;
      const contractsList = payload?.["contracts"];
      const message = payload?.["message"];
      if (data.type === "success" && Array.isArray(contractsList)) {
        contracts = contractsList as ContractRow[];
      } else if (message) {
        errorMessage = String(message);
      } else {
        errorMessage = "契約確認に失敗しました";
      }
    } catch (err) {
      errorMessage = String(err);
    } finally {
      checking = false;
    }
  }

  async function handleTestDecode(serviceId: number) {
    if (isBusy) return;
    testingServiceId = serviceId;
    errorMessage = null;
    try {
      const form = new FormData();
      form.append("serviceId", String(serviceId));
      const res = await fetch("?/testDecode", {
        method: "POST",
        body: form,
      });
      const data = deserialize(await res.text());
      const payload =
        data.type === "success" || data.type === "failure"
          ? (data.data as Record<string, unknown> | undefined)
          : undefined;
      const decodeOk = payload?.["decodeOk"];
      const message = payload?.["message"];
      if (data.type === "success" && typeof decodeOk === "boolean") {
        contracts = contracts.map((c) =>
          c.serviceId === serviceId
            ? { ...c, decodeOk, checkedAt: Date.now() }
            : c,
        );
      } else if (message) {
        errorMessage = String(message);
      } else {
        errorMessage = "復号テストに失敗しました";
      }
    } catch (err) {
      errorMessage = String(err);
    } finally {
      testingServiceId = null;
    }
  }

  async function handleTestDecodeAll() {
    if (isBusy) return;
    testingAll = true;
    errorMessage = null;
    infoMessage = null;
    try {
      const res = await fetch("?/testDecodeAll", {
        method: "POST",
        body: new FormData(),
      });
      const data = deserialize(await res.text());
      const payload =
        data.type === "success" || data.type === "failure"
          ? (data.data as Record<string, unknown> | undefined)
          : undefined;
      const results = payload?.["results"] as DecodeTestResult[] | undefined;
      const contractsList = payload?.["contracts"];
      const message = payload?.["message"];
      if (data.type === "success" && Array.isArray(results)) {
        if (Array.isArray(contractsList)) {
          contracts = contractsList as ContractRow[];
        }
        if (results.length === 0) {
          infoMessage = "まとめて確かめる対象の局がありませんでした";
        } else {
          const tested = results.filter((r) => r.ok);
          const ok = tested.filter((r) => r.decodeOk).length;
          const ng = tested.length - ok;
          const failed = results.length - tested.length;
          const parts = [`復号テスト: ${ok}局成功`];
          if (ng > 0) parts.push(`${ng}局は復号不可`);
          if (failed > 0) parts.push(`${failed}局は確認できませんでした`);
          infoMessage = parts.join(" / ");
        }
      } else if (message) {
        errorMessage = String(message);
      } else {
        errorMessage = "まとめて復号テストに失敗しました";
      }
    } catch (err) {
      errorMessage = String(err);
    } finally {
      testingAll = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  {onclose}
  aria-labelledby="contract-dialog-title"
  data-testid="contract-dialog"
>
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
    <div class="header-group">
      <h2 id="contract-dialog-title">有料契約の確認</h2>
      {#if cardId}
        <span class="card-id mono">B-CAS: {cardId}</span>
      {/if}
    </div>
    <p class="small muted intro">
      B-CAS
      カード内の契約情報（CA契約情報）を確認し、各局の契約状態と有効期限を表示します。
      選局せずにカードのみで判定するため、チューナーを塞ぎません。
      また、「復号を確かめる」で実際の放送ストリームを受信し、正常に復号できるかを検証できます。
      「未確認をまとめて復号テスト」は、同じ中継器の局をまとめて1回の選局で確かめます。
    </p>

    {#if errorMessage}
      <div class="alert error" role="alert">
        {errorMessage}
      </div>
    {/if}
    {#if infoMessage}
      <div class="alert info" role="status">
        {infoMessage}
      </div>
    {/if}

    <div class="toolbar">
      <button
        type="button"
        class="secondary small"
        disabled={isBusy}
        onclick={handleCheckContracts}
        data-testid="btn-check-contracts"
      >
        <RefreshCw class={checking ? "spin" : ""} aria-hidden="true" />
        {checking ? "確認中…" : "契約情報を再確認"}
      </button>

      <button
        type="button"
        class="secondary small"
        disabled={isBusy}
        onclick={handleTestDecodeAll}
        data-testid="btn-test-decode-all"
      >
        <ShieldCheck class={testingAll ? "spin" : ""} aria-hidden="true" />
        {testingAll ? "まとめて検証中…" : "未確認をまとめて復号テスト"}
      </button>
    </div>

    {#if contracts.length === 0}
      <p class="muted empty">
        有料放送の番組情報がまだ取得されていないか、有料局がありません。
      </p>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>局名</th>
              <th>種別</th>
              <th>契約状態</th>
              <th>有効期限</th>
              <th>復号テスト</th>
            </tr>
          </thead>
          <tbody>
            {#each contracts as row (row.serviceId)}
              <tr>
                <td class="name-cell">
                  <strong>{row.serviceName}</strong>
                </td>
                <td>
                  <span class="mono">{row.type} / {row.channel}</span>
                </td>
                <td>
                  {#if row.state === "subscribed"}
                    <span class="tag success">契約中</span>
                  {:else if row.state === "expired"}
                    <span class="tag">期限切れ</span>
                  {:else}
                    <span class="tag muted">未契約</span>
                  {/if}
                </td>
                <td>
                  <span class="mono">{formatDate(row.validUntil)}</span>
                </td>
                <td class="decode-cell">
                  {#if row.decodeOk === true}
                    <span class="tag success">復号成功</span>
                  {:else if row.decodeOk === false}
                    <span class="tag error">復号不可</span>
                  {:else}
                    <span class="small muted">未確認</span>
                  {/if}
                  <button
                    type="button"
                    class="ghost small test-btn"
                    disabled={isBusy}
                    onclick={() => handleTestDecode(row.serviceId)}
                    data-testid="btn-test-decode-{row.serviceId}"
                  >
                    <ShieldCheck aria-hidden="true" />
                    {testingServiceId === row.serviceId
                      ? "検証中…"
                      : "復号を確かめる"}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </article>
</dialog>

<style>
  .modal-box-wide {
    max-width: 48rem;
    width: 100%;
  }

  .header-group {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .card-id {
    font-size: 0.875rem;
    color: var(--dp-muted, #888);
  }

  .intro {
    margin-block: 0.5rem 1rem;
    line-height: 1.5;
  }

  .toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 0.75rem;
  }

  .table-wrap {
    overflow-x: auto;
    max-height: 60vh;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  th,
  td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    vertical-align: middle;
  }

  .name-cell {
    white-space: nowrap;
  }

  .decode-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .test-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
  }

  .alert.error {
    background-color: var(--dp-error-bg, rgba(239, 68, 68, 0.1));
    color: var(--dp-error, #ef4444);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    margin-bottom: 0.75rem;
    font-size: 0.875rem;
  }

  .alert.info {
    background-color: var(--dp-info-bg, rgba(59, 130, 246, 0.1));
    color: var(--dp-info, #3b82f6);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    margin-bottom: 0.75rem;
    font-size: 0.875rem;
  }

  :global(.spin) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .empty {
    text-align: center;
    padding: 2rem;
  }
</style>
