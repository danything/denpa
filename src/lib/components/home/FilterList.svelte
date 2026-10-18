<script lang="ts">
    /** 絞り込みの並び (すべて・予約・録画中・未視聴・失敗と件数)。サイドバーと、狭い画面の下からの一枚で同じもの */
    import { FILTERS, type Filter } from '#lib/timeline.js';

    let {
        filter = $bindable(),
        counts,
        onpick = () => {},
    }: {
        filter: Filter;
        counts: Record<Filter, number>;
        /** 選んだあとにすること (一枚を閉じる) */
        onpick?: () => void;
    } = $props();
</script>

<div class="s-list" role="group" aria-label="絞り込み">
    {#each FILTERS as f (f.id)}
        <button
            type="button"
            class="s-item"
            class:on={filter === f.id}
            aria-pressed={filter === f.id}
            onclick={() => {
                filter = f.id;
                onpick();
            }}
            data-testid="filter"
            data-filter={f.id}
        >
            <span>{f.label}</span>
            <span class="s-sub num" class:alert={f.id === 'failed' && counts.failed > 0} data-testid="filter-count">
                {counts[f.id]}
            </span>
        </button>
    {/each}
</div>
