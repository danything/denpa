<script lang="ts">
    import { untrack } from 'svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import {
        resultsHref,
        type SuggestGroup,
        type SuggestResponse,
        suggestGroups,
    } from '#lib/search-suggest.js';
    import { afterNavigate, goto } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { page } from '$app/state';
    import SearchIcon from '~icons/lucide/search';

    /**
     * **サイト全体の検索の欄** (`/search?q=`)。広い画面はヘッダーの真ん中、狭い画面は検索の画面の上の帯に
     * 同じものを置く (`+layout.svelte`)。`/` と Ctrl/⌘+K で入る (`data-search-field`。見えている欄を
     * `+layout.svelte` が探す)。
     *
     * **打つそばから応える。** 結果の画面の外 (`live` でない) では、少し待ってから `/api/search` に聞き、
     * 欄の下に節ごとの候補を出す (combobox と listbox の形。↑/↓ で選び、Enter で開く。何も選んでいなければ
     * Enter で結果の画面。Esc で閉じる)。結果の画面 (`live`) では候補を出さず、打つそばから結果の画面そのものを
     * 出し直す (履歴は積まずに置き換える)。どちらも、言葉が変わったら送りかけの問い合わせを止める
     */
    let {
        value = '',
        testid,
        live = false,
    }: {
        /** 入っている言葉。URL が変われば入れ直す (自分で送った言葉が返ってきたときは、打ちかけを残す) */
        value?: string;
        testid: string;
        /** 結果の画面の上にいるか。候補を出さず、結果の画面を出し直す */
        live?: boolean;
    } = $props();

    /** 打ってから聞くまでの間。打つ手を止めるたびに聞くと、1字ごとにサーバを叩く */
    const DELAY = 180;

    let typed = $state(untrack(() => value));
    /** 最後に自分で結果の画面に送った言葉。それが `value` で返ってきても、打ちかけを上書きしない */
    let sent: string | null = null;
    $effect(() => {
        const next = value;
        untrack(() => {
            if (next !== sent && next !== typed) typed = next;
            sent = null;
        });
    });

    const listId = $derived(`${testid}-list`);
    let groups = $state<SuggestGroup[]>([]);
    /** 候補を出しているときの言葉。結果の画面へのリンクと「見つかりません」に使う */
    let answered = $state('');
    let open = $state(false);
    let active = $state(-1);
    let focused = $state(false);
    const options = $derived(groups.flatMap((group) => group.items));
    /** 最後の候補は「すべての結果を見る」(`options` の次の番号) */
    const allIndex = $derived(options.length);
    const optionId = (index: number) =>
        index === allIndex ? `${testid}-all` : `${testid}-option-${options[index]?.key ?? index}`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    function cancel(): void {
        clearTimeout(timer);
        controller?.abort();
        controller = null;
    }

    function close(): void {
        open = false;
        active = -1;
    }

    /** 候補を聞く。言葉が変わったら前の問い合わせは止める */
    async function suggest(q: string): Promise<void> {
        controller?.abort();
        const mine = new AbortController();
        controller = mine;
        try {
            const res = await fetch(`${resolve('api/search')}?${new URLSearchParams({ q })}`, {
                signal: mine.signal,
            });
            if (!res.ok) throw new Error(String(res.status));
            const body = (await res.json()) as SuggestResponse;
            if (controller !== mine) return;
            groups = suggestGroups(body);
            answered = body.q;
            active = -1;
            open = focused;
        } catch {
            // 止めたもの・届かなかったものは何も出さない (Enter で結果の画面は開ける)
        } finally {
            if (controller === mine) controller = null;
        }
    }

    function oninput(): void {
        cancel();
        const q = typed.trim();
        if (live) {
            timer = setTimeout(() => {
                sent = q;
                /*
                 * 直しているルール (`?rule=`) は付けたまま。言葉を探し直しても、右の書く欄はそのルールのまま
                 */
                const next = new URLSearchParams(q === '' ? {} : { q });
                const rule = page.url.searchParams.get('rule');
                if (rule !== null) next.set('rule', rule);
                void goto(next.size === 0 ? resolve('search') : resolve(`search?${next}`), {
                    replace: true,
                    reset: false,
                });
            }, DELAY);
            return;
        }
        if (q === '') {
            groups = [];
            close();
            return;
        }
        timer = setTimeout(() => void suggest(q), DELAY);
    }

    function hrefAt(index: number): string {
        return index === allIndex ? resultsHref(answered || typed.trim()) : (options[index]?.href ?? '');
    }

    function choose(index: number): void {
        const href = hrefAt(index);
        cancel();
        close();
        void goto(resolve(href as `search?${string}`));
    }

    function onkeydown(event: KeyboardEvent): void {
        if (event.isComposing) return;
        if (event.key === 'Escape') {
            if (open) {
                event.preventDefault();
                close();
            }
            return;
        }
        if (live) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!open) {
                if (groups.length > 0 || answered !== '') open = true;
                return;
            }
            event.preventDefault();
            const last = allIndex;
            active =
                event.key === 'ArrowDown'
                    ? active >= last
                        ? 0
                        : active + 1
                    : active <= 0
                      ? last
                      : active - 1;
            document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && open && active >= 0) {
            event.preventDefault();
            choose(active);
        }
    }

    /** 送るとき (Enter で何も選んでいない) は、待っている候補を止めて閉じる */
    function onsubmit(): void {
        cancel();
        close();
        if (live) sent = typed.trim();
    }

    // 画面を移ったら閉じる (候補から選んだあと・ブラウザの戻る)
    afterNavigate(() => close());
