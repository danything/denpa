<script lang="ts" module>
  /**
   * 横にしたスマホ (下の説明)。**下の `@media` と同じ条件** — CSS には変数で渡せないので、
   * 変えるときは両方 (画面側で「いま映像が画面いっぱいの形か」を知りたいときに使う)
   */
  export const PHONE_LANDSCAPE =
    "(orientation: landscape) and (max-height: 500px) and (pointer: coarse)";

  /**
   * **テーブルトップ** (折り畳み端末を半分に折って机に置いた形)。折っていて (`device-posture: folded`)、
   * 画面が上下 2 段に分かれている (`vertical-viewport-segments: 2`。折り目が横)。どちらも Android の Chrome 系だけが知っていて、
   * 知らないブラウザ・平らに開いた端末・本の形 (左右 2 段) では当たらない。**下の `@media` と同じ条件** (変えるときは両方)
   */
  export const TABLETOP =
    "(device-posture: folded) and (vertical-viewport-segments: 2)";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { MediaQuery } from "svelte/reactivity";

  /**
   * 3画面の外枠。映像が左、読むものが右 (タブレット `md` = 768px から二段組。狭い画面は縦に積む)。
   * 周りの余白と横幅の頭打ちは外の `<main>` が持つ。横にしたスマホ (`PHONE_LANDSCAPE`) は高さが足りないので、
   * 見出しを隠して映像を画面の高さいっぱいにし、右の列は映像の下で巻き取る (マウスの PC は窓を低くしてもそのまま)。
   * テーブルトップ (`TABLETOP`) では映像を上の段、右の列を下の段に置く (下の style)
   */
  let {
    testid,
    children,
    aside,
  }: { testid?: string; children: Snippet; aside: Snippet } = $props();

  /**
   * テーブルトップの下の段は舞台の中 (いつも黒い地。映像の色の反射 `FoldReflection` を敷く)。
   * 右の列はテーマにかかわらず暗いテーマの色で描く (`data-theme`。`app.css` の色はそれに従う)
   */
  const tabletop = new MediaQuery(TABLETOP);
</script>

<div class="layout" data-testid={testid} data-player-layout>
  <!-- **映像を先に書く。** 縦積みになったときに上へ来るのはこちら -->
  <section class="main">
    {@render children()}
  </section>
  <div
    class="side"
    data-player-side
    data-theme={tabletop.current ? "dark" : undefined}
  >
    {@render aside()}
  </div>
</div>

