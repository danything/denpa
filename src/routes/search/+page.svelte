<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { submitting } from "#lib/actions.js";
  import { arming } from "#lib/arming.svelte.js";
  import ActionButton from "#lib/components/ActionButton.svelte";
  import ArmedDelete from "#lib/components/ArmedDelete.svelte";
  import ProgramDetail from "#lib/components/ProgramDetail.svelte";
  import ServiceLogo from "#lib/components/ServiceLogo.svelte";
  import Toasts, { errorNotice } from "#lib/components/Toasts.svelte";
  import { programDetail } from "#lib/detail.svelte.js";
  import {
    badgeClass,
    dateTime,
    quietState,
    recordedDuration,
    stateLabel,
    time,
  } from "#lib/format.js";
  import { loadRecent, pushRecent, saveRecent } from "#lib/recent-searches.js";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import type { Preview, PreviewRow } from "./+page.server";
  import RuleDraft, { SKIP_LABEL } from "./RuleDraft.svelte";

  let { data, form } = $props();
  /**
   * 探した言葉。**値が変わったときだけ追う** (`$derived`)。予約・取消のあとの読み直しでは `data` ごと
   * 入れ替わるので、`data.q` を直に見ていると、開いた「もっと見る」や打ちかけの欄まで戻っていた
   */
  const q = $derived(data.q);

  /** 節ごとに最初に出す数。「もっと見る」で受け取ったぶん (上限 `data.limit`) まで広げる */
  const FIRST = 5;
  type Key = "programs" | "recordings" | "reservations" | "rules";
  /** 開いた節。言葉が変わったら畳み直す */
  let expanded = $derived.by<Record<Key, boolean>>(() => {
    void q;
    return {
      programs: false,
      recordings: false,
      reservations: false,
      rules: false,
    };
  });
  function shown<T>(key: Key, rows: T[]): T[] {
    return expanded[key] ? rows : rows.slice(0, FIRST);
  }

  /** 最近の検索。端末ごと (`#lib/recent-searches.ts`)。描いたあとに読む (サーバは知らない) */
  let recent = $state<string[]>([]);
  onMount(() => {
    recent = loadRecent();
  });
  /**
   * **打ち終えてから覚える。** 打つそばから結果を出し直すので、すぐ覚えると「ひ」「ひだ」「ひだま」…と
   * 打ちかけが全部並ぶ。言葉が少しの間変わらなかったら覚える
   */
  const REMEMBER_AFTER = 1500;
  $effect(() => {
    if (q === "") return;
    const word = q;
    const timer = setTimeout(() => {
      // 覚えた並びは読まずに作る (読むとこの効果が自分の書いたものを追って回り続ける)
      const next = pushRecent(loadRecent(), word);
      saveRecent(next);
      recent = next;
    }, REMEMBER_AFTER);
    return () => clearTimeout(timer);
  });
  function clearRecent(): void {
    recent = [];
    saveRecent([]);
  }

  /**
   * **言葉なしで開いたら欄に入る** (下のタブの「検索」から来たとき)。結果を見に来たときは入らない —
   * 狭い画面でキーボードが出て結果を隠す。欄は画面の外 (`SearchField`。広い幅はヘッダー、狭い幅は上の帯)
   * にあるので、見えているほうに入る
   */
  onMount(() => {
    if (q !== "") return;
    void tick().then(() =>
      [...document.querySelectorAll<HTMLInputElement>("[data-search-field]")]
        .find((input) => input.getClientRects().length > 0)
        ?.focus(),
    );
  });

  const total = $derived(
    data.programs.total +
      data.recordings.total +
      data.reservations.total +
      data.rules.total,
  );

  /** いま放送中かの判定に使う時計。分で刻む (番組表と同じ) */
  let clock = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (clock = Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  const watchable = $derived(new Set(data.watchable));

  /**
   * 番組の詳細。押すもの (視聴・予約・取消・ルールを作る) を出すのに、開いた行を覚えておく。
   * 中身は番組表から引く (`detail.svelte.ts`。ホームと同じ)
   */
  interface Opened {
    program_id: number;
    service_id: number;
    start_at: number;
    end_at: number;
    reservation_id: number | null;
    copy_never: boolean;
  }
  const detail = programDetail();
  let opened = $state<Opened | null>(null);
  function showProgram(row: (typeof data.programs.rows)[number]): void {
    opened = {
      program_id: row.id,
      service_id: row.service_id,
      start_at: row.start_at,
      end_at: row.end_at,
      reservation_id: row.reservation_id,
      copy_never: row.copy_never,
    };
    void detail.open(row.id, row);
  }
  /** 下見の行 (言葉なしでルールを開いたとき) から詳細を開く */
  function showPreview(row: PreviewRow): void {
    opened = {
      program_id: row.id,
      service_id: row.service_id,
      start_at: row.start_at,
      end_at: row.end_at,
      reservation_id:
        row.reservation_state === "skipped" ? null : row.reservation_id,
      copy_never: row.skip?.kind === "copy-never",
    };
    void detail.open(row.id, row);
  }
  function showReservation(row: (typeof data.reservations.rows)[number]): void {
    opened = {
      program_id: row.program_id,
      service_id: row.service_id,
      start_at: row.start_at,
      end_at: row.end_at,
      reservation_id: row.id,
      copy_never: false,
    };
    void detail.open(row.program_id, row);
  }
  function close(): void {
    opened = null;
    detail.close();
    // 候補から来た番組 (`?program=`) を閉じたら URL からも外す。読み直しても開き直さない
    if (page.url.searchParams.has("program")) {
      const url = new URL(page.url.href);
      url.searchParams.delete("program");
      void goto(url, { replace: true, shallow: true, state: page.state });
    }
  }

  /**
   * **候補から選んだ番組は、開いたら詳細を出す** (`?program=`。ヘッダーの候補の番組・予約)。
   * 番組が変わったときだけ開く (予約・取消のあとの読み直しでは開き直さない)
   */
  const focusId = $derived(data.focus?.id ?? null);
  $effect(() => {
    if (focusId === null) return;
    const focus = untrack(() => data.focus);
    if (focus === null) return;
    opened = {
      program_id: focus.id,
      service_id: focus.service_id,
      start_at: focus.start_at,
      end_at: focus.end_at,
      reservation_id: focus.reservation_id,
      copy_never: focus.copy_never,
    };
    void detail.open(focus.id, focus);
  });

  /** 削除は2回押させる (ホームと同じ。[arming.svelte.ts](../../lib/arming.svelte.ts)) */
  const deleting = arming(
    '[data-testid="search-delete"], [data-testid="search-delete-confirm"]',
  );

  /**
   * 録画を観る画面。録り終えたものは `/watch`、録っている最中は `/chase`。
   * 録画そのものが失敗したものとファイルの無いものは観られない (ホームの一覧と同じ決め方)
   */
  function watchLink(
    rec: (typeof data.recordings.rows)[number],
  ): string | null {
    if (!rec.has_file || rec.state === "failed") return null;
    return resolve(
      rec.finished_at === null ? `chase/${rec.id}` : `watch/${rec.id}`,
    );
  }

  /**
   * **右の「ルールとして保存」を出すか。** 言葉で探したとき、ルールを直しているとき (`?rule=`)、
   * 書く欄の値を URL に載せて来たとき。何も探していない画面 (最近の検索) には出さない
   */
  const drafting = $derived(
    q !== "" || data.draft.editing !== null || data.draft.seed !== null,
  );
  /** 書く欄のいまの条件での下見 (`RuleDraft`)。行ごとの「録るか」もここ */
  let preview = $state<Preview | null>(null);
  /** 狭い画面で書く欄を下から出しているか */
  let sheetOpen = $state(false);
  /** 「録るか」を聞く番組。結果の一覧に出しうる行 (「もっと見る」で広げるぶんまで) */
  const programIds = $derived(data.programs.rows.map((row) => row.id));
  /** 一覧の行のうち、いまの条件で録るもの */
  const recordingCount = $derived(
    preview === null
      ? null
      : programIds.filter((id) => verdictOf(id)?.kind === "record").length,
  );
  function verdictOf(id: number) {
    return preview?.verdicts[id] ?? null;
  }
  /** ルールの削除の2回押し (書く欄の「削除」) */
  const ruleDeleting = arming('[data-testid^="rule-delete"]');

  const notices = $derived.by(() => {
    const list = errorNotice(form, "search-error");
    if (form?.deletedRule !== undefined) {
      const { canceled } = form.deletedRule;
      list.push({
        key: "rule-deleted",
        kind: "success",
        text:
          canceled > 0
            ? `ルールを削除しました (予約 ${canceled} 件を取り消し)`
            : "ルールを削除しました",
      });
    }
    if (form?.toggled)
      list.push({
        key: "rule-toggled",
        kind: "success",
        text: "ルールを切り替えました",
      });
    return list;
  });
</script>

<svelte:window
  onclick={(event) => {
    deleting.stand(event);
    ruleDeleting.stand(event);
  }}
/>

<Toasts {notices} source={form} />

<!--
    **結果と、右の「ルールとして保存」** (`RuleDraft`)。広い画面 (1024px から) では右の列、狭い画面では
    下のボタンで下から出す。書く欄の条件を変えると、結果の「これからの放送」の行ごとに録るかが出る
-->
<div class="search-layout" class:drafting>
  <div class="search-page">
    <!-- 検索の欄はこの画面には置かない。ヘッダー (狭い幅では上の帯) の欄がそのまま言葉を持っている -->
    {#if q === ""}
      {#if drafting}
        <!--
                **言葉なしでルールを開いたとき** (`?rule=`)。結果の代わりに、そのルールで録る番組を出す
                (下見の行。予約を立てるときと同じ判定)
            -->
        {@render rulePreview()}
      {:else if recent.length > 0}
        <section class="hits-section" aria-labelledby="recent-head">
          <div class="hits-head">
            <h2 id="recent-head">最近の検索</h2>
            <button
              type="button"
              class="link-button small"
              onclick={clearRecent}
              data-testid="recent-clear">履歴を消す</button
            >
          </div>
          <ul class="hits" data-testid="recent-searches">
            {#each recent as word (word)}
              <li class="hit">
                <a
                  class="hit-main"
                  href={resolve(`search?q=${encodeURIComponent(word)}`)}
                  >{word}</a
                >
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {:else}
      <p class="summary muted small" role="status" data-testid="search-summary">
        「<span class="bold">{q}</span>」の検索結果 {total} 件
      </p>

      <!-- これからの放送 (番組表)。予約の入口で、右の書く欄の条件で録るかどうかも行に出す -->
      <section
        class="hits-section"
        aria-labelledby="programs-head"
        data-testid="search-programs"
      >
        <div class="hits-head">
          <h2 id="programs-head">
            これからの放送 <span class="count">{data.programs.total}</span>
          </h2>
          {#if recordingCount !== null && data.programs.total > 0}
            <span class="small muted" data-testid="search-recording-count">
              いまの条件で録るのは <span class="bold">{recordingCount}</span>
              件{data.programs.total > data.programs.rows.length
                ? ` (先頭 ${data.programs.rows.length} 件のうち)`
                : ""}
            </span>
          {/if}
        </div>
        {#if data.programs.total === 0}
          <p class="none small muted">番組表に一致する番組はありません</p>
        {:else}
          <ul class="hits">
            {#each shown("programs", data.programs.rows) as program (program.id)}
              {@const verdict = verdictOf(program.id)}
              <li
                class="hit"
                class:dim={verdict?.kind === "skip" &&
                  program.reservation_state === null}
                data-testid="search-program"
                data-program-id={program.id}
                data-verdict={verdict?.kind}
              >
                <button
                  type="button"
                  class="hit-main"
                  onclick={() => showProgram(program)}
                  data-testid="search-open"
                >
                  <span class="hit-title">
                    <!-- 立っている予約は本当のこととして先に出す。無ければ書く欄の条件で録るか -->
                    {#if program.reservation_state !== null}
                      <span
                        class="tag {badgeClass(program.reservation_state)}"
                        data-testid="search-program-state"
                      >
                        {stateLabel(program.reservation_state)}
                      </span>
                    {:else if verdict?.kind === "record"}
                      <span class="tag success" data-testid="search-verdict"
                        >録る</span
                      >
                    {:else if verdict?.kind === "skip"}
                      <span class="tag" data-testid="search-verdict"
                        >録らない</span
                      >
                    {/if}
                    <span class="truncate broadcast">{program.name}</span>
                  </span>
                  <span class="hit-meta tiny muted">
                    <ServiceLogo
                      id={program.service_id}
                      has={program.has_logo}
                      style="height: 0.875rem; vertical-align: -0.125rem"
                    />
                    <span class="broadcast">{program.service_name}</span> ・
                    <span class="num"
                      >{dateTime(program.start_at)}〜{time(
                        program.end_at,
                      )}</span
                    >
                    {#if verdict?.kind === "skip" && program.reservation_state === null}
                      ・ <span data-testid="search-verdict-reason"
                        >{SKIP_LABEL[verdict.reason]}</span
                      >
                    {/if}
                  </span>
                </button>
                <div class="row-actions">
                  {#if program.reservation_id !== null}
                    <ActionButton
                      action="?/cancel"
                      fields={{ reservationId: program.reservation_id }}
                      class="small outline danger"
                      testid="search-cancel"
                    >
                      取消
                    </ActionButton>
                  {:else if !program.copy_never}
                    <ActionButton
                      action="?/reserve"
                      fields={{ programId: program.id }}
                      class="small outline"
                      testid="search-reserve"
                    >
                      予約
                    </ActionButton>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
          {@render more(
            "programs",
            data.programs.rows.length,
            data.programs.total,
          )}
        {/if}
      </section>

      <section
        class="hits-section"
        aria-labelledby="recordings-head"
        data-testid="search-recordings"
      >
        <div class="hits-head">
          <h2 id="recordings-head">
            録画 <span class="count">{data.recordings.total}</span>
          </h2>
        </div>
        {#if data.recordings.total === 0}
          <p class="none small muted">一致する録画はありません</p>
        {:else}
          <ul class="hits">
            {#each shown("recordings", data.recordings.rows) as rec (rec.id)}
              {@const link = watchLink(rec)}
              <li
                class="hit"
                data-testid="search-recording"
                data-recording-id={rec.id}
              >
                <svelte:element
                  this={link === null ? "div" : "a"}
                  class="hit-main"
                  href={link ?? undefined}
                  data-testid="search-play"
                >
                  <span class="hit-title">
                    {#if !quietState(rec.state)}
                      <span class="tag {badgeClass(rec.state)}"
                        >{stateLabel(rec.state)}</span
                      >
                    {/if}
                    <span class="truncate broadcast">{rec.name}</span>
                  </span>
                  <span class="hit-meta tiny muted">
                    <ServiceLogo
                      id={rec.service_id}
                      has={rec.has_logo}
                      style="height: 0.875rem; vertical-align: -0.125rem"
                    />
                    <span class="broadcast">{rec.service_name}</span> ・
                    <span class="num"
                      >{dateTime(rec.start_at)} ・ {recordedDuration(rec)}</span
                    >
                  </span>
                </svelte:element>
                {#if rec.state !== "recording"}
                  <div class="row-actions">
                    <ArmedDelete
                      {deleting}
                      armKey={rec.id}
                      fields={{ id: rec.id }}
                      class="small"
                      testid="search-delete"
                    />
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
          {@render more(
            "recordings",
            data.recordings.rows.length,
            data.recordings.total,
          )}
        {/if}
      </section>

      <section
        class="hits-section"
        aria-labelledby="reservations-head"
        data-testid="search-reservations"
      >
        <div class="hits-head">
          <h2 id="reservations-head">
            予約 <span class="count">{data.reservations.total}</span>
          </h2>
        </div>
        {#if data.reservations.total === 0}
          <p class="none small muted">一致する予約はありません</p>
        {:else}
          <ul class="hits">
            {#each shown("reservations", data.reservations.rows) as res (res.id)}
              <li
                class="hit"
                data-testid="search-reservation"
                data-program-id={res.program_id}
              >
                <button
                  type="button"
                  class="hit-main"
                  onclick={() => showReservation(res)}
                >
                  <span class="hit-title">
                    {#if !quietState(res.state)}
                      <span class="tag {badgeClass(res.state)}"
                        >{stateLabel(res.state)}</span
                      >
                    {/if}
                    <span class="truncate broadcast">{res.name}</span>
                  </span>
                  <span class="hit-meta tiny muted">
                    <ServiceLogo
                      id={res.service_id}
                      has={res.has_logo}
                      style="height: 0.875rem; vertical-align: -0.125rem"
                    />
                    <span class="broadcast">{res.service_name}</span> ・
                    <span class="num"
                      >{dateTime(res.start_at)}〜{time(res.end_at)}</span
                    >
                    ・ {res.manual
                      ? "手動予約"
                      : `ルール: ${res.rule_name ?? "(削除済み)"}`}
                  </span>
                </button>
                <div class="row-actions">
                  {#if res.recording_id !== null}
                    <a
                      class="button small ghost"
                      href={resolve(`chase/${res.recording_id}`)}
                      >追っかけ再生</a
                    >
                  {:else}
                    <ActionButton
                      action="?/cancel"
                      fields={{ reservationId: res.id }}
                      class="small outline danger"
                      testid="search-reservation-cancel"
                    >
                      取消
                    </ActionButton>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
          {@render more(
            "reservations",
            data.reservations.rows.length,
            data.reservations.total,
          )}
        {/if}
      </section>

      <section
        class="hits-section"
        aria-labelledby="rules-head"
        data-testid="search-rules"
      >
        <div class="hits-head">
          <h2 id="rules-head">
            ルール <span class="count">{data.rules.total}</span>
          </h2>
        </div>
        {#if data.rules.total === 0}
          <p class="none small muted">一致するルールはありません</p>
        {:else}
          <ul class="hits">
            {#each shown("rules", data.rules.rows) as rule (rule.id)}
              <li class="hit" data-testid="search-rule">
                <a class="hit-main" href={resolve(`search?rule=${rule.id}`)}>
                  <span class="hit-title">
                    {#if !rule.enabled}<span class="tag">無効</span>{/if}
                    <span class="truncate">{rule.name}</span>
                  </span>
                  <span class="hit-meta tiny muted">
                    {#if rule.keyword !== ""}キーワード: {rule.keyword} ・{/if}
                    優先度 {rule.priority} ・ 予約 {rule.reservations} 件
                  </span>
                </a>
              </li>
            {/each}
          </ul>
          {@render more("rules", data.rules.rows.length, data.rules.total)}
        {/if}
      </section>
    {/if}
  </div>
  {#if drafting}
    <RuleDraft
      draft={data.draft}
      {q}
      ids={programIds}
      refresh={data}
      deleting={ruleDeleting}
      bind:preview
      bind:open={sheetOpen}
    />
    <!-- 狭い画面だけ。書く欄を下から出す (下のタブの上に貼り付ける) -->
    <div class="sheet-bar">
      <button
        type="button"
        onclick={() => (sheetOpen = true)}
        data-testid="rule-draft-open"
      >
        {data.draft.editing === null
          ? "ルールとして保存"
          : `ルール「${data.draft.editing.name}」を直す`}
      </button>
    </div>
  {/if}
</div>

<!-- 言葉なしでルールを開いたときの、そのルールで録る番組 (`rule-preview.ts` の行) -->
{#snippet rulePreview()}
  <section
    class="hits-section"
    aria-labelledby="rule-preview-head"
    data-testid="rule-preview"
  >
    <div class="hits-head">
      <h2 id="rule-preview-head">
        この条件で録る番組 <span class="count">{preview?.total ?? "…"}</span>
      </h2>
      {#if preview !== null && preview.skipped > 0}
        <span class="small muted">うち {preview.skipped} 件は録りません</span>
      {/if}
    </div>
    {#if preview === null}
      <p class="none small muted">数えています…</p>
    {:else if preview.programs.length === 0}
      <p class="none small muted">いまの番組表では1件も一致しません</p>
    {:else}
      <ul class="hits">
        {#each preview.programs as row (row.id)}
          <li
            class="hit"
            class:dim={row.skip !== null || !row.matched}
            data-testid="preview-row"
            data-program-id={row.id}
          >
            <button
              type="button"
              class="hit-main"
              onclick={() => showPreview(row)}
              data-testid="preview-open"
            >
              <span class="hit-title">
                {#if row.skip !== null || !row.matched}
                  <span class="tag">録らない</span>
                {:else if row.reservation_state !== null}
                  <span class="tag {badgeClass(row.reservation_state)}"
                    >{stateLabel(row.reservation_state)}</span
                  >
                {:else}
                  <span class="tag success">録る</span>
                {/if}
                <span class="truncate broadcast">{row.name}</span>
              </span>
              <span class="hit-meta tiny muted">
                <span class="broadcast">{row.service_name}</span> ・
                <span class="num"
                  >{dateTime(row.start_at)}〜{time(row.end_at)}</span
                >
                {#if !row.matched}
                  ・ 条件から外れました
                {:else if row.skip !== null}
                  ・ {SKIP_LABEL[row.skip.kind]}
                {/if}
                {#if row.conflicts.length > 0 || row.conflict_reason !== null}
                  ・ <span class="text-error"
                    >{row.conflict_reason ??
                      `チューナーの競合 ${row.conflicts.length} 件`}</span
                  >
                {/if}
              </span>
            </button>
            <!-- 1件ずつ: 立っている予約は取り消し、録る行はその1本だけ予約できる (ホーム・結果の行と同じ action) -->
            <div class="row-actions">
              {#if row.reservation_id !== null && row.reservation_state !== "skipped"}
                <ActionButton
                  action="?/cancel"
                  fields={{ reservationId: row.reservation_id }}
                  class="small outline danger"
                  testid="preview-cancel"
                >
                  取消
                </ActionButton>
              {:else if row.reservation_id === null && row.matched && row.skip === null}
                <ActionButton
                  action="?/reserve"
                  fields={{ programId: row.id }}
                  class="small outline"
                  testid="preview-reserve"
                >
                  予約
                </ActionButton>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if preview.total > preview.programs.length}
        <p class="none tiny muted">
          先頭の {preview.programs.length} 件を表示しています
        </p>
      {/if}
    {/if}
  </section>
{/snippet}

<!-- 「もっと見る」。受け取ったぶんを出し切っても残りがあれば、言葉を足してもらう -->
{#snippet more(key: Key, received: number, all: number)}
  {#if !expanded[key] && received > FIRST}
    <button
      type="button"
      class="link-button small more"
      onclick={() => (expanded = { ...expanded, [key]: true })}
      data-testid="search-more-{key}"
    >
      もっと見る ({all - FIRST} 件)
    </button>
  {:else if expanded[key] && all > received}
    <p class="none tiny muted">
      先頭の {received} 件を表示しています。言葉を足して絞ってください
    </p>
  {/if}
{/snippet}

{#if detail.current}
  <ProgramDetail program={detail.current} onclose={close}>
    {#snippet actions()}
      {#if form?.message}
        <div class="notice error detail-error">{form.message}</div>
      {/if}
      <!-- 並びは控えから主へ (主の「予約」がいちばん右)。閉じるは右上の × (`ProgramDetail`) -->
      {#if opened !== null}
        <a
          class="button secondary"
          href={resolve(`search?from=program:${opened.program_id}`)}
          >ルールを作る</a
        >
      {/if}
      {#if opened !== null && opened.start_at <= clock && opened.end_at > clock && watchable.has(opened.service_id)}
        <a
          class="button outline"
          href={resolve(`live?service=${opened.service_id}`)}>視聴</a
        >
      {/if}
      {#if opened !== null && opened.reservation_id !== null}
        <form
          method="POST"
          action="?/cancel"
          use:submitting={() =>
            async ({ result, update }) => {
              await update();
              if (result.type === "success") close();
            }}
        >
          <input
            type="hidden"
            name="reservationId"
            value={opened.reservation_id}
          />
          <button
            type="submit"
            class="outline danger"
            data-testid="search-detail-cancel">予約取消</button
          >
        </form>
      {:else if opened !== null && opened.end_at > clock && !opened.copy_never}
        <form
          method="POST"
          action="?/reserve"
          use:submitting={() =>
            async ({ result, update }) => {
              await update();
              if (result.type === "success") close();
            }}
        >
          <input type="hidden" name="programId" value={opened.program_id} />
          <button type="submit" data-testid="search-detail-reserve">予約</button
          >
        </form>
      {/if}
    {/snippet}
  </ProgramDetail>
{/if}

<style>
  .search-page {
    display: flex;
    flex-direction: column;
    gap: var(--dp-space-5);
    width: 100%;
    max-width: 48rem;
    margin-inline: auto;
  }
  /*
     * **広い画面では右に書く欄の列** (`RuleDraft`)。列は main の余白の外まで出して、画面の右端と
     * ヘッダーの下に付ける。結果は残りの幅の真ん中 (48rem まで)
     */
  @media (min-width: 1024px) {
    .search-layout.drafting {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 25rem;
      align-items: start;
      gap: var(--dp-gutter);
      margin-block: calc(-1 * var(--dp-page-top)) calc(-1 * var(--dp-gutter));
      margin-inline-end: calc(-1 * var(--dp-gutter));
    }
    .drafting > .search-page {
      padding-block: var(--dp-page-top) var(--dp-gutter);
    }
    .sheet-bar {
      display: none;
    }
  }
  /*
     * 狭い画面では書く欄を下から出すボタンを、下のタブの上に貼り付ける。
     * 結果の一覧の最後の行が隠れないよう、ボタンの高さぶんの余白を下に足す
     */
  @media (max-width: 1023.98px) {
    .drafting > .search-page {
      padding-bottom: 4rem;
    }
    .sheet-bar {
      position: fixed;
      inset-inline: 0;
      bottom: var(--dp-tabbar, 0px);
      z-index: 30;
      padding: var(--dp-space-2) var(--dp-gutter);
      border-top: 1px solid var(--dp-line);
      background: var(--dp-bg);
    }
    .sheet-bar button {
      width: 100%;
      margin: 0;
      border-radius: var(--dp-radius-full);
    }
  }
  /* 書く欄の条件では録らない行。消さずに出すが、録るものより沈める */
  .hit.dim {
    opacity: 0.5;
  }
  .summary {
    margin: 0;
  }
  /*
     * **節は見出しと細い線だけ** (カードで囲まない)。行は名前と小さな説明の2段で、
     * 線で区切る。指を乗せると淡い地 (押せる範囲は行の中身いっぱい)
     */
  .hits-section {
    display: flex;
    flex-direction: column;
    gap: var(--dp-space-2);
  }
  .hits-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--dp-space-2) var(--dp-space-3);
    padding-bottom: var(--dp-space-2);
    border-bottom: 1px solid var(--dp-line);
  }
  .hits-head h2 {
    margin: 0;
    font-size: var(--dp-text-base);
    font-weight: var(--dp-weight-bold);
  }
  .count {
    margin-inline-start: var(--dp-space-1);
    color: var(--dp-muted);
    font-weight: normal;
    font-variant-numeric: tabular-nums;
  }
  .hits {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
  }
  .hit {
    display: flex;
    align-items: center;
    gap: var(--dp-space-2);
    margin: 0;
    list-style: none;
    border-bottom: 1px solid var(--dp-line);
  }
  .hit-main {
    display: flex;
    flex: 1 1 0%;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    margin: 0;
    padding: var(--dp-space-2) var(--dp-space-2);
    border: 0;
    border-radius: var(--dp-radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    text-decoration: none;
  }
  :is(a, button).hit-main {
    cursor: pointer;
  }
  :is(a, button).hit-main:hover {
    background: var(--dp-hover);
  }
  .hit-title {
    display: flex;
    align-items: center;
    gap: var(--dp-space-2);
    min-width: 0;
  }
  .hit-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hit .row-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--dp-space-1);
  }
  .none {
    margin: 0;
    padding: var(--dp-space-2);
  }
  .link-button {
    width: auto;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--pico-primary);
    cursor: pointer;
  }
  .link-button:hover {
    text-decoration: underline;
  }
  .more {
    align-self: flex-start;
    padding: var(--dp-space-2);
  }
  .detail-error {
    flex-basis: 100%;
  }
  /* 狭い画面では操作を名前の下に回す (名前を潰さない) */
  @media (max-width: 639.98px) {
    .hit {
      flex-wrap: wrap;
    }
    .hit .row-actions {
      margin-top: calc(var(--dp-space-2) * -1);
      padding-inline: var(--dp-space-1);
    }
    .hit .row-actions:not(:empty) {
      flex-basis: 100%;
      justify-content: flex-end;
    }
  }
</style>
