<script lang="ts">
    /**
     * **右のサイドバー** (1000px 以上)。ウィンドウの端まで寄せ、一覧とは別に巻き取る (線では分けない。地も一覧と同じ)。
     * 並びは `app.css` のサイドバーの部品 (太字の見出し・線の無い行・選んでいる行だけ内側の塗り)。
     * この幅では頭の1行 (`TimelineBar`) は出さず、一覧はいちばん上から始まる。上から
     *
     * 1. 絞り込み … すべて・予約・録画中・未視聴 (件数付き)
     * 2. 見てほしいこと … 競合・失敗・録り逃し・CM の判定。件数があるものだけ、注意の色とアイコンで。押すと絞り込みと同じく一覧を絞る
     * 3. 表示 … まとめて表示・完了した予約も表示・削除済みも表示 (スイッチ)、ファイルと照合 (→)
     * 4. 状態 … 次の録画・エンコード・空き (いちばん下)
     *
     * 中身はホームが読んだものから作る (問い合わせは足さない)。指を乗せたときだけ出るものは置かない
     */
    import Icon from '#lib/components/player/Icon.svelte';
    import { ATTENTION_FILTERS, FILTERS, type Filter } from '#lib/timeline.js';
    import TriangleAlert from '~icons/lucide/triangle-alert';
    import type { Rec, Res } from './context';
    import HomeState from './HomeState.svelte';
    import ViewList from './ViewList.svelte';

    let {
        filter,
        setFilter,
        counts,
        grouped,
        setGrouped,
        finishedHref,
        deletedHref,
        showFinished,
        showDeleted,
        encoding,
        nextRes,
        capacity,
    }: {
        filter: Filter;
        setFilter: (next: Filter) => void;
        counts: Record<Filter, number>;
        grouped: boolean;
        setGrouped: (on: boolean) => void;
        finishedHref: string;
        deletedHref: string;
        showFinished: boolean;
        showDeleted: boolean;
        encoding: Rec[];
        nextRes: Res | null;
        capacity: { free: string; hours: string | null } | null;
    } = $props();

    const attention = $derived(ATTENTION_FILTERS.filter((f) => counts[f.id] > 0 || filter === f.id));
</script>

<aside class="t-side side-panel" aria-label="絞り込みと表示" data-testid="sidebar">
    <h2 class="side-label">絞り込み</h2>
    <div class="side-list" role="group" aria-label="絞り込み">
        {#each FILTERS as f (f.id)}
            <button
                type="button"
                class="side-item"
                aria-pressed={filter === f.id}
                onclick={() => setFilter(f.id)}
                data-testid="filter"
                data-filter={f.id}
            >
                <span>{f.label}</span>
                <span class="side-sub num" data-testid="filter-count">{counts[f.id]}</span>
            </button>
        {/each}
    </div>

    {#if attention.length > 0}
        <h2 class="side-label">見てほしいこと</h2>
        <div class="side-list" role="group" aria-label="見てほしいこと">
            {#each attention as f (f.id)}
                <button
                    type="button"
                    class="side-item a-warn"
                    aria-pressed={filter === f.id}
                    onclick={() => setFilter(filter === f.id ? 'all' : f.id)}
                    data-testid="attention-item"
                    data-filter={f.id}
                >
                    <span class="a-warn-label"><Icon icon={TriangleAlert} size="size-4" />{f.label}</span>
                    <span class="side-sub num" data-testid="filter-count">{counts[f.id]}</span>
                </button>
            {/each}
        </div>
    {/if}

    <h2 class="side-label">表示</h2>
    <div class="side-list" role="group" aria-label="表示の切り替え">
        <ViewList {grouped} {setGrouped} {finishedHref} {deletedHref} {showFinished} {showDeleted} variant="list" />
    </div>

    <div class="side-foot">
        <h2 class="side-label">状態</h2>
        <HomeState {encoding} {nextRes} {capacity} where="side" />
    </div>
</aside>
