<script lang="ts">
    import { tick, untrack } from 'svelte';
    import { dragScroll, submitting } from '#lib/actions.js';
    import ProgramDetail from '#lib/components/ProgramDetail.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import ServiceLogo from '#lib/components/ServiceLogo.svelte';
    import { channelNumber, date, SERVICE_TYPE_LABEL, stateLabel, time } from '#lib/format.js';
    import { morph } from '#lib/motion.svelte.js';
    import { reload } from '#lib/reload.svelte.js';
    import { cellsOf, columnsOf, mainOf, SUBCHANNELS_COOKIE, splitOf } from '#lib/subchannels.js';
    import type { ProgramDetail as Facts } from '#lib/types.js';
    import { preloadData } from '$app/navigation';
    import { resolve } from '$app/paths';
    import SearchIcon from '~icons/lucide/search';

    let { data, form } = $props();

    type Sheet = Awaited<typeof data.grid>;

    /**
     * 表の中身。**外枠より後から届く** (`+page.server.ts` の `gridOf`)。
     * 届くまでは骨組みだけ出しておき、種別のタブ・日送り・検索窓は先に使えるようにする。
     *
     * **通知で読み直したときに骨組みへ戻さない。** 番組表は録画やエンコードの
     * 通知が来るたびに読み直すので、そのたび表が消えては現れるとちらつく。
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
             * **一度きりの失敗で、見えている表を消さない。** 通知のたびに
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
            if (fresh) drawGradually(cells.length);
            else drawAll();
        });
        return () => {
            stale = true;
        };
    });

    const services = $derived(sheet?.services ?? []);
    const programs = $derived(sheet?.programs ?? []);

    /**
     * サブチャンネル (テレ東2・3、Eテレ2・3、BS朝日2・3 など) の列を出すか。**既定は出す**
     * (分割放送のあるサブだけ。`#lib/subchannels.ts`)。切ったら端末ごとに cookie で覚える
     */
    let subchannels = $state(untrack(() => data.subchannels));
    const main = $derived(mainOf(services));
    /** サブチャンネルの分割放送。ずっと本チャンネルと同じ番組のサブは入らない */
    const split = $derived(splitOf(programs, main));
    /**
     * 切り替えは、その日に分割放送があるときだけ出す。無ければ出しても列が増えない
     * (ずっと本チャンネルと同じ番組のサブは列を立てない。CS・SKY は束ねないので出ない)
     */
    const canSplit = $derived(split.size > 0);
    const columns = $derived(columnsOf(services, main, subchannels ? split : null));
    /** 表のマス。本チャンネルと同じ番組を流しているサブの列には本チャンネルのマスが伸びてくる */
    const cells = $derived(cellsOf(columns, programs, main, split));

    function setSubchannels(on: boolean): void {
        subchannels = on;
        // 列が増減するだけなので、少しずつ描き直さない (`drawAll`)
        drawAll();
        // パスは接頭辞込み (録画一覧の「まとめて表示」と同じ)
        document.cookie = `${SUBCHANNELS_COOKIE}=${on ? '1' : '0'}; path=${resolve('')}; max-age=31536000; samesite=lax`;
    }

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
     * e2e の偽の放送 (数十番組) なら最初の1回で全部出て、
     * 実データの地上波 (20局×24時間 ≒ 500〜700) でも1〜2コマで済む数。
     * 画面の外のマスは中身を組まない (下の `.cell` の `content-visibility`) ので、
     * 1コマの仕事は「マスを置く」だけになり、数を増やしても止まらない
     */
    const CELL_CHUNK = 600;
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
     * **見えている表の差し替えは一度に。** 通知のたびに読み直すので、
     * そのたび少しずつ描き直すとマスが消えて現れてちらつく
     */
    function drawAll(): void {
        cancelAnimationFrame(drawFrame);
        shownCells = Number.POSITIVE_INFINITY;
    }

    $effect(() => () => cancelAnimationFrame(drawFrame));

    /** まだ描き終えていない。`aria-busy` で外から分かるようにする */
    const drawing = $derived(shownCells < cells.length);
    const visibleCells = $derived(drawing ? cells.slice(0, shownCells) : cells);

    /** クリックした番組。詳細を出してから予約するかどうか決める */
    let selected = $state<Sheet['programs'][number] | null>(null);

    /**
     * 開いた番組の中身 (出演者・あらすじ・音声…)。**表は持っていない**
     * (`+page.server.ts` の `GridProgram`) ので、開くときに 1 件だけ取る。
     */
    let facts = $state<Facts | null>(null);
    /** 続けて別のマスを押したとき、遅れて届いた前の結果で上書きしない */
    let opening = 0;

    /**
     * **届いてから出す。** 表が持っている分 (題名・時刻・概要) で先に出して
     * あとから差し替える手もあるが、詳細を開いた瞬間にラベル (ジャンル・音声) が
     * 無く、一拍おいて生える見え方になる。取りに行くのは同じホストの 1 件で
     * 数十 ms なので、揃ってから出す。取れなければ (番組表から消えた) 表の分だけ
     */
    async function open(program: Sheet['programs'][number], from: HTMLElement | null = null): Promise<void> {
        const token = ++opening;
        const seed: Facts = {
            name: program.name,
            service_name: serviceName(program.service_id),
            start_at: program.start_at,
            end_at: program.end_at,
            description: program.description,
            extended: null,
            genre_detail: null,
            audios: null,
            video_type: null,
            video_resolution: null,
            is_free: true,
            copy_never: false,
        };
        let detail = seed;
        try {
            const res = await fetch(resolve(`api/programs/${program.id}`));
            if (res.ok) detail = { ...seed, ...((await res.json()) as Facts) };
        } catch {
            // 取れなくても開く。中身は表が持っている分だけ
        }
        if (token !== opening) return;
        // 開いているところへ別の番組を出すとき (検索の結果から) は広げない。箱はもう出ている
        const fresh = selected === null;
        origin = from;
        morph(fresh ? from : null, DETAIL_NAME, 'open', () => {
            facts = detail;
            selected = program;
        });
    }

    function close(): void {
        opening++;
        const back = origin;
        origin = null;
        if (selected === null) return;
        morph(back, DETAIL_NAME, 'close', () => {
            selected = null;
            facts = null;
        });
    }

    /**
     * 押したマス。**詳細はこのマスから広がって開き、閉じるとここへ縮んで戻る**
     * (`morph`。名前は詳細の箱にも付ける。使えないブラウザと動かさない設定ではすぐ出てすぐ消える)
     */
    let origin: HTMLElement | null = null;
    const DETAIL_NAME = 'program-detail';

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
    /** 1 マスの高さ。表の行と今の線の送り (`nowSlots`) の両方がこれを使う */
    const SLOT_HEIGHT = '0.75rem';

    const slots = $derived((data.hours * HOUR) / SLOT);

    /** いま何時か。番組表に現在位置の線を出すため、1分ごとに進める */
    let clock = $state(Date.now());
    $effect(() => {
        const timer = setInterval(() => (clock = Date.now()), 60_000);
        return () => clearInterval(timer);
    });

    /**
     * 表示中の日にいまが含まれていれば、表の頭 (4:00) から何マスぶん下か (端数つき)。
     *
     * **線は 1 マス (5 分) ごとに飛ばさず、分の位置へ `translate` で送る。** 行 (`grid-row`) で
     * 置いていた頃は 5 分ごとに 1 マスずつ跳んでいた。1 分ごとの移りは短い transition でなめらかに
     * (`.now`。動かさない設定ではすぐ移る)
     */
    const nowSlots = $derived(
        clock >= data.start && clock < data.start + data.hours * HOUR ? (clock - data.start) / SLOT : null,
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
     * 時刻の列の幅。**数字と「いま」のラベルが入るぶんだけ。**
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

    const hourMarks = $derived(
        Array.from({ length: data.hours }, (_, i) => ({
            at: data.start + i * HOUR,
            row: (i * HOUR) / SLOT + 2,
            span: HOUR / SLOT,
        })),
    );

    function href(params: Record<string, string>): string {
        const query = new URLSearchParams({ type: data.type, ...params });
        return resolve(`guide?${query}`);
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
     * 「終わってから」は**マスを描き終わってから** (`drawing` が下りてから) —
     * 表が届いた時点で投げていた頃は、マスを描いている最中に BS で 1 件 1 MB 超の
     * 応答が 2 つ届いて、その解読が描画と取り合っていた。
     * requestIdleCallback は Safari に無いので、無ければ少し置いてから。
     * 同じ日・同じ放送波の読み直しでは取り直さない (`prefetchedFor`)
     */
    let prefetchedFor = '';
    $effect(() => {
        const soon = prevHref;
        const later = nextHref;
        if (sheet === null || drawing) return;
        const key = `${data.type}:${data.start}`;
        if (prefetchedFor === key) return;
        const fetchBoth = () => {
            prefetchedFor = key;
            void preloadData(soon);
            void preloadData(later);
        };
        if (typeof requestIdleCallback !== 'function') {
            const timer = setTimeout(fetchBoth, 500);
            return () => clearTimeout(timer);
        }
        const handle = requestIdleCallback(fetchBoth, { timeout: 3000 });
        return () => cancelIdleCallback(handle);
    });

    /**
     * **狭い画面では検索欄を畳み、虫眼鏡のボタンで開く。**
     *
     * 種別・日送り・検索を折り返して並べると、スマホの幅 (390px) では表の上に
     * 4段・250px ほどの操作欄が積まれ、表が画面の下半分に押し込まれていた。
     * 番組表で毎回触るのは種別と日送りで、検索はたまにしか使わない。
     * 広い画面 (768px 以上) では今までどおり右端に出しておく (CSS で切り替える)
     */
    let searching = $state(false);
    let keyword: HTMLInputElement | null = $state(null);
    async function openSearch(): Promise<void> {
        searching = !searching;
        if (!searching) return;
        await tick();
        keyword?.focus();
    }

    /** 予約を取り消せるのはこれから録るものだけ。録り終わったものに出しても何も起きない */
    const CANCELABLE = ['scheduled', 'conflict', 'skipped', 'recording'];
</script>

<!--
    **表は画面の残りをぜんぶ使う** (`+layout.svelte` の `FILLED`)。
    畳まれる幅ではページごとスクロールさせるので、そちらは 75% のまま。

    **ここだけ `%` で降ろせない** (畳まれる幅では途中の入れ物に高さが決まっておらず、
    `%` が解決しない)。そこは `svh` で採る — `svh` だけが見えている範囲を超えない
    (`vh` と `dvh` は実機の PWA でアドレスバーの高さぶん超えた)。天井なので小さく出る側に倒す
-->
<div class="page">
    <!-- **どこを見るかは1行にまとめる** (種別・日送り・探す)。縦は表に回す -->
    <div class="cluster toolbar">
        <div role="group" class="types segmented" data-testid="type-tabs">
            {#each ['GR', 'BS', 'CS'] as type (type)}
                <a
                    class="button small {data.type === type ? '' : 'secondary outline'}"
                    aria-current={data.type === type ? 'page' : undefined}
                    href={href({ type, start: String(data.start) })}
                    data-testid="type-{type}"
                >
                    {#if data.type === type}<span class="seg-pill" aria-hidden="true"></span>{/if}
                    {SERVICE_TYPE_LABEL[type]}
                </a>
            {/each}
        </div>

        <!-- 日送りは種別のすぐ隣。どちらも「表のどこを見るか」の操作なので離さない -->
        <div class="cluster days">
            <a class="button small secondary outline" href={prevHref} data-testid="prev-day">← 前日</a>
            <span class="small nowrap">
                <!-- 日本の番組表の慣習で、1日は4時から翌4時まで。狭い画面では日付だけ -->
                {date(data.start)} <span class="muted hours">(4:00〜翌4:00)</span>
            </span>
            <a class="button small secondary outline" href={nextHref} data-testid="next-day">翌日 →</a>
            <a class="button small secondary outline" href={href({})}>今日</a>
        </div>

        <!--
            **サブチャンネルを出すか** (issue #509)。テレビの番組表の「サブチャンネル表示」と同じ。
            見え方の好みなので設定画面ではなくここに置き、端末ごとに覚える。
            入っているかは aria-pressed と地の色で (録画一覧の「まとめて表示」と同じ形)。
            その日に分割放送が無ければ出さない (押しても列が増えない)
        -->
        {#if canSplit}
            <button
                type="button"
                class="small {subchannels ? '' : 'secondary outline'}"
                aria-pressed={subchannels}
                title={subchannels ? 'サブチャンネルを表示中 (押すと隠します)' : 'サブチャンネルも表示'}
                aria-label="サブチャンネル表示"
                onclick={() => setSubchannels(!subchannels)}
                data-testid="subchannel-toggle"
            >
                サブch
            </button>
        {/if}

        <!--
        探すのは右端に寄せる。見るための操作とは別のことなので、間を空ける。

        **見出しは置かない** — 枠の中の字が同じことを言っている。検索と条件の
        編集はルール画面に寄せてあり (条件を2箇所で書けるようにすると判定が
        ずれる)、探す範囲もあちらで切り替える。既定は番組名だけ
    -->
        <!-- 狭い画面だけ出る。押すと下の検索欄が1段だけ開く (上の `searching`) -->
        <button
            type="button"
            class="small secondary outline search-toggle"
            aria-label="番組を探す"
            aria-expanded={searching}
            aria-controls="guide-search"
            onclick={() => void openSearch()}
            data-testid="guide-search-toggle"
        >
            <Icon icon={SearchIcon} size="size-4" />
        </button>
        <!-- role="search" で入力欄とボタンを1つにつなぐ (Pico)。種別の切り替えと同じ見た目の決まり -->
        <form
            id="guide-search"
            method="GET"
            action={resolve('rules')}
            role="search"
            class="search"
            class:open={searching}
            data-testid="guide-filter"
        >
            <input
                type="search"
                name="keyword"
                bind:this={keyword}
                placeholder="全局の番組名で検索"
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
        <div class="panel empty">
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
                ]}の局がありません。チューナー画面でチャンネルスキャンを実行してください。
            </p>
        </div>
    {:else}
        <!--
            **見出しの裏を「見えている」に数えない** (`scroll-padding`)。

            チャンネル名の行と時刻の列は `sticky` で表の上に重なっている。そのままだと、
            キーボードでマスへ移ったとき (`focus`) や `scrollIntoView` のスクロールが、
            見出しの裏に半分隠れたマスを見えているとみなして動かない (e2e では 3時台に
            翌日の 4:00 のマスを押すと、真ん中が見出しに当たって詳細が開かなかった)
        -->
        <div
            class="grid-box"
            style="scroll-padding: {headHeight}px 0 0 {TIME_COLUMN};"
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
                style="grid-template-columns: {TIME_COLUMN} repeat({columns.length}, minmax(11rem, 1fr)); grid-template-rows: auto repeat({slots}, {SLOT_HEIGHT}); width: calc({TIME_COLUMN} + {columns.length} * 11rem); min-width: 100%;"
                data-testid="guide-rows"
            >
                <!-- 左上の角。時刻列とチャンネル行の交点で、どちらにも追従させる -->
                <div
                    class="corner"
                    style="grid-column: 1; grid-row: 1;"
                    bind:clientHeight={headHeight}
                ></div>
                {#each columns as service, i (service.id)}
                    <div
                        class="service"
                        style="grid-column: {i + 2}; grid-row: 1;"
                        title={service.name}
                        data-testid="guide-service"
                    >
                        <!--
                        ロゴを持たない局もあるので、有るものだけ出す。場所は
                        どちらでも空けておく — 局名の頭が列ごとにずれると、
                        横に並べたときにどれがどの局か追いにくい
                    -->
                        <ServiceLogo
                            id={service.id}
                            has={service.has_logo}
                            style="display: block; width: 2rem; height: 1.25rem"
                            fallback=""
                        />
                        <!-- テレビに出ている番号。ラベルの形はライブの一覧と同じ (format.ts の channelNumber) -->
                        {#if channelNumber(service) !== null}
                            <span class="tag ch-number" data-testid="guide-number">{channelNumber(service)}</span>
                        {/if}
                        <span class="truncate broadcast">{service.name}</span>
                    </div>
                {/each}

                <!--
                時刻の列。**横にも縦にも追従させる。**

                横は列そのものを `sticky` (`left: 0`) で置いておけば済む。縦は
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
                        <span class="hour-label num" style="top: {headHeight}px;">
                            {new Date(mark.at).getHours()}
                        </span>
                    </div>
                {/each}

                {#if nowSlots !== null}
                    <div
                        class="now"
                        style="grid-column: 1 / -1; grid-row: 2; translate: 0 calc({nowSlots} * {SLOT_HEIGHT});"
                        bind:this={nowMark}
                        data-testid="now-line"
                    >
                        <!--
                        時刻のラベルは**時刻の列の中に置く。**

                        右へずらして番組の上に浮かせていた頃は、列の外へはみ出して
                        番組名に被っていた。時刻を読むところは左の列と決まっているので、
                        そこに収める。ちょうど同じ時のところにある数字とは重なるが、
                        その1時間は「いま」のラベルを読めばいいので困らない。

                        `sticky` (`left: 0`) で横スクロールに付いてこさせる (`absolute` だと
                        線を引いている枠 `grid-column: 1 / -1` の左端に貼り付いて、
                        右へ流れると見えなくなる。`sticky` は流れの中にいないと効かない)。

                        **線をまたぐ位置は `translate` で決める。** `inline-block` に
                        負のマージンを付けていた頃は、行の高さのぶんだけ下へずれて
                        線の下に落ち、番組名に被っていた (下がるぶんは字の大きさで
                        変わるので、マージンの値では合わせられない)。
                        `block` にして高さの半分だけ上げれば、字が変わっても線の上に乗る
                    -->
                        <span
                            class="now-label num"
                            style="width: {TIME_COLUMN};"
                        >
                            {time(clock)}
                        </span>
                    </div>
                {/if}

                <!--
                    少しずつ足していく (`drawGradually`)。全部出るまで `aria-busy` が付いている。
                    本チャンネルと同じ番組を流しているサブチャンネルの列へは本チャンネルのマスを横に伸ばす (`span`)。
                    分割放送の前後で幅が変わると、同じ番組が上下2つのマスになる (`cell.key`)
                -->
                {#each visibleCells as cell (cell.key)}
                    {@const program = cell.program}
                    {@const pos = place(cell)}
                    <div
                        class="cell"
                        style="grid-column: {cell.column + 2} / span {cell.span}; grid-row: {pos.row} / span {pos.span};"
                        data-testid="grid-program"
                        data-program-id={program.id}
                        data-service-id={program.service_id}
                        data-start-at={program.start_at}
                    >
                        <!--
                        マスは上ぞろえ。button は中身を縦中央に置くので、短い番組と
                        長い番組で開始時刻の高さが揃わず、横に目で追えなかった。
                        縦の flex にして上から積む (色の決め方は下の `.program`)
                    -->
                        <button type="button"
                            class="program"
                            class:reserved={program.reservation_state && program.reservation_state !== 'skipped'}
                            data-state={program.reservation_state}
                            data-genre={program.genres?.[0]}
                            onclick={(event) => void open(program, event.currentTarget)}
                            data-testid="program-button"
                        >
                            <span class="title">
                                <span class="num">{time(program.start_at)}</span>
                                {#if program.name}
                                    <span class="broadcast">{program.name}</span>
                                {:else}
                                    <span class="faint">(番組情報なし)</span>
                                {/if}
                                {#if program.copy_never}
                                    <!-- 録らない番組。控えめに添えるだけ (理由は詳細で) -->
                                    <span class="copy-never" data-testid="grid-copy-never">コピー禁止</span>
                                {/if}
                            </span>
                            {#if program.reservation_state}
                                <span class="state">
                                    {stateLabel(program.reservation_state)}
                                </span>
                            {:else}
                                <span class="desc broadcast">
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
{#if selected && facts}
    {@const program = selected}
    <ProgramDetail program={facts} onclose={close} transitionName={DETAIL_NAME}>
        {#snippet actions()}
            <!--
                失敗の理由は詳細の中に出す。番組表にインラインで足すと、その分だけ
                グリッドが下にずれてスクロールバーが出る。

                **ここだけ Toasts に寄せていない。** 他の画面の通知は右下に浮かせて
                いるが、押したのはこのモーダルの中のボタンで、モーダルは浮かせた表示より
                上に出る。下に隠れるものを出しても読めないので、押したボタンの隣に置く
            -->
            {#if form?.message}
                <div class="notice error guide-error">{form.message}</div>
            {/if}
            <!--
                閉じるは**いちばん右で動かさない**。押すものが番組によって増えたり
                減ったりする (予約する / 取り消す / 再生 / 視聴) ので、
                そのたびに位置が変わると、閉じたつもりで別のものを押すことになる
            -->
            <div class="cluster guide-actions">
                {#if program.reservation_state}
                    <span class="tag info lead" data-testid="detail-state">
                        {stateLabel(program.reservation_state)}
                    </span>
                {:else if program.end_at <= clock}
                    <!--
                        もう終わった番組。予約ボタンを出しても、押した先で
                        「放送が終わっています」と断られるだけ (reservations.reserve)
                    -->
                    <span class="tag lead" data-testid="detail-ended">放送終了</span>
                {/if}

                {#if program.recording_id !== null && program.recording_state !== 'failed' && (program.library_path ?? program.ts_path) !== null}
                    <!--
                        録れているなら、録画一覧へ戻らずここからそのまま観られるようにする
                        (一覧の `hasFile` と同じ判定)。エンコードする前の元のTSは観る画面が追っかけ (`/chase`) へ送る
                    -->
                    <a class="button" href={resolve(`watch/${program.recording_id}`)}>再生</a>
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
                        href={resolve(`live?service=${program.service_id}`)}
                        data-testid="detail-watch"
                    >
                        視聴
                    </a>
                {/if}

                <!--
                    **ルールを作る。** 予約・録画の詳細と同じ入口
                    (`rules/+page.server.ts` の `originOf`)。毎回録りたい番組を番組表で
                    見つけたとき、ルールの画面で探し直さずに済む
                -->
                <a
                    class="button secondary outline"
                    href={resolve(`rules?program=${program.id}`)}
                    data-testid="detail-rule"
                >
                    ルールを作る
                </a>

                {#if CANCELABLE.includes(program.reservation_state ?? '') && !(program.reservation_state === 'skipped' && program.end_at <= clock)}
                    <!-- 予約したあと番組表から止められないと、わざわざ予約一覧まで行くことになる -->
                    <form
                        method="POST"
                        action="?/cancel"
                        use:submitting={() =>
                            async ({ result, update }) => {
                                await update();
                                if (result.type === 'success') close();
                            }}
                    >
                        <input type="hidden" name="programId" value={program.id} />
                        <button type="submit" class="danger outline" data-testid="detail-cancel">
                            予約取消
                        </button>
                    </form>
                {:else if program.reservation_state === null && program.end_at > clock && !program.copy_never}
                    <!--
                        録画のしかたはここでは選ばせない。設定画面の1箇所で決める
                        (同じ選択肢を予約・ルール・設定に並べると、どれで決まったのか
                        分からなくなる)。コピー禁止の番組には出さない — 押しても断るだけ
                        (`reservations.reserve`)。理由は詳細の「コピー禁止」に添えてある
                    -->
                    <form
                        method="POST"
                        action="?/reserve"
                        use:submitting={() =>
                            async ({ result, update }) => {
                                await update();
                                // 失敗したときは開いたままにして、中に理由を出す
                                if (result.type === 'success') close();
                            }}
                    >
                        <input type="hidden" name="programId" value={program.id} />
                        <button type="submit" data-testid="detail-reserve">予約</button>
                    </form>
                {/if}

                <!-- 位置を動かさないため、いつでもここが最後 -->
                <button type="button" class="secondary" onclick={close} data-testid="detail-close">
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
        /* Pico の role=search は横いっぱい・下に余白。ここでは右に寄せて置くだけ */
        width: auto;
        margin-bottom: 0;
        margin-left: auto;
    }
    .keyword {
        width: 14rem;
        height: auto;
        padding-block: 0.3rem;
        font-size: 0.85rem;
    }
    .search-toggle {
        display: none;
    }
    /*
     * **狭い画面は2段にまとめる** (上の `searching`)。1段目に種別と虫眼鏡、2段目に
     * 日送り (前日・日付・翌日・今日を1行)。検索欄は虫眼鏡で開いたときだけ3段目に出る。
     * 並べ替えは `order` で — DOM の順 (種別 → 日送り → 検索) は読み上げの順なので変えない
     */
    @media (max-width: 767px) {
        .days {
            order: 1;
            flex-basis: 100%;
            flex-wrap: nowrap;
        }
        .hours {
            display: none;
        }
        .search-toggle {
            display: inline-flex;
            align-items: center;
            margin-left: auto;
        }
        .search {
            display: none;
        }
        .search.open {
            display: flex;
            order: 2;
            flex-basis: 100%;
            margin-left: 0;
        }
        .search.open .keyword {
            width: auto;
            flex: 1 1 0%;
        }
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
        border-radius: var(--dp-radius-sm);
        background: var(--dp-subtle);
    }
    /* チャンネル名の行。本物と同じで、ここだけ濃い */
    .skeleton-head {
        height: 1.75rem;
        background: var(--dp-line);
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
        border-radius: var(--dp-radius-lg);
        background: var(--dp-surface);
        border: 1px solid var(--dp-line);
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
        border-color: var(--dp-line);
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
    .ch-number {
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
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
        /* 1 分ごとの移りを飛ばさずに (上の `nowSlots`) */
        transition: translate var(--dp-duration-slow) var(--dp-ease);
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
    /*
     * **画面の外のマスは中身を組まない** (`content-visibility: auto`)。
     *
     * 288 行 (5 分刻み) × 局数の grid に BS で 2,000 個超の `<button>` を置く。
     * マスを足すたびに表全体の Layout がやり直しになり、実データ相当 (BS 60 局・
     * 2,171 マス) で 1 回 450ms × 7 回 = 描き終わりまで 12 秒かかっていた。
     * 見えている範囲のマスだけ中身を組めば Layout は 11 秒 → 2 秒、描き終わりは
     * 12 秒 → 3.4 秒 (CPU を 4 倍遅くしても 23 秒 → 10 秒)。
     *
     * 大きさは grid の track で決まる (列は `minmax(11rem, 1fr)`、行は 0.75rem) ので、
     * 中身を組まなくてもマスの場所は変わらない。`contain-intrinsic-size` は
     * 中身が無いときの仮の大きさで、track に伸ばされるぶんには効かない
     */
    .cell {
        overflow: hidden;
        padding: 0.125rem;
        content-visibility: auto;
        contain-intrinsic-size: auto 11rem auto 0.75rem;
    }
    /*
     * 色はジャンル(大分類)ごと。**色は左の太い線で見せ、下地はごく淡く敷くだけ** (WebTS と同じ形)。
     * 下地を 15% 塗っていた頃は、明るいテーマでマスが桃色や水色のブロックになり、
     * 上に乗る小さい字が地に溶けて読みにくかった。下地は地の色 (--dp-surface) に
     * ジャンルの色を少しだけ混ぜる。暗いテーマは混ぜても沈みやすいので少し多めにする。
     * 字は本文と同じ濃さのまま。
     *
     * 予約したものは色より「予約済み」であることのほうが大事なので、主の色を優先し、
     * 線に加えて細い枠も引く。録画中はさらに録画の赤にする (一覧のバッジと同じ考え)
     */
    .program {
        --tint: var(--dp-line);
        --wash: 10%;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        height: 100%;
        width: 100%;
        overflow: hidden;
        margin: 0;
        padding: 0.125rem 0.25rem;
        border: 0;
        border-inline-start: 4px solid var(--tint);
        border-radius: 0.25rem;
        background: var(--dp-subtle);
        color: inherit;
        text-align: left;
        font-weight: normal;
        line-height: normal;
    }
    :global([data-theme="dark"]) .program {
        --wash: 14%;
    }
    .program:hover {
        background: var(--dp-hover);
    }
    .program[data-genre] {
        background: color-mix(in srgb, var(--tint) var(--wash), var(--dp-surface));
    }
    .program[data-genre]:hover {
        background: color-mix(in srgb, var(--tint) calc(var(--wash) + 10%), var(--dp-surface));
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
    .program.reserved {
        --tint: var(--pico-primary);
        background: color-mix(in srgb, var(--tint) calc(var(--wash) + 6%), var(--dp-surface));
        box-shadow: inset 0 0 0 1px var(--tint);
    }
    .program.reserved:hover {
        background: color-mix(in srgb, var(--tint) calc(var(--wash) + 14%), var(--dp-surface));
    }
    .program[data-state="recording"] {
        --tint: var(--dp-rec);
    }
    /*
     * **競合は予約済みと同じ青にしない。** 青のままだと「録れる」に見え、
     * チューナーが足りずに落ちる番組を表の上で見落とす。一覧のバッジ
     * (`format.ts` の `badgeClass`。赤い字と赤い枠) と同じ色にそろえる。
     * 録画中 (赤く塗ったマス) と見分けるため、**地は塗らずに枠と字だけ**赤くする —
     * 「いま動いているもの」だけを塗る決まり (`app.css`) のとおり
     */
    .program[data-state="conflict"] {
        --tint: var(--dp-rec);
        background: var(--dp-surface);
    }
    .program[data-state="conflict"]:hover {
        background: color-mix(in srgb, var(--tint) var(--wash), var(--dp-surface));
    }
    .title {
        display: block;
        font-size: 0.75rem;
        line-height: 1.25;
        font-weight: 500;
    }
    .state {
        display: block;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--dp-primary-text);
    }
    .program:is([data-state="recording"], [data-state="conflict"]) .state {
        color: var(--dp-rec-text);
    }
    /*
     * **録らないと決めた予約 (コピー禁止) は予約済みの青にしない** — 青だと「録れる」に見える。
     * 待っているだけで手を止めてほしいものでもないので、字を控えるだけにする
     */
    .program[data-state="skipped"] .state {
        color: inherit;
        opacity: 0.8;
    }
    .copy-never {
        font-size: 0.625rem;
        font-weight: normal;
        opacity: 0.7;
        white-space: nowrap;
    }
    /* 説明は番組名より一段だけ控える。0.6 まで落とすと淡い下地の上で字が溶けた */
    .desc {
        display: block;
        font-size: 0.75rem;
        line-height: 1.25;
        opacity: 0.8;
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
