<script lang="ts">
  import { refreshAll } from "$app/navigation";
  import { onMount } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import ExternalLink from "~icons/lucide/external-link";

  import Lead from "#lib/components/Lead.svelte";
  import Icon from "#lib/components/player/Icon.svelte";
  import {
    agentSystem,
    CCID_DRIVER,
    environmentText,
    type LogLine,
    type LogSource,
    sameVersion,
    stamp,
  } from "#lib/issue-report.js";
  import { held } from "#lib/live-updates.svelte.js";
  import { PHONE_FORM } from "#lib/phone-form.js";
  import { redact } from "#lib/redact.js";
  import type { CardReaderState } from "#lib/server/scramble.js";

  import type { PageData } from "./$types";
  import IssueDialog from "./IssueDialog.svelte";

  /**
   * 設定の「その他」の「バージョンと環境」(`#version`) と「ログ」(`#logs`) の節。前の「診断」の画面。
   * 環境の中身は Issue の報告にも入れるので、2つの節を1つの部品に置く
   */
  let { data }: { data: PageData } = $props();

  /**
   * スマホの形 (下のタブがある形。`#lib/phone-form.ts`) では、ログの押すもの (読み直す・Issue にする) を絞り込みと同じ1行に入れる。
   * その1行は下のタブの上に浮く (`settings/+layout.svelte` の `.section-bar`)
   */
  const phone = new MediaQuery(PHONE_FORM);

  /** 読み直しの間も前の中身を出したままにする (`held`。設定の「チューナー」と同じ) */
  const tuners = held(() => data.tuners);
  const card = held(() => data.card);
  const agent = held(() => data.agentLogs);
  const about = held(() => data.agentAbout);

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

  const showVersion = (version: string) =>
    version === "dev" ? "開発ビルド (dev)" : version;
  const versionText = $derived(showVersion(data.environment.version));

  /** エージェントのバージョン。前のバージョンのエージェントは返さないので、そのときは理由を出す */
  const agentVersionText = $derived(
    about.value === undefined
      ? null
      : about.value.about === null
        ? (about.value.error ?? "—")
        : about.value.about.version === null
          ? "不明"
          : showVersion(about.value.about.version),
  );
  /** denpa とエージェントは同じバージョンで使うもの。違えば知らせる */
  const versionMismatch = $derived.by(() => {
    const version = about.value?.about?.version ?? null;
    return version !== null && !sameVersion(data.environment.version, version);
  });

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
      await Promise.allSettled([
        data.agentLogs,
        data.agentAbout,
        data.tuners,
        data.card,
      ]);
      const agentLogs = agent.value;
      const environment = environmentText({
        denpaVersion: data.environment.version,
        server: `${data.environment.os}・${data.environment.runtime}`,
        agent: about.value,
        tuners: tunerText ?? "—",
        card: cardText ?? "—",
        browser: browser || "—",
      });
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
<div class="part" id="version" data-part>
  <div class="sections readable">
    <!--
        **動いているバージョンと、バグを報告するときに聞かれるもの。** denpa とエージェントのバージョン・OS・
        チューナー・カードリーダー・ブラウザ。エージェントのことは `GET /denpa/about` から。macOS のエージェントなら CCID ドライバも。
        **新しいバージョンのリンクは denpa のバージョンのすぐ下に出す** (`server/update.ts`)。スマホの形ではヘッダーを隠すので、
        ここが置き場になる。出ている間は設定の入口 (下のタブ・ヘッダー・左の一覧の「その他」) に同じ点を付ける (`.fresh-dot`)。
        main のイメージと手元は `dev` で、リリースと見比べない
    -->
    <section class="section" data-testid="diagnostics-environment">
      <div class="section-head">
        <h2>バージョンと環境</h2>
      </div>
      {#if data.environment.version === "dev"}
        <Lead>開発ビルドなので、新しいリリースとは見比べません</Lead>
      {:else}
        <Lead
          >新しいバージョンが出たら、ここに出ます (設定の入口に点が付きます)</Lead
        >
      {/if}
      <div class="setting-rows">
        <div class="field">
          <span class="field-label">denpa のバージョン</span>
          <span class="small" data-testid="diag-version">{versionText}</span>
          {#if data.update !== null}
            <a
              class="update small"
              href={data.update.url}
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub のリリースを開く"
              data-testid="settings-update"
            >
              <span class="fresh-dot" aria-hidden="true"></span>
              {data.update.version} が公開されています
              <Icon icon={ExternalLink} size="size-3.5" />
            </a>
          {/if}
        </div>
        <div class="field">
          <span class="field-label">エージェントのバージョン</span>
          <span class="small" data-testid="diag-agent-version">
            {agentVersionText ?? "エージェントに聞いています…"}
            {#if versionMismatch}
              <span class="mismatch" data-testid="diag-version-mismatch">
                ⚠ denpa ({data.environment.version})
                とバージョンが違います。同じバージョンに揃えてください
              </span>
            {/if}
          </span>
        </div>
        <div class="field">
          <span class="field-label">サーバ</span>
          <span class="small" data-testid="diag-server">
            {data.environment.os}・{data.environment.runtime}
          </span>
        </div>
        {#if about.value?.about}
          <div class="field">
            <span class="field-label">エージェントの OS</span>
            <span class="small" data-testid="diag-agent-system">
              {agentSystem(about.value.about)}
            </span>
          </div>
          {#if about.value.about.ccidDriver}
            <div class="field">
              <span class="field-label">CCID ドライバ</span>
              <span class="small" data-testid="diag-ccid-driver">
                {CCID_DRIVER[about.value.about.ccidDriver]}
              </span>
            </div>
          {/if}
        {/if}
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

<!-- ログの押すもの。広い画面では見出しの行の右、スマホの形では絞り込みの1行の頭 (上の `phone`) -->
{#snippet logActions()}
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
{/snippet}

<div class="part" id="logs" data-part>
  <div class="sections">
    <section class="section" data-testid="diagnostics-logs">
      <div class="section-head">
        <h2>ログ</h2>
        {#if !phone.current}
          <div class="head-actions">{@render logActions()}</div>
        {/if}
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

      <div class="filters section-bar" data-testid="logs-filters">
        {#if phone.current}{@render logActions()}{/if}
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
  /* 印と言葉を添えて状態の色で (色だけに頼らない。ログの警告と同じ) */
  .mismatch {
    display: block;
    color: var(--dp-warn-text);
  }
  /*
   * 新しいバージョンのリンク。事実なのでバッジにせず字のまま、外へ出る印を添える (ヘッダーの「… が公開されています」と同じ)。
   * 指で押すので高さは 40px を取る
   */
  .update {
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    gap: 0.375rem;
    min-height: 2.5rem;
    color: inherit;
    text-decoration: none;
  }
  .update:hover {
    color: var(--pico-h1-color);
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
  /* スマホの形 (`#lib/phone-form.ts`。`<html data-phone>`) では横に巻く1行の中なので、検索の欄は決まった幅 */
  :global(:where(html[data-phone])) .search {
    flex: 0 0 10rem;
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
