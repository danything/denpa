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
     * 押すのも読み上げもキーボードも、見えない `<input type="range">` が受け持つ。
     * 見えている溝は飾り
     */
    import { playedIn, trackParts } from './seek-track';

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
    } = $props();

    const span = $derived(max - min);
    const ratio = $derived(span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0);
    const parts = $derived(trackParts(cm, marks, min, max));
    const percent = (r: number) => `${Math.round(r * 1000000) / 10000}%`;
</script>

<div class="seek" data-paused={paused || undefined}>
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
        {value}
        oninput={(event) => onseek(Number(event.currentTarget.value))}
        aria-label="再生位置"
        aria-valuetext={valuetext}
        data-cm={cm.length > 0 ? cm.map((s) => `${s.start}-${s.end}`).join(' ') : undefined}
        data-testid={testid}
    />
</div>

<style>
    /*
     * 押せる高さは 1.5rem (24px。指でも外さない)。溝は真ん中に 4px、触っている間は 6px。
     * 色は舞台がいつも黒いので、ダーク・ライトで変えない
     */
    .seek {
        --seek-track: rgb(255 255 255 / 0.22);
        --seek-played: var(--pico-primary-background);
        --seek-cm: rgb(255 200 95 / 0.55);
        --seek-cm-played: rgb(255 179 0);
        position: relative;
        height: 1.5rem;
        border-radius: var(--dp-radius-sm);
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
    .part[data-part="cm"] .bar {
        background: var(--seek-cm);
    }
    .played {
        height: 100%;
        background: var(--seek-played);
    }
    .part[data-part="cm"] .played {
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
    .seek:is(:active, :has(input:focus-visible)) .track {
        transform: scaleY(1.5);
    }
    .seek:is(:active, :has(input:focus-visible)) .thumb {
        opacity: 1;
        transform: none;
    }
    .seek:has(input:focus-visible) {
        outline: 2px solid var(--pico-primary);
        outline-offset: 2px;
    }
    /*
     * 入力欄は溝の上に重ねて透かす。つまみは幅 1px にして、押した位置と値が溝の端から端まで
     * まっすぐ対応するようにする (`seek-track.ts`)。2つのブラウザの擬似要素は1つの規則にまとめられない
     * (知らないほうが規則ごと捨てる)
     */
    input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        opacity: 0;
        cursor: pointer;
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
