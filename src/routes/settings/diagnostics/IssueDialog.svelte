<script lang="ts">
  import "@anyblades/blades/layered/components/modal";
  import { untrack } from "svelte";
  import X from "~icons/lucide/x";

  import {
    fullReport,
    initialLogs,
    issueUrl,
    type LogSource,
    URL_LIMIT,
  } from "#lib/issue-report.js";

  /**
   * **Issue にする前に、送るものをそのまま見せる窓。**
   *
   * 中身はもう伏せてある (`#lib/redact.ts`)。欄はどれも書き換えられ、消せる。「GitHub で開く」は
   * ここに見えている欄そのものを入れた Issue のフォームを、新しいタブで開くだけ (denpa からは何も送らない)。
   * 「何が起きたか」「再現手順」は GitHub で書いてもらう。
   *
   * ログの欄は URL に入るぶんだけ (`initialLogs`)。全部はコピーかダウンロードで渡す
   */
  let {
    report,
    onclose,
  }: {
    /** 見せるもの (伏せたあと)。`null` で閉じる */
    report: {
      version: string;
      environment: string;
      sources: LogSource[];
    } | null;
    onclose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let box = $state<HTMLElement | null>(null);

  let title = $state("");
  let version = $state("");
  let environment = $state("");
  let logs = $state("");
  /** 最初に入りきらなかった行の数 */
  let omitted = $state(0);
  let sources = $state.raw<LogSource[]>([]);
  let copied = $state(false);

  /** 開くたびに欄を入れ直す。追うのは `report` と `dialog` だけ */
  $effect(() => {
    const next = report;
    const element = dialog;
    if (element === null) return;
    untrack(() => {
      if (next === null) {
        if (element.open) element.close();
        return;
      }
      title = "";
      version = next.version;
      environment = next.environment;
      sources = next.sources;
      const fitted = initialLogs(
        { title: "", version, environment },
        next.sources,
      );
      logs = fitted.text;
      omitted = fitted.omitted;
      copied = false;
      if (!element.open) {
        element.showModal();
        box?.focus();
      }
    });
  });

  const link = $derived(issueUrl({ title, version, environment, logs }));

  /** コピーとダウンロードの中身。ログは全部 (欄で直したタイトル・バージョン・環境は入れる) */
  const full = $derived(fullReport({ title, version, environment }, sources));

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(full);
      copied = true;
    } catch {
      copied = false;
    }
  }

  function download(): void {
    const blob = new Blob([full], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    a.href = href;
    a.download = `denpa-report-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
</script>

<dialog
  bind:this={dialog}
  {onclose}
  aria-labelledby="issue-title"
  data-testid="issue-dialog"
>
  <!-- 幕を押したら閉じる (`app.css` の `.modal-backdrop`) -->
  <button
    type="button"
    class="modal-backdrop"
    tabindex="-1"
    aria-label="閉じる"
    onclick={() => dialog?.close()}
  ></button>
  <article class="modal-box" bind:this={box} tabindex="-1">
    <button
      type="button"
      class="ghost icon small modal-close"
      onclick={() => dialog?.close()}
      aria-label="閉じる"
      data-testid="issue-close"
    >
      <X aria-hidden="true" />
    </button>
    <h2 id="issue-title">Issue にする</h2>
    <p class="small muted intro">
      GitHub の Issue
      のフォームに、下の欄をそのまま入れて開きます。カードの番号・IP
      アドレス・ホスト名・トークンなどは伏せてあります。直したり消したりしてから開いてください。
      「何が起きたか」「再現手順」は GitHub で書きます。
    </p>

    <div class="fields">
      <label>
        <span>タイトル</span>
        <input
          type="text"
          bind:value={title}
          placeholder="何が起きたかを短く"
          data-testid="issue-field-title"
        />
      </label>
      <label>
        <span>denpa のバージョン</span>
        <input
          type="text"
          bind:value={version}
          data-testid="issue-field-version"
        />
      </label>
      <label>
        <span>環境</span>
        <input
          type="text"
          bind:value={environment}
          data-testid="issue-field-environment"
        />
      </label>
      <label>
        <span>ログ</span>
        <textarea
          rows="12"
          bind:value={logs}
          spellcheck="false"
          data-testid="issue-field-logs"></textarea>
      </label>
    </div>

    <p class="small muted" data-testid="issue-length">
      {#if omitted > 0}
        URL に入るぶんだけ、警告とエラーを先に入れました ({omitted} 行を省きました)。全部はコピーかダウンロードして
        Issue に貼ってください。
      {:else}
        ログは全部入っています。
      {/if}
      <span class="num"
        >URL {link.url.length.toLocaleString()} / {URL_LIMIT.toLocaleString()} 字</span
      >
      {#if link.dropped > 0}
        ・長くなったので、ログの頭の {link.dropped} 行を省いて開きます
      {/if}
    </p>

    <footer class="modal-actions">
      <span class="small muted copied" aria-live="polite">
        {copied ? "コピーしました" : ""}
      </span>
      <button
        type="button"
        class="secondary"
        onclick={download}
        data-testid="issue-download">ダウンロード</button
      >
      <button
        type="button"
        class="secondary"
        onclick={copy}
        data-testid="issue-copy">コピー</button
      >
      <a
        class="button"
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="issue-open">GitHub で開く</a
      >
    </footer>
  </article>
</dialog>

<style>
  .intro {
    margin: var(--dp-space-1) 0 var(--dp-space-4);
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--dp-space-3);
    --pico-form-element-spacing-vertical: 0.25rem;
    --pico-form-element-spacing-horizontal: 0.625rem;
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: var(--dp-space-1);
    margin: 0;
    font-size: var(--dp-text-sm);
  }
  .fields input,
  .fields textarea {
    margin: 0;
  }
  textarea {
    font-family: var(--pico-font-family-monospace);
    font-size: var(--dp-text-xs);
    line-height: 1.5;
    white-space: pre;
    resize: vertical;
  }
  [data-testid="issue-length"] {
    margin: var(--dp-space-3) 0 0;
  }
  .copied {
    margin-right: auto;
  }
</style>
