<script lang="ts" module>
  /**
   * 横にしたスマホ (下の説明)。**下の `@media` と同じ条件** — CSS には変数で渡せないので、
   * 変えるときは両方 (画面側で「いま映像が画面いっぱいの形か」を知りたいときに使う)
   */
  export const PHONE_LANDSCAPE =
    "(orientation: landscape) and (max-height: 500px) and (pointer: coarse)";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * 3画面の外枠。映像が左、読むものが右 (タブレット `md` = 768px から二段組。狭い画面は縦に積む)。
   * 周りの余白と横幅の頭打ちは外の `<main>` が持つ。横にしたスマホ (`PHONE_LANDSCAPE`) は高さが足りないので、
   * 見出しを隠して映像を画面の高さいっぱいにし、右の列は映像の下で巻き取る (マウスの PC は窓を低くしてもそのまま)
   */
  let {
    testid,
    children,
    aside,
  }: { testid?: string; children: Snippet; aside: Snippet } = $props();
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
    .layout > :global(aside) {
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
    .layout > :global(aside) {
      --dp-side-pad: initial;
      width: auto;
      margin: 0 var(--dp-gutter, 1rem) var(--dp-gutter, 1rem);
    }
  }
</style>
