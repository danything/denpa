<script lang="ts">
  import type { SubmitFunction } from "$app/forms";
  import { resolve } from "$app/paths";

  import { submitting } from "#lib/actions.js";
  import { arming } from "#lib/arming.svelte.js";
  import ArmedDelete from "#lib/components/ArmedDelete.svelte";
  import Toasts, {
    errorNotice,
    type Notice,
  } from "#lib/components/Toasts.svelte";
  import { date } from "#lib/format.js";
  import { Paged, sentinel } from "#lib/paging.svelte.js";
  import { conditionSummary, upcomingLabel } from "#lib/rule-summary.js";

  let { data, form } = $props();

  /**
   * **ルールの一覧と管理。** 並べて見比べ、スイッチで止める・戻す、2回押しで消す。
   * 作る・直すのは検索の画面の「ルールとして保存」(行を押すと `/search?rule=<ID>`)
   */

  type Rule = (typeof data.rules)[number];
  type Filter = "all" | "on" | "off" | "idle" | "conflict";
  const FILTERS: {
    key: Filter;
    label: string;
    test: (rule: Rule) => boolean;
  }[] = [
    { key: "all", label: "すべて", test: () => true },
    { key: "on", label: "有効", test: (rule) => rule.enabled },
    { key: "off", label: "無効", test: (rule) => !rule.enabled },
    { key: "idle", label: "次の放送なし", test: (rule) => rule.next === null },
    { key: "conflict", label: "競合あり", test: (rule) => rule.conflicts > 0 },
  ];
  let filter = $state<Filter>("all");

  type Sort = "next" | "new" | "name" | "reservations" | "recorded";
  const SORTS: { key: Sort; label: string }[] = [
    { key: "next", label: "次の放送が近い順" },
    { key: "new", label: "新しい順" },
    { key: "name", label: "名前順" },
    { key: "reservations", label: "予約が多い順" },
    { key: "recorded", label: "最近録れた順" },
  ];
  let sort = $state<Sort>("next");

  /** 並べ替え。決まらないものは新しいルールを上に (読み込んだ順) */
  function compare(a: Rule, b: Rule): number {
    switch (sort) {
      case "next":
        return (a.next?.start_at ?? Infinity) - (b.next?.start_at ?? Infinity);
      case "name":
        return a.name.localeCompare(b.name, "ja");
      case "reservations":
        return b.reservations - a.reservations;
      case "recorded":
        return (
          (b.last_recorded_at ?? -Infinity) - (a.last_recorded_at ?? -Infinity)
        );
      default:
        return 0;
    }
  }
  const shownRules = $derived(
    data.rules
      .filter(FILTERS.find((f) => f.key === filter)!.test)
      .sort((a, b) => compare(a, b) || b.id - a.id),
  );
  /** 少しずつ出す (`paging.svelte.ts`)。ルールが数百あっても開いた直後に止まらない */
  const paged = new Paged(() => shownRules, 60);
  $effect(() => {
    void filter;
    void sort;
    paged.reset();
  });

  /** 絞り込みごとの件数 */
  const counts = $derived(
    Object.fromEntries(
      FILTERS.map((f) => [f.key, data.rules.filter(f.test).length]),
    ) as Record<Filter, number>,
  );
  const serviceNames = $derived(
    new Map(data.services.map((s) => [s.id, s.name])),
  );
  /** 「今日」「明日」の切れ目に使う時計。分で刻む */
  let clock = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (clock = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  /** ルールの削除は2回押させる (録画・通知先と同じ。[arming.svelte.ts](../../lib/arming.svelte.ts)) */
  const deleting = arming('[data-testid^="rule-delete"]');
  /**
   * 行のスイッチを送るとき。**送っている間は押せなくする** (連打で何度も切り替わらない)。
   * 断られたら見た目を戻す
   */
  const switched: SubmitFunction = ({ formElement }) => {
    const box = formElement.querySelector<HTMLInputElement>(
      'input[role="switch"]',
    );
    if (box !== null) box.disabled = true;
    return async ({ result, update }) => {
      await update();
      if (box !== null) {
        if (result.type !== "success" && result.type !== "redirect")
          box.checked = !box.checked;
        box.disabled = false;
      }
    };
  };

  const notices = $derived.by<Notice[]>(() => {
    const list = errorNotice(form, "rule-error");
    if (form?.canceled !== undefined) {
      const text =
        form.canceled > 0
          ? `ルールを削除しました (予約 ${form.canceled} 件を取り消し)`
          : "ルールを削除しました";
      list.push({ key: "rule-deleted", kind: "success", text });
    }
    return list;
  });
</script>

<svelte:window onclick={deleting.stand} />

<Toasts {notices} source={form} />

<!--
    **ホームと同じ作り。** 左に1本の一覧 (2段の淡い塊を 6px 空けて並べる)、1000px からは右にサイドバー
    (絞り込み・並び・集計。ドキュメントの目次と同じ行)。それより狭いと、絞り込みと並びは細い1行にまとめ、
    スマホ (下のタブがある幅) では画面の下、タブのすぐ上に置く (押すものは指の届く下に)
-->
<div class="rules-board">
  <div class="rules-list" data-testid="rule-list">
    <!-- 狭い画面の集計。広い画面ではサイドバーの「集計」 -->
    <p class="narrow-summary small muted" data-testid="rule-summary-narrow">
      これから7日の予約 <span class="num">{data.summary.weekReservations}</span>
      件 ・ この7日で録れた
      <span class="num">{data.summary.lastWeekRecordings}</span> 本
    </p>

    {#if data.rules.length === 0}
      <div class="empty" data-testid="rule-empty">
        <p class="bold">ルールはまだありません</p>
        <p class="small muted">
          <a href={resolve("search")}>検索</a
          >で番組を探して「ルールとして保存」を押すと、合う番組を自動で予約するルールができます
        </p>
      </div>
    {:else}
      <ul class="rows" data-testid="rule-table">
        {#each paged.rows as rule (rule.id)}
          <!--
                        **2段の塊。** 1段目に名前、右にスイッチと削除。2段目に条件・次の放送・予約と録画の数・最後に録れた日。
                        塊を押すと検索の画面でそのルールを直す。スイッチと削除はリンクの外 (隣) なので、押してもルールは開かない
                    -->
          <li
            class="row item"
            class:off={!rule.enabled}
            data-testid="rule-row"
            data-rule-id={rule.id}
          >
            <a
              class="row-body"
              href={resolve(`search?rule=${rule.id}`)}
              data-testid="rule-open"
            >
              <span class="name">
                <span class="truncate">{rule.name}</span>
                {#if !rule.enabled}<span class="tag">無効</span>{/if}
                {#if rule.conflicts > 0}<span class="tag error"
                    >競合 {rule.conflicts}</span
                  >{/if}
              </span>
              <span class="meta small muted">
                <span class="wide-part"
                  ><span class="cond"
                    >{conditionSummary(rule, (id) =>
                      serviceNames.get(id),
                    )}</span
                  >
                  <span class="sep" aria-hidden="true">・</span></span
                >
                <span class="next" data-testid="rule-next">
                  {#if rule.next === null}
                    予定なし
                  {:else}
                    次 {upcomingLabel(rule.next.start_at, clock)}
                    <span class="broadcast">{rule.next.service_name}</span>
                  {/if}
                </span>
                <span class="sep" aria-hidden="true">・</span>
                <span class="num"
                  >予約 <span data-testid="rule-reservations"
                    >{rule.reservations}</span
                  ></span
                >
                <span class="sep" aria-hidden="true">・</span>
                <span class="num">録画 {rule.recordings}</span>
                {#if rule.last_recorded_at !== null}
                  <span class="wide-part"
                    ><span class="sep" aria-hidden="true">・</span>
                    <span>最後に録れた {date(rule.last_recorded_at)}</span
                    ></span
                  >
                {/if}
              </span>
            </a>
            <form
              method="POST"
              action="?/toggle"
              class="switch"
              use:submitting={switched}
            >
              <input type="hidden" name="id" value={rule.id} />
              <input
                type="checkbox"
                role="switch"
                aria-checked={rule.enabled}
                checked={rule.enabled}
                aria-label="「{rule.name}」を有効にする"
                onchange={(event) => event.currentTarget.form?.requestSubmit()}
                data-testid="rule-switch"
              />
            </form>
            <ArmedDelete
              {deleting}
              armKey={rule.id}
              fields={{ id: rule.id }}
              class="xs"
              testid="rule-delete"
            />
          </li>
        {:else}
          <li class="none small muted" data-testid="rule-none">
            この絞り込みに当たるルールはありません
          </li>
        {/each}
        {#if paged.more}
          <li class="none small muted" use:sentinel={() => paged.reveal()}>
            残り {paged.rest} 件
          </li>
        {/if}
      </ul>
    {/if}
  </div>

  <!-- 1000px から。絞り込み・並び・集計 (ホームのサイドバーと同じ行) -->
  <aside
    class="rules-side side-panel"
    aria-label="絞り込みと並び"
    data-testid="rule-sidebar"
  >
    <h2 class="side-label">絞り込み</h2>
    <div
      class="side-list"
      role="group"
      aria-label="絞り込み"
      data-testid="rule-filters"
    >
      {#each FILTERS as f (f.key)}
        <button
          type="button"
          class="side-item"
          aria-pressed={filter === f.key}
          onclick={() => (filter = f.key)}
          data-testid="rule-filter-{f.key}"
        >
          <span>{f.label}</span>
          <span class="side-sub num">{counts[f.key]}</span>
        </button>
      {/each}
    </div>
    <h2 class="side-label">並び</h2>
    <div class="side-list" role="group" aria-label="並び">
      {#each SORTS as s (s.key)}
        <button
          type="button"
          class="side-item"
          aria-pressed={sort === s.key}
          onclick={() => (sort = s.key)}
          data-testid="rule-sort-{s.key}"
        >
          {s.label}
        </button>
      {/each}
    </div>
    <h2 class="side-label">集計</h2>
    <dl class="side-list stats" data-testid="rule-summary">
      <div class="side-item static">
        <dt>これから7日の予約</dt>
        <dd class="num">{data.summary.weekReservations} 件</dd>
      </div>
      <div class="side-item static">
        <dt>この7日で録れた</dt>
        <dd class="num">{data.summary.lastWeekRecordings} 本</dd>
      </div>
    </dl>
    <div class="side-foot">
      <!-- 作るのは検索の画面。言葉を打つ欄に入った状態で開く -->
      <a class="button small" href={resolve("search")} data-testid="rule-new"
        >ルールを作る</a
      >
    </div>
  </aside>

  <!--
        1000px より狭いときの細い1行。絞り込みは横に送れる1列のチップ、並びは選ぶ欄、右に「作る」。
        スマホでは画面の下 (タブの上) に貼り付ける
    -->
  <div class="rules-bar" data-testid="rule-bar">
    <div class="bar-chips" role="group" aria-label="絞り込み">
      {#each FILTERS as f (f.key)}
        <button
          type="button"
          class="chip-button"
          aria-pressed={filter === f.key}
          onclick={() => (filter = f.key)}
          data-testid="rule-bar-filter-{f.key}"
        >
          {f.label} <span class="num">{counts[f.key]}</span>
        </button>
      {/each}
    </div>
    <select bind:value={sort} aria-label="並び" data-testid="rule-sort">
      {#each SORTS as s (s.key)}
        <option value={s.key}>{s.label}</option>
      {/each}
    </select>
    <a
      class="button small"
      href={resolve("search")}
      data-testid="rule-new-narrow">作る</a
    >
  </div>
</div>

<style>
  /*
     * **どの幅でもページごとスクロールする** (ホームと同じ。`+layout.svelte` の `FILLED` に入れない)。広い画面では行が
     * 浮いたヘッダーの裏を流れる。768px からは左右と下を main の余白の外まで広げ、1000px からは右にサイドバーを置いて
     * 窓の右端に付け、ヘッダーの下に貼り付ける (中身があふれたときだけサイドバーの中で巻き取る。`app.css` の `.side-panel`)
     */
  .rules-board {
    display: flex;
    flex-direction: column;
    gap: var(--dp-space-3);
  }
  .rules-list {
    min-width: 0;
  }
  .rules-side {
    display: none;
  }
  @media (min-width: 768px) {
    .rules-board {
      margin: 0 calc(-1 * var(--dp-gutter)) calc(-1 * var(--dp-gutter));
      gap: 0;
    }
    .rules-list {
      padding: 0 var(--dp-gutter) var(--dp-gutter);
    }
  }
  /*
     * 768〜999px は細い1行が一覧の上。**ヘッダーと同じ角丸の面に乗せ、その下に貼り付ける** (ホームの頭の1行・番組表の操作の1行と同じ。
     * docs/design.md の「浮かせ方」。`app.css` の `--dp-bar-*`)。置かれた位置から隙間 (`--dp-bar-gap`) のぶん上へ出し、巻き始めても動かない。
     * 上端では平らで、巻いて行が裏に入ると面と近い影が出る (窓の巻いた量で。`dp-bar-float`)。
     * 浮いた面なので、中の「作る」は浮かせず太字だけ (`app.css` の「浮いたものの中」。スマホも同じ)
     */
  @media (min-width: 768px) and (max-width: 999.98px) {
    .rules-bar {
      --dp-btn-solid: transparent;
      --dp-btn-solid-hover: var(--dp-btn-tonal-hover);
      --dp-btn-lift: none;
      position: sticky;
      top: calc(var(--dp-header-bottom) + var(--dp-bar-gap));
      z-index: 5;
      margin: calc(
          var(--dp-header-bottom) + var(--dp-bar-gap) - var(--dp-header-space)
        )
        var(--dp-bar-inset) 0;
      padding: var(--dp-bar-pad);
      border-radius: var(--dp-bar-radius);
      background: var(--dp-float);
      box-shadow: var(--dp-shadow-tight);
    }
    @supports (animation-timeline: scroll()) {
      .rules-bar {
        background: transparent;
        box-shadow: none;
        animation: dp-bar-float linear both;
        animation-timeline: scroll(root block);
        animation-range: 0 1.5rem;
      }
    }
    .rules-list {
      padding-top: var(--dp-space-2);
    }
    /* この1行がある間はヘッダーも近い影にそろえる (番組表と同じ。遠い影が下の1行に掛かって段々に見えないように) */
    :global(html:has(.rules-bar)) {
      --navbar-shadow: var(--dp-shadow-tight);
    }
  }
  @media (min-width: 1000px) {
    .rules-board {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 20rem;
    }
    .rules-side {
      display: flex;
    }
    .rules-bar,
    .narrow-summary {
      display: none;
    }
  }
  @media (min-width: 1600px) {
    .rules-board {
      grid-template-columns: minmax(0, 1fr) 22rem;
    }
  }
  .stats {
    margin: 0;
  }
  .stats dt,
  .stats dd {
    margin: 0;
    font-weight: var(--dp-weight);
  }
  .stats dd {
    color: var(--dp-muted);
  }
  /*
     * 「ルールを作る」はサイドバーの下端。低い画面でサイドバーの中身があふれても、下に貼り付けて見えたままにする
     * (下の余白はサイドバーの余白 (1.5rem) を打ち消して自分で持つ。貼り付く位置もその余白の内側から測られるので同じだけ下げる)
     */
  .side-foot {
    position: sticky;
    bottom: -1.5rem;
    margin-bottom: -1.5rem;
    padding: 1rem 0.75rem 1.5rem;
    background: var(--dp-bg);
  }
  .side-foot .button {
    width: 100%;
    margin: 0;
  }

  /*
     * **行は2段の件** (ホームの行と同じく件の面 (`app.css` の `.item`) に乗せ、件の間は余白)
     */
  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--dp-list-gap);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.25rem 0.75rem;
    min-height: 4rem;
    margin: 0;
    padding: 0.5rem 0.75rem;
    list-style: none;
  }
  /* 指で押す端末では 72px (docs/design.md の「何行かある一覧」。ホームの行と同じ) */
  @media (pointer: coarse) {
    .row {
      min-height: 4.5rem;
    }
  }
  .row-body {
    display: flex;
    flex: 1 1 0%;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sep {
    margin-inline: 0.25rem;
  }
  /* 無効のルールは中身を沈める (印の「無効」と合わせて、色だけに頼らない) */
  .row.off .row-body {
    opacity: 0.55;
  }
  .switch {
    display: flex;
    margin: 0;
  }
  .switch input {
    margin: 0;
  }
  .none {
    margin: 0;
    padding: var(--dp-space-3);
    text-align: center;
    list-style: none;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--dp-space-2);
    padding: 3rem 1rem;
    text-align: center;
  }
  .empty p,
  .narrow-summary {
    margin: 0;
  }
  .narrow-summary {
    margin-bottom: var(--dp-space-2);
  }

  /* ---- 1000px より狭いときの細い1行 ---- */
  @media (max-width: 999.98px) {
    .rules-bar {
      display: flex;
      align-items: center;
      gap: var(--dp-space-2);
      order: -1;
    }
  }
  .bar-chips {
    display: flex;
    flex: 1 1 0%;
    gap: var(--dp-space-1);
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .chip-button {
    flex: none;
    width: auto;
    margin: 0;
    padding: 0.3rem 0.75rem;
    border: 0;
    border-radius: var(--dp-radius-full);
    background: transparent;
    /* 選んでいないものも本文並みの字 (押せると分かるように。ホームのチップと同じ) */
    color: var(--dp-btn-text);
    font-size: var(--dp-text-sm);
  }
  .chip-button:hover {
    background: var(--dp-hover-soft);
  }
  /* 選んでいるものはホームのチップ・`app.css` の `.chip` と同じ (囲まず、主の色の太字と字の幅いっぱいの下線) */
  .chip-button[aria-pressed="true"] {
    text-decoration: underline 2px var(--pico-primary);
    text-underline-offset: 0.3em;
    color: var(--dp-primary-text);
    font-weight: var(--dp-weight-bold);
  }
  .rules-bar select {
    flex: none;
    width: auto;
    margin: 0;
    padding-block: 0.25rem;
    border: 0;
    background-color: transparent;
    color: var(--dp-muted);
    font-size: var(--dp-text-sm);
  }
  .rules-bar .button {
    flex: none;
    margin: 0;
  }
  /*
     * **スマホではこの1行を画面の下、タブのすぐ上に浮かせる** (押すものは指の届く下に)。下のタブと同じ操作の層なので、
     * 同じ半透明のカプセル (`--dp-float`) にして、読んでいる間はタブと一緒に引っ込む (`+layout.svelte` の `data-retract`)。
     * 一覧の最後の行が隠れないよう、この1行の高さぶん下を空ける
     */
  @media (max-width: 639.98px) {
    .rules-bar {
      position: fixed;
      --dp-btn-solid: transparent;
      --dp-btn-solid-hover: var(--dp-btn-tonal-hover);
      --dp-btn-lift: none;
      inset-inline: 0.75rem;
      bottom: calc(var(--dp-tabbar, 0px) + 0.375rem);
      z-index: 30;
      padding: var(--dp-space-1) var(--dp-space-1) var(--dp-space-1)
        var(--dp-space-3);
      border-radius: 1.375rem;
      background: var(--dp-float);
      box-shadow: var(--dp-shadow-pop);
      transition: transform var(--dp-duration-move) var(--dp-ease-spring);
    }
    :global([data-retract]) .rules-bar:not(:has(:focus-visible)) {
      transform: translateY(calc(var(--dp-tabbar, 0px) + 0.375rem + 100%));
    }
    .rules-list {
      padding-bottom: 4rem;
    }
    /* 狭い幅の2段目は次の放送と予約・録画の数だけ (条件と最後に録れた日は押した先で見る) */
    .wide-part {
      display: none;
    }
  }
</style>
