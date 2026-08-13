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
    position="dropdown-top dropdown-end"
    menuClass="w-24 gap-1 text-lg"
    optionClass="tabular-nums justify-center py-2"
    items={SPEEDS.map((value) => ({ key: value, label: `${value}×`, active: value === speed }))}
    {onselect}
>
    {#snippet trigger()}
        <ControlButton {label} {testid} on={speed !== 1}>
            <span class="tabular-nums">{speed}×</span>
        </ControlButton>
    {/snippet}
</OverlayMenu>
