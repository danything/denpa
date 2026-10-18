<script lang="ts">
    import Lead from './Lead.svelte';

    /**
     * チェック + 見出し + 1行の要点 (設定の画面の決まりの形)。
     *
     * 要点と「詳しく」は label の外に置く — label の中に開け閉めを入れると、
     * 「詳しく」を押したつもりでチェックまで切り替わりかねない
     */
    let {
        name,
        checked,
        testid,
        title,
        hint,
        detail = '',
    }: {
        name: string;
        checked: boolean;
        testid: string;
        title: string;
        hint: string;
        /** 「詳しく」で開く続き。空なら「詳しく」は出さない */
        detail?: string;
    } = $props();
</script>

<div class="check-item">
    <label class="check-row">
        <input type="checkbox" {name} {checked} data-testid={testid} />
        <span>{title}</span>
    </label>
    {#if detail === ''}
        <Lead class="indent">{hint}</Lead>
    {:else}
        <Lead class="indent">
            {hint}
            {#snippet more()}
                <p>{detail}</p>
            {/snippet}
        </Lead>
    {/if}
</div>

<style>
    .check-item {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
    }
    /* チェックの下の要点と「詳しく」は、チェックの横の文に揃える (箱の幅 1.25rem + 間 0.5rem) */
    .check-item :global(.more-body) {
        margin-inline-start: 1.75rem;
    }
    .check-row {
        display: flex;
        cursor: pointer;
        align-items: flex-start;
        gap: 0.5rem;
    }
    .check-row input {
        margin: 0.15rem 0 0;
        flex-shrink: 0;
    }
</style>
