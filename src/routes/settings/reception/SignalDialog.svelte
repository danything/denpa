<script lang="ts">
  import "@anyblades/blades/components/modal";
  import "@anyblades/blades/content/table";
  import { deserialize } from "$app/forms";
  import Activity from "~icons/lucide/activity";
  import X from "~icons/lucide/x";

  import type { SignalQualityResult } from "#lib/server/signal-quality.js";
  import type { TunerSignal } from "#lib/server/tuner.js";

  /**
   * C/N の出し方。**生の値は dB と読まれないように「(生の値)」を付け、単位を付けない** (docs/tuners.md「信号レベル」)。
   * 上流 Tuners.svelte と同じ表記規則
   */
  function signalText(signal: TunerSignal): string {
    const state = signal.locked ? "同期しています" : "同期していません";
    if (signal.cn === null) return state;
    const cn =
      signal.unit === "dB"
        ? `C/N: ${signal.cn.toFixed(1)} dB${signal.atTune ? " (選局したとき)" : ""}`
        : `C/N (生の値): ${signal.cn.toLocaleString("ja-JP")}`;
    return `${state}・${cn}`;
  }

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
  let activeAbort: AbortController | null = null;

  $effect(() => {
    if (open) {
      if (initialType && initialChannel) {
        selectedKey = `${initialType}:${initialChannel}`;
      } else if (channels.length > 0 && !selectedKey) {
        selectedKey = `${channels[0]?.type}:${channels[0]?.channel}`;
      }
    }
  });

  $effect(() => {
    const element = dialog;
    if (element === null) return;
    if (open) {
      result = null;
      errorMessage = null;
      if (!element.open) {
        element.showModal();
        box?.focus();
      }
    } else {
      if (element.open) element.close();
    }
  });

  async function handleMeasure() {
    if (!selectedKey || measuring) return;
    const [type, channel] = selectedKey.split(":");
    if (!type || !channel) return;

    measuring = true;
    errorMessage = null;
    result = null;

    activeAbort?.abort();
    activeAbort = new AbortController();

    try {
      const formData = new FormData();
      formData.set("type", type);
      formData.set("channel", channel);

      const res = await fetch("?/measureSignal", {
        method: "POST",
        body: formData,
        signal: activeAbort.signal,
      });

      const data = deserialize(await res.text());
      if (data.type === "success" && data.data) {
        const payload = data.data as { signal?: SignalQualityResult };
        if (payload.signal) {
          if (payload.signal.ok) {
            result = payload.signal;
          } else {
            result = null;
            errorMessage = payload.signal.error ?? "受信に失敗しました";
          }
        }
      } else if (data.type === "failure" && data.data) {
        const payload = data.data as { message?: string };
        errorMessage = payload.message ?? "測定に失敗しました";
      } else {
        errorMessage = "予期しない応答を受け取りました";
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      errorMessage = `測定エラー: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      measuring = false;
      activeAbort = null;
    }
  }

  function handleClose() {
    activeAbort?.abort();
    activeAbort = null;
    measuring = false;
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
    onclick={() => dialog?.close()}
  ></button>
  <article bind:this={box} class="modal-box modal-box-wide" tabindex="-1">
    <button
      type="button"
      class="ghost circle small close modal-close"
      onclick={() => dialog?.close()}
      aria-label="閉じる"
      data-testid="signal-dialog-close"
    >
      <X aria-hidden="true" />
    </button>

    <h2 id="signal-dialog-title">受信品質の測定</h2>
    <p class="small muted intro">
      チューナーで対象チャンネルを選局し、実際の放送波ストリーム (TS パケット)
      の誤り・ドロップ数・受信レートを測定します。
    </p>

    {#if errorMessage}
      <div class="notice error" role="alert">
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
        aria-busy={measuring}
        onclick={handleMeasure}
        data-testid="btn-measure-signal"
      >
        {#if !measuring}
          <Activity aria-hidden="true" />
        {/if}
        {measuring ? "測定中…" : "受信品質測定"}
      </button>
    </div>

    {#if result}
      <div class="result-box">
        <div class="quality-header">
          <div class="header-status">
            <span class="small muted">TS ストリーム品質:</span>
            {#if result.quality === "excellent" || result.quality === "good"}
              <span class="tag success">{result.qualityLabel}</span>
            {:else if result.quality === "poor"}
              <span class="tag">{result.qualityLabel}</span>
            {:else if result.quality === "bad"}
              <span class="tag error">{result.qualityLabel}</span>
            {:else}
              <span class="tag muted">{result.qualityLabel}</span>
            {/if}
          </div>

          {#if result.tunerSignal}
            <div class="tuner-signal" data-testid="signal-dialog-tuner-signal">
              <span class="small muted">チューナー:</span>
              <span
                class="small num"
                class:error-text={!result.tunerSignal.locked}
              >
                {signalText(result.tunerSignal)}
              </span>
            </div>
          {/if}
        </div>

        {#if result.tunerSignal?.unit === "raw"}
          <p class="tiny muted raw-note" data-testid="signal-dialog-raw-note">
            C/N (生の値) は機材やドライバが返した値のままで、dB
            ではありません。同じチューナーで比べる目安です
          </p>
        {/if}

        <div class="metrics-grid">
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

          <div class="metric-card">
            <span class="metric-label">受信パケット総数</span>
            <span class="metric-value num mono"
              >{result.totalPackets.toLocaleString()}</span
            >
            <span class="tiny muted"
              >測定時間: {(result.durationMs / 1000).toFixed(1)} 秒</span
            >
          </div>
        </div>
      </div>
    {/if}

    <footer class="modal-actions">
      <button
        type="button"
        class="secondary small"
        onclick={() => dialog?.close()}
      >
        閉じる
      </button>
    </footer>
  </article>
</dialog>

<style>
  .modal-box-wide {
    max-width: 44rem;
    width: 100%;
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

  .result-box {
    border: 1px solid var(--dp-line, rgba(128, 128, 128, 0.2));
    border-radius: var(--dp-radius, 6px);
    padding: 1rem;
    background: var(--dp-surface, rgba(128, 128, 128, 0.05));
    margin-bottom: 1rem;
  }

  .quality-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .header-status,
  .tuner-signal {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .raw-note {
    margin-top: -0.5rem;
    margin-bottom: 1rem;
    line-height: 1.4;
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
    border-radius: var(--dp-radius, 4px);
    border: 1px solid var(--dp-line, rgba(128, 128, 128, 0.15));
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
    color: var(--dp-rec, #ef4444);
  }
</style>
