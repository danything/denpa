<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 右の「番組の中身」の列。**観る・追っかけ・ライブ (詳細を開いた間) で同じ枠。**
     *
     * モーダルにしない — 絵の上に被さると観ながら読めない。中身が長ければ
     * **ここだけが巻き取られ** (`overflow-y-auto`)、押すもの (`footer`) は
     * 巻き取られる中身の外に貼り付けて、いつでも見えるようにする。
     *
     * 幅と高さの決めごとは3画面共通: 幅は固定で映像側だけ伸び、高さは画面の
     * 残りぜんぶ (映像の高さに揃えない理由は [watch/[id]/+page.svelte](../../../routes/watch/%5Bid%5D/+page.svelte))。
     * **二段組にした直後は細く** (`md:w-64`)。理由は [ControlBar.svelte](ControlBar.svelte)。
     *
     * `card-body` は使わない — daisyUI が中の `<p>` に `flex-grow: 1` を当てるので、
     * 中身が枠より短いと段落が余白を全部吸う (実機で局名の下だけ 60px 空いた)。
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

<aside class="flex flex-col md:w-64 md:min-h-0 md:shrink-0 lg:w-80">
    {#if top}{@render top()}{/if}
    <div class="card bg-base-100 flex min-h-0 flex-1 shadow">
        <div class="min-h-0 flex-1 overflow-y-auto p-4" data-testid={testid}>
            {@render children()}
        </div>
        {#if footer}
            <div class="border-base-300 flex shrink-0 flex-wrap gap-2 border-t p-4">
                {@render footer()}
            </div>
        {/if}
    </div>
</aside>
