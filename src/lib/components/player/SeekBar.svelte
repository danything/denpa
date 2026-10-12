<script lang="ts">
    /**
     * 再生位置のバー。**3画面で同じ見た目。**
     *
     * Pico の range は溝を1色で塗るだけで、どこまで進んだかが見えない。進んだぶんを
     * 主の色で塗る。
     *
     * `cm` は CM の区間 (観る画面)。**琥珀で塗る** (denpa-tv と同じ色と意味)。どこが CM かが
     * 見えると、送りのボタンを何回押すか・どこまで飛ばせばよいかが分かる。`marks` は
     * それ以外の切れ目で、細い目盛りを打つ。塗りも目盛りも溝の background に描く
     * (`seek-track.ts`)
     */
    import { trackAt, trackLayers } from './seek-track';

    let {
        value,
        min = 0,
        max,
        step,
        onseek,
        cm = [],
        marks = [],
        valuetext,
        testid,
    }: {
        value: number;
        min?: number;
        max: number;
        step: number;
        onseek: (value: number) => void;
        /** CM の区間 (`value` と同じ単位。重ならず並んでいること) */
        cm?: { start: number; end: number }[];
        /** 目盛りを打つ切れ目の位置 (`value` と同じ単位) */
        marks?: number[];
        /**
         * 読み上げで言う位置 (`aria-valuetext`)。**色だけに頼らない** — 「12:34、CM」のように
         * いまの区間の名前を添える
         */
        valuetext?: string | undefined;
        testid?: string;
    } = $props();

    const span = $derived(max - min);
    const fill = $derived(trackAt(span > 0 ? (value - min) / span : 0));
    const layers = $derived(trackLayers(cm, marks, min, max));
</script>

<div class="seek">
    <!-- `data-cm` は塗った区間 (e2e が当てる。塗りは background なので要素からは読めない) -->
    <input
        type="range"
        style:--fill={fill}
        style:--cm={layers.cm}
        style:--ticks={layers.ticks}
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
    /* 細いバー。つまみは 1rem (塗りの位置の計算 `trackAt` がこれを前提にしている) */
    input {
        --pico-range-thumb-height: 1rem;
        --pico-range-thumb-width: 1rem;
        --pico-range-height: 0.25rem;
        --pico-range-thumb-color: var(--pico-primary-background);
        --pico-range-thumb-active-color: var(--pico-primary-background);
        width: 100%;
        height: 1rem;
        margin: 0;
        accent-color: var(--pico-primary-background);
    }
    /*
     * 溝の層は上から: 目盛り・観たぶん (主の色)・CM (琥珀)・溝の地。
     * Firefox も同じ層で描く (`::-moz-range-progress` は使わない) — 目盛りを観たぶんの上に出すため。
     * 2つのブラウザの擬似要素は1つの規則にまとめられない (知らないほうが規則ごと捨てる)
     */
    input::-webkit-slider-runnable-track {
        background:
            var(--ticks, none),
            linear-gradient(var(--pico-primary-background), var(--pico-primary-background)) 0 0 / var(--fill, 0%)
                100% no-repeat,
            var(--cm, none),
            var(--pico-range-border-color);
    }
    input::-moz-range-track {
        background:
            var(--ticks, none),
            linear-gradient(var(--pico-primary-background), var(--pico-primary-background)) 0 0 / var(--fill, 0%)
                100% no-repeat,
            var(--cm, none),
            var(--pico-range-border-color);
    }
    input::-moz-range-progress {
        background: transparent;
    }
</style>
