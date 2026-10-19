<script lang="ts">
    import { resolve } from '$app/paths';
    import '../app.css';
    import { onMount } from 'svelte';
    import type { ChannelNotice as NoticeKind } from '#lib/channel-notice.js';
    import ChannelNotice from '#lib/components/ChannelNotice.svelte';
    import Measure from '#lib/components/Measure.svelte';
    import Menu from '#lib/components/Menu.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import SearchField from '#lib/components/SearchField.svelte';
    import { denpaFontUrl } from '#lib/font.js';
    import { measure } from '#lib/measure.svelte.js';
    import { canTransition } from '#lib/motion.svelte.js';
    import { startOffline } from '#lib/offline.svelte.js';
    import { followNavigation, reload } from '#lib/reload.svelte.js';
    import { groupLabel } from '#lib/settings-sections.js';
    import { THEME_LABEL, theme } from '#lib/theme.svelte.js';
    import { goto, onNavigate } from '$app/navigation';
    import { navigating, page } from '$app/state';
    import CalendarDays from '~icons/lucide/calendar-days';
    import Contrast from '~icons/lucide/contrast';
    import Ellipsis from '~icons/lucide/ellipsis';
    import ListVideo from '~icons/lucide/list-video';
    import Moon from '~icons/lucide/moon';
    import Search from '~icons/lucide/search';
    import Sun from '~icons/lucide/sun';
    import Tv from '~icons/lucide/tv';

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
     * **ページを移るときは、選んでいる印を前の場所から滑らせる** (View Transitions。中身はすぐ替わる。見た目は `app.css` の
     * 「画面の切り替え」)。ヘッダーと下のタブは名前を付けて抜き出してあるので動かない。
     *
     * `onNavigate` は次の画面のデータが揃ってから呼ばれるので、写しを取って待たせるのは
     * 中身を描き替える一瞬だけ (読み込みの間は今の画面のまま、上の細いバーも出る)。
     *
     * 動かさないもの:
     * - **使えないブラウザと、動かさない設定の端末** (`canTransition`)。今までどおりすぐ替わる
     * - **同じ URL** (読み直し・全画面の段を積む・戻す)。替わるものが無い
     * - **映像の画面の中での移動** (ライブ・観る・追っかけ)。切り替えの間は画面が写しになるので、
     *   映っているものを止めて見せることになる
     */
    const PLAYING = new Set(['/live', '/watch/[id]', '/chase/[id]']);
    onNavigate((navigation) => {
        if (!canTransition() || navigation.to === null || navigation.from === null) return;
        const { from, to } = navigation;
        if (from.url.pathname === to.url.pathname && from.url.search === to.url.search) return;
        if (from.route.id === to.route.id && PLAYING.has(from.route.id ?? '')) return;
        return new Promise<void>((resolve) => {
            const transition = document.startViewTransition(async () => {
                resolve();
                await navigation.complete.catch(() => {});
            });
            transition.ready.catch(() => {});
            transition.finished.catch(() => {});
        });
    });

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
     * **その端末の高さを読む表示。**
     *
     * 縦のはみ出しは端末でしか起きないことがある — 自動運転のブラウザには
     * 引っ込むアドレスバーが作れない。実機の PWA で「リロードすると画面全体が
     * スクロールできる」として出たとき、**数を見る手が1つも無かった**。
     *
     * 入り口は2つ。`?measure` (1回だけ見る) と、設定画面のオン/オフ
     * (覚える) — **PWA にはアドレスバーが無い**ので、URL だけでは入れない
     */
    $effect(() => {
        measure.start(page.url);
    });

    // ハイドレーション完了の目印。SSR直後のDOMに入力しても、ハイドレーションで
    // 値が書き戻されて消える。E2Eはこの印が付くのを待ってから操作する
    let hydrated = $state(false);

    /**
     * テーマは `theme.svelte.ts` が持つ (設定の「その他」からも選べるので、ここだけの値にしない)。
     * 月・太陽・半分塗った丸 (Lucide)。絵文字は端末ごとに見た目が違い、太さも揃わなかった
     */
    const ICON = { dark: Moon, light: Sun, system: Contrast };

    onMount(() => {
        hydrated = true;
        return theme.start();
    });

    /**
     * **戻ってきたら読み直す。**
     *
     * ホーム画面から開いたアプリ (PWA) は、閉じても捨てられない。端末は画面を
     * 凍らせて残しておき、次に開いたときそのまま見せる — **前に閉じたときの
     * 一覧がそのまま出る**。録画は増えているし、録画中だったものは終わっている。
     *
     * 通知 (`liveUpdates`) を使っている画面でも足りない。あちらの繋ぎは
     * 凍っている間に切られて戻ってこないうえ、繋ぎ直しても**凍っていた間に
     * 起きたこと**は流れてこない (通知は溜めていない)。開き直した時点で
     * 1回読み直すのが確実で、番組表やルールのように通知を使っていない
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
        { href: '/', label: '録画' },
        { href: '/guide', label: '番組表' },
        { href: '/live', label: 'ライブ' },
        { href: '/rules', label: 'ルール' },
        { href: '/settings', label: '設定' },
    ] as const;

    /** 検索 (`/search`)。ヘッダーでは欄にして、狭い画面では下のタブに置く (上の `links` には並べない) */
    const SEARCH = { href: '/search', label: '検索' } as const;
    const pages = [...links, SEARCH];

    /**
     * いま開いている画面のナビの行き先。**設定はグループごとに経路が分かれている** (`/settings/reception` など) ので、
     * その下も「設定」に数える。録画 (`/`) は頭が全部に合うので、ぴったりのときだけ
     */
    const here = $derived.by(() => {
        const route = page.route.id ?? '';
        return pages.find((l) => route === l.href || (l.href !== '/' && route.startsWith(`${l.href}/`)))?.href ?? null;
    });

    /**
     * ページ名はナビと同じものを使う。タブに出す。設定はグループの名前を前に付ける。
     * 検索は言葉を前に付ける (履歴に並んだときに、どの検索だったか分かる)
     */
    const title = $derived.by(() => {
        const label = pages.find((l) => l.href === here)?.label ?? 'denpa';
        const q = here === '/search' ? (page.url.searchParams.get('q') ?? '').trim() : '';
        const section =
            here === '/settings' ? groupLabel(page.route.id?.split('/')[2] ?? '') : q === '' ? null : q;
        return `${section === null ? '' : `${section} - `}${label} - denpa`;
    });

    /**
     * 画面ぴったりの高さにして、中の一覧だけをスクロールさせる画面。
     *
     * - **予約と録画** … 2つ並べたときに片方だけ下に置いていかれないため
     * - **ライブ**・**観る**・**追っかけ** … 映像を見ながら読む・選ぶものなので、**ページごと
     *   動くと映像が画面から出ていく**。右の列だけが動けばよい。追っかけを入れ忘れていた頃は、
     *   右の列の地が画面の途中 (中身の高さ) で切れていた
     * - **番組表** … 表が画面の残りをぜんぶ使う。`max-height: 75vh` で切っていた頃は、
     *   **画面の下に余白があるのに表のほうが先に終わって**いた
     * - **設定** … 左に節の一覧、右に中身。一覧は動かさず、中身だけを巻き取る
     *
     * 他の画面まで同じにすると、スクロールするのが window ではなくなり、
     * 戻ったときに見ていた位置へ帰らなくなる。畳まれる幅ではどの画面も
     * 普通にページごとスクロールさせる。
     *
     * **二段組にする幅は全画面で `md` (768px)。** 画面ごとに違えていた頃は、
     * **同じ幅なのに画面によって形が変わって**いた (縦のiPad 820px で、
     * ライブは1段・観る画面は2段。映像の大きさが 772px と 436px)。ここと、
     * 各画面の 768px の `@media` がその1本の線で、**片方だけ動かさない**
     */
    const FILLED = ['/', '/live', '/watch/[id]', '/chase/[id]', '/guide'];
    // 比べるのは経路 (route.id)。URL は前段の接頭辞の下だと頭が付く (server/paths.ts)
    const fill = $derived(
        FILLED.includes(page.route.id ?? '') || here === '/settings',
    );

    /**
     * **狭い画面では、ナビを画面の下のタブにする** (下の `.tabbar`)。
     *
     * 項目を横に並べると、スマートフォンの幅ではヘッダーそのものが画面より
     * 広くなり、ページ全体が横スクロールしていた (実測で 390px の端末に対して
     * 420px)。上のハンバーガーに畳んでいた頃は、画面を移るたびに2回押していた。
     * よく開く 3 画面と検索をタブに、残り (ルール・設定) は「その他」の `Menu` (popover) に。
     * 狭い画面ではヘッダー (検索の欄) を隠すので、検索はタブから入る
     */
    const tabs = [
        { href: '/', label: '録画', icon: ListVideo },
        { href: '/guide', label: '番組表', icon: CalendarDays },
        { href: '/live', label: 'ライブ', icon: Tv },
        { href: SEARCH.href, label: SEARCH.label, icon: Search },
    ] as const;
    const moreLinks = links.filter((link) => !tabs.some((tab) => tab.href === link.href));
    const moreCurrent = $derived(moreLinks.some((link) => link.href === here));
    /** 検索の欄に入れておく言葉。結果の画面 (`/search?q=`) ではその言葉のまま直して送れる */
    const query = $derived(here === '/search' ? (page.url.searchParams.get('q') ?? '').trim() : '');
    /** タブを出すのはナビの 5 画面と検索 (設定はその下の節も) だけ (観る画面・追っかけ・ログイン・ペアリングには出さない) */
    const showTabbar = $derived(here !== null);
    /** 局が無いときの案内。録画・番組表・ライブの load が渡す (`#lib/channel-notice.ts`) */
    const notice = $derived((page.data['channelNotice'] ?? null) as NoticeKind | null);
    let menuOpen = $state(false);
    /** 行き先を選んだら閉じる。開いたままだと次の画面の頭が隠れる */
    $effect(() => {
        // 画面が変わったことをこの参照で知る
        page.url.pathname;
        menuOpen = false;
    });

    /**
     * **どこからでも `/` か Ctrl/⌘+K で検索の欄へ。** 字を打っている最中 (入力欄・テキストエリア・
     * 選ぶ欄・編集できる所) では取らない — `/` を打てなくなる。見えている欄 (ヘッダーか検索の画面) に入り、
     * どちらも無ければ (狭い画面でヘッダーを隠しているとき) 検索の画面を開く (開くと欄に入る)
     */
    function searchShortcut(event: KeyboardEvent): void {
        if (event.defaultPrevented || event.isComposing) return;
        const slash = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey;
        const k = event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
        if (!slash && !k) return;
        const target = event.target;
        if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null)) {
            return;
        }
        event.preventDefault();
        const field = [...document.querySelectorAll<HTMLInputElement>('[data-search-field]')].find(
            (input) => input.getClientRects().length > 0,
        );
        if (field === undefined) {
            void goto(resolve('search'));
            return;
        }
        field.focus();
        field.select();
    }

    /**
     * **放送の字 (Denpa Font) をここで名乗らせる** (使うのは `app.css` の `.broadcast`)。
     * 版付きの URL は組むときに決まるので、`app.css` には書けない (`#lib/font.ts`)。
     * 使う字が画面に出たときだけ落ちてくる。届くまでは画面の字で出しておく (`swap`)
     */
    const fontFace = `<style>@font-face{font-family:"Denpa Font";src:url("${denpaFontUrl()}") format("woff2");font-display:swap}</style>`;
