<script lang="ts">
    import { SPEEDS } from '$lib/ts/pacing';
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
    width="6rem"
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
