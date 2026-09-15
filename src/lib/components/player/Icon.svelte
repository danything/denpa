<script lang="ts">
    /**
     * 映像の上に置くアイコン1つ。**中身は `icons.ts` の `d` だけ。**
     *
     * 各画面が同じ `{#snippet icon}` を別々に持っていたのをまとめたもの
     */
    let { path, size = 'size-6' }: { path: string; size?: string } = $props();
    /** 大きさは `size-N` (N × 0.25rem。Tailwind の頃の書き方をそのまま受ける) */
    const rem = $derived(Number(/^size-(\d+(?:\.\d+)?)$/.exec(size)?.[1] ?? 6) * 0.25);
</script>

<svg viewBox="0 0 24 24" style="width: {rem}rem; height: {rem}rem; flex-shrink: 0" fill="currentColor" aria-hidden="true">
    <path d={path} />
</svg>
