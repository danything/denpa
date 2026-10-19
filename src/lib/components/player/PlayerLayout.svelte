<script lang="ts" module>
    /**
     * 横にしたスマホ (下の説明)。**下の `@media` と同じ条件** — CSS には変数で渡せないので、
     * 変えるときは両方 (画面側で「いま映像が画面いっぱいの形か」を知りたいときに使う)
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
     * ページが動くと映像が画面から出ていく。
     *
     * 二段組にする幅を画面ごとに変えていた頃は、**同じ幅で映像の大きさが変わって**いた
     * (縦の iPad 820px で、ライブ 772px に対して観る画面 436px)。
     * **周りの余白も横幅の頭打ちも足さない** — 外の `<main>` が持っている
     * (二段組では余白の幅 `--dp-gutter` だけをここで詰める。下の style)
     *
     * ## 横にしたスマホでは映像を画面いっぱいに
     *
     * 横にしたスマホ (844x390 など) は幅だけなら二段組に入るが、高さが足りない。
     * 見出し (64px) と右の列を残すと**映像の枠が 510x280 ほどしか残らず**、操作バーが二段に
     * 折れてシークバーが映像の真ん中に来ていた (押すつもりの無いところで位置が飛ぶ)。
     * そこで、指の端末で高さが 500px に満たない横向きでは:
     *
     * - 見出し (`+layout.svelte` の `.navbar`) を隠す。戻るのは映像の右上の × かブラウザの戻る
     * - 右の列は映像の下へ回す。映像が画面の高さいっぱいを取り、局の一覧や番組の中身は
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
        /*
         * **映像の周りの余白は詰める** (ほかの画面の 1.5rem → 1rem)。映像は見るためのものなので、
         * 一覧や設定と同じ余白を取ると、そのぶん映像が小さくなる
         */
        :global(body main:has([data-player-layout])) {
            --dp-gutter: 1rem;
        }
        .layout {
            height: 100%;
            min-height: 0;
            flex-direction: row;
            /* 映像の右も左と同じ余白にする (右の列は窓の端まで出るので) */
            gap: var(--dp-gutter, 1.5rem);
        }
        /*
         * **映像は上に寄せる。** 真ん中に置いてみたが (#1022)、見出しのすぐ下から映像が始まるほうが
         * 目で追いやすいので戻した。下に残る空きはそのまま (アンビエントモードの色が出る所)
         */
        .main {
            min-height: 0;
        }
        /*
         * **右の列は窓の右端に付けたサイドバー。** `<main>` の余白 (`--dp-gutter`) の外へ
         * 上・右・下にはみ出し、ヘッダーの下 (ヘッダーを隠す画面では窓の上) から窓の下まで届く。
         * **区切りの線も面の色も付けない** — 地はページと同じで、映像との間は余白 (`--dp-gutter`) だけで分ける
         * (アンビエントモードでは窓全体の色の上に載る。線と面があると、映像を開いてから色が出るまでの間だけ
         * 線が見えて、ちらついた)。中身の余白は列の中身が `--dp-side-pad` で取る — 巻き取る箱を
         * 列の幅いっぱいにして、スクロールバーを窓の右端に出すため。
         *
         * 幅は固定で映像側だけ伸びる。**二段組にした直後は細く** (256px)。理由は
         * [ControlBar.svelte](ControlBar.svelte)。列が右の余白を使うぶん、映像は前より広く残る
         */
        .layout > :global(aside) {
            /*
             * 中身の余白は映像の周りの余白と同じ (`--dp-gutter`)。上は `--dp-page-top` で、二段組ではどちらも 1rem。列の最初のもの (タブ・番組名) の上端が
             * 映像の上端とそろう。1.25rem にしていた頃は、列の中身だけ 4px 下から始まっていた
             */
            --dp-side-pad: var(--dp-gutter, 1rem);
            width: 16rem;
            min-height: 0;
            flex-shrink: 0;
            margin: calc(-1 * var(--dp-page-top, 1rem)) calc(-1 * var(--dp-gutter, 1.5rem))
                calc(-1 * var(--dp-gutter, 1.5rem)) 0;
        }
    }
    /*
     * **見出しの下の線も付けない** (3画面とも。右の列の線と同じ理由)。スクロールで線と影を濃くする動き
     * (`+layout.svelte`) も止める — 二段組ではページごとは動かない
     */
    :global(body:has([data-player-layout]) .navbar) {
        border-bottom-color: transparent;
        box-shadow: none;
        animation: none;
    }
    @media (min-width: 1024px) {
        .layout > :global(aside) {
            width: 20rem;
        }
    }
    /*
     * 横にしたスマホ (上の説明)。`--dp-gutter` は `<main>` の余白 (`+layout.svelte`)。
     * そのぶん外へはみ出して、映像を画面の端まで出す。条件は上の `PHONE_LANDSCAPE` と同じ
     */
    @media (orientation: landscape) and (max-height: 500px) and (pointer: coarse) {
        :global(body:has([data-player-layout]) .navbar) {
            display: none;
        }
        .layout {
            flex-direction: column;
            gap: 1rem;
            height: calc(100% + var(--dp-page-top, 1rem) + var(--dp-gutter, 1rem));
            margin: calc(-1 * var(--dp-page-top, 1rem)) calc(-1 * var(--dp-gutter, 1rem)) calc(-1 * var(--dp-gutter, 1rem));
            overflow-y: auto;
        }
        .main {
            flex: none;
            height: 100dvh;
            /* 映像の形の枠 (`PlayerStage`) の左右は黒。テーマの地を映像の横に出さない */
            background: #000;
        }
        .layout > :global(aside) {
            --dp-side-pad: initial;
            width: auto;
            margin: 0 var(--dp-gutter, 1rem) var(--dp-gutter, 1rem);
        }
    }
</style>
