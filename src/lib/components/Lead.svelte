<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 説明の 1 行と、その終わりに続く「詳しく」(設定の画面)。
     *
     * **「詳しく」は文の終わりの小さなリンクにする。** 欄ごとに「詳しく ›」の段が
     * 立っていた頃は、要点の文より開け閉めの段のほうが目に付いた。押すと続きを下に出す
     */
    let {
        children,
        more,
        class: extra = '',
    }: {
        children: Snippet;
        /** 畳んでおく続き。無ければ「詳しく」も出さない */
        more?: Snippet;
        class?: string;
    } = $props();

    let open = $state(false);
    const id = $props.id();
</script>

<p class="lead {extra}">
    {@render children()}
    {#if more}
        <button type="button" class="text-button" aria-expanded={open} aria-controls={id} onclick={() => (open = !open)}>
            詳しく<span class="chevron" class:open aria-hidden="true">›</span>
        </button>
    {/if}
</p>
{#if more}
    <!-- 閉じている間も置いておく (ページ内の検索で見つかる。読み上げとテストからも引ける) -->
    <div class="more-body" {id} hidden={!open}>
        {@render more()}
    </div>
{/if}

<style>
    .lead {
        margin: 0;
        color: var(--dp-muted);
        font-size: var(--dp-text-sm);
    }
    .chevron {
        display: inline-block;
        margin-inline-start: 0.15em;
        transition: transform var(--dp-duration) var(--dp-ease);
    }
    .chevron.open {
        transform: rotate(90deg);
    }
    .more-body {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        margin-top: 0.35rem;
        color: var(--dp-muted);
        font-size: var(--dp-text-sm);
    }
    .more-body[hidden] {
        display: none;
    }
    .more-body :global(p) {
        margin: 0;
    }
</style>
