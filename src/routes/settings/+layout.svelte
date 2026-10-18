<script lang="ts">
    import { SETTINGS_GROUPS } from '#lib/settings-sections.js';
    import { afterNavigate } from '$app/navigation';
    import { resolve } from '$app/paths';
    import { page } from '$app/state';

    let { children } = $props();

    /** いま開いている節 (`/settings/tuners` なら `tuners`)。`/settings` そのものなら null */
    const current = $derived(page.route.id?.split('/')[2] ?? null);

    /**
     * **節を移ったら右の列を頭に戻す。** 広い画面では window ではなく右の列が巻き取るので、
     * ブラウザのスクロールの戻し方が効かず、前の節で下まで巻いた位置のまま次の節が出ていた
     */
    let main = $state<HTMLElement>();
    afterNavigate(({ from, to }) => {
        if (main !== undefined && from?.url.pathname !== to?.url.pathname) main.scrollTop = 0;
    });
</script>

<!--
    **一覧と詳細の形** (ルールの画面と同じ)。左に節の一覧、右にその節の中身。
    節ごとに URL (`/settings/<節>`) があるので、戻る/進む・リンクもそのまま使える。

    **横に並べはじめる幅は全画面で 768px** ([+layout.svelte](../+layout.svelte) の `FILLED`)。
    並べたらページごとは動かさず、左右がそれぞれ自分で巻き取る。左の列は画面の左端とヘッダーの下に付け、
    境目は 1px の線だけ。

    **狭い画面では一覧と中身を切り替える。** `/settings` は一覧だけ、節を押すと中身と「← 設定」
-->
<div class="page" class:list-view={current === null}>
    <!--
        **行は線で区切らない** (ドキュメントの目次と同じ作り)。選んでいる行だけ角の丸い薄い塗り。
        グループの名前は小さく沈めた字で
    -->
    <nav class="side" aria-label="設定の項目" data-testid="settings-nav">
        {#each SETTINGS_GROUPS as group (group.label)}
            <div class="group">
                <p class="group-label">{group.label}</p>
                <ul>
                    {#each group.sections as section (section.slug)}
                        {@const selected = current === section.slug}
                        <li>
                            <a
                                href={resolve(`settings/${section.slug}`)}
                                class:selected
                                aria-current={selected ? 'page' : undefined}
                                data-testid="settings-nav-{section.slug}"
                            >
                                {section.label}
                            </a>
                        </li>
                    {/each}
                </ul>
            </div>
        {/each}
    </nav>

    <div class="main" bind:this={main}>
        <div class="main-inner">
            <!-- 狭い画面だけ。一覧へ戻る (ブラウザの戻ると同じ行き先) -->
            <a class="back small" href={resolve('settings')} data-testid="settings-back">← 設定</a>
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
            height: calc(100% + 2 * var(--dp-gutter));
            margin: calc(-1 * var(--dp-gutter));
        }
    }
    @media (min-width: 1280px) {
        .page {
            grid-template-columns: 16rem minmax(0, 1fr);
        }
    }

    /* ---- 左の一覧 ---- */
    .side {
        display: flex;
        min-height: 0;
        flex-direction: column;
        gap: var(--dp-space-4);
    }
    @media (min-width: 768px) {
        .side {
            overflow-y: auto;
            padding: var(--dp-space-4) var(--dp-space-2);
            border-right: 1px solid var(--dp-line);
        }
    }
    .group-label {
        margin: 0 0 0.25rem;
        padding-inline: 0.75rem;
        color: var(--dp-muted);
        font-size: var(--dp-text-xs);
        font-weight: var(--dp-weight-bold);
    }
    .side ul {
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .side li {
        margin: 0 0 1px;
        list-style: none;
    }
    .side a {
        display: block;
        padding: 0.375rem 0.75rem;
        border-radius: var(--dp-radius);
        color: var(--dp-muted);
        font-size: var(--dp-text-sm);
        text-decoration: none;
        transition:
            background-color var(--dp-duration),
            color var(--dp-duration);
    }
    .side a:hover {
        background: color-mix(in srgb, var(--dp-subtle) 55%, transparent);
        color: inherit;
    }
    .side a.selected {
        background: var(--dp-subtle);
        color: inherit;
        font-weight: var(--dp-weight-bold);
    }
    /*
     * 狭い画面の一覧は指で押すので行を高くする (40px 以上)。字は本文の大きさ、
     * 塗りだけ余白の外へ少し出して、字は上のグループの名前と揃える
     */
    @media (max-width: 767px) {
        .side ul {
            margin-inline: -0.75rem;
        }
        .group-label {
            padding-inline: 0;
        }
        .side a {
            padding-block: 0.625rem;
            color: inherit;
            font-size: var(--dp-text-base);
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
    /* 中の 2 段組 (`app.css` の `.setting-rows`) は、この列の幅で切り替える */
    .main-inner {
        display: flex;
        max-width: 64rem;
        flex-direction: column;
        gap: var(--dp-space-3);
        container-type: inline-size;
    }
    @media (min-width: 768px) {
        .main-inner {
            padding: var(--dp-gutter);
        }
    }
    /* 狭い画面は一覧か中身のどちらか。どちらを出すかは URL */
    @media (max-width: 767px) {
        .page.list-view .main,
        .page:not(.list-view) .side {
            display: none;
        }
    }
    .back {
        align-self: flex-start;
    }
    @media (min-width: 768px) {
        .back {
            display: none;
        }
    }
</style>
