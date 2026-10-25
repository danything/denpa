<script lang="ts">
  import { refreshAll } from "$app/navigation";
  import { onMount } from "svelte";

  import Lead from "#lib/components/Lead.svelte";
  import { type LogLine, type LogSource, stamp } from "#lib/issue-report.js";
  import { held } from "#lib/live-updates.svelte.js";
  import { redact } from "#lib/redact.js";
  import type { CardReaderState } from "#lib/server/scramble.js";

  import IssueDialog from "./IssueDialog.svelte";

  let { data } = $props();

  /** 読み直しの間も前の中身を出したままにする (`held`。設定の「チューナー」と同じ) */
  const tuners = held(() => data.tuners);
  const card = held(() => data.card);
  const agent = held(() => data.agentLogs);

  /** ブラウザ。サーバでは分からないので、開いてから入れる */
  let browser = $state("");
  onMount(() => {
    browser = navigator.userAgent;
  });

  const READER_STATE: Record<CardReaderState, string> = {
    active: "使用中",
    standby: "予備",
    empty: "カードなし",
    error: "エラー",
    unknown: "—",
  };

  const tunerText = $derived(
    tuners.value === undefined
      ? null
      : tuners.value.error !== null
        ? `取得できません (${tuners.value.error})`
        : tuners.value.list.length === 0
          ? "見つかりません"
          : tuners.value.list
              .map(
                (t) =>
                  `${t.name} (${t.types.join("・")}${t.disabled ? "・無効" : ""}${t.error === null ? "" : `・${t.error}`})`,
              )
              .join("、"),
  );

  const cardText = $derived(
    card.value === undefined
      ? null
      : card.value.readers.length === 0
        ? card.value.message || "見つかりません"
        : card.value.readers
            .map(
              (r) =>
                `${r.name} (${READER_STATE[r.state]}${r.error === undefined ? "" : `・${r.error}`})`,
            )
            .join("、"),
  );

  const versionText = $derived(
    data.environment.version === "dev"
      ? "開発ビルド (dev)"
      : data.environment.version,
  );

  // ---- ログ ----

  type Row = LogLine & { source: "server" | "agent"; key: string };

  let showServer = $state(true);
  let showAgent = $state(true);
  let problemsOnly = $state(false);
  let query = $state("");
  /** 一度に描く行の数。足りなければ「もっと見る」で増やす */
  const STEP = 300;
  let shown = $state(STEP);

  const rows = $derived.by((): Row[] => {
    const all: Row[] = [
      ...(showServer
        ? data.serverLogs.map((line, i) => ({
            ...line,
            source: "server" as const,
            key: `s${i}`,
          }))
        : []),
      ...(showAgent
        ? (agent.value?.lines ?? []).map((line, i) => ({
            ...line,
            source: "agent" as const,
            key: `a${i}`,
          }))
        : []),
    ];
    const words = query.trim().toLowerCase();
    return all
      .filter((row) => !problemsOnly || row.level !== "info")
      .filter((row) => words === "" || row.text.toLowerCase().includes(words))
      .sort((a, b) => b.at - a.at);
  });

  // 絞り方を変えたら、描く行の数を戻す
  $effect(() => {
    void [showServer, showAgent, problemsOnly, query];
    shown = STEP;
  });

  const LEVEL_MARK = { warn: "⚠ 警告", error: "✕ エラー" } as const;

  let reloading = $state(false);
  async function reload(): Promise<void> {
    reloading = true;
    try {
      await refreshAll();
    } finally {
      reloading = false;
    }
  }

  // ---- Issue にする ----

  let report = $state.raw<{
    version: string;
    environment: string;
    sources: LogSource[];
  } | null>(null);
  let preparing = $state(false);

  /** **伏せてから渡す。** 窓に見えるものが、そのまま GitHub に入る */
  async function openIssue(): Promise<void> {
    preparing = true;
    try {
      const known = { hosts: data.hosts };
      // エージェント待ちのものが届くまで待つ (`held` が先に受け取るので、待ったあとは中身が入っている)
      await Promise.allSettled([data.agentLogs, data.tuners, data.card]);
      const agentLogs = agent.value;
      const environment = [
        `サーバ: ${data.environment.os}・${data.environment.runtime}`,
        `チューナー: ${tunerText ?? "—"}`,
        `カードリーダー: ${cardText ?? "—"}`,
        `ブラウザ: ${browser || "—"}`,
      ].join(" / ");
      const scrub = (lines: LogLine[]): LogLine[] =>
        lines.map((line) => ({ ...line, text: redact(line.text, known) }));
      const agentSource: LogSource = {
        label: "エージェント",
        tagged: false,
        lines: scrub(agentLogs?.lines ?? []),
      };
      if (agentLogs?.error)
        agentSource.note = `(${redact(agentLogs.error, known)})`;
      report = {
        version: data.environment.version,
        environment: redact(environment, known),
        sources: [
          {
            label: "サーバ",
            tagged: true,
            lines: scrub(data.serverLogs),
          },
          agentSource,
        ],
      };
    } finally {
      preparing = false;
    }
  }
</script>

