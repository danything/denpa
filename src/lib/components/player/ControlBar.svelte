<script lang="ts">
    /**
     * 映像に重ねる操作列。**ライブと観る画面で同じもの。**
     *
     * - **黒いぼかしの上に置く。** 明るい絵の上でも読めるように
     * - **しばらく触らなければ消える** (`shown`)。絵の上に居座るものなので、
     *   見ている間は引っ込んでいるほうがいい
     * - 消えている間は押せなくする (`pointer-events-none`)。見えないものが
     *   押されると、絵を押したつもりが操作に取られる
     *
     * 下端 (既定) と右端 (`side`) の2つ。**下は観ながら使うもの、右は観るのを
     * やめるもの** — 閉じる・切り抜く・消すは、並べる理由も押す頻度も他と違う。
     * 1本に混ぜていた頃は、押すものが12個並んで**名前が入る幅が残らなかった**。
     *
     * 中身は画面ごとに違う (ライブは局と焼き方、観る画面は送りとチャプター)
     */
    let {
        shown = true,
        side = false,
        testid,
        children,
    }: { shown?: boolean; side?: boolean; testid?: string; children: import('svelte').Snippet } = $props();

    /**
     * ぼかしは絵の端から内側へ。伸びる向きだけが違う。
     *
     * **右の列は斜めに散らす** (`to-bl`)。左へ流すだけにしていた頃は、
     * **下端が直線で切れて**、絵の上に黒い四角を貼ったように見えていた
     */
    const place = $derived(
        side
            ? 'top-0 right-0 flex flex-col items-center gap-1 bg-gradient-to-bl from-black/70 to-transparent pt-3 pr-3 pb-12 pl-12'
            : 'inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pt-8 pb-3',
    );
</script>

<div
    class="absolute z-10 text-white transition-opacity duration-200 {place} {shown
        ? 'opacity-100'
        : 'pointer-events-none opacity-0'}"
    data-testid={testid}
    data-shown={shown}
>
    {@render children()}
</div>
