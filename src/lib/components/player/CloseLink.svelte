<script lang="ts">
    import { resolve } from '$app/paths';
    import Icon from './Icon.svelte';
    import { CLOSE, OVERLAY, OVERLAY_BTN, OVERLAY_ROUND } from './icons.js';

    /** 右上の列のいちばん上。**観る画面と追っかけで同じ場所・同じ行き先** (一覧へ戻る) */
    let { testid }: { testid: string } = $props();
</script>

<a class="{OVERLAY_BTN} {OVERLAY_ROUND} {OVERLAY}" href={resolve('')} aria-label="一覧へ戻る" data-testid={testid}>
    <Icon icon={CLOSE} />
</a>
