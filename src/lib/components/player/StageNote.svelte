<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 絵の上に浮かせる短い知らせ。**札の見た目は3画面+データ放送で同じ**
     * (`rounded-box bg-black/60`。テーマ色を絵に乗せない)。
     *
     * `wrap` は置き場だけ — 既定は上端の真ん中、観る画面は操作列と重ならない
     * `top-14`、データ放送の「取得中」は右上の隅。札そのものは変えない
     */
    let {
        testid,
        wrap = 'inset-x-0 top-0 justify-center p-2',
        children,
    }: {
        testid: string;
        /** 位置どりのクラス。札の色や形はここでは変えない */
        wrap?: string;
        children: Snippet;
    } = $props();
</script>

<div class="pointer-events-none absolute z-10 flex {wrap}" data-testid={testid}>
    <span class="rounded-box bg-black/60 px-3 py-1 text-xs text-white">{@render children()}</span>
</div>