<style>
  /* 右の列の入れ物は箱を持たない (列は `.layout` の子として並ぶ)。テーブルトップでテーマを切り替えるためだけにある */
  .side {
    display: contents;
  }
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
    /* 映像の周りの余白は詰める (ほかの画面の 1.5rem → 1rem) */
    :global(body main:has([data-player-layout])) {
      --dp-gutter: 1rem;
    }
    .layout {
      height: 100%;
      min-height: 0;
      flex-direction: row;
      /* 映像と右の列の間は空けない (列の中身の余白だけで分ける) */
      gap: 0;
    }
    /* 映像は上に寄せる (真ん中より見出しのすぐ下から始まるほうが目で追いやすい。#1022) */
    .main {
      min-height: 0;
    }
    /*
         * 右の列は窓の右端に付けたサイドバー (線も面の色も付けない)。`<main>` の余白の外へ上・右・下にはみ出し、
         * スクロールバーを窓の右端に出す。中身の余白は映像の周りと同じ (`--dp-side-pad`)、上は映像の上と同じ値
         * (`--dp-side-top`)。幅は固定で、二段組にした直後は細く (256px。映像に 476px 残す)。
         * E2E (20・22・25 の `expectSideFrame` / `expectSideAligned`) で見る
         */
    .side > :global(aside) {
      --dp-side-pad: var(--dp-gutter, 1rem);
      --dp-side-top: var(--dp-page-top, 0px);
      width: 16rem;
      min-height: 0;
      flex-shrink: 0;
      margin: calc(-1 * var(--dp-page-top, 1rem))
        calc(-1 * var(--dp-gutter, 1.5rem)) calc(-1 * var(--dp-gutter, 1.5rem))
        0;
    }
  }
  @media (min-width: 1024px) {
    .side > :global(aside) {
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
    /* ヘッダーを隠すので、ヘッダーのぶんの頭の空き (`+layout.svelte` の `.shell.fill`) も外す */
    :global(body:has([data-player-layout]) .shell.fill) {
      padding-top: 0;
    }
    .layout {
      flex-direction: column;
      gap: 1rem;
      height: calc(100% + var(--dp-page-top, 1rem) + var(--dp-gutter, 1rem));
      margin: calc(-1 * var(--dp-page-top, 1rem))
        calc(-1 * var(--dp-gutter, 1rem)) calc(-1 * var(--dp-gutter, 1rem));
      overflow-y: auto;
    }
    .main {
      flex: none;
      height: 100dvh;
      /* 映像の形の枠 (`PlayerStage`) の左右は黒。テーマの地を映像の横に出さない */
      background: var(--dp-video);
    }
    .side > :global(aside) {
      --dp-side-pad: initial;
      width: auto;
      margin: 0 var(--dp-gutter, 1rem) var(--dp-gutter, 1rem);
    }
  }
  /*
     * **テーブルトップ** (上の `TABLETOP`。条件は同じ)。映像を上の段、右の列を下の段に置く。どちらも今の作りのまま、
     * 折り目 (と蝶番の隙間) には何も置かない。段の境目は `env(viewport-segment-*)` (知らないブラウザは当たらないので逃げ道は形だけ)。
     * `<main>` を窓いっぱいに固定し、上の段は浮いたヘッダーの下 (`--dp-fill-top`。狭い画面ではヘッダーの高さ) から折り目まで、
     * 下の段は黒い地 (舞台の中。テーマで変えない) に映像の色の反射 (`FoldReflection`) を敷き、その上に右の列を重ねる。
     * 窓は巻かない。右の列は中で巻く。E2E 55 で見る
     */
  @media (device-posture: folded) and (vertical-viewport-segments: 2) {
    :global(body main:has([data-player-layout])) {
      position: fixed;
      inset: 0;
      padding: 0;
    }
    .layout {
      display: grid;
      grid-template-rows: env(viewport-segment-bottom 0 0, 50%) minmax(0, 1fr);
      grid-template-columns: minmax(0, 1fr);
      gap: calc(
          env(viewport-segment-top 0 1, 50%) -
            env(viewport-segment-bottom 0 0, 50%)
        )
        0;
      height: 100%;
      margin: 0;
      overflow: visible;
      /* 下のタブ (狭い画面のライブ) の裏に列の終わりを隠さない */
      padding-bottom: var(--dp-tabbar, 0px);
    }
    /* 下の段の黒い地。位置を持たせ、文書の順で反射と右の列より前に描く */
    .layout::before {
      content: "";
      position: fixed;
      top: env(viewport-segment-top 0 1, 50%);
      right: 0;
      bottom: 0;
      left: 0;
      background: var(--dp-video);
    }
    .main {
      min-height: 0;
      height: auto;
      padding: var(--dp-fill-top, 3.5rem) var(--dp-gutter, 1rem)
        var(--dp-gutter, 1rem);
      background: none;
    }
    .side > :global(aside) {
      --dp-side-pad: var(--dp-gutter, 1rem);
      --dp-side-top: var(--dp-gutter, 1rem);
      /* 反射より上に描く */
      position: relative;
      width: auto;
      min-height: 0;
      margin: 0;
      color: var(--dp-fg);
    }
  }
  /* 下のタブのある狭い画面ではヘッダーを隠している (`+layout.svelte`)。上の安全域のすぐ下から */
  @media (device-posture: folded) and (vertical-viewport-segments: 2) and (max-width: 639.98px) {
    :global(.shell:has(.tabbar)) .main {
      padding-top: env(safe-area-inset-top, 0px);
    }
  }
</style>
