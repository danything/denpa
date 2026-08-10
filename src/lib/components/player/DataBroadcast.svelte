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
     * 借りものは 1.2MB ある。**入れっぱなしにすると、データ放送を見ない人の
     * ぶんまで毎回落ちてくる**ので、`import()` で押されてから取りに行く。
     * どのみち押してからカルーセルが一周するのを待つので、そこに紛れる。
     */
    import { onDestroy } from 'svelte';
    import type { ResponseMessage } from '$lib/vendor/web-bml/server/ws_api';

    interface Props {
        /** 出すか。**押されたら読み込みが始まる** */
        on: boolean;
        /** 映像が居る入れ物。BML から「ここに映像がある」と見える */
        media: HTMLElement | null;
        /** 知らせを受け取る口を預ける。`null` を渡すと外れる */
        listen: (handler: ((message: ResponseMessage) => void) | null) => void;
    }

    const { on, media, listen }: Props = $props();

    /** 描く場所。BML の画面 (960x540 など) がこの中に入る */
    let host = $state<HTMLDivElement | null>(null);
    /** いま動いている借りもの。型は読み込んでから決まるので緩く持つ */
    let browser = $state<{ emitMessage: (m: ResponseMessage) => void; destroy: () => void } | null>(null);
    /** 読み込み中か。**押してすぐは何も出ないので、そう言う** */
    let loading = $state(false);
    /** 何度も作らないための世代。押して離してを繰り返しても混ざらない */
    let generation = 0;
    /** その回ぶんの入れ物。**毎回作り直す** (`open` の説明) */
    let mount: HTMLDivElement | null = null;
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
        mount.className = 'absolute inset-0';
        host.appendChild(mount);

        const made = new BMLBrowser({
            containerElement: mount,
            mediaElement: media,
            fonts: FONTS,
            // 覚えるもの (NVRAM) は局ごとに分ける。他の使い道と混ざらないように
            storagePrefix: 'denpa_bml_',
            nvramPrefix: 'denpa_nvram_',
            broadcasterDatabasePrefix: 'denpa_bcast_',
        });
        browser = made;
        loading = false;
        handed = 0;
        listen((message) => {
            handed++;
            made.emitMessage(message);
        });
    }

    function close(): void {
        generation++;
        listen(null);
        loading = false;
        handed = 0;
        browser?.destroy();
        browser = null;
        // 影ごと捨てる (上の説明)
        mount?.remove();
        mount = null;
    }

    $effect(() => {
        if (on && media !== null && host !== null) void open();
        else close();
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
        const content = (browser as unknown as { content: { processKeyDown(k: number): void; processKeyUp(k: number): void } }).content;
        if (down) content.processKeyDown(code);
        else content.processKeyUp(code);
    }

    onDestroy(close);
</script>

<svelte:window
    onkeydown={(event) => void key(event, true)}
    onkeyup={(event) => void key(event, false)}
/>

<!--
    **映像と同じ枠に重ねる。** BML の画面は中で自分の大きさを決めるので、
    こちらは場所だけ用意する。出していないときは触れないようにしておく
    (押すのを邪魔しない)
-->
<div
    bind:this={host}
    class="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    class:hidden={!on}
    data-testid="live-data"
    data-state={browser !== null ? 'ready' : loading ? 'loading' : 'off'}
    data-handed={handed}
></div>
