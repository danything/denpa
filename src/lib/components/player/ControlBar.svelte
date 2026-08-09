<script lang="ts">
    /**
     * 映像の下端に敷く操作列。**ライブと観る画面で同じもの。**
     *
     * - **黒いぼかしの上に置く。** 明るい絵の上でも読めるように
     * - **しばらく触らなければ消える** (`shown`)。絵の上に居座るものなので、
     *   見ている間は引っ込んでいるほうがいい
     * - 消えている間は押せなくする (`pointer-events-none`)。見えないものが
     *   押されると、絵を押したつもりが操作に取られる
     *
     * 中身は画面ごとに違う (ライブは局と焼き方、観る画面は送りとチャプター)
     */
    let {
        shown = true,
        testid,
        children,
    }: { shown?: boolean; testid?: string; children: import('svelte').Snippet } = $props();
</script>

<div
    class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-3 text-white transition-opacity duration-200 {shown
        ? 'opacity-100'
        : 'pointer-events-none opacity-0'}"
    data-testid={testid}
    data-shown={shown}
>
    {@render children()}
</div>
