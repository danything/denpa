<script lang="ts">
    /**
     * データ放送を映像の上に重ねる。**描くのは借りもの** (`BMLBrowser`)。
     *
     * denpa が作った `ResponseMessage` をそのまま食べさせるだけで、
     * **映像は denpa のまま**。BML 側には「映像はこの入れ物に居る」とだけ伝える
     * ([vendor/web-bml](../../vendor/web-bml/README.md))。
     *
     * ## 押されるまで何も読み込まない
     *
     * 組み上がると 700KB の塊になる。**入れっぱなしにすると、データ放送を
     * 見ない人のぶんまで毎回落ちてくる**ので、`import()` で押されてから
     * 取りに行く。どのみち押してからカルーセルが一周するのを待つので、
     * そこに紛れる。
     *
     * ## 借りものが持っていないぶんは、ここでやる
     *
     * `BMLBrowser` は**画面の器を持たない**。上流の単体ページ
     * (`client/index.ts`、denpa は借りていない) がやっていたことを、この
     * ファイルが肩代わりしている — `knock` (d を渡す)・`place` (映像を戻す)・
     * `fit` (枠に合わせる)・`indicator` (データ取得中)・`remember` (郵便番号)。
     *
     * **どれも抜けると「押しても何も出ない」形で壊れる。** 何がどう壊れるかは
     * 借りもの側の README に1箇所だけ書いてある
     * ([vendor/web-bml](../../vendor/web-bml/README.md#借りていないぶんこちらでやること))
     */
    import { onDestroy } from 'svelte';
    import type { BMLBrowser, Indicator, IP } from '$lib/vendor/web-bml/client/bml_browser';
    import type { ResponseMessage } from '$lib/vendor/web-bml/server/ws_api';

    interface Props {
        /** 出すか。**押されたら読み込みが始まる** */
        on: boolean;
        /**
         * いま映している局。**変わったら作り直す。**
         *
         * 借りものは一度に一つの放送しか持てない (カルーセルも NVRAM も
         * 局ごと)。局を変えても作り直さずにいると、**前の局の文書が
         * 映像を掴んだまま**残り、映像が BML の小窓の形に潰れる
         */
        channel: string | null;
        /** 映像が居る入れ物。**BML はこれを動かす** (`place`) */
        media: HTMLElement | null;
        /** 知らせを受け取る口を預ける。`null` を渡すと外れる */
        listen: (handler: ((message: ResponseMessage) => void) | null) => void;
        /**
         * 指のリモコン (`Remote.svelte`) から押す口を預ける。
         * `null` を渡すと外れる (`listen` と同じ形)。
         *
         * **口が有るかどうかが、そのままリモコンを出すかどうかになる** —
         * 器ができる前に出しても押せるものが無い
         */
        remote: (press: ((code: number) => void) | null) => void;
        /**
         * 郵便番号 (数字7桁。空なら渡さない)。**放送のアプリが地域を決めるのに読む。**
         *
         * 置き場はサーバの設定 (`server/settings.ts`) で、ここでは器を作る前に
         * NVRAM へ写すだけ (`remember`)
         */
        postal: string;
        /**
         * 双方向 (通信系コンテンツ) を使うか。**既定は切**
         * (`server/settings.ts` の `bmlNetwork`)。
         *
         * 切っている間は `isIPConnected` に 0 を返すので、放送のアプリは
         * 「インターネットに接続されていません」と正しく案内します。
         * **嘘をつかないのが大事** — 1 と答えて取りに行けないと、今度は
         * 無言で失敗します
         */
        network: boolean;
    }

    const { on, channel, media, listen, remote, postal, network }: Props = $props();

    /**
     * リモコンの d。`AribKeyCode.DataButton` と同じ値。
     *
     * **番号で書くのは、`content.ts` を読み込まずに済ませるため** —
     * あれを値として import すると、押される前に借りもの全体が落ちてくる
     */
    const DATA_BUTTON = 20;

    /**
     * 覚えるもの (NVRAM) の名前の頭。**借りものは
     * `storagePrefix + nvramPrefix + …` で探す**ので、こちらから直に
     * 置くとき (`remember`) にも同じものが要る
     */
    const STORAGE_PREFIX = 'denpa_bml_';
    const NVRAM_PREFIX = 'denpa_nvram_';

    /**
     * d を叩き直す回数と間隔。
     *
     * **一度では届かない。** 文書が組み上がった時点ではまだ `beitem` が
     * `subscribe` になっておらず (それを立てるのはアプリの `onload`)、
     * `DataButtonPressed` は誰にも拾われずに消える。出てくるまで叩き続ける —
     * 手でリモコンを押し直すのと同じこと
     */
    const KNOCK_TRIES = 12;
    const KNOCK_WAIT = 400;

    /** 描く場所。BML の画面 (960x540 など) がこの中に入る */
    let host = $state<HTMLDivElement | null>(null);
    /** いま動いている借りもの */
    let browser = $state<BMLBrowser | null>(null);
    /** 読み込み中か。**押してすぐは何も出ないので、そう言う** */
    let loading = $state(false);
    /**
     * BML が「いま出ている」と言っているか。
     *
     * **BML は `invisible` で始まる。** テレビでは d を押すと
     * `DataButtonPressed` が飛び、アプリが自分で `invisible` を外して出てくる。
     * つまり**器を作っただけでは何も出ない** — 中では動いているのに画面は
     * 変わらない、という壊れ方をする (実機でそうなった)
     */
    let showing = $state(false);
    /** いま実際に映しているか (`place` が決める)。`showing` との違いは `settled` を見よ */
    let visible = $state(false);
    /** 何度も作らないための世代。押して離してを繰り返しても混ざらない */
    let generation = 0;
    /** いま何を出しているか (`channel`)。出していなければ `null` */
    let shown = $state<string | null>(null);
    /** その回ぶんの入れ物。**毎回作り直す** (`open` の説明) */
    let mount: HTMLDivElement | null = null;
    /**
     * 映像の元の居場所。**順番まで覚える。**
     *
     * 末尾に付け直すと字幕の canvas より上に来てしまう。戻す先は
     * 「どの親の、どれの前」
     */
    let seat: { parent: Node; next: Node | null } | null = null;
    /** BML の画面の大きさ。`load` で分かる (960x540 / 720x480 など) */
    let plane: { width: number; height: number } | null = null;
    /**
     * まだ電波から取っている最中か。**借りものが教えてくれる**
     * (`Indicator.setReceivingStatus`)。テレビの「データ取得中…」と同じ札で、
     * 入口の部品が載っていない局では立たないようになっている
     */
    let receiving = $state(false);
    /**
     * 一度でも出し切ったか。
     *
     * **最初の1枚が揃うまでは映像のままにしておく。** 入口の文書 (`startup.bml`)
     * は本体へ渡すだけのほぼ白紙で、しかも自分で `invisible` を外してくる。
     * 素直に映すと、**本体が届くまでの数秒が真っ白**になる (実機でそうなった)。
     * テレビは電波をずっと拾い続けているのでこの待ちが無い — denpa は
     * 押されてから解きはじめるぶん、ここが目に見える。
     *
     * ただし**出し切ったあとは引っ込めない**。中を渡り歩くたびに取得中には
     * なるが、そこで映像に戻ってしまうと画面が点滅する
     */
    let settled = false;
    /** 残りの叩く回数 */
    let knocks = 0;
    /** 次に叩く約束 */
    let knocking: ReturnType<typeof setTimeout> | null = null;
    /** 枠の大きさを見張る。全画面にすると変わる */
    let watcher: ResizeObserver | null = null;
    /**
     * 渡した知らせの数。**画面には出さない** (切り分け用)。
     *
     * データ放送は「押しても何も出ない」という壊れ方をする。**届いていないのか、
     * 届いても描かれないのか**が外から分からないと、どちらを追えばいいかが
     * 決まらない (実機で1日それを探した)
     */
    let handed = $state(0);

    /**
     * 放送が名指しする字。**字幕を焼いているのと同じフォントを使う。**
     *
     * 像に入れてある `rounded-mplus-1m-arib` は、BML が要る3つ — **等幅**
     * (狭い画面で空白を使って組むため、仕様で必須)・**丸ゴシック**・**ARIB の
     * 外字** — を1本で満たす。借りている側が抱えている Kosugi (4.4MB) は
     * 外字を持っていないので、こちらのほうが適している。
     *
     * **同じ字なので、データ放送と字幕で字形が揃う。**
     *
     * 角ゴシックだけは端末のものに任せる — 丸い字で代用すると、放送が
     * 「ここは角」と言っている意味が消える。手元での開発や、像に入っていない
     * ときのために `local(...)` を後ろに並べてある (`api/font` は 404 を返す)
     */
    const FONTS = {
        roundGothic: {
            source: "url('/api/font') format('woff2'), local('Hiragino Maru Gothic ProN'), local('Meiryo')",
        },
        squareGothic: { source: "local('Hiragino Kaku Gothic ProN'), local('Meiryo'), local('MS Gothic')" },
    };

    /**
     * テレビが下のほうに出す「データ取得中…」。**借りものが持っている口。**
     *
     * 使うのは `setReceivingStatus` だけ。残りは上流の単体ページが画面の縁に
     * 出していたもの (いま開いている URL・通信中の印・番組名) で、denpa には
     * 既にそれぞれの置き場がある。
     *
     * 取り終わったかどうかは**こちらからは分からない** — 何個のモジュールで
     * 揃うのかを知っているのは借りている側だけなので、教えてもらうしかない
     */
    const indicator: Indicator = {
        setUrl: () => {},
        setReceivingStatus: (on: boolean) => {
            receiving = on;
            place();
        },
        setNetworkingGetStatus: () => {},
        setNetworkingPostStatus: () => {},
        setEventName: () => {},
    };

    /**
     * 双方向 (通信系コンテンツ)。**中継はサーバがやる**
     * (`/api/bml/proxy`。放送局のサーバは CORS を返さないので直には取れない)。
     *
     * **取ってくるだけ。** 応募・投票の送信 (`transmitTextDataOverIP`) と
     * 疎通確認 (`confirmIPNetwork`) は渡さない — 正規の受信機以外からの
     * 送信は放送側の想定外で、実装しないと決めてある
     * ([docs/stream.md](../../../../docs/stream.md#57-双方向通信系コンテンツプロキシ))。
     * 渡さなければ借りものは「その機能は無い」とアプリに答える
     */
    const ip: IP = {
        // 403 は「Ethernet で DHCP」。借りものの既定と同じ
        getConnectionType: () => 403,
        isIPConnected: () => (network ? 1 : 0),
        get: async (uri: string) => {
            const response = await fetch(`/api/bml/proxy?url=${encodeURIComponent(uri)}`);
            const body = new Uint8Array(await response.arrayBuffer());
            return { response: body, headers: response.headers, statusCode: response.status };
        },
    };

    /**
     * BML の画面を枠いっぱいに伸ばす。
     *
     * BML は 960x540 のような**決まった大きさ**で組まれていて、借りものは
     * 原寸のまま置く (上流のアプリには 100%/150%/200% のボタンが付いている)。
     * denpa の枠は端末しだいで変わるので、こちらで合わせる。
     *
     * **縦横を別々に伸ばす** — 映像が枠を埋めているのだから、その上に重ねる
     * ものも同じだけ伸びていないと位置がずれる
     */
    function fit(): void {
        if (mount === null || host === null || plane === null) return;
        const box = host.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return;
        mount.style.width = `${plane.width}px`;
        mount.style.height = `${plane.height}px`;
        mount.style.transform = `scale(${box.width / plane.width}, ${box.height / plane.height})`;
    }

    /**
     * 映像をあるべき場所に置き直す。
     *
     * 借りものは文書を組むたびに、渡された入れ物を BML の `<object>` の中へ
     * **移す** (`content.ts` の `videoElementNew.appendChild`)。データ放送が
     * 「小窓に映せ」と言えばそれで正しいが、**隠れている間もそのまま**なので、
     * 放っておくと映像が小窓の形に潰れたまま戻らない
     */
    function place(): void {
        // **出すと決まったら、そこから先は取得中でも出しっぱなし** (`settled`)
        const want = showing && (settled || !receiving);
        if (want) settled = true;
        if (settled || !showing) stopWaiting();
        else startWaiting();
        visible = want;
        if (mount !== null) mount.style.opacity = want ? '1' : '0';
        if (media === null) return;
        const box = want ? (browser?.getVideoElement() ?? null) : null;
        if (box !== null) {
            if (media.parentNode !== box) box.appendChild(media);
            return;
        }
        if (seat !== null && media.parentNode !== seat.parent) seat.parent.insertBefore(media, seat.next);
    }

    /**
     * 取得中が終わるのを待つ上限。
     *
     * **待ち続けて出ないより、白くても出るほうがまし。** 借りものが
     * 「取得中」を下ろし忘れる局があったとき、`settled` を立てる口が
     * 他に無いと**d を押しても永久に何も起きない**ことになる
     */
    const SHOW_WAIT = 8000;
    let waiting: ReturnType<typeof setTimeout> | null = null;

    function startWaiting(): void {
        if (waiting !== null) return;
        waiting = setTimeout(() => {
            waiting = null;
            settled = true;
            place();
        }, SHOW_WAIT);
    }

    function stopWaiting(): void {
        if (waiting !== null) clearTimeout(waiting);
        waiting = null;
    }

    /** 叩くのをやめる。**出てきたら、そこで止める** */
    function stopKnocking(): void {
        if (knocking !== null) clearTimeout(knocking);
        knocking = null;
        knocks = 0;
    }

    /** 押して離したことにする。**BML は押しっぱなしを嫌う** (離すまで次が来ない) */
    function tap(code: number): void {
        if (browser === null) return;
        browser.content.processKeyDown(code);
        browser.content.processKeyUp(code);
    }

    /**
     * BML に d を叩いて見せる。
     *
     * denpa の d ボタンは**器の出し入れ**に使っているので、そのままでは
     * BML に届かない。出てくるまで繰り返す (`KNOCK_TRIES`)
     */
    function knock(): void {
        knocking = null;
        if (browser === null || knocks <= 0) return;
        knocks--;
        tap(DATA_BUTTON);
        knocking = setTimeout(knock, KNOCK_WAIT);
    }

    /**
     * 郵便番号を NVRAM に置いておく。**器を作る前に。**
     *
     * 放送のアプリは `nvram://receiverinfo/zipcode` を数字7桁で読み、
     * 天気・地域のニュース・防災情報をどこのものにするかを決める。
     * 借りものはそれを `localStorage` の**この名前**で探す
     * (`vendor/web-bml/client/nvram.ts` の `readNVRAM`)。
     *
     * **書ける口が無いので、じかに置く。** 借りものが持っているのは
     * 「放送のアプリから読み書きさせる」道だけで、受信機の設定として
     * 外から入れる口は上流の単体ページ側にあった (denpa は借りていない)。
     *
     * 空なら**消す** — 入れたものを消したときに、前の番号が残らないように
     */
    function remember(): void {
        const key = `${STORAGE_PREFIX}${NVRAM_PREFIX}prefix=receiverinfo%2Fzipcode`;
        if (postal.length !== 7) {
            localStorage.removeItem(key);
            return;
        }
        localStorage.setItem(key, btoa(postal));
    }

    async function open(): Promise<void> {
        if (host === null || media === null) return;
        const mine = ++generation;
        loading = true;
        // 押されてから取りに行く (上の説明)
        const { BMLBrowser } = await import('$lib/vendor/web-bml/client/bml_browser');
        // 待っている間に離されていたら、作らない
        if (mine !== generation || host === null || media === null) return;

        /*
         * **毎回まっさらな入れ物を作る。**
         *
         * 借りている側は渡された要素に**閉じた影 (`attachShadow`)** を張る。
         * 影は外せないので、同じ要素に2度目を張ると転ぶ — 消して出し直すたびに
         * 「データ放送が出なくなる」という壊れ方をする
         */
        mount = document.createElement('div');
        mount.style.position = 'absolute';
        mount.style.left = '0';
        mount.style.top = '0';
        mount.style.transformOrigin = 'top left';
        /*
         * 出せと言われるまでは隠しておく (`showing` の説明)。
         *
         * **`visibility` では隠せない。** 借りものの既定のスタイルには
         * `body { visibility : visible !important }` があって、**子のほうが
         * 親の hidden を打ち消す** (visibility は継承するが、子で戻せる)。
         * 実機では「d を押すと、出るまで映像が真っ白に覆われる」形で出た。
         * `display:none` にすると寸法が測れなくなる (BML は自分で
         * `offsetLeft` を読む) ので、透明にして場所は残す
         */
        mount.style.opacity = '0';
        host.appendChild(mount);

        seat = { parent: media.parentNode as Node, next: media.nextSibling };

        receiving = false;
        settled = false;
        // 器ができる前に置く。入口の文書が真っ先に読みに来る
        remember();

        const made = new BMLBrowser({
            containerElement: mount,
            mediaElement: media,
            fonts: FONTS,
            indicator,
            ip,
            // 覚えるもの (NVRAM) は局ごとに分ける。他の使い道と混ざらないように
            storagePrefix: STORAGE_PREFIX,
            nvramPrefix: NVRAM_PREFIX,
            broadcasterDatabasePrefix: 'denpa_bcast_',
        });
        browser = made;
        loading = false;
        handed = 0;
        showing = false;
        plane = null;

        made.addEventListener('load', (event) => {
            plane = event.detail.resolution;
            fit();
            /*
             * **文書ができるたびに叩き直す。**
             *
             * 入口の文書はたいてい別の文書へ渡すだけで、その先は電波が
             * 一周するまで届かない。最初の1回ぶんだけ叩いて諦めると、
             * **本体が出てきた頃には叩き終わっている**
             */
            stopKnocking();
            knocks = KNOCK_TRIES;
            knocking = setTimeout(knock, KNOCK_WAIT);
        });
        /*
         * **「いま出ているか」を教えてくれる唯一の口。**
         *
         * 文書を組み終えた直後に必ず一度飛んでくる (`content.ts` の
         * `bmlBody.invisible = bmlBody.invisible`)
         */
        made.addEventListener('invisible', (event) => {
            showing = event.detail !== true;
            if (showing) stopKnocking();
            place();
        });

        watcher = new ResizeObserver(fit);
        watcher.observe(host);

        listen((message) => {
            handed++;
            made.emitMessage(message);
        });
        // 指のリモコンにも同じ口を渡す
        remote(tap);
    }

    function close(): void {
        generation++;
        listen(null);
        remote(null);
        loading = false;
        handed = 0;
        showing = false;
        receiving = false;
        settled = false;
        stopKnocking();
        stopWaiting();
        plane = null;
        watcher?.disconnect();
        watcher = null;
        /*
         * **映像を先に戻す。** BML の `<object>` に入ったままの入れ物ごと
         * 消すと、`<video>` が文書から抜けて画面から映像が消える
         */
        place();
        seat = null;
        browser?.destroy();
        browser = null;
        // 影ごと捨てる (上の説明)
        mount?.remove();
        mount = null;
    }

    $effect(() => {
        const want = on && media !== null && host !== null ? (channel ?? '') : null;
        if (want === shown) return;
        close();
        shown = want;
        if (want !== null) void open();
    });

    /**
     * リモコンの代わり。**十字・決定・戻る・数字・色**をそのまま渡す。
     *
     * `d` は出し入れに使うので渡さない (押しっぱなしで抜けられなくなる)。
     * 借りものが持っている対応表をそのまま使う
     */
    async function key(event: KeyboardEvent, down: boolean): Promise<void> {
        if (browser === null || event.altKey || event.ctrlKey || event.metaKey) return;
        const { keyCodeToAribKey } = await import('$lib/vendor/web-bml/client/content');
        const code = keyCodeToAribKey(event.key);
        if (code === -1) return;
        event.preventDefault();
        if (down) browser.content.processKeyDown(code);
        else browser.content.processKeyUp(code);
    }

    onDestroy(close);
