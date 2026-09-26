<script lang="ts" module>
    import { read } from '$lib/keep';
    import { SPEEDS } from '$lib/ts/pacing';

    /** 録画の速さを覚える鍵。観る画面と追っかけで共通 (焼く前と後で同じ録画を観る) */
    export const SPEED_KEY = 'watch-speed';

    /** 前に選んだ速さ。読めない・知らない値なら等速 */
    export function storedSpeed(): number {
        const saved = Number(read(SPEED_KEY));
        return SPEEDS.includes(saved as (typeof SPEEDS)[number]) ? saved : 1;
    }
</script>

<script lang="ts">
    import ControlButton from './ControlButton.svelte';
    import OverlayMenu from './OverlayMenu.svelte';

    /**
     * 速さの切り替え。**3画面で同じ見た目。**
     * `label` だけ画面の言葉 (ライブは「追っかけの速さ」、他は「再生の速さ」)
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

<OverlayMenu
    {testid}
    attrName="speed"
    align="end"
    size="large"
    items={SPEEDS.map((value) => ({ key: value, label: `${value}×`, active: value === speed }))}
    {onselect}
>
    {#snippet trigger()}
        <span class="speed">
            <ControlButton {label} {testid} on={speed !== 1}>
                <span style="font-variant-numeric: tabular-nums">{speed}×</span>
            </ControlButton>
        </span>
    {/snippet}
</OverlayMenu>

<style>
    /*
     * **数字だけなので、丸いボタンと同じ幅から。** 文字を添えるボタンの余白 (1.25rem) では
     * 「1×」でも 60px、「1.25×」で 80px と、隣の丸 (48px) に比べて横に間延びしていた
     */
    .speed {
        display: contents;
    }
    .speed :global(.ov-btn) {
        min-width: 3rem;
        padding-inline: 0.75rem;
    }
</style>
