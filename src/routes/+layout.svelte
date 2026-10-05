<script lang="ts">
    import { resolve } from '$app/paths';
    import '../app.css';
    import { onMount } from 'svelte';
    import Measure from '#lib/components/Measure.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import { write } from '#lib/keep.js';
    import { measure } from '#lib/measure.svelte.js';
    import { startOffline } from '#lib/offline.svelte.js';
    import { followNavigation, reload } from '#lib/reload.svelte.js';
    import { navigating, page } from '$app/state';
    import Contrast from '~icons/lucide/contrast';
    import MenuIcon from '~icons/lucide/menu';
    import Moon from '~icons/lucide/moon';
    import Sun from '~icons/lucide/sun';

    let { children, data } = $props();

    // オフライン視聴の控えを読み、オンラインに戻ったら outbox を流す (docs/offline.md)
    onMount(() => startOffline());

    /*
     * 画面遷移の終わりを自前で見る。**`navigating` は畳まれた遷移で真のまま残る**
     * ので、あれを当てにすると「遷移が終わったら流す」が永久に来ない (理由は
     * [reload.svelte.ts](../lib/reload.svelte.ts))。土台は画面遷移で作り直されない
     * ので、ここで1度追い始めれば全部の遷移を見ていられる
     */
    followNavigation();

    /**
     * **遷移が長引いているときだけ、上端に細いバーを出す。**
     *
     * リンクを押してから次の画面のデータが届くまで、画面は何も変わらない。
     * 番組表やルールのように読むものが多い画面では、それが「止まった」に見えて
     * いた (押した指の先に返事が無い)。
     *
     * 150ms 待ってから出す — 速い遷移でまで出すと、押すたびに光ってちらつく。
     * 消すのは `navigating.complete` の解決/拒否で。`navigating` の下りを待つと、
     * 畳まれた遷移 (読み直しに追い越されたもの) で**永久に出たまま**になる
     * ([reload.svelte.ts](../lib/reload.svelte.ts) と同じ落とし穴)
     */
    let slow = $state(false);
    $effect(() => {
        const done = navigating.complete;
        if (done === null) {
            slow = false;
            return;
        }
        const timer = setTimeout(() => {
            slow = true;
        }, 150);
        let stale = false;
        const settle = (): void => {
            clearTimeout(timer);
            // 次の遷移がもう始まっているなら、消すのはあちらに任せる
            if (stale) return;
            slow = false;
        };
        void done.then(settle, settle);
        return () => {
            stale = true;
            clearTimeout(timer);
        };
    });

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
    /** 月・太陽・半分塗った丸 (Lucide)。絵文字は端末ごとに絵が違い、太さも揃わなかった */
    const ICON = { dark: Moon, light: Sun, system: Contrast };

    function apply() {
        const dark =
            mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
        document.documentElement.dataset['themeMode'] = mode;
    }

    onMount(() => {
        hydrated = true;
        mode = (document.documentElement.dataset['themeMode'] as 'system' | 'light' | 'dark') ?? 'dark';

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
            reload();
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
     * サービスワーカーが勝手にあそこへ落とす (service-worker/index.ts)
     */
    const links = [
        { href: '/', label: '予約と録画' },
        { href: '/guide', label: '番組表' },
        { href: '/live', label: 'ライブ' },
        { href: '/rules', label: 'ルール' },
        { href: '/tuners', label: 'チューナー' },
        { href: '/settings', label: '設定' },
    ] as const;

    /** ページ名はナビと同じものを使う。タブに出す */
    const title = $derived(`${links.find((l) => l.href === page.route.id)?.label ?? 'denpa'} - denpa`);

    /**
     * 画面ぴったりの高さにして、中の一覧だけをスクロールさせる画面。
     *
     * - **予約と録画** … 2つ並べたときに片方だけ下に置いていかれないため
     * - **ライブ**・**観る** … 映像を見ながら読む・選ぶものなので、**ページごと
     *   動くと絵が画面から出ていく**。右の列だけが動けばよい
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
    // 比べるのは経路 (route.id)。URL は前段の接頭辞の下だと頭が付く (server/paths.ts)
    const fill = $derived(FILLED.includes(page.route.id ?? '') || page.route.id === '/watch/[id]');

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
    **土台の高さは `html` から `%` で降ろす** (`app.css` で `html, body` に
    高さを与えてある)。単位で言い当てない — `100vh` も `100dvh` も**実機では
    画面の高さと一致しないことがあった** (PWA で 763.765px 対 708px。差の
    56px は Chrome for Android のアドレスバーの高さそのもの)。

    `%` なら JS も要らず、**描く前から正しい**。**二段組の線 (768px) は横に
    倒した携帯も越える** (915x412 など) ので、768px 以上の `.fill` のほうも同じ採り方
-->
<div class="shell" class:fill={fill} data-root data-hydrated={hydrated ? 'true' : undefined}>
    <!--
        遷移の進み具合 (上の `slow`)。長さの分からない読み込みなので、
        光が左から右へ走るだけの不確定のバー。ヘッダーの上端に貼る
    -->
    {#if slow}
        <div
            class="nav-progress"
            role="progressbar"
            aria-label="次の画面を読み込んでいます"
            data-testid="nav-progress"
        ></div>
    {/if}
    <div class="navbar">
        <div class="brand">
            <a class="button ghost logo" href={resolve('')}>denpa</a>
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
                    {data.update.version} が公開されています
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
                <Icon icon={ICON[mode]} size="size-5" />
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
                            href={resolve(link.href)}
                            class="button ghost small"
                            aria-current={page.route.id === link.href ? 'page' : undefined}
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
                    <Icon icon={MenuIcon} size="size-5" />
                </summary>
                <ul class="burger-list">
                    {#each links as link (link.href)}
                        <li>
                            <a
                                href={resolve(link.href)}
                                aria-current={page.route.id === link.href ? 'page' : undefined}
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
                <!-- ボタンはフォームの POST で押す。リンク (GET) だと先読みで勝手に切れる -->
                <form method="POST" action={resolve('logout')}>
                    <button type="submit" class="ghost small" data-testid="logout">
                        ログアウト
                    </button>
                </form>
            {/if}
        </nav>

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
    /*
     * 遷移中のバー。**ヘッダーより上に重ねる** (z-index)。色は主の色で、
     * 光の帯を左から右へ流す。動かせない設定の端末では帯を止めて色だけ出す
     */
    .nav-progress {
        position: fixed;
        inset: 0 0 auto 0;
        z-index: 60;
        height: 3px;
        background:
            linear-gradient(
                    90deg,
                    transparent 0%,
                    var(--pico-primary-background) 40%,
                    var(--pico-primary-background) 60%,
                    transparent 100%
                )
                0 0 / 40% 100% no-repeat,
            color-mix(in srgb, var(--pico-primary-background) 30%, transparent);
        animation: nav-progress 1.1s ease-in-out infinite;
    }
    @keyframes nav-progress {
        from {
            background-position: -40% 0;
        }
        to {
            background-position: 140% 0;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .nav-progress {
            animation: none;
            background: var(--pico-primary-background);
        }
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
    /* 並べ方の余白は Pico の `nav ul` / `nav li` が消す (app.css で間を 0 にしてある)。印だけ `ul li` に残る */
    ul.links li,
    ul.burger-list li {
        list-style: none;
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
    /*
     * **いまの画面は主の色の字と下線で示す。** 薄い灰色の地を敷くだけだった頃は、
     * ヘッダーの地とほとんど見分けが付かず「どの画面に居るのか」が読めなかった。
     * 地は塗らない (指を乗せたときの灰色と混ざらないように)。下線は押す場所の
     * 内側に引くので、ヘッダーの高さは変わらない。
     * `.button.ghost` まで書くのは、`app.css` の ghost の `[aria-current]` (灰色の地と
     * 継いだ字の色) より強くするため。短く書くとあちらが勝って色が付かない
     */
    ul.links a.button {
        position: relative;
        font-size: 0.9rem;
    }
    ul.links a.button.ghost[aria-current='page'] {
        --pico-background-color: transparent;
        --pico-color: var(--pico-primary);
        font-weight: 600;
    }
    ul.links a.button.ghost[aria-current='page']:hover {
        --pico-background-color: var(--dp-base-200);
    }
    ul.links a.button.ghost[aria-current='page']::after {
        content: '';
        position: absolute;
        inset-inline: 0.65rem;
        bottom: 0.2rem;
        height: 2px;
        border-radius: 1px;
        background: currentColor;
    }
    .burger {
        position: relative;
    }
    .burger summary {
        display: inline-flex;
        align-items: center;
        min-height: 2.5rem;
        /*
         * **開いても余白を足さない。** Pico は `details[open] > summary` に下の余白
         * (1rem) を付ける — 文章の中の折りたたみでは中身と離すために要るが、ヘッダーの
         * ハンバーガーでは**開いた瞬間にヘッダーが 64px から 72px に伸び**、
         * 隣のテーマ切り替えまで下にずれていた (実機の携帯)
         */
        margin-bottom: 0;
        padding: 0.3rem 0.65rem;
        border-radius: var(--pico-border-radius);
        cursor: pointer;
        color: inherit;
    }
    .burger summary:hover,
    .burger[open] summary {
        background: var(--dp-base-200);
    }
    .burger summary::after {
        display: none;
    }
    /*
     * **縦に積む。** Pico は `nav ul` を横並び (flex) にするので、何も言わないと
     * 畳んだメニューの中まで横に並び、12rem の箱から「ライブ」より先がはみ出していた
     */
    .burger-list {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        position: absolute;
        right: 0;
        z-index: 50;
        width: 12rem;
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
    /* 畳んだメニューでも同じ色。縦に並ぶので下線ではなく左端に印を立てる */
    ul.burger-list a[aria-current='page'] {
        background: color-mix(in srgb, var(--pico-primary) 12%, transparent);
        box-shadow: inset 3px 0 0 var(--pico-primary);
        color: var(--pico-primary);
        font-weight: 600;
    }
    /*
     * **余白の幅は `--dp-gutter` で配る。** スマホの縦で映像だけ端まで広げる
     * (`PlayerStage`) のに、同じ幅だけ外へはみ出させるため。数字を2か所に
     * 書くと、片方だけ変えたときに映像が横にずれる
     */
    main {
        --dp-gutter: 1rem;
        padding: var(--dp-gutter);
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
        main {
            --dp-gutter: 1.5rem;
        }
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
