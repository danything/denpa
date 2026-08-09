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
     * **敷くのは下端だけ。**
     *
     * 下は絵の幅いっぱいに渡るので、まっすぐ上へ流せば端が出ない。文字 (時刻・
     * 番組名) を載せるのもこちらなので、明るい絵の上でも読めるように要る。
     *
     * **右端には敷かない。** 載っているのは丸いボタンだけで、そのひとつずつが
     * 既に黒く敷いてある (`OVERLAY`)。全体にも敷くと、絵の上に**四角い影が
     * 貼り付いて**見える — 直線のぼかしは色の変わり目が一方向にしか進まない
     * ので、横へ流せば下端が、斜めへ流せば左端と下端が直線で切れる。
     * 角から丸く散らす手もあるが、要らないものを丁寧に薄くしているだけだった
     */
    const place = $derived(
        side
            ? 'top-0 right-0 flex flex-col items-center gap-1 p-3'
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
