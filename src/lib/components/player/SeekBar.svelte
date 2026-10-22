<script lang="ts">
    /**
     * 再生位置のバー。**3画面で同じ見た目。**
     *
     * 映像の上に重ねる細い溝。溝は半透明の白で、どんなコマの上でも読める
     * (明るいコマには下に薄い影)。観たぶんは主の色。マウスを載せた・キーボードで触った・
     * つまんでいる間だけ太くなり、つまみが出る。指の端末では止めている間もつまみを出す。
     *
     * `cm` は CM の区間 (観る画面)。**CM は色で分ける** — 区切りのすき間だけでは、
     * どこが CM かがひと目で読めない。CM は柔らかい琥珀、観たぶんは濃い琥珀
     * (denpa-tv と同じ `#FFB300`)。本編より明るさも違うので、色の見え方によらず分かる。
     * どこが CM かが見えると、送りのボタンを何回押すか・どこまで飛ばせばよいかが分かる。
     * `marks` はそれ以外の切れ目。どちらの切れ目でも溝を区切る (`seek-track.ts`)。
     *
     * 読み上げとキーボードは見えない `<input type="range">` が受け持つ。見えている溝は飾り。
     *
     * **つまんで動かす間は、つまみが指にそのまま付いてくる。** 指 (マウス) の位置を自分で持ち、
     * 映像が飛び終わるのを待たない (タブレットでは飛ぶのが追いつかない)。ちゃんと飛ぶのは**離したとき**の1回 (`onseek`)。`preview` を渡した
     * 画面は、動かしている間もその位置の絵を出す — ただし1度に1つまで・間を空けて、飛び終わってから
     * いちばん新しい位置へ (`preview` が返す約束で終わりを知る)。
     * 動かしている間に届く `value` はつまみに使わない (戻って見える)。離したあとも、
     * `value` が動くまでは離した位置に置いておく
     */
    import '@anyblades/blades/layered/forms/input-range';
    import { playedIn, trackParts } from './seek-track';

    /** 下見の間を少なくともこれだけ空ける (ms)。飛ぶのが速い端末でも絵の読み込みを詰めすぎない */
    const PREVIEW_GAP = 150;
    /** 離したあと、`value` が動かなくてもつまみを返すまで (ms)。同じ位置へ飛んだときなど */
    const SETTLE = 1500;

    let {
        value,
        min = 0,
        max,
        step,
        onseek,
        cm = [],
        marks = [],
        valuetext,
        paused = false,
        testid,
        preview,
        scrub = $bindable(null),
    }: {
        value: number;
        min?: number;
        max: number;
        step: number;
        onseek: (value: number) => void;
        /** CM の区間 (`value` と同じ単位。重ならず並んでいること) */
        cm?: { start: number; end: number }[];
        /** 溝を区切る切れ目の位置 (`value` と同じ単位) */
        marks?: number[];
        /**
         * 読み上げで言う位置 (`aria-valuetext`)。**色だけに頼らない** — 「12:34、CM」のように
         * いまの区間の名前を添える
         */
        valuetext?: string | undefined;
        /** 止めているか。指の端末では、止めている間つまみを出す (マウスを載せられないので) */
        paused?: boolean;
        testid?: string;
        /**
         * つまんで動かしている間の下見。渡すと、動かしている間もその位置へ (粗く) 飛ぶ。
         * 返す約束が終わる (飛び終わる) まで次は頼まない。渡さなければ離したときだけ飛ぶ
         * (飛ぶのが重いプレイヤー向け)
         */
        preview?: ((value: number) => unknown) | undefined;
        /** つまんで動かしている間の位置 (`value` と同じ単位)。触っていなければ `null`。時刻の表示に使う */
        scrub?: number | null;
    } = $props();

    const span = $derived(max - min);
    /** 離したあと、飛び終わるまで置いておく位置 */
    let landing = $state<number | null>(null);
    const shown = $derived(scrub ?? landing ?? value);
    const ratio = $derived(span > 0 ? Math.min(1, Math.max(0, (shown - min) / span)) : 0);
    const parts = $derived(trackParts(cm, marks, min, max));
    const percent = (r: number) => `${Math.round(r * 1000000) / 10000}%`;

    let root = $state<HTMLDivElement | null>(null);
    /** つまんでいる指 (マウス) の `pointerId` */
    let pointer: number | null = null;
    /** 離したときの `value`。ここから動いたら飛んだ先に着いたとみる */
    let leftAt: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    /** 押している位置を値にする。刻み (`step`) に揃え、端は超えない */
    function under(event: PointerEvent): number {
        const rect = (root as HTMLDivElement).getBoundingClientRect();
        const r = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
        const raw = min + r * span;
        const snapped = step > 0 ? min + Math.round((raw - min) / step) * step : raw;
        return Math.min(max, Math.max(min, Math.round(snapped * 1000) / 1000));
    }

    function settled(): void {
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = null;
        landing = null;
        leftAt = null;
    }

    // 離したあと `value` が動いた = 飛んだ先に着いた (か、CM を跨いで先へ行った)。つまみを返す
    $effect(() => {
        if (landing !== null && leftAt !== null && value !== leftAt) settled();
    });
    $effect(() => () => {
        if (settleTimer !== null) clearTimeout(settleTimer);
    });

    /*
     * 下見は1度に1つまで。終わったら、間 (`PREVIEW_GAP`) を空けていちばん新しい位置へ。
     * 飛び終わらないまま次を頼むと前のを捨ててやり直すので、いつまでも絵が出ない
     */
    let wanted: number | null = null;
    let busy = false;
    let lastPreview = Number.NEGATIVE_INFINITY;
    let lastAsked: number | null = null;

    /** つまみを指の位置へ。下見があれば頼む */
    function follow(event: PointerEvent): void {
        scrub = under(event);
        if (preview === undefined) return;
        wanted = scrub;
        pump();
    }

    function pump(): void {
        if (busy || pointer === null || wanted === null || preview === undefined) return;
        if (wanted === lastAsked) {
            wanted = null;
            return;
        }
        const wait = PREVIEW_GAP - (performance.now() - lastPreview);
        if (wait > 0) {
            busy = true;
            setTimeout(() => {
                busy = false;
                pump();
            }, wait);
            return;
        }
        const at = wanted;
        const run = preview;
        wanted = null;
        lastAsked = at;
        busy = true;
        lastPreview = performance.now();
        void Promise.resolve()
            .then(() => run(at))
            .catch(() => undefined)
            .finally(() => {
                busy = false;
                pump();
            });
    }

    function down(event: PointerEvent): void {
        if (event.button !== 0 || !(span > 0) || root === null) return;
        // 押した所へすぐ。文字選びやページの送りは起こさない
        event.preventDefault();
        root.setPointerCapture(event.pointerId);
        pointer = event.pointerId;
        settled();
        lastAsked = null;
        follow(event);
    }

    function move(event: PointerEvent): void {
        if (event.pointerId === pointer) follow(event);
    }

    /** 離した。ここで1回だけちゃんと飛ぶ。取り消し (`pointercancel`) でも最後の位置へ */
    function up(event: PointerEvent): void {
        if (event.pointerId !== pointer) return;
        const to = event.type === 'pointerup' ? under(event) : (scrub ?? value);
        pointer = null;
        wanted = null;
        leftAt = value;
        landing = to;
        scrub = null;
        settleTimer = setTimeout(settled, SETTLE);
        onseek(to);
    }