<!-- 節の並びと名前は `#lib/settings-sections.ts`。`id` は左の一覧から飛ぶ先 -->
<div class="part" id="environment" data-part>
  <div class="sections readable">
    <!--
        **バグを報告するときに聞かれるもの。** バージョン・OS・チューナー・カードリーダー・ブラウザ。
        エージェントのバージョンと OS はエージェントが返さないので出さない
    -->
    <section class="section" data-testid="diagnostics-environment">
      <div class="section-head">
        <h2>環境</h2>
      </div>
      <div class="setting-rows">
        <div class="field">
          <span class="field-label">denpa のバージョン</span>
          <span class="small" data-testid="diag-version">{versionText}</span>
        </div>
        <div class="field">
          <span class="field-label">サーバ</span>
          <span class="small" data-testid="diag-server">
            {data.environment.os}・{data.environment.runtime}
          </span>
        </div>
        <div class="field">
          <span class="field-label">チューナー</span>
          <span class="small" data-testid="diag-tuners">
            {tunerText ?? "エージェントに聞いています…"}
          </span>
        </div>
        <div class="field">
          <span class="field-label">カードリーダー</span>
          <span class="small" data-testid="diag-card">
            {cardText ?? "エージェントに聞いています…"}
          </span>
        </div>
        <div class="field">
          <span class="field-label">ブラウザ</span>
          <span class="small ua" data-testid="diag-browser"
            >{browser || "—"}</span
          >
        </div>
      </div>
    </section>
  </div>
</div>

<div class="part" id="logs" data-part>
  <div class="sections">
    <section class="section" data-testid="diagnostics-logs">
      <div class="section-head">
        <h2>ログ</h2>
        <div class="head-actions">
          <button
            type="button"
            class="small secondary"
            onclick={reload}
            disabled={reloading}
            data-testid="logs-reload"
          >
            {reloading ? "読み直しています…" : "読み直す"}
          </button>
          <button
            type="button"
            class="small"
            onclick={openIssue}
            disabled={preparing}
            data-testid="issue-start"
          >
            Issue にする
          </button>
        </div>
      </div>
      <Lead>
        新しい順。サーバとエージェントのそれぞれ最後の 2000 行です
        {#snippet more()}
          <p>
            サーバのログはメモリにだけ持っていて、再起動すると消えます。「Issue
            にする」では、カードの番号・IP
            アドレス・ホスト名・トークンなどを伏せた報告を作り、確かめてから
            GitHub で開きます。denpa からは何も送りません。
          </p>
          <p>
            エージェントのログには重さが無いので、「警告とエラーだけ」は字
            (失敗・エラー・できません など) から見分けています。
          </p>
        {/snippet}
      </Lead>

      <div class="filters">
        <div class="chips">
          <label class="chip">
            <input
              type="checkbox"
              bind:checked={showServer}
              data-testid="logs-server"
            />
            サーバ
          </label>
          <label class="chip">
            <input
              type="checkbox"
              bind:checked={showAgent}
              data-testid="logs-agent"
            />
            エージェント
          </label>
        </div>
        <label class="check">
          <input
            type="checkbox"
            role="switch"
            aria-checked={problemsOnly}
            bind:checked={problemsOnly}
            data-testid="logs-problems"
          />
          <span>警告とエラーだけ</span>
        </label>
        <input
          type="search"
          class="search"
          placeholder="ログを検索"
          aria-label="ログを検索"
          bind:value={query}
          data-testid="logs-search"
        />
      </div>

      {#if agent.value?.error}
        <p class="small muted" data-testid="agent-logs-error">
          ⚠ {agent.value.error}
        </p>
      {/if}

      {#if rows.length === 0}
        <p class="small muted" data-testid="logs-empty">
          {query.trim() !== "" || problemsOnly
            ? "当てはまる行はありません"
            : "ログはまだありません"}
        </p>
      {:else}
        <ol class="log-lines" data-testid="log-lines">
          {#each rows.slice(0, shown) as row (row.key)}
            <li
              class="log-line {row.level}"
              data-source={row.source}
              data-level={row.level}
              data-testid="log-line"
            >
              <time class="at" datetime={new Date(row.at).toISOString()}
                >{stamp(row.at).slice(5)}</time
              >
              <span class="from"
                >{row.source === "server" ? "サーバ" : "エージェント"}</span
              >
              {#if row.level !== "info"}
                <span class="level">{LEVEL_MARK[row.level]}</span>
              {/if}
              <span class="text">{row.text}</span>
            </li>
          {/each}
        </ol>
        {#if rows.length > shown}
          <button
            type="button"
            class="small ghost more"
            onclick={() => (shown += STEP)}
            data-testid="logs-more"
          >
            もっと見る (残り {rows.length - shown} 行)
          </button>
        {/if}
      {/if}
    </section>
  </div>
</div>

<IssueDialog {report} onclose={() => (report = null)} />

<style>
  .head-actions {
    display: flex;
    gap: var(--dp-space-2);
    margin-left: auto;
  }
  .ua {
    overflow-wrap: anywhere;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--dp-space-2) var(--dp-space-4);
  }
  .filters .check {
    margin: 0;
  }
  .search {
    flex: 1 1 12rem;
    max-width: 20rem;
    margin: 0;
  }
  /*
   * **1 行ずつ地の上に並べる** (1 行の並びは地。docs/design.md「3 つの層」)。線で区切らず、詰めて読む。
   * 警告とエラーは印と言葉を添えて状態の色で (色だけに頼らない)
   */
  .log-lines {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--dp-text-xs);
    line-height: 1.5;
  }
  .log-line {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--dp-space-2);
    margin: 0;
    padding: 0.125rem 0;
  }
  .at,
  .from {
    flex-shrink: 0;
    color: var(--dp-muted);
    font-variant-numeric: tabular-nums;
  }
  .from {
    min-width: 5.5em;
  }
  .level {
    flex-shrink: 0;
    font-weight: var(--dp-weight-bold);
  }
  .warn .level {
    color: var(--dp-warn-text);
  }
  .error .level {
    color: var(--dp-rec-text);
  }
  .text {
    flex: 1 1 20rem;
    min-width: 0;
    font-family: var(--pico-font-family-monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .more {
    align-self: flex-start;
  }
</style>
