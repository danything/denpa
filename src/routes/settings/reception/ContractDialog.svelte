<script lang="ts">
  import "@anyblades/blades/components/modal";
  import "@anyblades/blades/content/table";
  import { deserialize } from "$app/forms";
  import { untrack } from "svelte";
  import RefreshCw from "~icons/lucide/refresh-cw";
  import ShieldCheck from "~icons/lucide/shield-check";
  import X from "~icons/lucide/x";

  import type {
    ContractRow,
    ContractSettings,
    DecodeTestResult,
  } from "#lib/server/contracts.js";

  let {
    open,
    cardId,
    initialContracts = [],
    initialSettings,
    onclose,
  }: {
    open: boolean;
    cardId: string | null;
    initialContracts: ContractRow[];
    initialSettings?: ContractSettings | undefined;
    onclose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let box = $state<HTMLElement | null>(null);

  let contracts = $state<ContractRow[]>([]);
  let settings = $state<ContractSettings>({
    modalMode: "modal",
    intendedServiceIds: null,
    periodicScanEnabled: false,
    periodicScanStart: "03:00",
    periodicScanEnd: "06:00",
  });
  let checking = $state(false);
  let receivingEmm = $state(false);
  let testingAll = $state(false);
  let savingSettings = $state(false);
  let testingServiceId = $state<number | null>(null);
  let settingServiceId = $state<number | null>(null);
  let errorMessage = $state<string | null>(null);
  let infoMessage = $state<string | null>(null);

  /** 契約確認・復号テスト・EMM受信・手動設定・設定保存の実行中フラグ (多重実行・同時実行の防止) */
  const isBusy = $derived(
    checking ||
      receivingEmm ||
      testingAll ||
      savingSettings ||
      testingServiceId !== null ||
      settingServiceId !== null,
  );

  const PROVIDER_ORDER: Record<string, number> = {
    wowow: 1,
    japanet: 2,
    skyperfect: 3,
    other: 4,
  };

  let groupedContracts = $derived.by(() => {
    const groups: Record<string, ContractRow[]> = {};
    for (const row of contracts) {
      const list = groups[row.providerId] ?? (groups[row.providerId] = []);
      list.push(row);
    }
    return Object.entries(groups)
      .map(([providerId, rows]) => ({
        providerId,
        providerName: rows[0]?.providerName ?? providerId,
        rows,
      }))
      .sort(
        (a, b) =>
          (PROVIDER_ORDER[a.providerId] ?? 99) -
          (PROVIDER_ORDER[b.providerId] ?? 99),
      );
  });

  $effect(() => {
    contracts = initialContracts;
    if (initialSettings) {
      settings = initialSettings;
    }
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

  async function handleReceiveEmm() {
    if (isBusy) return;
    receivingEmm = true;
    errorMessage = null;
    infoMessage = null;
    try {
      const form = new FormData();
      form.append("seconds", "20");
      const res = await fetch("?/receiveEmm", {
        method: "POST",
        body: form,
      });
      const data = deserialize(await res.text());
      const payload =
        data.type === "success" || data.type === "failure"
          ? (data.data as Record<string, unknown> | undefined)
          : undefined;
      const emmResult = payload?.["result"] as
        { success: number; processed: number; emmPids: number[] } | undefined;
      const message = payload?.["message"];
      if (data.type === "success" && emmResult) {
        if (emmResult.success > 0) {
          infoMessage = `カードの契約更新メッセージを受信し適用しました (更新: ${emmResult.success} 件)`;
        } else if (emmResult.processed > 0) {
          infoMessage = `EMM を ${emmResult.processed} 件受信しました (適用対象外)`;
        } else if (emmResult.emmPids.length === 0) {
          infoMessage =
            "放送の CAT を受け取れませんでした。時間をおいて、もう一度お試しください";
        } else {
          infoMessage =
            "受信しましたが、このカード宛ての更新メッセージは流れていませんでした";
        }
        await handleCheckContracts();
      } else if (message) {
        errorMessage = String(message);
      } else {
        errorMessage = "EMM の受信に失敗しました";
      }
    } catch (err) {
      errorMessage = String(err);
    } finally {
      receivingEmm = false;
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

  async function handleSaveSettings(patch: Partial<ContractSettings>) {
    if (isBusy) return;
    savingSettings = true;
    errorMessage = null;
    infoMessage = null;
    try {
      const form = new FormData();
      Object.entries(patch).forEach(([key, value]) => {
        if (key === "intendedServiceIds") {
          form.append(key, value === null ? "all" : JSON.stringify(value));
        } else {
          form.append(key, String(value));
        }
      });
      const res = await fetch("?/saveContractSettings", {
        method: "POST",
        body: form,
      });
      const data = deserialize(await res.text());
      const payload =
        data.type === "success" || data.type === "failure"
          ? (data.data as Record<string, unknown> | undefined)
          : undefined;
      const updatedSettings = payload?.["settings"] as
        ContractSettings | undefined;
      const updatedContracts = payload?.["contracts"] as
        ContractRow[] | undefined;
      const message = payload?.["message"];

      if (data.type === "success") {
        if (updatedSettings) {
          settings = updatedSettings;
        } else {
          settings = { ...settings, ...patch };
        }
        if (Array.isArray(updatedContracts)) {
          contracts = updatedContracts;
        }
      } else if (message) {
        errorMessage = String(message);
      } else {
        errorMessage = "設定の保存に失敗しました";
      }
    } catch (err) {
      errorMessage = String(err);
    } finally {
      savingSettings = false;
    }
  }

  /** 契約意志 (対象チェックボックス) の切り替え */
  async function handleToggleIntended(serviceId: number, checked: boolean) {
    // 現在の intendedServiceIds が null の場合、全有料局が対象となっている
    const current =
      settings.intendedServiceIds !== null
        ? settings.intendedServiceIds
        : contracts.map((c) => c.serviceId);

    const next = checked
      ? Array.from(new Set([...current, serviceId]))
      : current.filter((id) => id !== serviceId);

    await handleSaveSettings({ intendedServiceIds: next });
  }

  /** 契約中と判定されている局をすべて契約対象に一括選択 */
  async function handleSelectSubscribed() {
    const subscribed = contracts
      .filter((c) => c.state === "subscribed")
      .map((c) => c.serviceId);
    await handleSaveSettings({ intendedServiceIds: subscribed });
    infoMessage = `契約中と判定された ${subscribed.length} 局を契約対象に選択しました。`;
  }

  /** 全有料局を対象にするか全解除するか */
  async function handleSelectAllIntended(all: boolean) {
    await handleSaveSettings({ intendedServiceIds: all ? null : [] });
    infoMessage = all
      ? "すべての有料局を契約対象に選択しました。"
      : "すべての局の契約対象チェックを解除しました。";
  }

  async function handleSetManualContract(serviceId: number, value: string) {
    if (isBusy) return;
    settingServiceId = serviceId;
    errorMessage = null;
    try {
      const form = new FormData();
      form.append("serviceId", String(serviceId));
      if (value) {
        form.append("manualState", value);
      }
      const res = await fetch("?/setManualContract", {
        method: "POST",
        body: form,
      });
      const data = deserialize(await res.text());
      const payload =
        data.type === "success" || data.type === "failure"
          ? (data.data as Record<string, unknown> | undefined)
          : undefined;
      const updatedContract = payload?.["contract"] as ContractRow | undefined;
      const message = payload?.["message"];
      if (data.type === "success" && updatedContract) {
        contracts = contracts.map((c) =>
          c.serviceId === serviceId ? updatedContract : c,
        );
      } else if (message) {
        errorMessage = String(message);
      } else {
        errorMessage = "手動設定の保存に失敗しました";
      }
    } catch (err) {
      errorMessage = String(err);
    } finally {
      settingServiceId = null;
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
      契約している局の「契約対象」にチェックを入れることで、自動録画や期限通知の対象として管理できます。
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

    <div class="contract-settings">
      <div class="setting-row">
        <label class="setting-item">
          <span class="setting-label">契約期限・更新案内:</span>
          <select
            class="small"
            value={settings.modalMode}
            disabled={isBusy}
            onchange={(e) =>
              handleSaveSettings({
                modalMode: e.currentTarget.value as "modal" | "banner" | "none",
              })}
            data-testid="select-modal-mode"
          >
            <option value="modal">モーダルで通知</option>
            <option value="banner">控えめに通知 (バナーのみ)</option>
            <option value="none">通知しない</option>
          </select>
        </label>
      </div>

      <div class="setting-row periodic-scan-row">
        <label class="setting-item">
          <input
            type="checkbox"
            checked={settings.periodicScanEnabled}
            disabled={isBusy}
            onchange={(e) =>
              handleSaveSettings({
                periodicScanEnabled: e.currentTarget.checked,
              })}
            data-testid="checkbox-periodic-scan"
          />
          <span>深夜の空き時間に自動復号確認 (定期スキャン)</span>
        </label>
        {#if settings.periodicScanEnabled}
          <div class="time-range-picker">
            <span class="setting-label">時間帯:</span>
            <input
              type="time"
              class="small time-input"
              value={settings.periodicScanStart}
              disabled={isBusy}
              onchange={(e) =>
                handleSaveSettings({
                  periodicScanStart: e.currentTarget.value,
                })}
              data-testid="input-scan-start"
            />
            <span>〜</span>
            <input
              type="time"
              class="small time-input"
              value={settings.periodicScanEnd}
              disabled={isBusy}
              onchange={(e) =>
                handleSaveSettings({ periodicScanEnd: e.currentTarget.value })}
              data-testid="input-scan-end"
            />
          </div>
        {/if}
        <p class="small muted setting-help">
          チューナーが空いている時に、契約対象局の復号状態をバックグラウンドで巡回確認します。録画や視聴が始まると即座に中断してチューナーを譲ります。
        </p>
      </div>
    </div>

    <div class="intended-guide">
      <p class="small muted">
        <strong>契約チャンネルの選択:</strong>
        ご契約中の局にチェックを入れてください。チェックを入れた局のみを<strong
          >自動録画の許可</strong
        >、<strong>期限切れ通知</strong>、<strong>深夜定期スキャン</strong
        >の対象とします。未契約の局を外しておくことで、スクランブル解除失敗による録画エラーや不要な通知を防げます。
      </p>
    </div>

    <div class="toolbar">
      <div class="toolbar-group">
        <button
          type="button"
          class="secondary small"
          disabled={isBusy}
          onclick={handleSelectSubscribed}
          data-testid="btn-select-subscribed"
          title="いま契約中と判定されている局をすべて契約対象にチェックします"
        >
          契約中の局を一括選択
        </button>
        <button
          type="button"
          class="ghost small"
          disabled={isBusy}
          onclick={() => handleSelectAllIntended(true)}
          title="すべての有料局を契約対象にします"
        >
          全選択
        </button>
        <button
          type="button"
          class="ghost small"
          disabled={isBusy}
          onclick={() => handleSelectAllIntended(false)}
          title="すべての局の契約対象チェックを外します"
        >
          全解除
        </button>
      </div>

      <div class="toolbar-group">
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
          onclick={handleReceiveEmm}
          data-testid="btn-receive-emm"
        >
          <ShieldCheck class={receivingEmm ? "spin" : ""} aria-hidden="true" />
          {receivingEmm ? "EMM受信中 (約20秒)…" : "カード更新 (EMM受信)"}
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
              <th
                class="intended-col"
                title="契約している局にチェックを入れます。自動録画・通知・定期スキャンの対象になります"
                >契約対象</th
              >
              <th>局名</th>
              <th>種別</th>
              <th>対応方式</th>
              <th>契約状態</th>
              <th>有効期限</th>
              <th>手動設定</th>
              <th>復号テスト</th>
            </tr>
          </thead>
          <tbody>
            {#each groupedContracts as group (group.providerId)}
              <tr class="provider-header-row">
                <th colspan="8">{group.providerName}</th>
              </tr>
              {#each group.rows as row (row.serviceId)}
                <tr class:not-intended={!row.isIntended}>
                  <td class="intended-cell">
                    <input
                      type="checkbox"
                      checked={row.isIntended}
                      disabled={isBusy}
                      onchange={(e) =>
                        handleToggleIntended(
                          row.serviceId,
                          e.currentTarget.checked,
                        )}
                      title="「{row.serviceName}」を契約対象（自動録画・通知・定期スキャン）にする"
                      aria-label="「{row.serviceName}」を契約対象にする"
                      data-testid="checkbox-intended-{row.serviceId}"
                    />
                  </td>
                  <td class="name-cell">
                    <strong>{row.serviceName}</strong>
                  </td>
                  <td>
                    <span class="mono">{row.type} / {row.channel}</span>
                  </td>
                  <td>
                    {#if row.availableMethods?.includes("eit_ca")}
                      <span
                        class="small"
                        title="番組表 (EIT 0xCB) からカードで確認可能"
                        >カード・復号</span
                      >
                    {:else}
                      <span
                        class="small muted"
                        title="番組表に契約情報が無いため復号テストで確認"
                        >復号テストのみ</span
                      >
                    {/if}
                  </td>
                  <td>
                    {#if row.state === "subscribed"}
                      <span class="tag success">契約中</span>
                    {:else if row.state === "expired"}
                      <span class="tag">期限切れ</span>
                    {:else if row.state === "unknown"}
                      <span class="tag muted">未確認</span>
                    {:else}
                      <span class="tag muted">未契約</span>
                    {/if}
                    {#if row.source === "manual"}
                      <span class="tag source-tag" title="手動で設定された状態"
                        >手動</span
                      >
                    {:else if row.source === "eit_ca"}
                      <span
                        class="tiny muted source-tag"
                        title="番組表 (EIT 0xCB) と B-CAS カードで確認"
                        >カード判定</span
                      >
                    {:else if row.source === "decode"}
                      <span
                        class="tiny muted source-tag"
                        title="実際の放送波ストリームの復号テストで確認"
                        >復号テスト</span
                      >
                    {/if}
                  </td>
                  <td>
                    <span class="mono">{formatDate(row.validUntil)}</span>
                  </td>
                  <td>
                    <select
                      class="small manual-select"
                      value={row.manualState ?? ""}
                      disabled={isBusy}
                      onchange={(e) =>
                        handleSetManualContract(
                          row.serviceId,
                          e.currentTarget.value,
                        )}
                      data-testid="select-manual-{row.serviceId}"
                    >
                      <option value="">自動判定</option>
                      <option value="subscribed">契約中 (手動)</option>
                      <option value="unsubscribed">未契約・除外 (手動)</option>
                      <option value="unknown">未確認 (手動)</option>
                    </select>
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
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </article>
</dialog>

<style>
  .modal-box-wide {
    max-width: 56rem;
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

  .source-tag {
    display: inline-block;
    margin-left: 0.35rem;
    font-size: 0.75rem;
  }

  .manual-select {
    padding: 0.2rem 0.4rem;
    font-size: 0.75rem;
    width: auto;
    max-width: 9.5rem;
    margin: 0;
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

  .contract-settings {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    padding: 0.75rem 1rem;
    margin-bottom: 0.75rem;
    background: var(--dp-pop, rgba(255, 255, 255, 0.05));
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .setting-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1.25rem;
  }

  .setting-item {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    user-select: none;
  }

  .time-range-picker {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .time-input {
    width: auto;
    padding: 0.2rem 0.4rem;
    font-size: 0.8rem;
    font-family: inherit;
  }

  .intended-guide {
    margin-bottom: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--dp-pop, rgba(255, 255, 255, 0.03));
    border-radius: 6px;
    border-left: 3px solid var(--dp-accent, #3b82f6);
  }

  .intended-guide p {
    margin: 0;
    line-height: 1.5;
  }

  .setting-help {
    margin: 0.25rem 0 0;
    line-height: 1.4;
    width: 100%;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin-bottom: 0.75rem;
  }

  .toolbar-group {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  .intended-col {
    width: 5.5rem;
    text-align: center;
    white-space: nowrap;
  }

  .intended-cell {
    text-align: center;
  }

  tr.not-intended td {
    opacity: 0.55;
  }

  tr.not-intended .intended-cell {
    opacity: 1;
  }

  .setting-label {
    color: var(--dp-muted, #888);
  }

  .provider-header-row th {
    padding: 0.6rem 0.75rem;
    background: var(--dp-pop, rgba(255, 255, 255, 0.05));
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--dp-text, #eee);
    text-align: left;
    border-bottom: 1px solid var(--dp-border, #333);
  }

  .empty {
    text-align: center;
    padding: 2rem;
  }
</style>
