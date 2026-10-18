<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 右の「番組の中身」の列。**観る・追っかけ・ライブ (詳細を開いた間) で同じ枠。**
     *
     * モーダルにしない — 映像の上に被さると観ながら読めない。中身が長ければ
     * **ここだけが巻き取られ** (`overflow-y: auto`)、押すもの (`footer`) は
     * 巻き取られる中身の外に貼り付けて、いつでも見えるようにする。
     *
     * 幅と高さ・広い画面でのサイドバーの形 (窓の右端に付け、左の線で区切る) は3画面共通で、
     * [PlayerLayout.svelte](PlayerLayout.svelte) が持つ。高さは画面の残りぜんぶ (映像の高さに
     * 揃えない理由は [watch/[id]/+page.svelte](../../../routes/watch/%5Bid%5D/+page.svelte))。
     * 中の余白はサイドバーのとき `--dp-side-pad` (巻き取る箱は列の幅いっぱい)。
     */
    let {
        testid,
        top,
        children,
        footer,
    }: {
        testid?: string;
        /** 枠の上に置くもの (データ放送のリモコンなど)。枠の外なので巻き取られない */
        top?: Snippet;
        children: Snippet;
        /** 押すもの。巻き取られる中身の外に貼り付ける */
        footer?: Snippet;
    } = $props();
</script>

<aside class="facts">
    {#if top}<div class="top">{@render top()}</div>{/if}
    <div class="box">
        <div class="body" data-testid={testid}>
            {@render children()}
        </div>
        {#if footer}
            <div class="foot">
                {@render footer()}
            </div>
        {/if}
    </div>
</aside>

<style>
    .facts {
        display: flex;
        flex-direction: column;
    }
    .top {
        padding: var(--dp-side-pad, 0) var(--dp-side-pad, 0) 0;
    }
    /* 中身が無ければ場所も取らない (データ放送を出していない間のリモコン) */
    .top:empty {
        display: none;
    }
    /*
     * カードにしない。高さは画面の残りぜんぶで映像とは揃わないので、枠があると
     * 映像の下端とずれた枠の下端が目立った。地の上に文字だけを置く
     */
    .box {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
    }
    .body {
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        padding: var(--dp-side-pad, 0.25rem) var(--dp-side-pad, 0.5rem) 1rem;
    }
    .foot {
        display: flex;
        flex-shrink: 0;
        flex-wrap: wrap;
        gap: 0.5rem;
        padding: 0.75rem var(--dp-side-pad, 0.5rem);
        border-top: 1px solid var(--dp-line);
    }
</style>