</script>

<svelte:window onkeydown={(event) => void key(event, true)} onkeyup={(event) => void key(event, false)} />

<!--
    **映像と同じ枠に重ねる。** BML の画面は中で自分の大きさを決めるので、
    こちらは場所だけ用意する。出していないときは触れないようにしておく
    (押すのを邪魔しない)。

    **操作列より下に敷く** (`z-5` / `ControlBar` は `z-10`)。上に載せていた頃は、
    データ放送を出した瞬間に操作列が隠れた — そこに d ボタンも居るので、
    **出したら消せなくなる**
-->
<div
    bind:this={host}
    class="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
    class:hidden={!on}
    data-testid="live-data"
    data-state={browser !== null ? 'ready' : loading ? 'loading' : 'off'}
    data-showing={visible}
    data-receiving={receiving}
    data-for={shown ?? ''}
    data-handed={handed}
>
    <!--
        **テレビと同じ「データ取得中」。** denpa は押されてから電波を解きはじめる
        ので、テレビより待つ (実測で8秒)。何も言わずに待たせると壊れて見える
    -->
    {#if on && (loading || receiving)}
        <div class="absolute top-3 right-3 z-10" data-testid="live-data-receiving">
            <span class="rounded-box bg-black/60 px-3 py-1 text-xs text-white">データ取得中…</span>
        </div>
    {/if}
</div>
