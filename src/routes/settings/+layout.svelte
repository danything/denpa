<script lang="ts">
    import { onDestroy } from 'svelte';
    import { SECTION_ALIASES, SETTINGS_GROUPS } from '#lib/settings-sections.js';
    import { afterNavigate, replaceState } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { page } from '$app/state';
    import ArrowLeft from '~icons/lucide/arrow-left';

    let { children } = $props();

    /** いま開いているグループ (`/settings/reception` なら `reception`)。`/settings` そのものなら null */
    const current = $derived(page.route.id?.split('/')[2] ?? null);
    const group = $derived(SETTINGS_GROUPS.find((g) => g.slug === current) ?? null);

    /** 見えている節 (左の一覧と、狭い画面の上の行で塗る) */
    let active = $state<string | null>(null);

    let main = $state<HTMLElement>();
    let jumpRow = $state<HTMLElement>();

    const WIDE = '(min-width: 768px)';

    /**
     * **巻き取るのは広い画面では右の列、狭い画面では window。** 広い画面ではページごとは動かさない
     * (`+layout.svelte` の `.shell.fill`)
     */
    function scroller(): HTMLElement | null {
        return matchMedia(WIDE).matches ? (main ?? null) : null;
    }

    /**
     * **グループを移ったら右の列を頭に戻す。** 広い画面では window ではなく右の列が巻き取るので、
     * ブラウザのスクロールの戻し方が効かず、前のグループで下まで巻いた位置のまま次の画面が出ていた。
     * `#<節>` 付きで来たらその節へ (飛ぶ途中を見せても意味が無いので、ここは滑らかにしない)
     */
    afterNavigate(({ from, to }) => {
        if (main === undefined) return;
        let hash = decodeURIComponent(to?.url.hash.slice(1) ?? '');
        // なくなった節 (`#logos`) で来たら、入った先の節へ。URL も書き換えて、そのまま共有されても迷わせない
        const alias = Object.hasOwn(SECTION_ALIASES, hash) ? SECTION_ALIASES[hash] : undefined;
        if (alias !== undefined) {
            hash = alias;
            replaceState(`#${alias}`, page.state);
        } else if (from?.url.pathname === to?.url.pathname) {
            return;
        }
        const target = hash === '' ? null : document.getElementById(hash);
        if (target === null) {
            main.scrollTop = 0;
            active = group?.sections[0]?.slug ?? null;
        } else {
            pin(target);
        }
    });

    /**
     * **飛んだ先に、上の節が育つ間は付いていく。** 相手待ちの節 (チューナー) は骨組みのあとで本物が流れてきて
     * 背が変わるので、開いた瞬間に合わせただけでは、流れ終わったころには前の節を見ている。
     * 自分で巻こうとしたら (ホイール・指・キー・クリック)、そこで手を離す
     */
    let unpin = () => {};
    const LET_GO = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    function pin(target: HTMLElement): void {
        unpin();
        const align = () => {
            target.scrollIntoView({ block: 'start', behavior: 'instant' });
            active = target.id;
        };
        align();
        const resize = new ResizeObserver(align);
        resize.observe(main?.firstElementChild ?? target);
        const timer = setTimeout(() => unpin(), 4000);
        const letGo = () => unpin();
        for (const type of LET_GO) window.addEventListener(type, letGo, { passive: true });
        unpin = () => {
            resize.disconnect();
            clearTimeout(timer);
            for (const type of LET_GO) window.removeEventListener(type, letGo);
            unpin = () => {};
        };
    }
    onDestroy(() => unpin());

    /** 押した節へ飛んでいる間は、見えている節を数え直さない (途中の節が点々と塗られる) */
    let jumping: ReturnType<typeof setTimeout> | undefined;
    function jump(slug: string): void {
        active = slug;
        clearTimeout(jumping);
        jumping = setTimeout(() => (jumping = undefined), 800);
    }

    /**
     * **見えている節を追う** (Vercel のドキュメントの目次と同じ)。上の帯 (ヘッダーの下から画面の 45%) に
     * かかっている節のうち、いちばん上のもの。長い節 (チューナー) が帯にかかっている間は次の節に移らない。
     * 下まで巻いたら最後の節 (短い節は帯まで上がってこない)
     */
    $effect(() => {
        void page.url.pathname;
        if (main === undefined) return;
        const parts = [...main.querySelectorAll<HTMLElement>('[data-part]')];
        if (parts.length === 0) return;
        const root = scroller();
        const seen = new Set<string>();

        const pick = () => {
            if (jumping !== undefined) return;
            const box = root ?? document.documentElement;
            const bottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
            if (bottom && box.scrollTop > 0) {
                active = parts.at(-1)!.id;
                return;
            }
            const first = parts.find((part) => seen.has(part.id));
            if (first !== undefined) active = first.id;
        };

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) seen.add(entry.target.id);
                    else seen.delete(entry.target.id);
                }
                pick();
            },
            /*
             * 狭い画面は上に節の行 (とヘッダー) が重なるので、その下から数える。
             * rootMargin は px か % だけ (rem は投げる)
             */
            { root, rootMargin: `-${root === null ? Math.round(jumpRow?.getBoundingClientRect().bottom ?? 0) + 8 : 16}px 0px -55% 0px` },
        );
        for (const part of parts) observer.observe(part);
        const target = root ?? window;
        target.addEventListener('scroll', pick, { passive: true });
        return () => {
            observer.disconnect();
            target.removeEventListener('scroll', pick);
        };
    });
