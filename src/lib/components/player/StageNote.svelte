<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 絵の上に浮かせる短い知らせ。**札の見た目は3画面+データ放送で同じ**
     * (角丸の黒い札。テーマ色を絵に乗せない)。
     *
     * `place` は置き場だけ — 既定 (`top`) は上端の真ん中、観る画面は操作列と
     * 重ならない `lower` (上から 3.5rem)、データ放送の「取得中」は右上の隅 (`corner`)。
     * 札そのものは変えない
     */
    let {
        testid,
        place = 'top',
        children,
    }: {
        testid: string;
        /** 置き場。札の色や形はここでは変えない */
        place?: 'top' | 'lower' | 'corner';
        children: Snippet;
    } = $props();
</script>

<div class="note {place}" data-testid={testid}>
    <span class="tag">{@render children()}</span>
</div>

<style>
    .note {
        pointer-events: none;
        position: absolute;
        z-index: 10;
        display: flex;
    }
    .top {
        left: 0;
        right: 0;
        top: 0;
        justify-content: center;
        padding: 0.5rem;
    }
    .lower {
        left: 0;
        right: 0;
        top: 3.5rem;
        justify-content: center;
    }
    .corner {
        top: 0.75rem;
        right: 0.75rem;
    }
    .tag {
        padding: 0.25rem 0.75rem;
        border-radius: 1rem;
        background: rgb(0 0 0 / 0.6);
        font-size: 0.75rem;
        color: #fff;
    }
</style>
