<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 右の「番組の中身」の列。**観る・追っかけ・ライブ (詳細を開いた間) で同じ枠。**
     *
     * モーダルにしない — 絵の上に被さると観ながら読めない。中身が長ければ
     * **ここだけが巻き取られ** (`overflow-y: auto`)、押すもの (`footer`) は
     * 巻き取られる中身の外に貼り付けて、いつでも見えるようにする。
     *
     * 幅と高さの決めごとは3画面共通: 幅は固定で映像側だけ伸び、高さは画面の
     * 残りぜんぶ (映像の高さに揃えない理由は [watch/[id]/+page.svelte](../../../routes/watch/%5Bid%5D/+page.svelte))。
     * **二段組にした直後は細く** (256px)。理由は [ControlBar.svelte](ControlBar.svelte)。
     *
     * 中の段落を伸ばさない — daisyUI の `card-body` を使っていた頃は中の `<p>` に
     * `flex-grow: 1` が当たり、中身が枠より短いと段落が余白を全部吸っていた
     * (実機で局名の下だけ 60px 空いた)。
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
    {#if top}{@render top()}{/if}
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
    @media (min-width: 768px) {
        .facts {
            width: 16rem;
            min-height: 0;
            flex-shrink: 0;
        }
    }
    @media (min-width: 1024px) {
        .facts {
            width: 20rem;
        }
    }
    .box {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
        border-radius: 1rem;
        background: var(--dp-surface);
        box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
    }
    .body {
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        padding: 1rem;
    }
    .foot {
        display: flex;
        flex-shrink: 0;
        flex-wrap: wrap;
        gap: 0.5rem;
        padding: 1rem;
        border-top: 1px solid var(--dp-base-300);
    }
</style>
