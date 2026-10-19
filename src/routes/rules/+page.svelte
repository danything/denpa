<script lang="ts">
    import { submitting } from '#lib/actions.js';
    import { arming } from '#lib/arming.svelte.js';
    import ArmedDelete from '#lib/components/ArmedDelete.svelte';
    import Toasts, { errorNotice, type Notice } from '#lib/components/Toasts.svelte';
    import { date } from '#lib/format.js';
    import { Paged, sentinel } from '#lib/paging.svelte.js';
    import { conditionSummary, upcomingLabel } from '#lib/rule-summary.js';
    import type { SubmitFunction } from '$app/forms';
    import { resolve } from '$app/paths';

    let { data, form } = $props();

    /**
     * **ルールの一覧と管理。** 並べて見比べ、スイッチで止める・戻す、2回押しで消す。
     * 作る・直すのは検索の画面の「ルールとして保存」(行を押すと `/search?rule=<ID>`)
     */

    type Filter = 'all' | 'on' | 'off' | 'idle' | 'conflict';
    const FILTERS: { key: Filter; label: string; test: (rule: (typeof data.rules)[number]) => boolean }[] = [
        { key: 'all', label: 'すべて', test: () => true },
        { key: 'on', label: '有効', test: (rule) => rule.enabled },
        { key: 'off', label: '無効', test: (rule) => !rule.enabled },
        { key: 'idle', label: '次の放送なし', test: (rule) => rule.next === null },
        { key: 'conflict', label: '競合あり', test: (rule) => rule.conflicts > 0 },
    ];
    let filter = $state<Filter>('all');

    type Sort = 'next' | 'new' | 'name' | 'reservations' | 'recorded';
    const SORTS: { key: Sort; label: string }[] = [
        { key: 'next', label: '次の放送が近い順' },
        { key: 'new', label: '新しい順' },
        { key: 'name', label: '名前順' },
        { key: 'reservations', label: '予約が多い順' },
        { key: 'recorded', label: '最近録れた順' },
    ];
    let sort = $state<Sort>('next');

    /** 並べ替え。決まらないものは新しいルールを上に (読み込んだ順) */
    function compare(a: (typeof data.rules)[number], b: (typeof data.rules)[number]): number {
        switch (sort) {
            case 'next':
                return (a.next?.start_at ?? Infinity) - (b.next?.start_at ?? Infinity);
            case 'name':
                return a.name.localeCompare(b.name, 'ja');
            case 'reservations':
                return b.reservations - a.reservations;
            case 'recorded':
                return (b.last_recorded_at ?? -Infinity) - (a.last_recorded_at ?? -Infinity);
            default:
                return 0;
        }
    }
    const shownRules = $derived(
        data.rules.filter(FILTERS.find((f) => f.key === filter)!.test).sort((a, b) => compare(a, b) || b.id - a.id),
    );
    /** 少しずつ出す (`paging.svelte.ts`)。ルールが数百あっても開いた直後に止まらない */
    const paged = new Paged(() => shownRules, 60);
    $effect(() => {
        void filter;
        void sort;
        paged.reset();
    });

    const serviceNames = $derived(new Map(data.services.map((s) => [s.id, s.name])));
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
        const box = formElement.querySelector<HTMLInputElement>('input[role="switch"]');
        if (box !== null) box.disabled = true;
        return async ({ result, update }) => {
            await update();
            if (box !== null) {
                if (result.type !== 'success' && result.type !== 'redirect') box.checked = !box.checked;
                box.disabled = false;
            }
        };
    };

    const notices = $derived.by<Notice[]>(() => {
        const list = errorNotice(form, 'rule-error');
        if (form?.canceled !== undefined) {
            const text = form.canceled > 0 ? `ルールを削除しました (予約 ${form.canceled} 件を取り消し)` : 'ルールを削除しました';
            list.push({ key: 'rule-deleted', kind: 'success', text });
        }
        return list;
    });
</script>

<svelte:window onclick={deleting.stand} />

<Toasts {notices} source={form} />

