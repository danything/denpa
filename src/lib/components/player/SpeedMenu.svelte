<script lang="ts" module>
    import { read } from '#lib/keep.js';
    import { SPEEDS } from '#lib/ts/pacing.js';

    /** 録画の速さを覚える鍵。観る画面と追っかけで共通 (焼く前と後で同じ録画を観る) */
    export const SPEED_KEY = 'watch-speed';

    /** 前に選んだ速さ。読めない・知らない値なら等速 */
    export function storedSpeed(): number {
        const saved = Number(read(SPEED_KEY));
        return SPEEDS.includes(saved as (typeof SPEEDS)[number]) ? saved : 1;
    }
</script>

<script lang="ts">
    import { speedLabel } from '#lib/ts/pacing.js';
    import ControlButton from './ControlButton.svelte';
    import { SPEED } from './icons';
    import OverlayMenu from './OverlayMenu.svelte';

    /**
     * 速さの切り替え。**3画面で同じ見た目。**
     * `label` だけ画面の言葉 (ライブは「追っかけの速さ」、他は「再生の速さ」)。
     *
     * **口は、等速ならメーターの絵だけの丸、速めている間は数字だけ (「1.25」)。**
     * 「×1」と数字を出していた頃は、ふだん (等速) でも帯に数字が居座って目に付いた。
     * 速めているときだけ数字が出れば、それ自体が「いま速めている」の印になる (押されている
     * 見た目 `on` も同じとき)。口の上では × を付けない — 速さの口だと分かっているので要らない。
     *
     * **選択肢は「×1.25」のまま。** 開いた並びには数字しか無いので、何の数か (倍) を
     * 書いておく。並びの中では「×1」が等速の行にもなる (絵の口と違い、ここには絵が無い)
     */
    let {
        testid,
        label,
        speed,
        onselect,
    }: {
        testid: string;
        label: string;
        speed: number;
        onselect: (speed: number) => void;
    } = $props();
</script>

<!--
    中身 (`children`) は速めているときだけ渡す。ControlButton は中身が無いときだけ丸くする。
    ボタンは1つのまま、絵と数字を差し替える (`{#if}` で ControlButton ごと出し分けない)
-->
{#snippet number()}
    <span style="font-variant-numeric: tabular-nums">{speed}</span>
{/snippet}

<OverlayMenu
    {testid}
    attrName="speed"
    align="end"
    size="large"
    items={SPEEDS.map((value) => ({ key: value, label: `×${value}`, active: value === speed }))}
    {onselect}
>
    {#snippet trigger()}
        <span class="speed">
            <ControlButton
                label={speedLabel(label, speed)}
                {testid}
                on={speed !== 1}
                icon={speed === 1 ? SPEED : undefined}
                children={speed === 1 ? undefined : number}
            />
        </span>
    {/snippet}
</OverlayMenu>

<style>
    /*
     * **数字のときも、丸いボタンと同じ幅から。** 文字を添えるボタンの余白 (1.25rem) では
     * 「1.25」で 80px と、隣の丸 (48px) に比べて横に間延びする。「2」は丸と同じ幅まで広げる。
     * 等速の丸 (`ov-round`) には当てない — 幅も余白も丸の決まりのまま
     */
    .speed {
        display: contents;
    }
    .speed :global(.ov-btn:not(.ov-round)) {
        min-width: 3rem;
        padding-inline: 0.75rem;
    }
    /* 狭い枠では丸も 40px になる (`ControlButton` の `data-compact`)。数字も同じ幅から */
    :global(.stage[data-compact]) .speed :global(.ov-btn:not(.ov-round)) {
        min-width: 2.5rem;
    }
</style>
