<script lang="ts">
    import { untrack } from 'svelte';
    import { preloadData } from '$app/navigation';
    import { dragScroll, submitting } from '$lib/actions';
    import ProgramDetail from '$lib/components/ProgramDetail.svelte';
    import { startDownload } from '$lib/download';
    import { date, SERVICE_TYPE_LABEL, stateLabel, time } from '$lib/format';
    import { reload } from '$lib/reload.svelte';

    let { data, form } = $props();

    // 検索条件はURLに持たせる。そのままルールにできるようにするため

    type Sheet = Awaited<typeof data.grid>;

    /**
     * 表の中身。**器より後から届く** (`+page.server.ts` の `gridOf`)。
     * 届くまでは骨組みだけ出しておき、種別のタブ・日送り・検索窓は先に使えるようにする。
     *
     * **知らせで読み直したときに骨組みへ戻さない。** 番組表は録画やエンコードの
     * 知らせが来るたびに読み直すので、そのたび表が消えては現れるとちらつく。
     * 同じ日・同じ放送波なら前のものを出したままにして、届いたら差し替える
     * (`live-updates.svelte.ts` の `held` と同じ考え方)。
     * **別の日・別の放送波へ移ったときだけ**捨てる — 選び直したのに前の表が
     * 残っていると、タブと中身が食い違って見える
     */
    let sheet = $state<Sheet | null>(null);
    let shownKey = '';
    $effect(() => {
        const key = `${data.type}:${data.start}`;
        const coming = data.grid;
        if (key !== shownKey) {
            /*
             * 骨組みを挟むと表ごと作り直しになる。縦位置は戻せるように覚えておく。
             *
             * **`untrack` で読む。** 素で読むと表が消えた拍子にこの効果がもう一度
             * 回り、そのとき `grid` は null なので**覚えたばかりの位置を消して**
             * しまう (実測: 選び直すたびに先頭へ戻った)
             */
            keptTop = untrack(() => grid?.scrollTop) ?? null;
            sheet = null;
        }
        // 追い越しがあると古いほうで上書きしてしまう
        let stale = false;
        void coming.then((next) => {
            if (stale) return;
            /*
             * **一度きりの失敗で、見えている表を消さない。** 知らせのたびに
             * 読み直すので、そのうち1回が転んだだけで番組表が消えるのは割に
             * 合わない (`held` と同じ考え方)。まだ何も出していないときと、
             * 別の日・別の放送波へ移ったあと (`sheet` は null に戻してある) は、
             * 出すものが無いので理由を出す
             */
            if (next.failed !== null && sheet !== null && sheet.failed === null) return;
            // 骨組みから表に変わる回か、見えている表の差し替えか
            const fresh = shownKey !== key;
            sheet = next;
            shownKey = key;
            if (fresh) drawGradually(next.programs.length);
            else drawAll();
        });
        return () => {
            stale = true;
        };
    });

    const services = $derived(sheet?.services ?? []);
    const programs = $derived(sheet?.programs ?? []);

    /**
     * 一度に描くマスの数。
     *
     * **表が届いた瞬間に画面が止まって見えるのは、マスを一度に全部描くから。**
     * BS/CS は局が多く、24時間ぶんで数千個の `<button>` になる。骨組みを出して
     * 待たせないようにしても、届いたあとの描画で同じだけ止まっていた。
     * 先頭 (開始時刻順なので朝の 4:00 側) から数百個ずつ、描画の合間
     * (`requestAnimationFrame`) に足していけば、1コマあたりの仕事は数十ms に収まり、
     * 描いている最中でもスクロールもタブの切り替えもできる。
     *
     * 300 は「e2e の偽の放送 (数十番組) なら最初の1回で全部出る」数。
     * 実データの地上波 (20局×24時間 ≒ 500〜700) でも2〜3コマで済む
     */
    const CELL_CHUNK = 300;
    /** いま描いているマスの数。`Infinity` なら全部 */
    let shownCells = $state(Number.POSITIVE_INFINITY);
    let drawFrame = 0;

    /**
     * **骨組みから表に変わるときだけ**少しずつ描く。
     *
     * 位置は `grid-row` / `grid-column` で決めているので、途中まででも
     * マスの場所は崩れない。いま (`nowMark`) の線はマスと独立に描くので、
     * 「いま」へのスクロールは最初のコマで済む
     */
    function drawGradually(total: number): void {
        cancelAnimationFrame(drawFrame);
        shownCells = Math.min(CELL_CHUNK, total);
        const step = (): void => {
            if (shownCells >= total) return;
            shownCells = Math.min(total, shownCells + CELL_CHUNK);
            drawFrame = requestAnimationFrame(step);
        };
        if (shownCells < total) drawFrame = requestAnimationFrame(step);
    }

    /**
     * **見えている表の差し替えは一度に。** 知らせのたびに読み直すので、
     * そのたび少しずつ描き直すとマスが消えて現れてちらつく
     */
    function drawAll(): void {
        cancelAnimationFrame(drawFrame);
        shownCells = Number.POSITIVE_INFINITY;
    }

    $effect(() => () => cancelAnimationFrame(drawFrame));

    /** まだ描き終えていない。`aria-busy` で外から分かるようにする */
    const drawing = $derived(shownCells < programs.length);
    const visibleCells = $derived(drawing ? programs.slice(0, shownCells) : programs);

    /** クリックした番組。詳細を出してから予約するかどうか決める */
    let selected = $state<Sheet['programs'][number] | null>(null);

    const serviceName = (id: number) => services.find((s) => s.id === id)?.name ?? '';

    /**
     * いまライブで選べる局。詳細の「視聴」を出すかどうかに使う。
     *
     * **決めているのはサーバ** (`+page.server.ts` の `watchable`)。ライブ画面と
     * 同じ決め方でないと、押した先で別の局が映る
     */
    const watchable = $derived(new Set(data.watchable));

    const HOUR = 60 * 60 * 1000;
    /** 5分を1マスにする。細かすぎると行数が増えるだけ、粗いと短い番組が潰れる */
    const SLOT = 5 * 60 * 1000;

    const slots = $derived((data.hours * HOUR) / SLOT);

    /** いま何時か。番組表に現在位置の線を出すため、1分ごとに進める */
    let clock = $state(Date.now());
    $effect(() => {
        const timer = setInterval(() => (clock = Date.now()), 60_000);
        return () => clearInterval(timer);
    });

    /** 表示中の日にいまが含まれていれば、その行 */
    const nowRow = $derived(
        clock >= data.start && clock < data.start + data.hours * HOUR
            ? Math.floor((clock - data.start) / SLOT) + 2
            : null,
    );

    let grid = $state<HTMLElement | null>(null);
    let nowMark = $state<HTMLElement | null>(null);
    /**
     * チャンネル名の行の高さ。時刻を下ろしてくるときの上端に使う。
     * 決め打ちの値だと、局ロゴが入ったり字の大きさが変わったりしたときに
     * 数字が見出しの裏へ潜る
     */
    let headHeight = $state(0);

    /**
     * 時刻の列の幅。**数字と「いま」の札が入るぶんだけ。**
     *
     * 出しているのは「13」のような時だけなので、3.5rem は要らなかった。
     * 狭くしたぶんは番組の列に回る (横に並ぶ局が増える)
     */
    const TIME_COLUMN = '2.5rem';

    /*
     * 開いたときに「いま」が見えている状態にする。24時間ぶん出るので、
     * 先頭(4:00)のままだと毎回スクロールさせることになる。
     *
     * 位置は offsetTop では測れない。offsetTop は「位置指定された親」からの距離で、
     * ここでは body が親になるため、ナビや見出しの高さまで足し込まれて
     * その分だけ下に行き過ぎる。実際に見えている位置の差から出す。
     */
    let scrolled = false;
    /**
     * 骨組みを挟んでいる間の縦位置。
     *
     * 放送波や日を選び直すと表を作り直すので、`scrollTop` は 0 に戻ってしまう。
     * **縦は時刻**で、どの放送波でも同じ意味なので、見ていたところへ戻す
     * (横は局の並びが別物なので、別の効果で先頭に戻している)
     */
    let keptTop: number | null = null;
    $effect(() => {
        if (grid === null) return;
        const back = keptTop;
        if (back !== null) {
            keptTop = null;
            grid.scrollTop = back;
            return;
        }
        if (scrolled || nowMark === null) return;
        scrolled = true;

        const target = grid;
        const mark = nowMark;
        // 「いま」を上端ちょうどに置くと直前の番組が見えず、放送中のものが
        // 頭から切れて分かりにくい。画面の4分の1あたりに来るようにする
        const place = () => {
            const top = mark.getBoundingClientRect().top - target.getBoundingClientRect().top;
            target.scrollTop = Math.max(0, target.scrollTop + top - target.clientHeight / 4);
        };

        place();
        let frames = 0;
        const settle = () => {
            place();
            // 画像(局ロゴ)やバッジが入って高さが変わることがあるので数回追う
            if (++frames < 5) requestAnimationFrame(settle);
        };
        requestAnimationFrame(settle);
    });

    const end = $derived(data.start + data.hours * HOUR);

    /** 何行目から何行分か。ヘッダーが1行目なので +2 */
    function place(program: { start_at: number; end_at: number }) {
        const from = Math.max(0, Math.floor((program.start_at - data.start) / SLOT));
        const to = Math.min(slots, Math.ceil((Math.min(program.end_at, end) - data.start) / SLOT));
        return { row: from + 2, span: Math.max(1, to - from) };
    }

    const columnOf = $derived(new Map(services.map((s, i) => [s.id, i + 2])));

    const hourMarks = $derived(
        Array.from({ length: data.hours }, (_, i) => ({
            at: data.start + i * HOUR,
            row: (i * HOUR) / SLOT + 2,
            span: HOUR / SLOT,
        })),
    );


    function href(params: Record<string, string>): string {
        const query = new URLSearchParams({ type: data.type, ...params });
        return `/guide?${query}`;
    }

    const prevHref = $derived(href({ start: String(data.start - data.hours * HOUR) }));
    const nextHref = $derived(href({ start: String(data.start + data.hours * HOUR) }));

    /**
     * 読み込み中に出す骨組みの形。**中身の数とは関係なく決め打ち。**
     *
     * 何局あるかは表と一緒に届くので、この時点では分からない。8列ぶん出して
     * おけば、狭い画面でも広い画面でも「ここに表が来る」ことは伝わる。
     *
     * 高さは**番組の尺のつもり**でばらけさせる。全部同じ高さだと表ではなく
     * ただの縞に見えた。乱数ではなく決め打ちなのは、描き直すたびに形が変わると
     * それ自体が動いて見えるため
     */
    const SKELETON_COLUMNS = 8;
    const SKELETON_CELLS = [
        [3, 1.5, 4.5, 2, 3, 2.5, 4, 1.5, 3, 2],
        [1.5, 5, 2, 3.5, 2, 3, 1.5, 4, 2.5, 2],
        [4, 2, 2.5, 4, 1.5, 3, 2, 3.5, 2.5, 2],
        [2, 3, 6, 1.5, 2.5, 2, 4, 1.5, 3, 1.5],
        [5, 1.5, 2, 3, 2.5, 4, 1.5, 3, 2, 2.5],
        [1.5, 4, 3, 2, 3.5, 2.5, 2, 4, 2.5, 2],
        [3.5, 2.5, 1.5, 5, 2, 3, 2, 2.5, 3, 2],
        [2, 6, 2.5, 1.5, 3, 2, 3.5, 2, 2.5, 2],
    ];

    /*
     * 放送波を切り替えたら横位置を先頭へ戻す。
     *
     * 同じ画面のまま中身だけ入れ替わるので、DOM は使い回され、横スクロールの
     * 位置がそのまま残る。地上波で右のほうを見ていたあと BS を開くと、
     * 局の並びは別物なのに同じ位置から始まり、左端の局が隠れていた。
     * 縦(時刻)はどの放送波でも同じ意味なので、そのままにする
     */
    $effect(() => {
        data.type;
        if (grid !== null) grid.scrollLeft = 0;
    });

    /*
     * 前日・翌日を先に取り寄せておく。
     *
     * 押してから読み込むと、24時間ぶんの番組を引き直して組み直す間だけ止まって見えた。
     * body の `data-sveltekit-preload-data="hover"` は指を乗せてからなので、
     * 狙って押すと間に合わない。表を出した時点で両隣を取っておけば、押した瞬間に出る。
     *
     * **開くのが終わってから**取りに行く。すぐ投げていた頃は、いま見たい番組表と
     * 前後2日ぶんを同時に取ることになり、初めの表示そのものが遅くなっていた。
     * requestIdleCallback は Safari に無いので、無ければ少し置いてから
     */
    $effect(() => {
        const soon = prevHref;
        const later = nextHref;
        const fetchBoth = () => {
            void preloadData(soon);
            void preloadData(later);
        };
        // requestIdleCallback は Safari に無い
        if (typeof requestIdleCallback !== 'function') {
            const timer = setTimeout(fetchBoth, 500);
            return () => clearTimeout(timer);
        }
        const handle = requestIdleCallback(fetchBoth, { timeout: 3000 });
        return () => cancelIdleCallback(handle);
    });

    /** 予約を取り消せるのはこれから録るものだけ。録り終わったものに出しても何も起きない */
    const CANCELABLE = ['scheduled', 'conflict', 'recording'];
