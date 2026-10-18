<script lang="ts">
    import Icon from '#lib/components/player/Icon.svelte';
    import { resolve } from '$app/paths';
    import SearchIcon from '~icons/lucide/search';

    /**
     * **サイト全体の検索の欄** (`/search?q=`)。広い画面はヘッダーの真ん中、狭い画面は検索の画面の上の帯に
     * 同じものを置く (`+layout.svelte`)。結果の画面では探した言葉が入ったまま直して送れる。
     *
     * GET で送るので、結果の URL をそのまま人に渡せる。`/` と Ctrl/⌘+K で入る (`data-search-field`。
     * 見えている欄を `+layout.svelte` が探す)
     */
    let {
        value = '',
        testid,
    }: {
        /** 入っている言葉。URL が変われば入れ直す (打ちかけは URL が変わるまで残す) */
        value?: string;
        testid: string;
    } = $props();

    let typed = $derived(value);
</script>

<form method="GET" action={resolve('search')} role="search" aria-label="サイト内" class="search-field" data-testid={testid}>
    <Icon icon={SearchIcon} size="size-4" />
    <input
        type="search"
        name="q"
        bind:value={typed}
        placeholder="番組・録画・予約・ルールを検索"
        aria-label="番組・録画・予約・ルールを検索"
        autocomplete="off"
        enterkeyhint="search"
        data-search-field
        data-testid="{testid}-input"
    />
    <kbd class="key" aria-hidden="true">/</kbd>
</form>

<style>
    /*
     * **欄の形は虫眼鏡と字と `/` の印だけ。** 欄そのものの枠は外し、包んだ `form` に枠を付ける
     * (虫眼鏡も欄の中に見せる)。角は入力欄と同じ丸い端
     */
    .search-field {
        display: flex;
        align-items: center;
        gap: var(--dp-space-2);
        width: 100%;
        min-width: 0;
        height: 2.5rem;
        margin: 0;
        padding-inline: var(--dp-space-3) var(--dp-space-2);
        border: 1px solid var(--dp-line);
        border-radius: var(--dp-radius-full);
        background: var(--dp-subtle);
        color: var(--dp-muted);
    }
    .search-field:focus-within {
        border-color: var(--pico-primary);
    }
    /* Pico の role=search は中の物を等分に伸ばす。欄だけを伸ばし、虫眼鏡と印は字の幅のまま */
    .search-field > :global(*) {
        flex: none;
    }
    .search-field input {
        flex: 1 1 0%;
        min-width: 0;
        height: auto;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        color: var(--pico-color);
        font-size: var(--dp-text-sm);
        outline: none;
        text-align: start;
    }
    .key {
        padding: 0 0.375rem;
        border: 1px solid var(--dp-line);
        border-radius: var(--dp-radius-sm);
        background: transparent;
        color: var(--dp-muted);
        font-size: var(--dp-text-xs);
        line-height: 1.4;
    }
    /* 打っている間と、キーボードの無い端末では印を出さない */
    .search-field:focus-within .key {
        display: none;
    }
    @media (pointer: coarse) {
        .key {
            display: none;
        }
    }
</style>
