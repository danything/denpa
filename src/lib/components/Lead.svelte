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
        <button type="button" class="more-link" aria-expanded={open} aria-controls={id} onclick={() => (open = !open)}>
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
    /* 文の続きとして読める、地も枠も無い小さなリンク。押せることは下線で示す */
    .more-link {
        display: inline;
        width: auto;
        margin: 0 0 0 0.25rem;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: none;
        box-shadow: none;
        color: var(--dp-muted);
        font: inherit;
        text-decoration: underline;
        text-decoration-color: var(--dp-line-strong);
        text-underline-offset: 0.2em;
        cursor: pointer;
    }
    .more-link:hover {
        color: var(--pico-color);
        text-decoration-color: currentColor;
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