</script>

<svelte:window onkeydown={searchShortcut} />

<svelte:head>
    <title>{title}</title>
    {@html fontFace}
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
            <!--
                アンテナの印 (favicon と同じ形) と名前。印は飾りなので読み上げない (名前で足りる)
            -->
            <a class="button ghost logo" href={resolve('')}>
                <svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
                    <rect width="32" height="32" rx="6" fill="#1d232a" />
                    <g fill="none" stroke="#7dd3fc" stroke-width="2" stroke-linecap="round">
                        <path d="M11 9a8 8 0 0 0 0 10" />
                        <path d="M21 9a8 8 0 0 1 0 10" />
                        <path d="M7.5 5.5a13 13 0 0 0 0 17" />
                        <path d="M24.5 5.5a13 13 0 0 1 0 17" />
                    </g>
                    <circle cx="16" cy="14" r="2.5" fill="#7dd3fc" />
                    <path d="M16 16.5 13 27h6z" fill="#7dd3fc" />
                </svg>
                <!--
                    名前は字ではなく形で描く。BIZ UDPゴシックの欧文は下に伸びる部分がごく短く、
                    「denpa」の p が下で切れて見えた (行の高さを広げても字の形は変わらない)。
                    同じ字 (Bold) の輪郭から作り、p の下だけを伸ばしてある。読み上げには字で渡す
                -->
                <svg class="logo-word" viewBox="95 0 7016 2134" aria-hidden="true"><path d="M1045 692L1045 0L1313 0L1313 1757L1063 1757L1063 1591Q1018 1656 955 1699Q823 1788 650 1788Q376 1788 219 1576Q95 1407 95 1152Q95 941 182 785Q265 635 410 564Q519 510 643 510Q908 510 1045 692ZM1045 1329L1045 924Q899 717 712 717Q539 717 445 872Q375 987 375 1156Q375 1305 429 1408Q518 1579 710 1579Q844 1579 946 1479Q1005 1422 1045 1329ZM2773 1129L2773 1199L1872 1199Q1879 1358 1972 1457Q2084 1574 2257 1574Q2461 1574 2618 1383L2778 1545Q2581 1793 2232 1793Q1946 1793 1771 1610Q1604 1434 1604 1156Q1604 930 1713 763Q1810 615 1972 548Q2083 502 2209 502Q2410 502 2552 614Q2699 728 2750 933Q2773 1026 2773 1129ZM1889 1004L2505 1004Q2497 901 2451 832Q2364 705 2201 705Q2055 705 1961 823Q1903 896 1889 1004ZM3092 543L3350 543L3350 752Q3518 520 3770 520Q3947 520 4064 622Q4196 737 4196 998L4196 1751L3926 1751L3926 1032Q3926 890 3873 814Q3822 741 3701 741Q3577 741 3476 845Q3402 921 3362 1041L3362 1751L3092 1751L3092 543ZM4565 543L4813 543L4813 707Q4979 510 5230 510Q5482 510 5636 678Q5783 837 5783 1106Q5783 1333 5678 1486Q5527 1706 5234 1706Q4968 1706 4833 1524L4833 2134L4565 2134L4565 543ZM4833 957L4833 1292Q4977 1499 5169 1499Q5322 1499 5411 1398Q5503 1294 5503 1103Q5503 930 5426 831Q5338 719 5169 719Q5048 719 4952 795Q4877 854 4833 957ZM6670 973L6777 973L6777 954Q6777 707 6542 707Q6322 707 6146 840L6044 655Q6275 504 6551 504Q6817 504 6948 657Q7039 762 7039 967L7039 1389Q7039 1623 7111 1751L6867 1751Q6824 1668 6810 1561L6803 1561Q6752 1661 6639 1730Q6547 1786 6396 1786Q6217 1786 6100 1681Q5978 1571 5978 1401Q5978 973 6670 973ZM6777 1249L6777 1161L6697 1161Q6463 1161 6346 1221Q6246 1272 6246 1397Q6246 1481 6306 1530Q6363 1577 6454 1577Q6575 1577 6671 1491Q6777 1397 6777 1249Z" /></svg>
                <span class="visually-hidden">denpa</span>
            </a>
            <!--
                **新しい版が出ている** (server/update.ts が GitHub のリリースを見比べる)。
                押せばリリースのページ。閉じるボタンは無い — 上げるか、リリースが消えれば引っ込む
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
            **検索の欄はヘッダーの真ん中** (広い幅だけ。狭い幅ではヘッダーごと隠し、検索の画面の上の帯に同じ欄を置く)。
            結果の画面でも同じ欄で、探した言葉が入ったまま直して送れる
        -->
        <div class="header-search">
            <SearchField value={query} testid="header-search" live={here === '/search'} />
        </div>
        <!--
            テーマの切り替え・画面へのリンク (広い幅だけ)。ログアウトは設定の「その他」にある。
            狭い幅ではリンクを隠し、画面の下のタブ (`.tabbar`) に任せる
        -->
        <nav class="actions">
            <button type="button"
                class="ghost small icon"
                onclick={theme.cycle}
                aria-label="テーマを切り替える"
                title={THEME_LABEL[theme.mode]}
                data-testid="theme-toggle"
                data-mode={theme.mode}
            >
                <Icon icon={ICON[theme.mode]} size="size-5" />
            </button>
            <!--
                広い画面はそのまま並べる。狭い画面では画面の下のタブに替わる。
                同じリンクを2か所に出すことになるが、data-testid は別にして (`nav-*` と `tab-*`)、
                テストがどちらを指すのか迷わないようにする
            -->
            <ul class="links">
                {#each links as link (link.href)}
                    <li>
                        <a
                            href={resolve(link.href)}
                            class="button ghost small"
                            aria-current={here === link.href ? 'page' : undefined}
                            data-testid="nav-{link.href === '/' ? 'home' : link.href.slice(1)}"
                        >
                            {link.label}
                            {#if here === link.href}<span class="nav-underline" aria-hidden="true"></span>{/if}
                        </a>
                    </li>
                {/each}
            </ul>
        </nav>

    </div>

    <!--
        **局が無いときの案内** (録画・番組表・ライブ。`#lib/channel-notice.ts`)。閉じるボタンは無く、
        スキャンして局が入れば消える。中身の外 (ヘッダーの下) に置くので、各画面の高さの取り方は変わらない
    -->
    <!--
        **狭い幅の検索の画面だけ、上に検索の欄の帯を出す** (ヘッダーを隠しているので)。ヘッダーと同じ欄
    -->
    {#if here === '/search'}
        <div class="search-bar">
            <SearchField value={query} testid="search" live />
        </div>
    {/if}

    {#if notice}
        <div class="notice-slot">
            <ChannelNotice kind={notice} />
        </div>
    {/if}

    <main>
        {@render children()}
    </main>

    <!--
        **狭い幅では、主な画面へのタブを画面の下に並べる** (録画・番組表・ライブ・検索)。
        指が届くのは画面の下のほうで、上のハンバーガーから開いていた頃は、画面を移るたびに
        2回押していた。ルールと設定はたまにしか開かないので「その他」の中。
        出すのはナビの 5 画面だけ — 観る画面・追っかけ (映像が主役)、ログインやペアリングには出さない。
        ライブの全画面 (`html[data-stage-fullscreen]`) のときも隠す (`app.css`)。
        下の安全域 (ホームバー) のぶんは内側の余白で避ける
    -->
    {#if showTabbar}
        <nav class="tabbar" aria-label="主な画面" data-testid="tabbar">
            {#each tabs as tab (tab.href)}
                <a
                    href={resolve(tab.href)}
                    class="tab"
                    aria-current={here === tab.href ? 'page' : undefined}
                    data-testid="tab-{tab.href === '/' ? 'home' : tab.href.slice(1)}"
                >
                    {#if here === tab.href}<span class="tab-indicator" aria-hidden="true"></span>{/if}
                    <Icon icon={tab.icon} size="size-5" />
                    <span>{tab.label}</span>
                </a>
            {/each}
            <!-- 「その他」。ほかのメニューと同じ `Menu` (popover)。リンクを並べるだけなので `nav` -->
            <div class="tab-more" data-testid="nav-menu">
                <Menu bind:open={menuOpen} side="top" align="end" nav class="tab-more-menu">
                    {#snippet trigger(props)}
                        <button
                            {...props}
                            type="button"
                            class="tab"
                            aria-current={moreCurrent ? 'page' : undefined}
                        >
                            {#if moreCurrent}<span class="tab-indicator" aria-hidden="true"></span>{/if}
                            <Icon icon={Ellipsis} size="size-5" />
                            <span>その他</span>
                        </button>
                    {/snippet}
                    <ul class="more-list">
                        {#each moreLinks as link (link.href)}
                            <li>
                                <a
                                    href={resolve(link.href)}
                                    class="menu-item"
                                    aria-current={here === link.href ? 'page' : undefined}
                                >
                                    {link.label}
                                </a>
                            </li>
                        {/each}
                    </ul>
                    <!--
                        狭い幅ではヘッダーを隠すので、ヘッダーにあったもの (新しい版・テーマ) をここに置く
                    -->
                    <ul class="more-list more-extra">
                        {#if data.update !== null}
                            <li>
                                <a
                                    class="menu-item"
                                    href={data.update.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    {data.update.version} が公開されています
                                </a>
                            </li>
                        {/if}
                        <li>
                            <button type="button" class="menu-item" onclick={theme.cycle}>
                                <Icon icon={ICON[theme.mode]} size="size-5" />
                                テーマ: {THEME_LABEL[theme.mode]}
                            </button>
                        </li>
                    </ul>
                </Menu>
            </div>
        </nav>
    {/if}
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
        background: var(--dp-bg);
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
        animation: nav-progress var(--dp-shine) ease-in-out infinite;
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
        padding: 0.5rem var(--dp-space-3);
        background: var(--dp-bg);
        /* 画面の切り替えでは抜き出して動かさない (`app.css` の「画面の切り替え」) */
        view-transition-name: site-header;
    }
    /*
     * **本文との間に線を引かない** (巻いても出さない)。高さはちょうど 3.5rem。
     * 下を流れる中身とは、次のぼかし (透けてぼける地) で分かれる。サイドバーとの間も線は引かず、
     * 地の色か余白で分ける (`app.css` の「地は 1 色」)
     */
    /*
     * **ヘッダーは本文と同じ地に置く。** スクロールすると下を流れる中身が
     * ぼけて透ける (地を 80% にしてぼかす)。ぼかせないブラウザは上の地の色のまま
     */
    @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .navbar {
            background: color-mix(in srgb, var(--dp-bg) 80%, transparent);
            -webkit-backdrop-filter: saturate(1.8) blur(12px);
            backdrop-filter: saturate(1.8) blur(12px);
        }
    }
    .brand {
        display: flex;
        flex: 1 1 0%;
        align-items: center;
        gap: 0.5rem;
    }
    /* 印と名前。名前は 1.25rem の字と同じ大きさで描く (d の頂から p の下まで) */
    .logo {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding-block: 0.25rem;
    }
    .logo-mark {
        width: 1.5rem;
        height: 1.5rem;
        flex-shrink: 0;
    }
    .logo-word {
        height: 1.3rem;
        flex-shrink: 0;
        fill: currentColor;
    }
    .actions {
        display: flex;
        flex: none;
        align-items: center;
        gap: 0.25rem;
    }
    /* 印と余白を消す。Pico のナビの部品は読まないので、文章の決まり (`ul li` の印・下の余白) がそのまま当たる */
    ul.links li,
    ul.more-list li {
        margin: 0;
        list-style: none;
    }
    ul.links {
        display: none;
        align-items: center;
        gap: 0.125rem;
        padding: 0 0.25rem;
    }
    /* ヘッダーの押すものは高さ 40px。小さい字のままでも指で外さない */
    .actions :global(button),
    .actions :global(a.button) {
        min-height: 2.5rem;
    }
    /*
     * **いまの画面は太い字と主の色の下線で示す。** ほかの画面へのリンクは薄い字 (`--dp-muted`) で、
     * 指を乗せると本文の字になる。薄い灰色の地を敷くだけだった頃は、
     * ヘッダーの地とほとんど見分けが付かず「どの画面にいるのか」が読めなかった。
     * 地は塗らない (指を乗せたときの灰色と混ざらないように)。下線は押す場所の
     * 内側に引くので、ヘッダーの高さは変わらない。
     * `.button.ghost` まで書くのは、`app.css` の ghost の `[aria-current]` (灰色の地と
     * 継いだ字の色) より強くするため。短く書くとあちらが勝って色が付かない
     */
    ul.links a.button {
        position: relative;
        font-size: var(--dp-text-sm);
    }
    ul.links a.button.ghost:not([aria-current='page']) {
        --pico-color: var(--dp-muted);
    }
    ul.links a.button.ghost:not([aria-current='page']):hover {
        --pico-color: inherit;
    }
    ul.links a.button.ghost[aria-current='page'] {
        --pico-background-color: transparent;
        --pico-color: var(--pico-h1-color, var(--pico-color));
        font-weight: var(--dp-weight-bold);
    }
    ul.links a.button.ghost[aria-current='page']:hover {
        --pico-background-color: var(--dp-subtle);
    }
    /* 下線は別の要素にして、画面を移ると前の画面の下線から横に滑らせる (`app.css` の「画面の切り替え」) */
    .nav-underline {
        position: absolute;
        inset-inline: 0.65rem;
        bottom: 0.2rem;
        height: 2px;
        border-radius: 1px;
        background: var(--pico-primary);
        view-transition-name: nav-underline;
        pointer-events: none;
    }
    /*
     * ヘッダーの検索の欄 (中身は `SearchField`)。広い幅では「印と名前 ｜ 欄 ｜ ナビ」の3列にして、
     * 欄を真ん中に置く (両脇の列を同じ幅に分けるので、欄は画面の中央に来る)。欄は 36rem まで広がり、
     * 中くらいの幅ではナビより先に縮む
     */
    .header-search {
        display: none;
        min-width: 0;
    }
    /*
     * 狭い幅の検索の画面の上の帯。ヘッダーと同じ地で、巻いても上に残る (下の線も引かない)。
     * 指で使う幅なので `/` の印は出さない
     */
    .search-bar :global(kbd) {
        display: none;
    }
    .search-bar {
        position: sticky;
        top: 0;
        z-index: 40;
        padding: calc(var(--dp-space-2) + env(safe-area-inset-top)) var(--dp-gutter, 1rem) var(--dp-space-2);
        background: var(--dp-bg);
    }
    /*
     * 画面の下のタブ (狭い幅だけ)。ヘッダーと同じ地に上の線 1 本、スクロールすると透けてぼける。
     * 1 つの的は幅を等分し、高さは 3.5rem (アイコンと小さな字)。下の安全域は内側の余白で避ける。
     * いまの画面は主の色の字。タブの高さ (`--dp-tabbar`) は本文の下の余白と、右下の通知 (`Toasts`) の
     * 位置に使う (タブに被らないように)
     */
    .tabbar {
        position: fixed;
        inset: auto 0 0 0;
        z-index: 40;
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        padding-bottom: env(safe-area-inset-bottom);
        border-top: 1px solid var(--dp-line);
        background: var(--dp-bg);
        view-transition-name: site-tabbar;
    }
    @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .tabbar {
            background: color-mix(in srgb, var(--dp-bg) 80%, transparent);
            -webkit-backdrop-filter: saturate(1.8) blur(12px);
            backdrop-filter: saturate(1.8) blur(12px);
        }
    }
    .tabbar .tab,
    .tab-more :global(.tab) {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.125rem;
        width: 100%;
        min-height: 3.5rem;
        margin: 0;
        padding: 0.25rem 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        color: var(--dp-muted);
        font-size: 0.6875rem;
        line-height: 1.2;
        text-decoration: none;
        white-space: nowrap;
    }
    .tabbar .tab:hover,
    .tab-more :global(.tab:is(:hover, [aria-expanded='true'])) {
        color: var(--pico-h1-color); /* ボタンの中の --pico-color は白抜きの字なので使わない */
    }
    .tabbar .tab[aria-current='page'],
    .tab-more :global(.tab[aria-current='page']) {
        color: var(--dp-primary-text);
        font-weight: var(--dp-weight-bold);
    }
    .tab-more {
        display: flex;
    }
    /*
     * いまの画面の印。タブの上端 (区切りの線の上) に短い線を置く。画面を移ると
     * 前のタブから横に滑る (`app.css` の「画面の切り替え」)
     */
    .tabbar :global(.tab-indicator) {
        position: absolute;
        top: -1px;
        left: 50%;
        width: 2rem;
        height: 2px;
        margin-left: -1rem;
        border-radius: 1px;
        background: var(--dp-primary-text);
        view-transition-name: tab-indicator;
        pointer-events: none;
    }
    /*
     * **元の要素から広げるとき (番組表のマス → 詳細) は抜き出さない** (`motion.svelte.ts` の `morph`)。
     * 抜き出すと切り替えの間だけ詳細の幕より上に重なり、暗くならずに明るく残ってちらつく
     */
    :global(:root[data-morph]) .navbar,
    :global(:root[data-morph]) .nav-underline,
    :global(:root[data-morph]) .tabbar,
    :global(:root[data-morph]) .tabbar :global(.tab-indicator) {
        view-transition-name: none;
    }
    /* 「その他」の中身 (枠は `Menu` の中なので :global)。見た目は `app.css` の `.menu` */
    :global(.tab-more-menu) {
        width: 12rem;
    }
    /*
     * 「その他」はいちばん右のタブなので、右端を揃えると画面の端に貼り付く。ページの余白ぶん内へ寄せる
     * (anchor positioning の無いブラウザは `Menu` が JS で置き、端から 4px 空ける)
     */
    :global(.menu.tab-more-menu) {
        margin-inline-end: var(--dp-gutter, 0.75rem);
    }
    /*
     * **縦に積む。** Pico のナビの部品を読んでいた頃は `nav ul` が横並び (flex) になり、
     * 畳んだメニューの中まで横に並んで、箱からはみ出していた
     */
    .more-list {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        margin: 0;
        padding: 0;
    }
    .more-extra {
        margin-top: 0.25rem;
        padding-top: 0.25rem;
        border-top: 1px solid var(--dp-line);
    }
    ul.more-list a[aria-current='page'] {
        color: var(--dp-primary-text);
        font-weight: var(--dp-weight-bold);
    }
    @media (max-width: 639.98px) {
        :global(:root:has(.tabbar)) {
            --dp-tabbar: calc(3.5rem + 1px + env(safe-area-inset-bottom));
        }
        /*
         * 下のタブがある画面ではヘッダーを隠す。リンクはタブと重なり、残りは「その他」に移したので、
         * 上の 3.5rem はまるごと中身に回す。上の安全域 (ノッチ) のぶんは本文の余白で避ける
         */
        .shell:has(.tabbar) .navbar {
            display: none;
        }
        .shell:has(.tabbar) main {
            padding-top: calc(var(--dp-page-top) + env(safe-area-inset-top));
        }
        .shell:has(.tabbar) main {
            padding-bottom: calc(var(--dp-gutter) + var(--dp-tabbar));
        }
        /* 局が無いときの案内がいちばん上に来る。安全域はそちらで避け、本文は普通の余白に戻す */
        .shell:has(.tabbar) .notice-slot {
            padding-top: env(safe-area-inset-top);
        }
        .shell:has(.tabbar):has(.notice-slot) main,
        .shell:has(.tabbar):has(.search-bar) main {
            padding-top: var(--dp-page-top);
        }
    }
    /* ライブの全画面のあいだは隠す (映像だけにする) */
    :global(html[data-stage-fullscreen]) :is(.tabbar, .notice-slot) {
        display: none;
    }
    /*
     * **余白の幅は `--dp-gutter` で配る。** スマホの縦で映像だけ端まで広げる
     * (`PlayerStage`) のに、同じ幅だけ外へはみ出させるため。数字を2か所に
     * 書くと、片方だけ変えたときに映像が横にずれる
     */
    main {
        --dp-gutter: 1rem;
        /*
         * **ヘッダーから最初の中身までは、どの画面も `--dp-page-top` (1rem)。** 左右と下の余白 (`--dp-gutter`) は
         * 広い画面で 1.5rem に広がるが、上は広げない — 画面を移るたびに最初の行の高さが変わって見えた。
         * 余白の外まで広げる画面 (番組表・録画・設定・観る画面の右の列など) も、上はこの値だけ打ち消し、
         * 最初の行をこの線にそろえる
         */
        --dp-page-top: 1rem;
        padding: var(--dp-page-top) var(--dp-gutter) var(--dp-gutter);
    }
    @media (min-width: 640px) {
        ul.links {
            display: flex;
        }
        .navbar {
            display: grid;
            grid-template-columns: minmax(max-content, 1fr) minmax(8rem, 36rem) minmax(max-content, 1fr);
            gap: var(--dp-space-4);
        }
        .header-search {
            display: block;
        }
        .actions {
            justify-self: end;
        }
        .search-bar {
            display: none;
        }
        .tabbar {
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
