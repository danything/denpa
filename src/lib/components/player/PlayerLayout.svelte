<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 3画面 (ライブ・追っかけ・観る画面) の外枠。**映像が左、読むものが右。**
     *
     * 右は映像の高さに合わせない。**タブレット (`md` = 768px) から2段組**、狭い画面では
     * 映像が上・右の列が下に積まれ、ページごとスクロールする。広い画面では
     * ページを動かさない (`+layout.svelte` の `fill`) — 映像を見ながら読むので、
     * ページが動くと絵が画面から出ていく。
     *
     * 二段組にする幅を画面ごとに変えていた頃は、**同じ幅で絵の大きさが変わって**いた
     * (縦の iPad 820px で、ライブ 772px に対して観る画面 436px)。
     * **周りの余白も横幅の頭打ちも足さない** — 外の `<main>` が持っている
     */
    let { testid, children, aside }: { testid?: string; children: Snippet; aside: Snippet } = $props();
</script>

<div class="layout" data-testid={testid}>
    <!-- **映像を先に書く。** 縦積みになったときに上へ来るのはこちら -->
    <section class="main">
        {@render children()}
    </section>
    {@render aside()}
</div>

<style>
    .layout {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }
    .main {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
    }
    @media (min-width: 768px) {
        .layout {
            height: 100%;
            min-height: 0;
            flex-direction: row;
        }
        .main {
            min-height: 0;
        }
    }
</style>
