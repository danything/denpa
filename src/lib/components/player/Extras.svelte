<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 操作バーの中で「毎回は使わないもの」を包む。**3画面で同じ。**
     *
     * 広い枠では何もしない (`display: contents`) — 包んだものは今までどおりの場所に並ぶ。
     * **畳むとき (`PlayerStage` の `data-fold`。狭い枠か、一段に収まらないとき) は隠す。** 同じものは
     * 再生の設定 (⚙) の頭に行として並ぶ (`StageTail` の `fold`。音・速さ・Hybridcast・小窓)。
     * 字幕の出し入れは ⚙ の「字幕」の行が持っている。キー操作 (m・c・`<` `>`) は畳んでも効く。
     *
     * 畳んだときに残すのは、画面ごとに毎回使うものだけ。観る画面は再生・チャプター送り・
     * 時刻・⚙・全画面、ライブと追っかけは再生・端 (ライブ・最新)・読みもの・⚙・全画面。
     * スマホの縦ではこれで一段に収まる (「ほか」(⋯) のボタンを置いていた頃は、開くと二段になっていた)
     */
    let { children }: { children: Snippet } = $props();
</script>

<span class="extras">{@render children()}</span>

<style>
    .extras {
        display: contents;
    }
    /* 測っている間 (`PlayerStage` の `data-measuring`) は、畳まずに並べたときの幅を見るので出す */
    :global(.stage[data-fold]:not([data-measuring])) .extras {
        display: none;
    }
</style>
