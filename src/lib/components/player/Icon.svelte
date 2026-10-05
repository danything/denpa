<script lang="ts">
    import type { IconShape } from './icons';

    /**
     * アイコン1つ。**中身は `icons.ts` の部品 (Lucide) をそのまま渡す。**
     *
     * 各画面が同じ `{#snippet icon}` を別々に持っていたのをまとめたもの。
     * 読み上げはボタンの `aria-label` に任せるので、絵そのものは隠す
     */
    let { icon: Shape, size = 'size-6' }: { icon: IconShape; size?: string } =
        $props();
    /** 大きさは `size-N` (N × 0.25rem。Tailwind の頃の書き方をそのまま受ける) */
    const rem = $derived(Number(/^size-(\d+(?:\.\d+)?)$/.exec(size)?.[1] ?? 6) * 0.25);
</script>

<Shape width="{rem}rem" height="{rem}rem" style="flex-shrink: 0" aria-hidden="true" />
