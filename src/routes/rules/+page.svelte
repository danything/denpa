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
  import { minuteClock } from "#lib/minute-clock.svelte.js";
  import { Paged, sentinel } from "#lib/paging.svelte.js";
  import { conditionSummary, upcomingLabel } from "#lib/rule-summary.js";

  let { data, form } = $props();

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
  const minute = minuteClock();
  const clock = $derived(minute.now);

  /** ルールの削除は 2 回押させる (録画・通知先と同じ。[arming.svelte.ts](../../lib/arming.svelte.ts)) */
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
    if (form?.remapped === true)
      list.push({
        key: "rule-remapped",
        kind: "success",
        text: "ルールの局を付け替えました",
      });
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
    **ホームと同じ作り。** 左に 1 本の一覧 (2 段の件を件の面に乗せて並べる)、広い形では右にサイドバー
    (絞り込み・並び・集計。ドキュメントの目次と同じ行)。スマホの形 (下のタブがある形。`#lib/phone-form.ts`) では、
    絞り込みと並びを細い 1 行にまとめ、画面の下、タブのすぐ上に置く (押すものは指の届く下に)
-->
<div class="rules-board with-side">
  <div class="rules-list" data-testid="rule-list">
    <!-- スマホの形の集計。広い形ではサイドバーの「集計」 -->
    <p class="narrow-summary small muted" data-testid="rule-summary-narrow">
      これから 7 日の予約 <span class="num"
        >{data.summary.weekReservations}</span
      >
      件・この 7 日で録れた
      <span class="num">{data.summary.lastWeekRecordings}</span> 本
    </p>

    <!--
        **選局できなくなった局を指すルール** (局のサービス ID が変わった。`server/rule-remap.ts`)。そのままでは録画しないので、
        付け替える局を選ばせる。自動では付け替えない (間違えると別の局を録る)
    -->
    {#if data.orphans.length > 0}
      <div class="notice info" data-testid="rule-orphans">
        <p class="small">
          選局できなくなった局を指しているルールがあります。このままでは録画しません。付け替える局を選ぶと、その局の番組を録画します
        </p>
        <ul class="remap-list">
          {#each data.orphans as orphan (`${orphan.ruleId}:${orphan.serviceId}`)}
            <li>
              <form
                method="POST"
                action="?/remap"
                class="remap-row small"
                use:submitting
                data-testid="rule-orphan"
              >
                <input type="hidden" name="id" value={orphan.ruleId} />
                <input type="hidden" name="from" value={orphan.serviceId} />
                <span
                  >「{orphan.ruleName}」の
                  <span class="broadcast">{orphan.serviceName}</span></span
                >
                <select
                  name="to"
                  aria-label="「{orphan.ruleName}」で {orphan.serviceName} の代わりに録る局"
                >
                  {#each orphan.candidates as candidate (candidate.id)}
                    <option value={candidate.id}>{candidate.name}</option>
                  {/each}
                </select>
                <button type="submit" class="small" data-testid="rule-remap"
                  >付け替え</button
                >
              </form>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if data.rules.length === 0}
      <div class="empty-state glow" data-testid="rule-empty">
        <p class="bold">ルールはまだありません</p>
        <p class="small muted">
          <a href={resolve("search")}>検索</a
          >で番組を探して「ルールとして保存」を押すと、合う番組を自動で予約するルールができます
        </p>
      </div>
    {:else}
      <ul class="item-list" data-testid="rule-table">
        {#each paged.rows as rule (rule.id)}
          <!--
                        **2 段の件。** 1 段目に名前、右にスイッチと削除。2 段目に条件・次の放送・予約と録画の数・最後に録れた日。
                        件を押すと検索の画面でそのルールを直す。スイッチと削除はリンクの外 (隣) なので、押してもルールは開かない
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
            <!-- 削除は行の操作 (`app.css` の `.row-actions`。押せる範囲は 40px。docs/design.md) -->
            <div class="row-actions">
              <ArmedDelete
                {deleting}
                armKey={rule.id}
                fields={{ id: rule.id }}
                class="small"
                testid="rule-delete"
              />
            </div>
          </li>
        {:else}
          <li class="empty-state" data-testid="rule-none">
            <p class="bold">当てはまるものはありません</p>
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

  <!-- 広い形だけ。絞り込み・並び・集計 (ホームのサイドバーと同じ行) -->
  <aside
    class="rules-side side-panel side-column"
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
        <dt>これから 7 日の予約</dt>
        <dd class="side-sub num">{data.summary.weekReservations} 件</dd>
      </div>
      <div class="side-item static">
        <dt>この 7 日で録れた</dt>
        <dd class="side-sub num">{data.summary.lastWeekRecordings} 本</dd>
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
        スマホの形の細い 1 行。絞り込みは横に送れる 1 列のチップ、並びは選ぶ欄、右に「作る」。
        画面の下 (タブの上) に貼り付ける
    -->
  <div class="rules-bar dock" data-testid="rule-bar">
    <div class="chips scroll" role="group" aria-label="絞り込み">
      {#each FILTERS as f (f.key)}
        <button
          type="button"
          class="chip pick-line"
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
  /* 付け替えの欄。ページの中の通知 (`.notice.info`) の中に、1 件 1 行で並べる */
  .remap-list {
    margin: var(--dp-space-2) 0 0;
    padding: 0;
    list-style: none;
  }
  .remap-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--dp-space-2);
    margin: 0;
  }
  .remap-row select {
    width: auto;
    margin: 0;
  }
  .remap-row button {
    margin: 0;
  }
  /*
     * **どの幅でもページごとスクロールする** (ホームと同じ。`+layout.svelte` の `FILLED` に入れない)。広い画面では行が
     * 浮いたヘッダーの裏を流れる。768px からは左右と下を main の余白の外まで広げ、広い形では右にサイドバーを置いて
     * 窓の右端に付け、ヘッダーの下に貼り付ける (中身があふれたときだけサイドバーの中で巻き取る。`app.css` の `.side-panel`)
     */
  .rules-list {
    min-width: 0;
  }
  @media (min-width: 768px) {
    .rules-board {
      margin: 0 calc(-1 * var(--dp-gutter)) calc(-1 * var(--dp-gutter));
    }
    .rules-list {
      padding: 0 var(--dp-gutter) var(--dp-gutter);
    }
  }
  /* 一覧と右の列の組み方は録画・切り抜きと同じ (`app.css` の `.with-side`)。広い形 (`#lib/phone-form.ts`) ではスマホの形の 1 行と集計を隠す */
  :global(:where(html:not([data-phone]))) .rules-bar,
  :global(:where(html:not([data-phone]))) .narrow-summary {
    display: none;
  }
  .stats {
    margin: 0;
  }
  .stats dt,
  .stats dd {
    margin: 0;
    font-weight: var(--dp-weight);
  }
  /*
     * 「ルールを作る」はサイドバーの下端。低い画面でサイドバーの中身があふれても、下に貼り付けて見えたままにする
     * (下の余白はサイドバーの余白 (`--dp-side-pad-end`) を打ち消して自分で持つ。貼り付く位置もその余白の内側から測られるので同じだけ下げる)
     */
  .side-foot {
    position: sticky;
    bottom: calc(-1 * var(--dp-side-pad-end));
    margin-bottom: calc(-1 * var(--dp-side-pad-end));
    padding: var(--dp-space-4) var(--dp-space-3) var(--dp-side-pad-end);
    background: var(--dp-bg);
  }
  .side-foot .button {
    width: 100%;
    margin: 0;
  }

  /*
     * **行は 2 段の件** (ホームの行と同じく件の面 (`app.css` の `.item`) に乗せ、並べ方は `.item-list`)
     */
  .row {
    display: flex;
    align-items: center;
    gap: var(--dp-space-1) var(--dp-space-3);
    min-height: var(--dp-item-h);
    padding: var(--dp-space-2) var(--dp-space-3);
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
    gap: var(--dp-space-2);
    min-width: 0;
  }
  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sep {
    margin-inline: var(--dp-space-1);
  }
  /* 無効のルールは中身を控えた字にする (印の「無効」と合わせて、色だけに頼らない)。透かすと 4.5:1 を割る */
  .row.off .row-body {
    color: var(--dp-muted);
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
  }
  .narrow-summary {
    margin: 0 0 var(--dp-space-2);
  }

  /* ---- スマホの形の細い 1 行 (`#lib/phone-form.ts`。`<html data-phone>`) ---- */
  .rules-bar select {
    flex: none;
    width: auto;
    margin: 0;
    padding-block: var(--dp-space-1);
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
     * **スマホの形ではこの 1 行を画面の下、タブのすぐ上に浮かせる** (押すものは指の届く下に。形は `app.css` の `.dock`)。
     * 一覧の最後の行が隠れないよう、この 1 行の高さぶん下を空ける
     */
  :global(:where(html[data-phone])) .rules-bar {
    display: flex;
    align-items: center;
    gap: var(--dp-space-2);
    position: fixed;
    inset-inline: var(--dp-dock-inset);
    z-index: var(--dp-z-dock);
    padding: var(--dp-space-1) var(--dp-space-1) var(--dp-space-1)
      var(--dp-space-3);
  }
  :global(:where(html[data-phone])) .rules-list {
    padding-bottom: 4rem;
  }
  /* 狭い幅の 2 段目は次の放送と予約・録画の数だけ (条件と最後に録れた日は押した先で見る。幅で決める) */
  @media (max-width: 639.98px) {
    .wide-part {
      display: none;
    }
  }
</style>
