<script lang="ts">
    import '../app.scss';
    import { onMount } from 'svelte';
    import { invalidateAll } from '$app/navigation';
    import { navigating, page } from '$app/state';
    import { busy } from '$lib/busy.svelte';
    import Measure from '$lib/components/Measure.svelte';
    import Icon from '$lib/components/player/Icon.svelte';
    import { write } from '$lib/keep';
    import { measure } from '$lib/measure.svelte';
    import { startOffline } from '$lib/offline.svelte';

    let { children, data } = $props();

    // オフライン視聴の控えを読み、オンラインに戻ったら outbox を流す (docs/offline.md)
    onMount(() => startOffline());

    /**
     * **その端末の高さを読む札。**
     *
     * 縦のはみ出しは端末でしか起きないことがある — 自動運転のブラウザには
     * 引っ込むアドレスバーが作れない。実機の PWA で「リロードすると画面全体が
     * スクロールできる」として出たとき、**数を見る手が1つも無かった**。
     *
     * 入り口は2つ。`?measure` (1回だけ見る) と、設定画面の入り切り
     * (覚える) — **PWA にはアドレスバーが無い**ので、URL だけでは入れない
     */
    $effect(() => {
        measure.start(page.url);
    });

    // ハイドレーション完了の目印。SSR直後のDOMに入力しても、ハイドレーションで
    // 値が書き戻されて消える。E2Eはこの印が付くのを待ってから操作する
    let hydrated = $state(false);

    /** 既定はダーク (映像を観るものはダークが基本)。system は端末の設定に従う */
    let mode = $state<'system' | 'light' | 'dark'>('dark');
    const LABEL = { system: '端末に合わせる', light: 'ライト', dark: 'ダーク' };
    /** 月・太陽・半分塗った丸 (Pico の見本と同じ月)。絵文字は端末ごとに絵が違い、太さも揃わなかった */
    const ICON = {
        dark: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z',
        light: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2zm18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2zM11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0zm0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0zM5.99 4.58a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41L5.99 4.58zm12.37 12.37a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41l-1.06-1.06zm1.06-10.96a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41l1.06-1.06zM7.05 18.36a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41l1.06-1.06z',
        system: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18V4a8 8 0 0 1 0 16z',
    };

    function apply() {
        const dark =
            mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
        document.documentElement.dataset['themeMode'] = mode;
    }

    onMount(() => {
        hydrated = true;
        mode = (document.documentElement.dataset['themeMode'] as 'system' | 'light' | 'dark') ?? 'system';

        // 端末側の設定が変わったら、system のときだけ追従する
        const media = matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            if (mode === 'system') apply();
        };
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    });

    function cycleTheme() {
        mode = mode === 'dark' ? 'light' : mode === 'light' ? 'system' : 'dark';
        // 既定がダークなので「端末に合わせる」も選んだ印として残す (残さないと次に開いたときダークに戻る)
        write('theme', mode);
        apply();
    }

    /**
     * **戻ってきたら読み直す。**
     *
     * ホーム画面から開いたアプリ (PWA) は、閉じても捨てられない。端末は画面を
     * 凍らせて残しておき、次に開いたときそのまま見せる — **前に閉じたときの
     * 一覧がそのまま出る**。録画は増えているし、録画中だったものは終わっている。
     *
     * 知らせ (`liveUpdates`) を使っている画面でも足りない。あちらの繋ぎは
     * 凍っている間に切られて戻ってこないうえ、繋ぎ直しても**凍っていた間に
     * 起きたこと**は流れてこない (通知は溜めていない)。開き直した時点で
     * 1回読み直すのが確実で、番組表やルールのように知らせを使っていない
     * 画面もこれで揃う。
     *
     * `pageshow` も見るのは、履歴で戻ったとき (bfcache) が
     * `visibilitychange` を伴わないため。**取っておいた画面のときだけ** —
     * 素の読み込みでも来るので、見境なく読み直すと毎回2回読むことになる
     *
     * **`resume` も見る。** Android の Chrome は裏に回した画面を*凍らせ*、
     * 戻すときに `resume` を出す。`visibilitychange` が必ず付いてくるとは
     * 決まっていないので、出なかったときに前のままの一覧を見せ続けないよう
     * 両方を見る。**こちらは実機でしか確かめられない** — 自動運転の
     * ブラウザ (CDP の `setWebLifecycleState`) では `freeze` も `resume` も
     * 飛んでこないので、あの経路で「効いた」ことは示せない
     */
    onMount(() => {
        const refresh = () => {
            if (document.visibilityState !== 'visible') return;
            void invalidateAll();
        };
        const restored = (event: PageTransitionEvent) => {
            if (event.persisted) refresh();
        };
        document.addEventListener('visibilitychange', refresh);
        document.addEventListener('resume', refresh);
        window.addEventListener('pageshow', restored);
        return () => {
            document.removeEventListener('visibilitychange', refresh);
            document.removeEventListener('resume', refresh);
            window.removeEventListener('pageshow', restored);
        };
    });

    /*
     * `/offline` (端末に保存した録画) はここに並べない。ふだんの操作は一覧で
     * 全部できて、あの画面が要るのは**電波が無いとき**だけ — そのときは
     * サービスワーカーが勝手にあそこへ落とす (service-worker.ts)
     */
    const links = [
        { href: '/', label: '予約と録画' },
        { href: '/guide', label: '番組表' },
        { href: '/live', label: 'ライブ' },
        { href: '/rules', label: 'ルール' },
        { href: '/tuners', label: 'チューナー' },
        { href: '/settings', label: '設定' },
    ];

    /** ページ名はナビと同じものを使う。タブに出す */
    const title = $derived(`${links.find((l) => l.href === page.url.pathname)?.label ?? 'denpa'} - denpa`);

    /**
     * 画面ぴったりの高さにして、中の一覧だけをスクロールさせる画面。
     *
     * - **予約と録画** … 2つ並べたときに片方だけ下に置いていかれないため
     * - **ライブ**・**観る** … 映像を見ながら読む・選ぶものなので、**ページごと
     *   動くと絵が画面から出ていく**。右の列だけが動けばよい
     *
     * - **ルール** … 左に書く欄、右に一覧。書きながら効き目を見るものなので、
     *   ページごと動くと書いている欄が画面から出ていく
     * - **番組表** … 表が画面の残りをぜんぶ使う。`max-height: 75vh` で切っていた頃は、
     *   **画面の下に余白があるのに表のほうが先に終わって**いた
     *
     * 他の画面まで同じにすると、スクロールするのが window ではなくなり、
     * 戻ったときに見ていた位置へ帰らなくなる。畳まれる幅ではどの画面も
     * 普通にページごとスクロールさせる。
     *
     * **二段組にする幅は全画面で `md` (768px)。** 画面ごとに違えていた頃は、
     * **同じ幅なのに画面によって形が変わって**いた (縦のiPad 820px で、
     * ライブは1段・観る画面は2段。絵の大きさが 772px と 436px)。ここと、
     * 各画面の 768px の `@media` がその1本の線で、**片方だけ動かさない**
     */
    const FILLED = ['/', '/live', '/rules', '/guide'];
    const fill = $derived(FILLED.includes(page.url.pathname) || page.url.pathname.startsWith('/watch/'));


    /**
     * 狭い画面ではナビを畳む。
     *
     * 項目を横に並べると、スマートフォンの幅ではヘッダーそのものが画面より
     * 広くなり、ページ全体が横スクロールしていた (実測で 390px の端末に対して
     * 420px)。番組表を横に流すのと、ページごと横に動くのが混ざって扱いにくい。
     *
     * `<details>` で作る。開閉に JS が要らないので、読み込み途中でも押せる
     */
    let menu = $state<HTMLDetailsElement | null>(null);
    /** 行き先を選んだら閉じる。開いたままだと次の画面の頭が隠れる */
    $effect(() => {
        // 画面が変わったことをこの参照で拾う
        page.url.pathname;
        if (menu !== null) menu.open = false;
    });
