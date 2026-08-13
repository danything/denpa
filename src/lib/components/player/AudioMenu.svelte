<script lang="ts" generics="T extends string | number">
    import ControlButton from './ControlButton.svelte';
    import { AUDIO } from './icons';
    import OverlayMenu from './OverlayMenu.svelte';

    /**
     * 音声の選び直し。**3画面で同じ見た目。**
     *
     * 二カ国語も多重音声も、見ている人には「音声を選ぶ」1つの操作でしかない。
     * 選べるものが2つ以上あるときだけ出す — その判定は呼び出し側が持つ
     * (何が「選べるもの」かは画面ごとに違う: ライブは焼き直し、録画は器の中)
     */
    let {
        testid,
        items,
        onselect,
    }: {
        testid: string;
        items: { key: T; label: string; active: boolean }[];
        onselect: (key: T) => void;
    } = $props();
</script>

<OverlayMenu {testid} attrName="audio" {items} {onselect}>
    {#snippet trigger()}
        <ControlButton path={AUDIO} label="音声を選ぶ" {testid}>
            <span class="hidden max-w-28 truncate sm:inline">
                {items.find((item) => item.active)?.label ?? '音声'}
            </span>
        </ControlButton>
    {/snippet}
</OverlayMenu>
