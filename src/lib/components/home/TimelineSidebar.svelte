<script lang="ts">
    /**
     * **右のサイドバー** (1000px 以上)。ウィンドウの端まで寄せ、1px の線で分けて、一覧とは別にスクロールする。
     * 上から絞り込み・表示の切り替え、今日のまとめ、選んだ番組。並びはドキュメントの目次と同じ作り
     */
    import Icon from '#lib/components/player/Icon.svelte';
    import { time } from '#lib/format.js';
    import type { Filter } from '#lib/timeline.js';
    import ChevronRight from '~icons/lucide/chevron-right';
    import { home, type Item, type Res } from './context';
    import FilterList from './FilterList.svelte';
    import SelectedDetail from './SelectedDetail.svelte';
    import ViewList from './ViewList.svelte';

    let {
        filter = $bindable(),
        counts,
        grouped,
        setGrouped,
        finishedHref,
        deletedHref,
        showFinished,
        showDeleted,
        capacity,
        nextRes,
        selected,
    }: {
        filter: Filter;
        counts: Record<Filter, number>;
        grouped: boolean;
        setGrouped: (on: boolean) => void;
        finishedHref: string;
        deletedHref: string;
        showFinished: boolean;
        showDeleted: boolean;
        /** 空きと、あと何時間録れるか (`disk.capacity`)。読めなければ null */
        capacity: { free: string; hours: string | null } | null;
        /** 次の録画 (今日のまとめ) */
        nextRes: Res | null;
        /** サイドバーに出す1本 */
        selected: Item | null;
    } = $props();
    const ctx = home();

    /** 表示の切り替え。開け閉めはその場かぎり */
    let viewOpen = $state(false);
</script>

<aside class="t-side" aria-label="絞り込みと選んだ番組" data-testid="sidebar">
    <h2 class="s-group s-first">絞り込み</h2>
    <FilterList bind:filter {counts} />
    <h2 class="s-group">
        <button
            type="button"
            class="s-group-toggle"
            aria-expanded={viewOpen}
            onclick={() => (viewOpen = !viewOpen)}
            data-testid="view-toggle"
        >
            表示の切り替え
            {#if grouped || showDeleted || showFinished}<span class="view-dot" aria-hidden="true"></span>{/if}
            <span class="group-chevron" class:open={viewOpen} aria-hidden="true">
                <Icon icon={ChevronRight} size="size-4" />
            </span>
        </button>
    </h2>
    {#if viewOpen}
        <ViewList {grouped} {setGrouped} {finishedHref} {deletedHref} {showFinished} {showDeleted} />
    {/if}

    <h2 class="s-group">今日</h2>
    <dl class="s-list s-stats" data-testid="summary">
        <div class="s-item s-static">
            <dt>次の録画</dt>
            <dd class="s-sub num">{nextRes === null ? 'なし' : `${time(nextRes.start_at)}・${ctx.untilLabel(nextRes.start_at)}`}</dd>
        </div>
        <div class="s-item s-static">
            <dt>録画中</dt>
            <dd class="s-sub num">{counts.recording} 本</dd>
        </div>
        <div class="s-item s-static">
            <dt>未視聴</dt>
            <dd class="s-sub num">{counts.unfinished} 本</dd>
        </div>
        {#if capacity !== null}
            <!-- 空きと、あと何時間録れるか (issue #505。`disk.capacity`) -->
            <div class="s-item s-static">
                <dt>空き</dt>
                <dd class="s-sub num" data-testid="recordings-capacity">
                    {capacity.free.replace(/^空き\s*/, '')}{capacity.hours === null ? '' : `・${capacity.hours}`}
                </dd>
            </div>
        {/if}
    </dl>

    {#if selected !== null}
        <SelectedDetail item={selected} />
    {/if}
</aside>