</script>

<!--
    **表は画面の残りをぜんぶ使う** (`+layout.svelte` の `FILLED`)。
    `max-h-[75vh]` で切っていた頃は、**画面の下に余白があるのに表のほうが
    先に終わって**いた (実測で 1880x960 の窓に 130px の余り)。番組表は縦に
    長いほど読めるものなので、余りは表に回す。

    畳まれる幅ではページごとスクロールさせるので、そちらは 75% のまま —
    小さい画面で中だけスクロールさせると、指の届く範囲が二重になる。

    **ここだけ `%` で降ろせない。** 土台は `html` から `%` で採っているが、
    畳まれる幅では途中の入れ物 (`main` と外枠) に高さが決まっておらず、
    `%` が解決しない。

    **そこは `svh` で採る。** 3つの単位のうち `svh` だけが「ブラウザの UI が
    出ているとき」= いちばん小さい側で、**見えている範囲を超えない**。
    `vh` と `dvh` は超えることがあり、実機の PWA で 56px ずれた
    (Chrome for Android のアドレスバーの高さそのもの)。

    ここは天井を決めているだけなので、少し小さく出る側に倒すのが正しい
-->
<div class="page">
    <!--
    **どこを見るかは1行にまとめる。** 種別・日送り・探すを3段に分けていた頃は、
    絵の出ていない上半分に 130px 使っていた。番組表は縦に長いほど読めるもの
    なので、**そのぶんを表に回す。**

    「番組 30343 / 局 125」も出していたが、番組表が入っているかどうかは
    **表そのものを見れば分かる** (集まり具合の内訳はチューナー画面にある)
