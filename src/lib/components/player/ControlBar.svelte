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
     * ぼかしは絵の端から内側へ。
     *
     * **下端は絵の幅いっぱいなので、まっすぐ上へ流せばよい。** 逃げ場のある
     * 端が上の1つしかないので、直線のぼかしで端が出ない。
     *
     * **右端は角から丸く散らす** (`radial`)。直線のぼかしは色の変わり目が
     * 一方向にしか進まないので、横へ流すと**下端が、斜めへ流すと左端と下端が
     * 直線で切れて**、絵の上に黒い四角を貼ったように見えていた。右上の角を
     * 中心に散らせば、内側を向いている二辺 (左と下) が両方とも消えていく
     */
    const place = $derived(
        side
            ? 'top-0 right-0 flex flex-col items-center gap-1 pt-3 pr-3 pb-16 pl-16 ' +
                  'bg-[radial-gradient(120%_120%_at_100%_0%,#000000b3_0%,#00000000_70%)]'
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
