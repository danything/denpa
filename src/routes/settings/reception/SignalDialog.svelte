<script lang="ts">
  import "@anyblades/blades/components/modal";
  import "@anyblades/blades/content/table";
  import { deserialize } from "$app/forms";
  import { untrack } from "svelte";
  import Activity from "~icons/lucide/activity";
  import RefreshCw from "~icons/lucide/refresh-cw";
  import X from "~icons/lucide/x";

  import type { SignalQualityResult } from "#lib/server/signal-quality.js";

  interface ChannelOption {
    type: string;
    channel: string;
    name: string;
  }

  let {
    open,
    channels = [],
    initialType = "",
    initialChannel = "",
    onclose,
  }: {
    open: boolean;
    channels: ChannelOption[];
    initialType?: string;
    initialChannel?: string;
    onclose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let box = $state<HTMLElement | null>(null);

  let selectedKey = $state("");
  let measuring = $state(false);
  let result = $state<SignalQualityResult | null>(null);
  let errorMessage = $state<string | null>(null);

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
        if (initialType && initialChannel) {
          selectedKey = `${initialType}:${initialChannel}`;
        } else if (channels.length > 0 && !selectedKey) {
          selectedKey = `${channels[0]?.type}:${channels[0]?.channel}`;
        }
      } else {
        if (element.open) element.close();
      }
    });
  });

  async function handleMeasure() {
    if (!selectedKey || measuring) return;
    const [type, channel] = selectedKey.split(":");
    if (!type || !channel) return;

    measuring = true;
    errorMessage = null;

    try {
      const formData = new FormData();
      formData.set("type", type);
      formData.set("channel", channel);

      const res = await fetch("?/measureSignal", {
        method: "POST",
        body: formData,
      });

      const data = deserialize(await res.text());
      if (data.type === "success" && data.data) {
        const payload = data.data as { signal?: SignalQualityResult };
        if (payload.signal) {
          result = payload.signal;
          if (!payload.signal.ok && payload.signal.error) {
            errorMessage = payload.signal.error;
          }
        }
      } else if (data.type === "failure" && data.data) {
        const payload = data.data as { message?: string };
        errorMessage = payload.message ?? "測定に失敗しました";
      } else {
        errorMessage = "予期しない応答を受け取りました";
      }
    } catch (err) {
      errorMessage = `測定エラー: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      measuring = false;
    }
  }

  function handleClose() {
    onclose();
  }
</script>

<dialog
  bind:this={dialog}
  class="modal"
  onclose={handleClose}
  aria-labelledby="signal-dialog-title"
>
  <button
    type="button"
    class="modal-backdrop"
    tabindex="-1"
    aria-label="閉じる"
    onclick={handleClose}
  ></button>
  <article bind:this={box} class="modal-box modal-box-wide" tabindex="-1">
    <button
      type="button"
      class="ghost circle small close modal-close"
      onclick={handleClose}
      aria-label="閉じる"
    >
      <X aria-hidden="true" />
    </button>

    <div class="header-group">
      <h2 id="signal-dialog-title">電波レベル・受信品質の測定</h2>
    </div>
    <p class="small muted intro">
      空きチューナーを一時的に選局し、実際の放送波ストリーム (TS パケット)
      の誤り率・ドロップ数・受信レートを測定します。
      アンテナ線の接続状態や受信環境の確認に利用できます。
    </p>

    {#if errorMessage}
      <div class="alert error" role="alert">
        {errorMessage}
      </div>
    {/if}

    <div class="toolbar">
      <label class="select-label">
        <span class="small muted">チャンネル:</span>
        <select
          bind:value={selectedKey}
          disabled={measuring}
          class="small channel-select"
        >
          {#each channels as ch (`${ch.type}:${ch.channel}`)}
            <option value="{ch.type}:{ch.channel}">
              [{ch.type}] {ch.channel} : {ch.name}
            </option>
          {/each}
        </select>
      </label>

      <button
        type="button"
        class="secondary small"
        disabled={measuring || !selectedKey}
        onclick={handleMeasure}
        data-testid="btn-measure-signal"
      >
        <Activity class={measuring ? "spin" : ""} aria-hidden="true" />
        {measuring ? "選局して測定中 (約3秒)…" : "電波を測定"}
      </button>
    </div>

    {#if result}
      <div class="result-box">
        <div class="quality-header">
          <span class="small muted">判定結果:</span>
          {#if result.quality === "excellent"}
            <span class="tag success">{result.qualityLabel}</span>
          {:else if result.quality === "good"}
            <span class="tag success">{result.qualityLabel}</span>
          {:else if result.quality === "poor"}
            <span class="tag warning">{result.qualityLabel}</span>
          {:else if result.quality === "bad"}
            <span class="tag error">{result.qualityLabel}</span>
          {:else}
            <span class="tag muted">{result.qualityLabel}</span>
          {/if}
          {#if result.cnDb !== null}
            <span class="cn-badge mono">
              C/N <strong>{result.cnDb.toFixed(1)}</strong> dB
            </span>
          {/if}
        </div>

        <div class="metrics-grid">
          <div class="metric-card highlight-card">
            <span class="metric-label">電波レベル (C/N)</span>
            <span
              class="metric-value num mono"
              class:error-text={result.cnDb === null || result.cnDb < 18}
            >
              {#if result.cnDb !== null}
                {result.cnDb.toFixed(1)} <span class="unit">dB</span>
              {:else}
                — <span class="unit">dB</span>
              {/if}
            </span>
            <span class="tiny muted">
              {#if result.type === "GR"}
                地上波 (所要 19dB〜)
              {:else}
                BS/CS (所要 11dB〜)
              {/if}
            </span>
          </div>

          <div class="metric-card">
            <span class="metric-label">受信ビットレート</span>
            <span class="metric-value num mono"
              >{result.bitrateMbps} <span class="unit">Mbps</span></span
            >
            <span class="tiny muted"
              >有効: {result.effectiveBitrateMbps} Mbps</span
            >
          </div>

          <div class="metric-card">
            <span class="metric-label">パケット誤り (TEI)</span>
            <span
              class="metric-value num mono"
              class:error-text={result.errorPackets > 0}
            >
              {result.errorPackets} <span class="unit">個</span>
            </span>
            <span class="tiny muted"
              >誤り率: {(result.errorRate * 100).toFixed(2)}%</span
            >
          </div>

          <div class="metric-card">
            <span class="metric-label">パケットドロップ</span>
            <span
              class="metric-value num mono"
              class:error-text={result.dropPackets > 0}
            >
              {result.dropPackets} <span class="unit">個</span>
            </span>
            <span class="tiny muted"
              >ドロップ率: {(result.dropRate * 100).toFixed(2)}%</span
            >
          </div>
        </div>
      </div>
    {/if}
  </article>
</dialog>

<style>
  .modal-box-wide {
    max-width: 44rem;
    width: 100%;
  }

  .header-group {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .intro {
    margin-block: 0.5rem 1rem;
    line-height: 1.5;
  }

  .toolbar {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
  }

  .select-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .channel-select {
    max-width: 20rem;
    width: auto;
  }

  .alert.error {
    background-color: var(--dp-error-bg, rgba(239, 68, 68, 0.1));
    color: var(--dp-error, #ef4444);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    margin-bottom: 0.75rem;
    font-size: 0.875rem;
  }

  .result-box {
    border: 1px solid var(--dp-border, rgba(128, 128, 128, 0.2));
    border-radius: 6px;
    padding: 1rem;
    background: var(--dp-card-bg, rgba(128, 128, 128, 0.05));
  }

  .quality-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .cn-badge {
    margin-left: auto;
    font-size: 0.95rem;
    padding: 0.2rem 0.5rem;
    background: var(--dp-surface, rgba(255, 255, 255, 0.08));
    border-radius: 4px;
    border: 1px solid var(--dp-border, rgba(128, 128, 128, 0.2));
  }

  .highlight-card {
    border-color: var(--dp-accent, rgba(59, 130, 246, 0.4));
    background: var(--dp-surface-highlight, rgba(59, 130, 246, 0.05));
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 0.75rem;
  }

  .metric-card {
    display: flex;
    flex-direction: column;
    padding: 0.75rem;
    background: var(--dp-surface, rgba(255, 255, 255, 0.05));
    border-radius: 4px;
    border: 1px solid var(--dp-border, rgba(128, 128, 128, 0.15));
  }

  .metric-label {
    font-size: 0.75rem;
    color: var(--dp-muted, #888);
    margin-bottom: 0.25rem;
  }

  .metric-value {
    font-size: 1.25rem;
    font-weight: 600;
  }

  .metric-value .unit {
    font-size: 0.8rem;
    font-weight: normal;
  }

  .error-text {
    color: var(--dp-error, #ef4444);
  }

  .tag.warning {
    background-color: var(--dp-warning-bg, rgba(245, 158, 11, 0.15));
    color: var(--dp-warning, #f59e0b);
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
</style>
