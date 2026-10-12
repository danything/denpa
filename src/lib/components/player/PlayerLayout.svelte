<script lang="ts" module>
    /**
     * 横にしたスマホ (下の説明)。**下の `@media` と同じ条件** — CSS には変数で渡せないので、
     * 変えるときは両方 (画面側で「いま絵が画面いっぱいの形か」を知りたいときに使う)
     */
    export const PHONE_LANDSCAPE = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)';
</script>

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
     *
     * ## 横にしたスマホでは絵を画面いっぱいに
     *
     * 横にしたスマホ (844x390 など) は幅だけなら二段組に入るが、高さが足りない。
     * 見出し (64px) と右の列を残すと**絵の枠が 510x280 ほどしか残らず**、操作バーが二段に
     * 折れてシークバーが絵の真ん中に来ていた (押すつもりの無いところで位置が飛ぶ)。
     * そこで、指の端末で高さが 500px に満たない横向きでは:
     *
     * - 見出し (`+layout.svelte` の `.navbar`) を隠す。戻るのは絵の右上の × かブラウザの戻る
     * - 右の列は絵の下へ回す。絵が画面の高さいっぱいを取り、局の一覧や番組の中身は
     *   この箱の中を巻き取って読む (ライブは局を選べなくならないよう、隠さずに下へ)
     *
     * マウスの PC は窓を低くしても今までどおり (見出しを消すと行き先が無くなる)
     */
    let { testid, children, aside }: { testid?: string; children: Snippet; aside: Snippet } = $props();
</script>

<div class="layout" data-testid={testid} data-player-layout>
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
    /*
     * 横にしたスマホ (上の説明)。`--dp-gutter` は `<main>` の余白 (`+layout.svelte`)。
     * そのぶん外へはみ出して、絵を画面の端まで出す。条件は上の `PHONE_LANDSCAPE` と同じ
     */
    @media (orientation: landscape) and (max-height: 500px) and (pointer: coarse) {
        :global(body:has([data-player-layout]) .navbar) {
            display: none;
        }
        .layout {
            flex-direction: column;
            height: calc(100% + 2 * var(--dp-gutter, 1rem));
            margin: calc(-1 * var(--dp-gutter, 1rem));
            overflow-y: auto;
        }
        .main {
            flex: none;
            height: 100dvh;
            /* 絵の形の枠 (`PlayerStage`) の左右は黒。テーマの地を絵の横に出さない */
            background: #000;
        }
        .layout > :global(aside) {
            width: auto;
            margin: 0 var(--dp-gutter, 1rem) var(--dp-gutter, 1rem);
        }
    }
</style>