</script>

<!-- 押すのは溝の全体 (指の端末では上へ広げてある)。キーボードは入力欄が受け持つ -->
<!-- svelte-ignore a11y_no_static_element_interactions -- 役割は中の入力欄 (range) が持つ。ここは指とマウスを受けるだけ -->
<div
    class="seek"
    bind:this={root}
    data-paused={paused || undefined}
    data-dragging={scrub !== null || undefined}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
>
    <!-- `data-part` は溝の部分 (e2e が当てる)。CM の部分は `cm` -->
    <div class="track" aria-hidden="true">
        {#each parts as part (part.from)}
            <div
                class="part"
                data-part={part.cm ? 'cm' : 'main'}
                style:left={percent(part.from)}
                style:width={percent(part.to - part.from)}
            >
                <div class="bar">
                    <div class="played" style:width={percent(playedIn(part, ratio))}></div>
                </div>
            </div>
        {/each}
    </div>
    <div class="thumb" aria-hidden="true" style:left={percent(ratio)}></div>
    <!-- `data-cm` は CM の区間 (e2e が当てる) -->
    <input
        type="range"
        {min}
        {max}
        {step}
        value={shown}
        oninput={(event) => onseek(Number(event.currentTarget.value))}
        aria-label="再生位置"
        aria-valuetext={valuetext}
        data-cm={cm.length > 0 ? cm.map((s) => `${s.start}-${s.end}`).join(' ') : undefined}
        data-testid={testid}
    />
</div>

<style>
    /*
     * 見た目の高さは 1.5rem (24px)。指の端末では押せる所を上へ広げて 48px ほどにする
     * (`::before`。下は操作列のボタンなので広げすぎない)。溝は真ん中に 4px、触っている間は 6px。
     * 色は舞台がいつも黒いので、ダーク・ライトで変えない。
     * `touch-action: none` — 横に動かしている間にページが動かないように
     */
    .seek {
        --seek-track: rgb(255 255 255 / 0.22);
        --seek-played: var(--pico-primary-background);
        --seek-cm: rgb(255 200 95 / 0.55);
        --seek-cm-played: rgb(255 179 0);
        position: relative;
        height: 1.5rem;
        border-radius: var(--dp-radius-sm);
        cursor: pointer;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
    }
    @media (pointer: coarse) {
        .seek::before {
            content: '';
            position: absolute;
            inset: -1.25rem 0 -0.25rem;
        }
    }
    .track {
        position: absolute;
        inset-inline: 0;
        top: 50%;
        height: 4px;
        margin-top: -2px;
        filter: drop-shadow(0 0 1px rgb(0 0 0 / 0.5));
        transition: transform var(--dp-duration) var(--dp-ease);
        pointer-events: none;
    }
    /*
     * 切れ目は 2px のすき間。両端の部分は溝の端まで。
     * 2px に満たない部分 (長いバーの短い CM) も 1px は残す (すき間で消えないように)
     */
    .part {
        position: absolute;
        top: 0;
        bottom: 0;
    }
    .bar {
        height: 100%;
        min-width: 1px;
        margin-inline: 1px;
        border-radius: 2px;
        overflow: hidden;
        background: var(--seek-track);
    }
    .part:first-child .bar {
        margin-left: 0;
    }
    .part:last-child .bar {
        margin-right: 0;
    }
    .part[data-part='cm'] .bar {
        background: var(--seek-cm);
    }
    .played {
        height: 100%;
        background: var(--seek-played);
    }
    .part[data-part='cm'] .played {
        background: var(--seek-cm-played);
    }
    .thumb {
        position: absolute;
        top: 50%;
        width: 0.75rem;
        height: 0.75rem;
        margin: -0.375rem 0 0 -0.375rem;
        border-radius: 50%;
        background: var(--seek-played);
        box-shadow: 0 0 2px rgb(0 0 0 / 0.5);
        opacity: 0;
        transform: scale(0.5);
        transition:
            opacity var(--dp-duration) var(--dp-ease),
            transform var(--dp-duration) var(--dp-ease);
        pointer-events: none;
    }
    /*
     * 太くなり、つまみが出る: マウスを載せている・キーボードで触っている・つまんでいる間。
     * 指の端末では止めている間もつまみだけ出す
     */
    @media (hover: hover) {
        .seek:hover .track {
            transform: scaleY(1.5);
        }
        .seek:hover .thumb {
            opacity: 1;
            transform: none;
        }
    }
    @media (hover: none) {
        .seek[data-paused] .thumb {
            opacity: 1;
            transform: none;
        }
    }
    .seek:is(:active, [data-dragging], :has(input:focus-visible)) .track {
        transform: scaleY(1.5);
    }
    .seek:is(:active, [data-dragging], :has(input:focus-visible)) .thumb {
        opacity: 1;
        transform: none;
    }
    .seek:has(input:focus-visible) {
        outline: 2px solid var(--pico-primary);
        outline-offset: 2px;
    }
    /*
     * 入力欄は溝の上に重ねて透かす。**指とマウスは受けない** (つまむのは `.seek` が受け持つ)。
     * つまみは幅 1px にして、値と溝の位置が端から端までまっすぐ対応するようにする (`seek-track.ts`)。
     * 2つのブラウザの擬似要素は1つの規則にまとめられない (知らないほうが規則ごと捨てる)
     */
    input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        opacity: 0;
        pointer-events: none;
        appearance: none;
        background: transparent;
    }
    input::-webkit-slider-runnable-track {
        height: 100%;
        border: 0;
        background: transparent;
    }
    input::-webkit-slider-thumb {
        appearance: none;
        width: 1px;
        height: 100%;
        margin-top: 0;
        border: 0;
    }
    input::-moz-range-track {
        height: 100%;
        border: 0;
        background: transparent;
    }
    input::-moz-range-thumb {
        width: 1px;
        height: 100%;
        border: 0;
    }
</style>
