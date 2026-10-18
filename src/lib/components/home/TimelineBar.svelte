<script lang="ts">
    /**
     * **一覧の頭の細い1行** (どの幅でも同じ)。左に絞り込みのチップ (件数付き。1回押せば絞れる。狭い画面では横に流せる)、
     * 右に今日のまとめ (次の録画・空き) と、表示の切り替えをまとめた「⋯」。
     *
     * 右のサイドバーをやめて、一覧に幅を全部回した。絞り込みはたまにしか使わず、指を乗せた行の中身を右に出す
     * 欄も要らなかった (中身は行と詳細で読める)
     */
    import Menu from '#lib/components/Menu.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import { time } from '#lib/format.js';
    import { FILTERS, type Filter } from '#lib/timeline.js';
    import Ellipsis from '~icons/lucide/ellipsis';
    import { home, type Res } from './context';
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
        capacity,
        nextRes,
    }: {
        filter: Filter;
        /** 絞り込みを替える (見ていた行をその場に残す。`routes/+page.svelte`) */
        setFilter: (next: Filter) => void;
        counts: Record<Filter, number>;
        grouped: boolean;
        setGrouped: (on: boolean) => void;
        finishedHref: string;
        deletedHref: string;
        showFinished: boolean;
        showDeleted: boolean;
        /** 空きと、あと何時間録れるか (`disk.capacity`)。読めなければ null */
        capacity: { free: string; hours: string | null } | null;
        /** 次の録画。絞り込みに関係なく、これからの予約のうちいちばん早いもの */
        nextRes: Res | null;
    } = $props();
    const ctx = home();

    let viewOpen = $state(false);
    const free = $derived(capacity === null ? null : capacity.free.replace(/^空き\s*/, ''));
</script>

<div class="t-toolbar" data-testid="timeline-toolbar">
    <div class="t-chips" role="group" aria-label="絞り込み">
        {#each FILTERS as f (f.id)}
            <button
                type="button"
                class="t-chip"
                aria-pressed={filter === f.id}
                onclick={() => setFilter(f.id)}
                data-testid="filter-chip"
                data-filter={f.id}
            >
                {f.label}<span class="num" class:alert={f.id === 'failed' && counts.failed > 0} data-testid="filter-count"
                    >{counts[f.id]}</span
                >
            </button>
        {/each}
    </div>

    <!-- 今日のまとめ。狭い画面では外す (空きは「⋯」の中に出す) -->
    <p class="t-summary small muted num" data-testid="summary">
        <span>次の録画 {nextRes === null ? 'なし' : `${time(nextRes.start_at)}・${ctx.untilLabel(nextRes.start_at)}`}</span>
        {#if free !== null}
            <span aria-hidden="true">·</span>
            <span data-testid="recordings-capacity" title={capacity?.hours ?? undefined}>空き {free}</span>
        {/if}
    </p>

    <Menu bind:open={viewOpen} side="bottom" align="end" class="view-menu" testid="view-menu">
        {#snippet trigger(props)}
            <button {...props} type="button" class="ghost icon t-more" title="表示の切り替え" data-testid="view-toggle">
                <Icon icon={Ellipsis} size="size-5" /><span class="visually-hidden">表示の切り替え</span>
                {#if grouped || showDeleted || showFinished}<span class="view-dot" aria-hidden="true"></span>{/if}
            </button>
        {/snippet}
        <ViewList
            {grouped}
            {setGrouped}
            {finishedHref}
            {deletedHref}
            {showFinished}
            {showDeleted}
            done={() => (viewOpen = false)}
        />
        {#if capacity !== null}
            <!-- 空きは押せない1行 (頭の1行のまとめと同じもの。狭い画面ではここにだけ出る) -->
            <div class="menu-note small muted num" data-testid="recordings-capacity-menu">
                空き {free}{capacity.hours === null ? '' : `・${capacity.hours}`}
            </div>
        {/if}
    </Menu>
</div>