<div class="rules-page">
    <!--
        **上の操作と表の見出しは、巻いても上に残す** (`position: sticky`)。ルールが増えると、
        下のほうで絞り込みや並びを変えるのに上まで戻ることになる。地はページと同じで枠は付けない。
        下の線も引かない (ヘッダーと同じ。下を流れる行とは地で分かれる)
    -->
    <div class="top" data-testid="rule-top">
        <div class="toolbar">
            <div class="chips filters" role="group" aria-label="絞り込み" data-testid="rule-filters">
                {#each FILTERS as f (f.key)}
                    <button
                        type="button"
                        class="filter"
                        class:active={filter === f.key}
                        aria-pressed={filter === f.key}
                        onclick={() => (filter = f.key)}
                        data-testid="rule-filter-{f.key}"
                    >
                        {f.label} <span class="num">{data.rules.filter(f.test).length}</span>
                    </button>
                {/each}
            </div>
            <label class="sort small muted">
                <span class="visually-hidden">並び</span>
                <select bind:value={sort} data-testid="rule-sort">
                    {#each SORTS as s (s.key)}
                        <option value={s.key}>{s.label}</option>
                    {/each}
                </select>
            </label>
            <p class="summary small muted" data-testid="rule-summary">
                これから7日の予約 <span class="num">{data.summary.weekReservations}</span> 件 ・ この7日で録れた <span class="num">{data.summary.lastWeekRecordings}</span> 本
            </p>
            <!-- 作るのは検索の画面。言葉を打つ欄に入った状態で開く -->
            <a class="button small" href={resolve('search')} data-testid="rule-new">ルールを作る</a>
        </div>
        {#if data.rules.length > 0}
            <div class="head row" aria-hidden="true">
                <div class="cells">
                    <span>ルール</span>
                    <span class="wide">条件</span>
                    <span class="wide">次の放送</span>
                    <span class="wide end">予約</span>
                    <span class="wide end">録画</span>
                    <span class="wide">最後に録れた</span>
                </div>
                <span></span>
                <span></span>
            </div>
        {/if}
    </div>

    {#if data.rules.length === 0}
        <div class="empty" data-testid="rule-empty">
            <p class="bold">ルールはまだありません</p>
            <p class="small muted">
                <a href={resolve('search')}>検索</a>で番組を探して「ルールとして保存」を押すと、合う番組を自動で予約するルールができます
            </p>
        </div>
    {:else}
        <div class="table" data-testid="rule-table">
            {#each paged.rows as rule (rule.id)}
                <!--
                    **行を押すと検索の画面でそのルールを直す。** スイッチと削除はリンクの外 (隣) に置くので、
                    押してもルールは開かない
                -->
                <div class="row" class:off={!rule.enabled} data-testid="rule-row" data-rule-id={rule.id}>
                    <a class="cells" href={resolve(`search?rule=${rule.id}`)} data-testid="rule-open">
                        <span class="name">
                            {rule.name}
                            {#if !rule.enabled}<span class="tag">無効</span>{/if}
                        </span>
                        <span class="cond wide muted">{conditionSummary(rule, (id) => serviceNames.get(id))}</span>
                        <span class="next" class:muted={rule.next === null} data-testid="rule-next">
                            {#if rule.next === null}
                                予定なし
                            {:else}
                                {upcomingLabel(rule.next.start_at, clock)} <span class="broadcast">{rule.next.service_name}</span>
                            {/if}
                            {#if rule.conflicts > 0}<span class="tag error outline">競合 {rule.conflicts}</span>{/if}
                        </span>
                        <span class="count wide end num" data-testid="rule-reservations">{rule.reservations}</span>
                        <span class="count wide end num muted">{rule.recordings}</span>
                        <span class="wide muted small">
                            {rule.last_recorded_at === null ? '—' : date(rule.last_recorded_at)}
                        </span>
                        <!-- 狭い画面の2段目。予約と録画の数 -->
                        <span class="narrow counts muted">予約 {rule.reservations} ・ 録画 {rule.recordings}</span>
                    </a>
                    <form method="POST" action="?/toggle" class="switch" use:submitting={switched}>
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
                    <div class="delete">
                        <ArmedDelete {deleting} armKey={rule.id} fields={{ id: rule.id }} class="xs" testid="rule-delete" />
                    </div>
                </div>
            {:else}
                <p class="none small muted" data-testid="rule-none">この絞り込みに当たるルールはありません</p>
            {/each}
            {#if paged.more}
                <p class="none small muted" use:sentinel={() => paged.reveal()}>残り {paged.rest} 件</p>
            {/if}
        </div>
    {/if}
</div>

<style>
    .rules-page {
        display: flex;
        flex-direction: column;
        width: 100%;
    }
    /*
     * 巻いても残る上の操作と見出し。ヘッダー (3.5rem) のすぐ下に止める。地はページと同じで、
     * 本文の余白 (`--dp-gutter`) まで広げて、下を流れる行が横から覗かないようにする。
     * 止まっても下に線は引かない (ヘッダーと同じ。下を流れる行とは地で分かれる)
     */
    .top {
        position: sticky;
        top: 3.5rem;
        z-index: 20;
        display: flex;
        flex-direction: column;
        gap: var(--dp-space-3);
        /* 止まったときにヘッダーと字がくっつかないよう上に余白。止まる前の位置は負のマージンで変えない */
        margin: calc(-1 * var(--dp-space-2)) calc(-1 * var(--dp-gutter)) 0;
        padding: var(--dp-space-2) var(--dp-gutter) var(--dp-space-1);
        background: var(--dp-bg);
    }
    /* ヘッダーを隠す幅 (下のタブ) では画面の上端に止める。ノッチのぶんは内側の余白で避ける */
    @media (max-width: 639.98px) {
        .top {
            top: 0;
            margin-top: calc(-1 * var(--dp-space-2) - env(safe-area-inset-top));
            padding-top: calc(var(--dp-space-2) + env(safe-area-inset-top));
        }
    }
    .table {
        padding-top: var(--dp-space-1);
    }
    .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--dp-space-2) var(--dp-space-4);
    }
    /* Pico は role="group" を横いっぱいの帯にするので、中身の幅に戻す */
    .filters {
        width: auto;
        margin: 0;
        gap: var(--dp-space-1);
    }
    /* 絞り込み。選んでいるものだけ淡い地 (枠は付けない) */
    .filter {
        width: auto;
        margin: 0;
        padding: 0.3rem 0.75rem;
        border: 0;
        border-radius: var(--dp-radius-full);
        background: transparent;
        color: var(--dp-muted);
        font-size: var(--dp-text-sm);
    }
    .filter:hover {
        background: var(--dp-hover-soft);
    }
    .filter.active {
        background: var(--dp-subtle);
        color: inherit;
    }
    .sort {
        width: auto;
        margin: 0 0 0 auto;
    }
    .sort select {
        width: auto;
        margin: 0;
        padding-block: 0.25rem;
        border: 0;
        background-color: transparent;
        color: var(--dp-muted);
        font-size: var(--dp-text-sm);
    }
    .summary {
        margin: 0;
    }
    .toolbar .button {
        margin: 0;
    }
    .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--dp-space-2);
        padding: 3rem 1rem;
        text-align: center;
    }
    .empty p {
        margin: 0;
    }

    /*
     * **詰めた表。** 行は線で区切らず、触れると淡い地。列は 名前・条件・次の放送・予約・録画・最後に録れた
     * と、リンクの外にスイッチと削除。行の中身 (リンク) とヘッダーは同じ列の割り振り
     */
    .table {
        display: flex;
        flex-direction: column;
    }
    .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 3rem 6.5rem;
        align-items: center;
        gap: var(--dp-space-2);
        min-height: 2.875rem;
        padding-inline-end: var(--dp-space-2);
        border-radius: var(--dp-radius);
        transition: background-color var(--dp-duration);
    }
    .row:not(.head):hover {
        background: var(--dp-hover-soft);
    }
    .cells {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.4fr) 11rem 4rem 4rem 7rem;
        align-items: center;
        gap: var(--dp-space-3);
        min-width: 0;
        padding: 0.5rem var(--dp-space-3);
        color: inherit;
        text-decoration: none;
    }
    .head {
        min-height: 2rem;
        font-size: var(--dp-text-xs);
        color: var(--dp-muted);
    }
    .head .cells {
        padding-block: 0.25rem;
    }
    .name,
    .cond,
    .next {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .name {
        font-size: var(--dp-text-sm);
    }
    .cond {
        font-size: var(--dp-text-xs);
    }
    .next {
        font-size: var(--dp-text-sm);
    }
    .end {
        text-align: end;
    }
    .num {
        font-variant-numeric: tabular-nums;
    }
    /* 無効のルールは行ごと沈める (印の「無効」と合わせて、色だけに頼らない) */
    .row.off .cells {
        opacity: 0.55;
    }
    .switch {
        display: flex;
        justify-content: flex-end;
        margin: 0;
    }
    .switch input {
        margin: 0;
    }
    /* 削除は幅を決めておく (「削除を確定」になっても列がずれない)。スイッチのすぐ右に寄せる */
    .delete {
        display: flex;
        justify-content: flex-start;
    }
    .narrow {
        display: none;
    }
    .none {
        margin: 0;
        padding: var(--dp-space-3);
        text-align: center;
    }
    /*
     * **狭い画面では2段の行。** 1段目に名前 (とスイッチ・削除)、2段目に次の放送と予約・録画の数。
     * 条件と最後に録れた日は押した先 (検索の画面の書く欄) で見る
     */
    @media (max-width: 767.98px) {
        .top {
            gap: var(--dp-space-2);
            padding-bottom: var(--dp-space-2);
        }
        /* 絞り込みは1行に並べ、はみ出したぶんは横に送る */
        .filters {
            flex-wrap: nowrap;
            max-width: 100%;
            overflow-x: auto;
            scrollbar-width: none;
        }
        .filter {
            flex: none;
        }
        .summary {
            order: 3;
            flex-basis: 100%;
        }
        .sort {
            margin-inline-start: 0;
        }
        .head {
            display: none;
        }
        .row {
            grid-template-columns: minmax(0, 1fr) auto auto;
            padding-inline-end: 0;
        }
        .cells {
            grid-template-columns: minmax(0, 1fr) auto;
            gap: 0.125rem var(--dp-space-2);
            padding: 0.5rem 0;
        }
        .wide {
            display: none;
        }
        .name {
            grid-column: 1 / -1;
            font-size: var(--dp-text-base);
        }
        .next,
        .narrow {
            font-size: var(--dp-text-xs);
        }
        .narrow {
            display: inline;
            text-align: end;
        }
    }
</style>
