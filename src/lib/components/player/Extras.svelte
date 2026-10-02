<script lang="ts">
    import type { Snippet } from 'svelte';

    /**
     * 帯の中で「毎回は使わないもの」を包む。**3画面で同じ。**
     *
     * 広い枠では何もしない (`display: contents`) — 包んだものは今までどおりの場所に並ぶ。
     * **狭い枠 (スマホの縦。`PlayerStage` の `data-compact`) では畳んで、「ほか」(⋯) を
     * 押したときだけ押すものの上の行に出す** (`MoreButton`)。
     *
     * 狭い枠に毎回全部並べていた頃は、観る画面で 9 個 (再生・音・字幕・音声・送り2つ・
     * CM・速さ・全画面) が 358px に入らず帯が折れ、**絵がほとんど隠れて**いた。
     * 残すのは再生・音・字幕・端 (ライブ・最新)・全画面だけ。
     *
     * **並べ替えは CSS の `order` だけでやる** (DOM は動かさない)。中身を2か所に書くと、
     * 片方だけ直してずれる。畳んだものは `order: -2`、読みもの (`InfoBlock`) は
     * `order: -1` で一行を取るので、開くと「畳んだもの → 読みもの → 押すもの」の順になる。
     * 包みは何個あってもよい (速さは読みものより後ろにあるので、別に包む)
     */
    let { children }: { children: Snippet } = $props();
</script>

<span class="extras">{@render children()}</span>

<style>
    .extras {
        display: contents;
    }
    :global(.stage[data-compact]:not([data-more])) .extras {
        display: none;
    }
    /*
     * 包みの子は `display: contents` の入れ子 (速さの `.speed` など) のことがあるので、
     * 子孫ぜんぶに付ける。並びに効くのは帯の直接の並び (flex の子) だけ
     */
    :global(.stage[data-compact]) .extras :global(*) {
        order: -2;
    }
</style>
