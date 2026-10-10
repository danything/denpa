<script lang="ts">
    /**
     * 再生位置の帯。**3画面で同じ見た目。**
     *
     * Pico の range は溝を1色で塗るだけで、どこまで進んだかが見えない。進んだぶんを
     * 主の色で塗る (Firefox は `::-moz-range-progress` が持つ)。
     *
     * `marks` は切れ目 (観る画面のチャプター)。どこで CM が挟まっているかが見えると、
     * 送りのボタンを何回押すかが分かる
     */
    let {
        value,
        min = 0,
        max,
        step,
        onseek,
        marks = [],
        testid,
    }: {
        value: number;
        min?: number;
        max: number;
        step: number;
        onseek: (value: number) => void;
        /** 切れ目の位置 (`value` と同じ単位) */
        marks?: number[];
        testid?: string;
    } = $props();

    const span = $derived(max - min);
</script>

<div class="seek">
    <input
        type="range"
        style="--fill: {span > 0 ? ((value - min) / span) * 100 : 0}%"
        {min}
        {max}
        {step}
        {value}
        oninput={(event) => onseek(Number(event.currentTarget.value))}
        aria-label="再生位置"
        data-testid={testid}
    />
    {#if marks.length > 0 && span > 0}
        <div class="marks">
            <!--
                **つまみの往復ぶんを引く。** つまみは幅のぶんだけ内側を動く (端で枠から
                出ないため) ので、切れ目を素の百分率で置くと**つまみとずれます** —
                実機では、まだ来ていない CM の印が再生位置の左に出ていた。つまみは 1rem
            -->
            {#each marks as at (at)}
                <span class="mark" style="left: calc(0.5rem + {(at - min) / span} * (100% - 1rem))"></span>
            {/each}
        </div>
    {/if}
</div>

<style>
    .seek {
        position: relative;
    }
    /* 細い帯。つまみは 1rem (切れ目の位置の計算がこれを前提にしている) */
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
    input::-webkit-slider-runnable-track {
        background:
            linear-gradient(var(--pico-primary-background), var(--pico-primary-background)) 0 0 / var(--fill, 0%)
                100% no-repeat,
            var(--pico-range-border-color);
    }
    input::-moz-range-progress {
        height: var(--pico-range-height);
        border-radius: var(--pico-border-radius);
        background: var(--pico-primary-background);
    }
    .marks {
        pointer-events: none;
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 0.25rem;
    }
    .mark {
        position: absolute;
        top: 0;
        height: 0.25rem;
        width: 1px;
        background: rgb(255 255 255 / 0.7);
    }
</style>
