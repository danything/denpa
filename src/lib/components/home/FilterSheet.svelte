<script lang="ts">
    /**
     * 狭い画面 (1000px 未満) の絞り込みと表示の切り替え。下から出る一枚。`<dialog>` なので焦点は中に
     * 閉じ込められ、Esc で閉じる。中身は開いている間だけ描く (サイドバーと同じ項目が二重に並ばないように)
     */
    import { tick } from 'svelte';
    import type { Filter } from '#lib/timeline.js';
    import FilterList from './FilterList.svelte';
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
    }: {
        filter: Filter;
        counts: Record<Filter, number>;
        grouped: boolean;
        setGrouped: (on: boolean) => void;
        finishedHref: string;
        deletedHref: string;
        showFinished: boolean;
        showDeleted: boolean;
        capacity: { free: string; hours: string | null } | null;
    } = $props();

    let sheet: HTMLDialogElement | undefined = $state();
    let sheetOpen = $state(false);

    /** 開く (頭のボタンから) */
    export async function show(): Promise<void> {
        sheetOpen = true;
        await tick();
        sheet?.showModal();
    }
</script>

<!-- 狭い画面の絞り込み。下から出る一枚 -->
<dialog
    class="t-sheet"
    bind:this={sheet}
    aria-label="絞り込みと表示"
    data-testid="filter-sheet"
    onclose={() => (sheetOpen = false)}
>
    <!-- 一枚の外 (背景) を押したら閉じる (番組の詳細と同じ作り) -->
    <button type="button" class="t-sheet-backdrop" tabindex="-1" aria-label="閉じる" onclick={() => sheet?.close()}></button>
    {#if sheetOpen}
        <div class="t-sheet-body">
            <div class="t-sheet-grip" aria-hidden="true"></div>
            <h2 class="s-group">絞り込み</h2>
            <FilterList bind:filter {counts} onpick={() => sheet?.close()} />
            <h2 class="s-group">表示の切り替え</h2>
            <ViewList
                {grouped}
                {setGrouped}
                {finishedHref}
                {deletedHref}
                {showFinished}
                {showDeleted}
                done={() => sheet?.close()}
            />
            {#if capacity !== null}
                <p class="s-note muted small num" data-testid="recordings-capacity-menu">
                    {capacity.free}{capacity.hours === null ? '' : `・${capacity.hours}`}
                </p>
            {/if}
            <button type="button" class="secondary t-sheet-close" onclick={() => sheet?.close()}>閉じる</button>
        </div>
    {/if}
</dialog>