</script>

<div
    class="search-wrap"
    onfocusin={() => {
        focused = true;
        if (!live && typed.trim() !== '' && (groups.length > 0 || answered !== '')) open = true;
    }}
    onfocusout={(event) => {
        // 候補の中へ移っただけなら閉じない
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        focused = false;
        close();
    }}
>
    <form
        method="GET"
        action={resolve('search')}
        role="search"
        aria-label="サイト内"
        class="search-field"
        data-testid={testid}
        {onsubmit}
    >
        <Icon icon={SearchIcon} size="size-4" />
        <input
            type="search"
            name="q"
            bind:value={typed}
            {oninput}
            {onkeydown}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete={live ? 'none' : 'list'}
            aria-activedescendant={!live && open && active >= 0 ? optionId(active) : undefined}
            placeholder="番組・録画・予約・ルールを検索"
            aria-label="番組・録画・予約・ルールを検索"
            autocomplete="off"
            enterkeyhint="search"
            data-search-field
            data-testid="{testid}-input"
        />
        <kbd class="key" aria-hidden="true">/</kbd>
    </form>

    <!--
        候補。押す・選ぶのは行そのもの (中にボタンは置かない。listbox の行は1つの操作)。焦点は欄に置いたまま
        (`aria-activedescendant`)、押した瞬間に欄から焦点が外れて閉じないよう、mousedown では焦点を動かさない。
        結果の画面 (`live`) では出さない (欄の `aria-controls` が指す先として空のまま置く)
    -->
    <div class="suggest" hidden={live || !open} data-testid="{testid}-suggest">
        <div id={listId} role="listbox" aria-label="検索の候補" class="suggest-list">
            {#each groups as group (group.key)}
                <div role="group" aria-labelledby="{testid}-group-{group.key}" class="suggest-group">
                    <div class="suggest-title" id="{testid}-group-{group.key}">{group.title}</div>
                    {#each group.items as item (item.key)}
                        {@const index = options.indexOf(item)}
                        <div
                            id={optionId(index)}
                            role="option"
                            tabindex="-1"
                            aria-selected={active === index}
                            class="suggest-option"
                            class:active={active === index}
                            data-testid="{testid}-option"
                            data-href={item.href}
                            onmousedown={(event) => event.preventDefault()}
                            onclick={() => choose(index)}
                            onkeydown={(event) => event.key === 'Enter' && choose(index)}
                            onmousemove={() => (active = index)}
                        >
                            <span class="suggest-text">
                                <span class="suggest-label truncate" class:broadcast={item.broadcast}
                                    >{item.label}</span
                                >
                                {#if item.meta !== ''}
                                    <span class="suggest-meta tiny muted truncate">{item.meta}</span>
                                {/if}
                            </span>
                            <span class="suggest-hint tiny muted">{item.hint}</span>
                        </div>
                    {/each}
                </div>
            {/each}
            {#if groups.length === 0}
                <div class="suggest-empty small muted">「{answered}」に一致するものはありません</div>
            {/if}
            <div
                id={optionId(allIndex)}
                role="option"
                tabindex="-1"
                aria-selected={active === allIndex}
                class="suggest-option suggest-all"
                class:active={active === allIndex}
                data-testid="{testid}-all"
                onmousedown={(event) => event.preventDefault()}
                onclick={() => choose(allIndex)}
                onkeydown={(event) => event.key === 'Enter' && choose(allIndex)}
                onmousemove={() => (active = allIndex)}
            >
                <span class="small">「{answered}」のすべての結果を見る</span>
            </div>
        </div>
    </div>
    <!-- 読み上げに候補の数を伝える -->
    <span class="visually-hidden" role="status">{open ? `候補 ${options.length} 件` : ''}</span>
</div>

<style>
    .search-wrap {
        position: relative;
        width: 100%;
        min-width: 0;
    }
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

    /*
     * 候補。欄の真下に浮かせ、欄より少し広く取る (ヘッダーの欄が縮んでも読める幅)。
     * 節は小さな見出しと行だけ (カードにしない)。選んでいる行は淡い地。
     * 箱は透かさない面に縁と影 (ぼかさない。`app.css` の「磨りガラス」)
     */
    .suggest {
        position: absolute;
        top: calc(100% + var(--dp-space-1));
        left: 50%;
        z-index: 50;
        width: max(100%, min(36rem, calc(100vw - 2rem)));
        max-height: min(70vh, 36rem);
        overflow-y: auto;
        padding: var(--dp-space-1);
        border: 1px solid var(--dp-line);
        border-radius: var(--dp-radius-lg);
        background: var(--dp-bg);
        box-shadow: var(--dp-shadow-pop);
        transform: translateX(-50%);
    }
    .suggest[hidden] {
        display: none;
    }
    /*
     * **節は縦に積む。** Pico は `role="group"` を横並びの組 (inline-flex。角を落とし、間に線) にするので、
     * 打ち消して普通の縦の並びに戻す
     */
    .suggest-group {
        display: flex;
        flex-direction: column;
        width: 100%;
        margin: 0;
        border-radius: 0;
        box-shadow: none;
    }
    .suggest-group > * {
        margin: 0;
        border-left: 0;
    }
    .suggest-group + .suggest-group,
    .suggest-all {
        margin-top: var(--dp-space-1);
        border-top: 1px solid var(--dp-line);
    }
    .suggest-title {
        padding: var(--dp-space-2) var(--dp-space-3) var(--dp-space-1);
        color: var(--dp-muted);
        font-size: var(--dp-text-xs);
        font-weight: var(--dp-weight-bold);
    }
    .suggest-option {
        display: flex;
        align-items: center;
        gap: var(--dp-space-3);
        min-height: 2.5rem;
        padding: var(--dp-space-1) var(--dp-space-3);
        border-radius: var(--dp-radius-sm);
        cursor: pointer;
    }
    .suggest-option.active {
        background: var(--dp-hover);
    }
    .suggest-text {
        display: flex;
        flex: 1 1 0%;
        flex-direction: column;
        min-width: 0;
    }
    .suggest-label {
        font-size: var(--dp-text-sm);
    }
    .suggest-hint {
        flex: none;
    }
    .suggest-empty {
        padding: var(--dp-space-2) var(--dp-space-3);
    }
    .suggest-all {
        padding-top: var(--dp-space-2);
    }
</style>
