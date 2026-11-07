<script lang="ts">
  import "@anyblades/blades/components/modal";
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
  import AlertTriangle from "~icons/lucide/alert-triangle";
  import X from "~icons/lucide/x";

  import type { ContractNotice } from "#lib/server/contracts.js";

  let { notices = [] }: { notices?: ContractNotice[] } = $props();

  let dismissedProviders = $state<string[]>([]);
  let dialog = $state<HTMLDialogElement | null>(null);

  // まだ閉じられていない通知
  const activeNotices = $derived(
    notices.filter((n) => !dismissedProviders.includes(n.providerId)),
  );

  const modalNotices = $derived(
    activeNotices.filter((n) => n.mode === "modal"),
  );
  const bannerNotices = $derived(
    activeNotices.filter((n) => n.mode === "banner"),
  );

  function formatDate(ms: number): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  }

  function dismiss(providerId: string) {
    dismissedProviders = [...dismissedProviders, providerId];
    try {
      sessionStorage.setItem(
        `denpa-dismiss-contract-${providerId}`,
        String(Date.now()),
      );
    } catch {
      // ignore
    }
  }

  $effect(() => {
    // sessionStorage から前回の控えを復元
    try {
      const dismissed: string[] = [];
      for (const n of notices) {
        if (sessionStorage.getItem(`denpa-dismiss-contract-${n.providerId}`)) {
          dismissed.push(n.providerId);
        }
      }
      if (dismissed.length > 0) {
        dismissedProviders = dismissed;
      }
    } catch {
      // ignore
    }
  });

  $effect(() => {
    const element = dialog;
    if (!element) return;
    const hasModal = modalNotices.length > 0;
    untrack(() => {
      if (hasModal) {
        if (!element.open) element.showModal();
      } else {
        if (element.open) element.close();
      }
    });
  });
</script>

{#if bannerNotices.length > 0}
  <aside class="contract-banners" aria-label="契約更新案内">
    {#each bannerNotices as notice (notice.providerId)}
      <div
        class="contract-banner"
        data-testid="contract-banner-{notice.providerId}"
      >
        <div class="banner-body">
          <AlertTriangle class="banner-icon" aria-hidden="true" />
          <div class="banner-text">
            <strong>{notice.providerName} の契約を確認してください</strong>
            <span class="muted"
              >詳細: 以下のチャンネルが 1 週間後に復号できなくなります ({notice.channels
                .map((c) => c.name)
                .join("、")})</span
            >
          </div>
        </div>
        <div class="banner-actions">
          <a
            href={`${resolve("settings/reception")}#card`}
            class="button small secondary outline">契約を確認</a
          >
          <button
            type="button"
            class="ghost small icon"
            onclick={() => dismiss(notice.providerId)}
            aria-label="閉じる"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
    {/each}
  </aside>
{/if}

{#if modalNotices.length > 0}
  {@const currentNotice = modalNotices[0]!}
  <dialog
    bind:this={dialog}
    aria-labelledby="contract-warning-title"
    data-testid="contract-warning-modal"
  >
    <button
      type="button"
      class="modal-backdrop"
      tabindex="-1"
      aria-label="閉じる"
      onclick={() => dismiss(currentNotice.providerId)}
    ></button>
    <article class="modal-box modal-box-narrow">
      <button
        type="button"
        class="ghost icon small modal-close"
        onclick={() => dismiss(currentNotice.providerId)}
        aria-label="閉じる"
      >
        <X aria-hidden="true" />
      </button>

      <div class="modal-header">
        <AlertTriangle class="modal-alert-icon" aria-hidden="true" />
        <h2 id="contract-warning-title">
          {currentNotice.providerName} の契約を確認してください
        </h2>
      </div>

      <p class="warning-detail">
        詳細: 以下のチャンネルが 1 週間後に復号できなくなります
      </p>

      <div class="channels-box">
        <table class="channels-table">
          <thead>
            <tr>
              <th>対象チャンネル</th>
              <th>有効期限</th>
            </tr>
          </thead>
          <tbody>
            {#each currentNotice.channels as ch (ch.serviceId)}
              <tr>
                <td><strong>{ch.name}</strong></td>
                <td class="mono">{formatDate(ch.validUntil)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="modal-footer">
        <button
          type="button"
          class="secondary small"
          onclick={() => dismiss(currentNotice.providerId)}
        >
          閉じる
        </button>
        <a
          href={`${resolve("settings/reception")}#card`}
          class="primary small button"
          onclick={() => dismiss(currentNotice.providerId)}
        >
          契約情報を確認
        </a>
      </div>
    </article>
  </dialog>
{/if}

<style>
  .contract-banners {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .contract-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.45rem 1rem;
    background: var(--dp-warning-bg, rgba(234, 179, 8, 0.12));
    border-bottom: 1px solid var(--dp-warning-border, rgba(234, 179, 8, 0.3));
    font-size: 0.85rem;
    gap: 1rem;
  }

  .banner-body {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  :global(.banner-icon) {
    color: var(--dp-warning, #eab308);
    flex-shrink: 0;
  }

  .banner-actions {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .modal-box-narrow {
    max-width: 28rem;
    padding: 1.5rem;
  }

  .modal-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.3;
  }

  :global(.modal-alert-icon) {
    color: var(--dp-warning, #eab308);
    font-size: 1.4rem;
    flex-shrink: 0;
  }

  .warning-detail {
    margin-top: 0;
    margin-bottom: 0.75rem;
    font-size: 0.875rem;
    color: var(--dp-text, #ccc);
  }

  .channels-box {
    margin-bottom: 1.25rem;
    border: 1px solid var(--dp-border, #333);
    border-radius: 6px;
    overflow: hidden;
  }

  .channels-table {
    width: 100%;
    margin: 0;
    font-size: 0.85rem;
  }

  .channels-table th,
  .channels-table td {
    padding: 0.45rem 0.75rem;
    text-align: left;
  }

  .channels-table th {
    background: var(--dp-pop, rgba(255, 255, 255, 0.05));
    color: var(--dp-muted, #888);
    font-weight: 500;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.5rem;
  }
</style>