-->
    <div class="cluster toolbar">
        <div role="group" class="types" data-testid="type-tabs">
            {#each ['GR', 'BS', 'CS'] as type (type)}
                <a
                    class="button small {data.type === type ? '' : 'secondary outline'}"
                    aria-current={data.type === type ? 'page' : undefined}
                    href="/guide?type={type}&start={data.start}"
                    data-testid="type-{type}"
                >
                    {SERVICE_TYPE_LABEL[type]}
                </a>
            {/each}
        </div>

        <!-- 日送りは種別のすぐ隣。どちらも「表のどこを見るか」の操作なので離さない -->
        <div class="cluster">
            <a class="button small secondary outline" href={prevHref} data-testid="prev-day">← 前日</a>
            <span class="small" data-testid="window-label">
                <!-- 日本の番組表の慣習で、1日は4時から翌4時まで -->
                {date(data.start)} <span class="muted">(4:00〜翌4:00)</span>
            </span>
            <a class="button small secondary outline" href={nextHref} data-testid="next-day">翌日 →</a>
            <a class="button small secondary outline" href={href({})}>今日</a>
        </div>

        <!--
        探すのは右端に寄せる。見るための操作とは別のことなので、間を空ける。

        **見出しは置かない** — 枠の中の字が同じことを言っている。検索と条件の
        編集はルール画面に寄せてあり (条件を2箇所で書けるようにすると判定が
        ずれる)、探す範囲もあちらで切り替える。既定は番組名だけ
    -->
        <form method="GET" action="/rules" class="cluster search" data-testid="guide-filter">
            <input
                type="search"
                name="keyword"
                placeholder="全チャンネルの番組名から"
                class="keyword"
                data-testid="filter-keyword"
            />
            <button class="small" type="submit">検索</button>
        </form>
    </div>

    {#if sheet !== null && sheet.failed !== null}
        <!--
            組めなかった。**骨組みのまま放っておかない** — 読み込み中と区別が
            付かず、いつまでも待たせることになる。本当の理由はサーバのログに出る
        -->
        <div class="panel empty" data-testid="guide-failed">
            <p class="muted">番組表を読み込めませんでした ({sheet.failed})</p>
            <button type="button" class="small secondary outline" onclick={reload}>読み直す</button>
        </div>
    {:else if sheet === null}
        <!--
            **表のところだけ読み込み中にする。** 画面ごと出てこないと、放送波を
            選び直すのも検索を打ち始めるのも待たされる。骨組みは本物と同じ形
            (左に時刻の列、上にチャンネルの行) にしておく — 何が出てくるのかが
            分かるし、届いたときに位置が飛ばない
        -->
        <div
            class="panel skeleton"
            data-testid="guide-skeleton"
            role="status"
            aria-label="番組表を読み込んでいます"
        >
            <div class="skeleton-rows" aria-hidden="true">
                {#each { length: SKELETON_COLUMNS } as _, column (column)}
                    <div class="skeleton-column">
                        <div class="skeleton-head"></div>
                        {#each SKELETON_CELLS[column] as height, cell (cell)}
                            <div class="skeleton-cell" style="height: {height}rem"></div>
                        {/each}
                    </div>
                {/each}
            </div>
        </div>
    {:else if services.length === 0}
        <div class="panel empty" data-testid="empty-grid">
            <p class="muted">
                {SERVICE_TYPE_LABEL[
                    data.type
                ]}のチャンネルがありません。チューナー画面でチャンネルスキャンを実行してください。
            </p>
        </div>
    {:else}
        <div
            class="grid-box"
            use:dragScroll
            bind:this={grid}
            data-testid="guide-grid"
            aria-busy={drawing ? 'true' : undefined}
        >
            <!--
            **横幅を数えて入れておく。**

            列の合計 (5688px) より外側の枠が狭いままだと、grid はそこからはみ出して
            描かれるだけで、枠自体は画面の幅 (358px) のまま残る。`sticky` は
            親の枠から外へは出られない決まりなので、時刻の列は
            「画面の幅 − 列の幅」ぶんしか付いてこられず、そこから先は
            置いていかれていた (390px の端末だと 302px スクロールしたところで脱落)。

            幅を列の合計にしておけば、端まで付いてくる。局が少なくて画面のほうが
            広いときは min-width で伸ばし、余りは 1fr が分け合う
        -->
            <div
                class="rows"
                style="grid-template-columns: {TIME_COLUMN} repeat({services.length}, minmax(11rem, 1fr)); grid-template-rows: auto repeat({slots}, 0.75rem); width: calc({TIME_COLUMN} + {services.length} * 11rem); min-width: 100%;"
                data-testid="guide-rows"
            >
                <!-- 左上の角。時刻列とチャンネル行の交点で、どちらにも追従させる -->
                <div
                    class="corner"
                    style="grid-column: 1; grid-row: 1;"
                    bind:clientHeight={headHeight}
                ></div>
                {#each services as service, i (service.id)}
                    <div
                        class="service"
                        style="grid-column: {i + 2}; grid-row: 1;"
                        title={service.name}
                        data-testid="guide-service"
                    >
                        <!--
                        ロゴを持たない局もあるので、有るものだけ出す。場所は
                        どちらでも空けておく — 局名の頭が列ごとにずれると、
                        横に並べたときにどれがどの局か追いにくい。

                        **出せなかったときに引っ込めない。** `onerror` で消していた頃は、
                        Svelte が持っている節点を横から触ることになって並びが崩れ、
                        しかも一度消すと読み込み直すまで戻らなかった。denpa を入れ替えた
                        直後は読みかけの画像がまとめて途切れて全局ぶんが消えていた
                        (ファイルは残っているのに)。`alt=""` なので、出せなければ
                        場所だけが残る = 持っていない局と同じ見た目になる
                    -->
                        {#if service.has_logo}
                            <img
                                src="/api/services/{service.id}/logo"
                                alt=""
                                class="logo"
                                loading="lazy"
                            />
                        {:else}
                            <span class="logo"></span>
                        {/if}
                        <span class="name">{service.name}</span>
                    </div>
                {/each}

                <!--
                時刻の列。**横にも縦にも追従させる。**

                横は列そのものを `sticky left-0` で置いておけば済む。縦は
                そうはいかない。1マス(5分)ずつでは細かすぎるので1時間を1つの
                グリッド領域にしているが、そうすると数字はその領域の先頭に
                書かれるだけで、時間の途中まで下ろすと画面の外へ出てしまい、
                いま何時のところを見ているのか分からなくなっていた。

                中の数字をもう一段 `sticky` にして、その1時間ぶんの領域の中で
                下りてくるようにする。上端はチャンネル名の行のぶんだけ空ける
                (高さは実測する。決め打ちだと1pxずれて数字が見出しの裏へ潜る)
            -->
                {#each hourMarks as mark (mark.at)}
                    <div
                        class="hour"
                        style="grid-column: 1; grid-row: {mark.row} / span {mark.span};"
                    >
                        <span class="hour-label" style="top: {headHeight}px;">
                            {new Date(mark.at).getHours()}
                        </span>
                    </div>
                {/each}

                {#if nowRow !== null}
                    <div
                        class="now"
                        style="grid-column: 1 / -1; grid-row: {nowRow};"
                        bind:this={nowMark}
                        data-testid="now-line"
                    >
                        <!--
                        時刻の札は**時刻の列の中に置く。**

                        右へずらして番組の上に浮かせていた頃は、列の外へはみ出して
                        番組名に被っていた。時刻を読むところは左の列と決まっているので、
                        そこに収める。ちょうど同じ時のところにある数字とは重なるが、
                        その1時間は「いま」の札を読めばいいので困らない。

                        `sticky left-0` で横スクロールに付いてこさせる (`absolute` だと
                        線を引いている枠 `grid-column: 1 / -1` の左端に貼り付いて、
                        右へ流れると見えなくなる。`sticky` は流れの中に居ないと効かない)。

                        **線をまたぐ位置は `translate` で決める。** `inline-block` に
                        負のマージンを付けていた頃は、行の高さのぶんだけ下へずれて
                        線の下に落ち、番組名に被っていた (下がるぶんは字の大きさで
                        変わるので、マージンの値では合わせられない)。
                        `block` にして高さの半分だけ上げれば、字が変わっても線の上に乗る
                    -->
                        <span
                            class="now-label"
                            style="width: {TIME_COLUMN};"
                        >
                            {time(clock)}
                        </span>
                    </div>
                {/if}

                <!-- 少しずつ足していく (`drawGradually`)。全部出るまで `aria-busy` が付いている -->
                {#each visibleCells as program (program.id)}
                    {@const pos = place(program)}
                    <div
                        class="cell"
                        style="grid-column: {columnOf.get(
                            program.service_id,
                        )}; grid-row: {pos.row} / span {pos.span};"
                        data-testid="grid-program"
                        data-program-id={program.id}
                        data-service-id={program.service_id}
                        data-start-at={program.start_at}
                    >
                        <!--
                        マスは上ぞろえ。button は中身を縦中央に置くので、短い番組と
                        長い番組で開始時刻の高さが揃わず、横に目で追えなかった。
                        flex-col にして上から積む。

                        色はジャンル(大分類)ごとに変える。白黒のマスが敷き詰まっていると
                        どこに何があるのか目で追えない。予約したものだけは色より
                        「予約済み」であることのほうが大事なので、そちらを優先する
                    -->
                        <button type="button"
                            class="program"
                            class:reserved={program.reservation_state}
                            data-genre={program.genres?.[0]}
                            onclick={() => (selected = program)}
                            data-testid="program-button"
                        >
                            <span class="title">
                                {time(program.start_at)}
                                {#if program.name}
                                    {program.name}
                                {:else}
                                    <span class="faint">(番組情報なし)</span>
                                {/if}
                            </span>
                            {#if program.reservation_state}
                                <span class="state">
                                    {stateLabel(program.reservation_state)}
                                </span>
                            {:else}
                                <span class="desc">
                                    {program.description}
                                </span>
                            {/if}
                        </button>
                    </div>
                {/each}
            </div>
        </div>
    {/if}
</div>

<!-- 番組の中身。**二段組の外に置く** (中に入れると巻き取る箱の中で開くことになる) -->
{#if selected}
    {@const program = selected}
    <ProgramDetail
        program={{ ...program, service_name: serviceName(program.service_id) }}
        onclose={() => (selected = null)}
    >
        {#snippet actions()}
            <!--
                失敗の理由は詳細の中に出す。番組表にインラインで足すと、その分だけ
                グリッドが下にずれてスクロールバーが出る。

                **ここだけ Toasts に寄せていない。** 他の画面の知らせは右下に浮かせて
                いるが、押したのはこのモーダルの中のボタンで、モーダルは浮かせた札より
                上に出る。下に隠れるものを出しても読めないので、押したボタンの隣に置く
            -->
            {#if form?.message}
                <div class="notice error guide-error" data-testid="guide-error">{form.message}</div>
            {/if}
            <!--
                閉じるは**いちばん右で動かさない**。押すものが番組によって増えたり
                減ったりする (予約する / 取り消す / 再生 / ダウンロード) ので、
                そのたびに位置が変わると、閉じたつもりで別のものを押すことになる
            -->
            <div class="cluster guide-actions">
                {#if program.reservation_state}
                    <span class="tag info lead" data-testid="detail-state">
                        {stateLabel(program.reservation_state)}
                    </span>
                {:else if program.end_at <= clock}
                    <!--
                        もう終わった番組。予約する口を出しても、押した先で
                        「放送が終わっています」と断られるだけ (reservations.reserve)
                    -->
                    <span class="tag lead" data-testid="detail-ended">放送終了</span>
                {/if}

                {#if program.recording_id !== null && (program.library_path ?? program.ts_path) !== null}
                    <!--
                        録れているなら、ここからそのまま観られるようにする。
                        番組表で見つけた番組を観るのに、録画一覧へ戻って同じ番組を
                        探し直させるのは遠回り。

                        **観られるのは焼けたものだけ** (`library_path`)。生TSは
                        MPEG-2 で、ブラウザに復号器が無い (docs/stream.md §5.5)。
                        焼き上がるまでは落として観てもらう
                    -->
                    {#if program.library_path !== null}
                        <a
                            class="button"
                            href="/watch/{program.recording_id}"
                            data-testid="detail-play"
                        >
                            再生
                        </a>
                    {/if}
                    <!-- 押されてから期限付きの署名URLを作って落とす ($lib/download) -->
                    <button
                        type="button"
                        class="ghost"
                        onclick={() => void startDownload(program.recording_id ?? -1)}
                        data-testid="detail-download"
                    >
                        ダウンロード
                    </button>
                {/if}

                {#if program.start_at <= clock && program.end_at > clock && watchable.has(program.service_id)}
                    <!--
                        **いま流れている番組は、その場で観られるようにする。**
                        番組表で見つけた番組を観るのに、ライブ画面へ行って
                        同じ局を一覧から探し直させるのは遠回り (局が100を超える
                        環境では、探すほうが手間になる)。

                        **ライブ画面が持っている局にだけ出す** (`watchable`)。
                        番組表のマスは**名前の無い枠でも出る**ので、そのまま出すと
                        押した先で別の局が映る (実機の NHKEテレ2/3。分割放送を
                        していない間のサブチャンネルがこれにあたる)。

                        **リンクにする。** 押した先は別の画面で、そこで選局から
                        やり直すことになるので、モーダルの中で始めるものではない
                    -->
                    <a
                        class="button outline"
                        href="/live?service={program.service_id}"
                        data-testid="detail-watch"
                    >
                        視聴
                    </a>
                {/if}

                {#if CANCELABLE.includes(program.reservation_state ?? '')}
                    <!-- 予約したあと番組表から止められないと、わざわざ予約一覧まで行くことになる -->
                    <form
                        method="POST"
                        action="?/cancel"
                        use:submitting={() =>
                            async ({ result, update }) => {
                                await update();
                                if (result.type === 'success') selected = null;
                            }}
                    >
                        <input type="hidden" name="programId" value={program.id} />
                        <button type="submit" class="danger outline" data-testid="detail-cancel">
                            予約を取り消す
                        </button>
                    </form>
                {:else if program.reservation_state === null && program.end_at > clock}
                    <!--
                        録画のしかたはここでは選ばせない。設定画面の1箇所で決める
                        (同じ選択肢を予約・ルール・設定に並べると、どれで決まったのか
                        分からなくなる)
                    -->
                    <form
                        method="POST"
                        action="?/reserve"
                        use:submitting={() =>
                            async ({ result, update }) => {
                                await update();
                                // 失敗したときは開いたままにして、中に理由を出す
                                if (result.type === 'success') selected = null;
                            }}
                    >
                        <input type="hidden" name="programId" value={program.id} />
                        <button type="submit" data-testid="detail-reserve">予約する</button>
                    </form>
                {/if}

                <!-- 位置を動かさないため、いつでもここが最後 -->
                <button type="button" class="secondary" onclick={() => (selected = null)} data-testid="detail-close">
                    閉じる
                </button>
            </div>
        {/snippet}
    </ProgramDetail>
{/if}

<style>
    .toolbar {
        margin-bottom: 0.75rem;
    }
    .types {
        width: auto;
    }
    .search {
        margin-left: auto;
    }
    .keyword {
        width: 14rem;
        height: auto;
        padding-block: 0.3rem;
        font-size: 0.85rem;
    }
    .empty {
        padding: 1.5rem;
        text-align: center;
    }

    /*
     * 読み込み中の骨組み。**表と同じ場所・同じ高さに置く** ので、
     * 中身が届いたときに下のものが飛び跳ねない。
     *
     * 光が流れるのは骨組みそのものではなく**上に重ねた一枚**。桝ごとに動かすと
     * 数十個ぶんのアニメーションが同時に走り、届いた瞬間の描き直しと重なって
     * もたついた。重ねた一枚なら動くのは1つで済む
     */
    .skeleton {
        position: relative;
        overflow: hidden;
        padding: 0.75rem;
        /* 表と同じ高さを取っておく。届いた拍子に枠が伸びると画面が跳ねる */
        height: 75svh;
    }
    .skeleton-rows {
        display: flex;
        height: 100%;
        gap: 0.5rem;
    }
    .skeleton-column {
        display: flex;
        flex: 1 1 0;
        flex-direction: column;
        gap: 0.5rem;
        /* 狭い画面では右の列がはみ出すが、外側で切る (本物の表も横に流れる) */
        min-width: 6rem;
    }
    .skeleton-head,
    .skeleton-cell {
        /* 縮ませない。合計が枠より高いぶんは下で切る (本物の表も下へ続く) */
        flex-shrink: 0;
        border-radius: 0.375rem;
        background: var(--dp-base-200);
    }
    /* チャンネル名の行。本物と同じで、ここだけ濃い */
    .skeleton-head {
        height: 1.75rem;
        background: var(--dp-base-300);
    }
    .skeleton::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(
            90deg,
            transparent 0%,
            rgb(255 255 255 / 0.06) 50%,
            transparent 100%
        );
        transform: translateX(-100%);
        animation: skeleton-sweep 1.4s ease-in-out infinite;
    }
    @keyframes skeleton-sweep {
        to {
            transform: translateX(100%);
        }
    }
    /* 動くものが苦手な人には動かさない (Pico と同じ約束) */
    @media (prefers-reduced-motion: reduce) {
        .skeleton::after {
            animation: none;
        }
    }
    /* 畳まれる幅ではページごとスクロールさせ、表の高さは見えている範囲まで(上のコメント) */
    .grid-box {
        max-height: 75svh;
        overflow: auto;
        cursor: grab;
        border-radius: 1rem;
        background: var(--dp-surface);
        border: 1px solid var(--dp-base-300);
    }
    .grid-box:active {
        cursor: grabbing;
    }
    @media (min-width: 768px) {
        .page {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        .grid-box {
            max-height: none;
            min-height: 0;
            flex: 1 1 0%;
        }
    }
    .rows {
        display: grid;
    }
    .corner,
    .service,
    .hour {
        background: var(--dp-surface);
        border-color: var(--dp-base-300);
        border-style: solid;
        border-width: 0;
    }
    .corner {
        position: sticky;
        top: 0;
        left: 0;
        z-index: 30;
        border-right-width: 1px;
    }
    .service {
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        gap: 0.375rem;
        overflow: hidden;
        white-space: nowrap;
        border-bottom-width: 1px;
        padding: 0.5rem;
        font-size: 0.875rem;
        /* 行の高さ(= 時刻の数字が止まる位置 headHeight)を Tailwind の頃の 37px に揃える */
        line-height: 1.25rem;
        font-weight: 500;
    }
    .logo {
        display: block;
        height: 1.25rem;
        width: 2rem;
        flex-shrink: 0;
        object-fit: contain;
    }
    .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .hour {
        position: sticky;
        left: 0;
        z-index: 10;
        border-top-width: 1px;
        border-right-width: 1px;
        padding-inline: 0.25rem;
        font-size: 0.75rem;
        /* 数字の行の高さは 1rem に揃える。高いと、前の時間の数字が枠の下に残って次の時間の数字と並んで見える */
        line-height: 1rem;
    }
    .hour-label {
        position: sticky;
        display: block;
    }
    .now {
        position: relative;
        z-index: 10;
        pointer-events: none;
        border-top: 2px solid var(--dp-error);
    }
    .now-label {
        position: sticky;
        left: 0;
        z-index: 20;
        display: block;
        transform: translateY(-50%);
        border-radius: 0.25rem;
        background: var(--dp-error);
        color: #fff;
        text-align: center;
        font-size: 10px;
        line-height: 1rem;
    }
    .cell {
        overflow: hidden;
        padding: 0.125rem;
    }
    /*
     * 色はジャンル(大分類)ごと。下地は薄く敷いて左に濃い線を引く。濃く塗ると文字が読めなくなる。
     * 予約したものは色より「予約済み」であることのほうが大事なので、主の色を優先する
     */
    .program {
        --tint: var(--dp-base-300);
        display: flex;
        flex-direction: column;
        align-items: stretch;
        height: 100%;
        width: 100%;
        overflow: hidden;
        margin: 0;
        padding: 0.125rem 0.25rem;
        border: 0;
        border-left: 2px solid var(--tint);
        border-radius: 0.25rem;
        background: var(--dp-base-200);
        color: inherit;
        text-align: left;
        font-weight: normal;
        line-height: normal;
    }
    .program:hover {
        background: var(--dp-base-300);
    }
    .program[data-genre] {
        background: color-mix(in srgb, var(--tint) 15%, transparent);
    }
    .program[data-genre]:hover {
        background: color-mix(in srgb, var(--tint) 25%, transparent);
    }
    /*
     * ジャンルの色は **色みだけを変えて、濃さと鮮やかさは全部同じ** にする
     * (hsl の S と L を固定)。拾ってきた色を12個並べていた頃は、黄色のマスだけが
     * 前に出て紺色のマスが沈み、番組表を眺めると明るいマスに目が吸われていた。
     * 濃さが揃っていれば、色は「種類が違う」ことだけを伝える
     */
    .program[data-genre="0"] { --tint: hsl(210 62% 55%); }  /* ニュース/報道 */
    .program[data-genre="1"] { --tint: hsl(145 62% 55%); }  /* スポーツ */
    .program[data-genre="2"] { --tint: hsl(190 62% 55%); }  /* 情報/ワイドショー */
    .program[data-genre="3"] { --tint: hsl(350 62% 55%); }  /* ドラマ */
    .program[data-genre="4"] { --tint: hsl(280 62% 55%); }  /* 音楽 */
    .program[data-genre="5"] { --tint: hsl(25 62% 55%); }   /* バラエティ */
    .program[data-genre="6"] { --tint: hsl(250 62% 55%); }  /* 映画 */
    .program[data-genre="7"] { --tint: hsl(310 62% 55%); }  /* アニメ/特撮 */
    .program[data-genre="8"] { --tint: hsl(45 62% 55%); }   /* ドキュメンタリー/教養 */
    .program[data-genre="9"] { --tint: hsl(325 62% 55%); }  /* 劇場/公演 */
    .program[data-genre="10"] { --tint: hsl(95 62% 55%); }  /* 趣味/教育 */
    .program[data-genre="11"] { --tint: hsl(170 62% 55%); } /* 福祉 */
    .program.reserved,
    .program.reserved:hover {
        --tint: var(--pico-primary);
        background: color-mix(in srgb, var(--pico-primary) 20%, transparent);
    }
    .title {
        display: block;
        font-size: 0.75rem;
        line-height: 1.25;
        font-weight: 500;
    }
    .faint {
        opacity: 0.4;
    }
    .state {
        display: block;
        font-size: 0.75rem;
        color: var(--pico-primary);
    }
    .desc {
        display: block;
        font-size: 0.75rem;
        line-height: 1.25;
        opacity: 0.6;
    }
    .guide-error {
        margin-top: 1rem;
    }
    .guide-actions {
        justify-content: flex-end;
    }
    .lead {
        margin-right: auto;
    }
</style>