</script>

<!--
    **一覧と詳細の形**。左にグループとその節の一覧、右にグループの画面。
    **グループごとに1つの画面** (`/settings/<グループ>`) で、節は上から積む。節を押すとそこへ滑らかに巻き、
    巻いていくと見えている節が左の一覧で塗られる。並びは `#lib/settings-sections.ts`。

    **横に並べはじめる幅は全画面で 768px** ([+layout.svelte](../+layout.svelte) の `FILLED`)。
    並べたらページごとは動かさず、左右がそれぞれ自分で巻き取る。左の列は画面の左端とヘッダーの下に付け、
    右とは線で分けない (地は同じで、右の列を真ん中に寄せた余白で分かれる)。

    **狭い画面では一覧と中身を切り替える。** `/settings` はグループの一覧だけ、押すとその画面と「← 設定」、
    上に節へ飛ぶ行 (巻いても上に残る)
-->
<div class="page settings-page" class:list-view={current === null}>
    <!--
        **行は線で区切らない** (録画の画面のサイドバーと同じ部品)。グループは太字の見出し、
        節はそれより一段深い行。見えている節だけ角の丸い薄い塗り
    -->
    <nav class="side side-panel" aria-label="設定の項目" data-testid="settings-nav">
        <ul class="groups">
            {#each SETTINGS_GROUPS as g (g.slug)}
                {@const here = current === g.slug}
                {@const href = resolve(`settings/${g.slug}`)}
                <li>
                    <a
                        {href}
                        class="group-link side-label"
                        class:here
                        aria-current={here ? 'page' : undefined}
                        data-testid="settings-nav-{g.slug}"
                    >
                        {g.label}
                        <!-- 狭い画面の一覧だけ。中に何があるかを1行で (節の一覧は出さないので) -->
                        <span class="group-hint">{g.sections.map((s) => s.label).join('・')}</span>
                    </a>
                    <ul class="sections-nav side-list">
                        {#each g.sections as section (section.slug)}
                            {@const selected = here && active === section.slug}
                            <li>
                                <a
                                    href="{href}#{section.slug}"
                                    class="side-item"
                                    aria-current={selected ? 'location' : undefined}
                                    onclick={() => jump(section.slug)}
                                    data-testid="settings-nav-{section.slug}"
                                >
                                    {section.label}
                                </a>
                            </li>
                        {/each}
                    </ul>
                </li>
            {/each}
        </ul>
    </nav>

    <div class="main" bind:this={main}>
        <div class="main-inner">
            {#if group !== null}
                <!-- 狭い画面だけ。一覧へ戻る (ブラウザの戻ると同じ行き先) と、節へ飛ぶ行 -->
                <div class="jump small" bind:this={jumpRow} data-testid="settings-jump">
                    <a class="back" href={resolve('settings')} title="設定へ戻る" data-testid="settings-back"
                        ><ArrowLeft aria-hidden="true" /><span class="visually-hidden">設定へ戻る</span></a
                    >
                    {#each group.sections as section (section.slug)}
                        <a
                            href="{resolve(`settings/${group.slug}`)}#{section.slug}"
                            class:selected={active === section.slug}
                            onclick={() => jump(section.slug)}
                            data-testid="settings-jump-{section.slug}"
                        >
                            {section.label}
                        </a>
                    {/each}
                </div>
            {/if}
            {@render children()}
        </div>
    </div>
</div>

<style>
    /*
     * **広い画面では main の余白の外まで広げる。** 左の列は画面の左端とヘッダーの下に付け、
     * 高さは画面の残りいっぱい (`+layout.svelte` の `.shell.fill`)
     */
    @media (min-width: 768px) {
        .page {
            display: grid;
            grid-template-columns: 14rem minmax(0, 1fr);
            height: calc(100% + var(--dp-page-top) + var(--dp-gutter));
            margin: calc(-1 * var(--dp-page-top)) calc(-1 * var(--dp-gutter)) calc(-1 * var(--dp-gutter));
        }
    }
    @media (min-width: 1280px) {
        .page {
            grid-template-columns: 16rem minmax(0, 1fr);
        }
    }

    /*
     * ---- 左の一覧 ----
     * **録画の画面のサイドバーと同じ部品** (`app.css` の `.side-panel`・`.side-label`・`.side-list`・`.side-item`)。
     * グループの見出しはその画面へのリンク。ここは幅と、狭い画面の形だけ
     */
    .groups {
        display: flex;
        flex-direction: column;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .groups > li {
        margin: 0;
        list-style: none;
    }
    .side a {
        text-decoration: none;
    }
    .group-link {
        border-radius: var(--dp-radius);
        transition:
            background-color var(--dp-duration),
            color var(--dp-duration);
    }
    .group-link:hover {
        color: inherit;
    }
    .group-hint {
        display: none;
    }
    /*
     * 狭い画面の一覧はグループだけ (押すとその画面。節へは画面の上の行で飛ぶ)。
     * 指で押すので行を高くする (40px 以上)。字は本文の大きさ、塗りだけ余白の外へ少し出す
     */
    @media (max-width: 767px) {
        .side {
            padding: 0;
            overflow: visible;
        }
        .side .sections-nav {
            display: none;
        }
        .groups {
            margin-inline: -0.75rem;
        }
        /* 行どうしは線で区切らない。見出しの太字も外し、ふつうの行にする (下に中身の1行) */
        .group-link {
            display: block;
            margin: 0;
            padding-block: 0.625rem;
            color: inherit;
            font-size: var(--dp-text-base);
            font-weight: var(--dp-weight);
        }
        .group-link:hover {
            background: var(--dp-hover-soft);
        }
        .group-hint {
            display: block;
            color: var(--dp-muted);
            font-size: var(--dp-text-xs);
        }
    }

    /* ---- 右の中身 ---- */
    .main {
        min-width: 0;
    }
    @media (min-width: 768px) {
        .main {
            min-height: 0;
            overflow-y: auto;
        }
    }
    /* 節を押したら滑らかに巻く。動かさない設定の端末ではそのまま飛ぶ */
    @media (prefers-reduced-motion: no-preference) {
        .main,
        :global(html:has(.settings-page)) {
            scroll-behavior: smooth;
        }
    }
    /*
     * 中の 2 段組 (`app.css` の `.setting-rows`) は、この列の幅で切り替える。
     * 広い画面では列を真ん中に寄せる (左に寄せたままだと右が大きく空いて見えた)
     */
    .main-inner {
        display: flex;
        width: 100%;
        max-width: 60rem;
        margin-inline: auto;
        box-sizing: border-box;
        flex-direction: column;
        gap: var(--dp-space-3);
        container-type: inline-size;
    }
    @media (min-width: 768px) {
        .main-inner {
            padding: var(--dp-page-top) var(--dp-gutter) var(--dp-gutter);
        }
    }
    /*
     * **節どうしは細い線1本と、上下にたっぷりの余白で区切る** (左の一覧のグループの境目と同じ考え。カードにはしない)。
     * 線の上下を広めに取り、節の中の行の間より目に見えて空ける。飛んだ先が見出しの上にぴったり付くよう、
     * 巻き取りの余白を取る (狭い画面はヘッダーと節の行の下)
     */
    .main-inner :global([data-part] + [data-part]) {
        margin-top: var(--dp-space-4);
        padding-top: var(--dp-space-6);
        border-top: 1px solid var(--dp-line);
    }
    .main-inner :global([data-part]) {
        scroll-margin-top: var(--dp-gutter);
    }
    @media (max-width: 767px) {
        .main-inner :global([data-part]) {
            scroll-margin-top: 7rem;
        }
    }
    @media (max-width: 639.98px) {
        .main-inner :global([data-part]) {
            scroll-margin-top: calc(3.5rem + env(safe-area-inset-top));
        }
    }
    /* 狭い画面は一覧か中身のどちらか。どちらを出すかは URL */
    @media (max-width: 767px) {
        .page.list-view .main,
        .page:not(.list-view) .side {
            display: none;
        }
    }

    /*
     * **狭い画面の上の行。** 「← 設定」と節の名前を横に並べ、巻いてもヘッダーの下に残す (ヘッダーと同じく下の線は引かない)。
     * はみ出す分は横に巻く (行を折り返すと高さが変わり、飛んだ先の余白が合わなくなる)
     */
    .jump {
        position: sticky;
        top: 3.5rem;
        z-index: 30;
        display: flex;
        align-items: center;
        gap: var(--dp-space-1);
        margin-inline: calc(-1 * var(--dp-gutter));
        padding: 0.5rem var(--dp-gutter);
        overflow-x: auto;
        background: var(--dp-bg);
        scrollbar-width: none;
        white-space: nowrap;
    }
    .jump a {
        flex-shrink: 0;
        padding: 0.3rem 0.65rem;
        border-radius: var(--dp-radius-full);
        color: var(--dp-muted);
        text-decoration: none;
    }
    .jump a.selected {
        background: var(--dp-subtle);
        color: inherit;
        font-weight: var(--dp-weight-bold);
    }
    /* 戻るは字だけのアイコンのボタン */
    .jump .back {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: var(--dp-btn-h-sm);
        height: var(--dp-btn-h-sm);
        padding: 0;
        color: inherit;
    }
    .jump .back:hover {
        background: var(--dp-btn-tonal-hover);
    }
    .jump .back :global(svg) {
        width: 1.125rem;
        height: 1.125rem;
    }
    /* 640px より狭いとヘッダーは隠れている (下のタブに替わる)。いちばん上に付ける */
    @media (max-width: 639.98px) {
        .jump {
            top: env(safe-area-inset-top);
        }
    }
    @media (min-width: 768px) {
        .jump {
            display: none;
        }
    }
</style>
