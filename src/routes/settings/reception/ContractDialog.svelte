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

  let contracts = $state<ContractRow[]>([]);
  let checking = $state(false);
  let testingServiceId = $state<number | null>(null);
  let errorMessage = $state<string | null>(null);

  /** 契約の確認か復号を確かめている最中 (同時に動かさない) */
  const isBusy = $derived(checking || testingServiceId !== null);

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
        errorMessage = "契約を確認できませんでした";
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
        errorMessage = "復号を確かめられませんでした";
      }
    } catch (err) {
      errorMessage = String(err);
    } finally {
      testingServiceId = null;
    }
  }
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
    </p>

    {#if errorMessage}
      <div class="notice error small" role="alert">
        {errorMessage}
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
                  {#if row.state === "subscribed"}
                    <span class="tag success">契約中</span>
                  {:else if row.state === "expired"}
                    <span class="tag">期限切れ</span>
                  {:else}
                    <span class="tag muted">未契約</span>
                  {/if}
                </td>
                <td class="nowrap num">
                  {row.validUntil ? fullDate(row.validUntil) : "—"}
                </td>
                <td class="decode-cell">
                  {#if row.decodeOk === true}
                    <span class="tag success">復号できました</span>
                  {:else if row.decodeOk === false}
                    <span class="tag error">復号できませんでした</span>
                  {/if}
                  <button
                    type="button"
                    class="ghost small"
                    disabled={isBusy}
                    onclick={() => handleTestDecode(row.serviceId)}
                    data-testid="btn-test-decode-{row.serviceId}"
                  >
                    <ShieldCheck aria-hidden="true" />
                    {testingServiceId === row.serviceId
                      ? "確かめています…"
                      : "復号を確かめる"}
                  </button>
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
        disabled={isBusy}
        onclick={handleCheckContracts}
        data-testid="btn-check-contracts"
      >
        <RefreshCw aria-hidden="true" />
        {checking ? "確認しています…" : "契約を確認し直す"}
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
  .table-wrap {
    overflow-x: auto;
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