</script>

<svelte:head>
    <title>{title}</title>
</svelte:head>

<!--
    **土台の高さは `html` から `%` で降ろす** (`app.scss` で `html, body` に
    高さを与えてある)。単位で言い当てない — `100vh` も `100dvh` も**実機では
    画面の高さと一致しないことがあった** (PWA で 763.765px 対 708px。差の
    56px は Chrome for Android のアドレスバーの高さそのもの)。

    `%` なら JS も要らず、**描く前から正しい**。**二段組の線 (768px) は横に
    倒した携帯も越える** (915x412 など) ので、768px 以上の `.fill` のほうも同じ採り方
-->
<div
    class="shell"
    class:fill
    data-root
    data-fill={fill ? 'true' : undefined}
    data-hydrated={hydrated ? 'true' : undefined}
>
    <div class="navbar">
        <div class="brand">
            <a class="button ghost logo" href="/">denpa</a>
            <!--
                **新しい版が出ている** (server/update.ts が GitHub のリリースを見比べる)。
                押せばリリースのページ。閉じる口は無い — 上げるか、リリースが消えれば引っ込む
            -->
            {#if data.update !== null}
                <a
                    class="tag info"
                    href={data.update.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="GitHub のリリースを開く"
                    data-testid="update-available"
                >
                    {data.update.version} が出ています
                </a>
            {/if}
        </div>
        <!--
            **横に並べる指定を忘れない。** `<details>` は行を占める箱なので、
            flex にしていないとテーマの切り替えがその上の行に押し出され、
            ヘッダーが2段ぶんの厚さになる。狭い画面ではテーマとハンバーガーが
            横に並ぶ形にしたい
        -->
        <nav class="actions">
            <button type="button"
                class="ghost small"
                onclick={cycleTheme}
                aria-label="テーマを切り替える"
                title={LABEL[mode]}
                data-testid="theme-toggle"
                data-mode={mode}
            >
                <Icon path={ICON[mode]} size="size-5" />
            </button>
            <!--
                広い画面はそのまま並べる。狭い画面では下のハンバーガーに畳む。
                同じリンクを2つ出すことになるが、data-testid は横並びのほうにだけ
                付けて、テストがどちらを指すのか迷わないようにする
            -->
            <ul class="links">
                {#each links as link (link.href)}
                    <li>
                        <a
                            href={link.href}
                            class="button ghost small"
                            aria-current={page.url.pathname === link.href ? 'page' : undefined}
                            data-testid="nav-{link.href === '/' ? 'home' : link.href.slice(1)}"
                        >
                            {link.label}
                        </a>
                    </li>
                {/each}
            </ul>

            <!--
                `<details>` のまま。開閉に JS が要らないので、読み込み途中でも押せる
                (Bits UI のメニューはハイドレーションが済むまで開かない)
            -->
            <details class="burger" bind:this={menu} data-testid="nav-menu">
                <summary aria-label="メニュー">
                    <svg
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        aria-hidden="true"
                    >
                        <path d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                </summary>
                <ul class="burger-list">
                    {#each links as link (link.href)}
                        <li>
                            <a
                                href={link.href}
                                aria-current={page.url.pathname === link.href ? 'page' : undefined}
                            >
                                {link.label}
                            </a>
                        </li>
                    {/each}
                </ul>
            </details>

            <!--
                **名前は出さない。** 誰で入っているかを出しても、できることは
                変わらない (人ごとの権限も個人設定も無い)。出すのは切る道だけ。

                ログインして入っているときだけ。素通し (LAN) では denpa は
                誰か知らないし、切るものも持っていない
            -->
            {#if data.user}
                <!-- 控えを消すので GET では出させない (先読みで勝手に切れる) -->
                <form method="POST" action="/logout">
                    <button type="submit" class="ghost small" data-testid="logout">
                        ログアウト
                    </button>
                </form>
            {/if}
        </nav>

        <!--
            画面遷移とフォーム送信の待ち時間を出す。番組表やEPG取得は数秒かかることがあり、
            無反応に見えると二度押しされる。ヘッダーの下端に重ねて、隙間ができないようにする
        -->
        <div
            class="loading-bar"
            data-testid="loading-bar"
            data-loading={navigating.to || busy.active ? 'true' : undefined}
        >
            {#if navigating.to || busy.active}
                <progress></progress>
            {/if}
        </div>
    </div>

    <main>
        {@render children()}
    </main>
</div>

{#if measure.on}
    <Measure />
{/if}

<style>
    /* 土台。高さは html から % で降ろす(上のコメント) */
    .shell {
        display: flex;
        flex-direction: column;
        min-height: 100%;
        background: var(--dp-base-200);
    }
    .navbar {
        position: sticky;
        top: 0;
        z-index: 40;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-height: 3.5rem;
        padding: 0.5rem;
        background: var(--dp-surface);
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
    }
    .brand {
        display: flex;
        flex: 1 1 0%;
        align-items: center;
        gap: 0.5rem;
    }
    .logo {
        font-size: 1.25rem;
        font-weight: 700;
    }
    .actions {
        display: flex;
        flex: none;
        align-items: center;
        gap: 0.25rem;
    }
    .actions form {
        margin: 0;
    }
    ul.links,
    ul.burger-list {
        margin: 0;
        padding: 0;
        list-style: none;
    }
    ul.links li,
    ul.burger-list li {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    ul.links {
        display: none;
        gap: 0.125rem;
        padding: 0 0.25rem;
    }
    /* ヘッダーの押すものは高さ 40px。小さい字のままでも指で外さない */
    .actions :global(button),
    .actions :global(a.button) {
        min-height: 2.5rem;
    }
    ul.links a[aria-current='page'] {
        --pico-background-color: var(--dp-base-300);
    }
    .burger {
        position: relative;
        margin: 0;
    }
    .burger summary {
        display: inline-flex;
        align-items: center;
        min-height: 2.5rem;
        padding: 0.3rem 0.65rem;
        border-radius: var(--pico-border-radius);
        list-style: none;
        cursor: pointer;
        color: inherit;
    }
    .burger summary:hover,
    .burger[open] summary {
        background: var(--dp-base-200);
    }
    .burger summary::-webkit-details-marker {
        display: none;
    }
    .burger summary::after {
        display: none;
    }
    .burger-list {
        position: absolute;
        right: 0;
        z-index: 50;
        margin-top: 0.5rem;
        width: 12rem;
        padding: 0.25rem;
        border-radius: 0.75rem;
        background: var(--dp-surface);
        border: 1px solid var(--dp-base-300);
        box-shadow: 0 10px 30px rgb(0 0 0 / 0.35);
    }
    .burger-list a {
        display: block;
        padding: 0.45rem 0.75rem;
        border-radius: 0.5rem;
        color: inherit;
        text-decoration: none;
    }
    .burger-list a:hover {
        background: var(--dp-base-200);
    }
    ul.burger-list a[aria-current='page'] {
        background: var(--dp-base-300);
    }
    .loading-bar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: -0.25rem;
        height: 0.25rem;
        line-height: 0;
    }
    .loading-bar progress {
        display: block;
        width: 100%;
        height: 0.25rem;
        margin: 0;
        border-radius: 0;
    }
    main {
        padding: 1rem;
    }
    @media (min-width: 768px) {
        main {
            padding: 1.5rem;
        }
    }
    @media (min-width: 640px) {
        ul.links {
            display: flex;
        }
        .burger {
            display: none;
        }
    }
    @media (min-width: 768px) {
        .shell.fill {
            height: 100%;
            min-height: 0;
            overflow: hidden;
        }
        .shell.fill main {
            min-height: 0;
            flex: 1 1 0%;
        }
    }
</style>
