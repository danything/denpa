<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 操作バーの中で「毎回は使わないもの」を包む。**3画面で同じ。**
     *
     * 広い枠では何もしない (`display: contents`) — 包んだものは今までどおりの場所に並ぶ。
     * **畳むとき (`PlayerStage` の `data-fold`。狭い枠か、一段に収まらないとき) は隠して、
     * 「ほか」(⋯) を押したときだけ押すものの上の行に出す** (`MoreButton`)。
     *
     * 畳んだときに残すのは、画面ごとに毎回使うものだけ。観る画面は再生・チャプター送り・
     * 時刻・全画面、ライブと追っかけは再生・端 (ライブ・最新)・読みもの・全画面。
     * 音・字幕・速さ・小窓は包む。コーデック・音声・CMスキップ・アンビエントモード・バックグラウンド再生は
     * はじめから再生の設定 (⚙ `SettingsMenu`) にあり、⚙ は畳んでも残す
     * (スマホは本体のボタンで音を変えられる。字幕は出したら出したまま使う)。
     *
     * **並べ替えは CSS の `order` だけでやる** (DOM は動かさない)。中身を2か所に書くと、
     * 片方だけ直してずれる。畳んだものは `order: -2` で、開くと行の頭 (上の行) に来る
     * (`ControlRow`)。包みは何個あってもよい (速さは読みものより後ろにあるので、別に包む)
     */
    let { children }: { children: Snippet } = $props();
</script>

<span class="extras">{@render children()}</span>

<style>
    .extras {
        display: contents;
    }
    /* 測っている間 (`PlayerStage` の `data-measuring`) は、畳まずに並べたときの幅を見るので出す */
    :global(.stage[data-fold]:not([data-more]):not([data-measuring])) .extras {
        display: none;
    }
    /*
     * 包みの子は `display: contents` の入れ子 (速さの `.speed` など) のことがあるので、
     * 子孫ぜんぶに付ける。並びに効くのは操作バーの直接の並び (flex の子) だけ
     */
    :global(.stage[data-fold]) .extras :global(*) {
        order: -2;
    }
</style>
