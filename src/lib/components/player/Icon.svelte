<script lang="ts">
    /**
     * 映像の上に置くアイコン1つ。**中身は `icons.ts` の `d` だけ。**
     *
     * ライブと観る画面が同じ `{#snippet icon}` を別々に持っていたのをまとめたもの
     */
    let { path, size = 'size-6' }: { path: string; size?: string } = $props();
</script>

<svg viewBox="0 0 24 24" class={size} fill="currentColor" aria-hidden="true">
    <path d={path} />
</svg>
