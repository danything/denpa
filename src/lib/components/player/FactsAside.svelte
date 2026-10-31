<script lang="ts">
  import type { Snippet } from "svelte";
  import ArrowLeft from "~icons/lucide/arrow-left";

  /**
   * 右の「番組の中身」の列。**観る・追っかけ・ライブ (詳細を開いた間) で同じ枠。**
   *
   * モーダルにしない — 映像の上に被さると観ながら読めない。中身が長ければ
   * **ここだけが巻き取られる** (`overflow-y: auto`)。戻る (`back`) は巻き取られる中身の外、
   * 番組名の上に置いて、いつでも見えるようにする。
   *
   * 幅と高さ・広い画面でのサイドバーの形 (窓の右端に付け、線も面の色も付けない) は3画面共通で、
   * [PlayerLayout.svelte](PlayerLayout.svelte) が持つ。高さは画面の残りぜんぶで、映像の高さには揃えない。
   * 中の余白はサイドバーのとき `--dp-side-pad` (巻き取る箱は列の幅いっぱい)。
   */
  let {
    testid,
    top,
    back,
    children,
  }: {
    testid?: string;
    /** 枠の上に置くもの (データ放送のリモコンなど)。枠の外なので巻き取られない */
    top?: Snippet;
    /**
     * 列の左上に置く戻る (ライブの「← 局の一覧」)。番組名のすぐ上で、巻き取られない。
     * 下に貼り付けていた頃は、中身が短いと空いた列の下の端にボタンだけが浮いて見えた
     */
    back?: { label: string; onclick: () => void; testid?: string };
    children: Snippet;
  } = $props();
</script>

<aside class="facts">
  {#if top}<div class="top">{@render top()}</div>{/if}
  {#if back}
    <div class="back-row">
      <button
        type="button"
        class="ghost small back"
        aria-label="{back.label}へ戻る"
        onclick={back.onclick}
        data-testid={back.testid}
      >
        <ArrowLeft aria-hidden="true" />{back.label}
      </button>
    </div>
  {/if}
  <div class="box">
    <div class="body" data-testid={testid}>
      {@render children()}
    </div>
  </div>
</aside>

<style>
  .facts {
    display: flex;
    flex-direction: column;
  }
  /*
     * **列の最初のものの上は `--dp-side-top`** (サイドバーのとき `PlayerLayout` が映像の上と同じ値を入れる)。
     * 映像の上端と列の最初のものの上端を、同じ1つの値でそろえる
     */
  .top {
    padding: var(--dp-side-top, var(--dp-side-pad, 0)) var(--dp-side-pad, 0) 0;
  }
  /*
   * 中身が無ければ場所も取らない (データ放送を出していない間のリモコン・出していないコメントの一覧)。
   * `:empty` で見ないのは、出し分けるものが 2 つ並ぶと間に空白の字が残るため
   */
  .top:not(:has(:global(*))) {
    display: none;
  }
  /*
     * 戻るは字とアイコンだけの小さなボタン。
     * 矢印の頭を下の番組名の字の頭にそろえる (ボタンの左の余白ぶん外へ出す)
     */
  .back-row {
    flex-shrink: 0;
    padding: var(--dp-side-top, var(--dp-side-pad, 0.25rem))
      var(--dp-side-pad, 0.5rem) 0;
  }
  .top:has(:global(*)) + .back-row {
    padding-top: var(--dp-side-pad, 0.25rem);
  }
  .back {
    margin: 0 0 0 -0.5rem;
    padding-inline: 0.5rem 0.75rem;
  }
  .back :global(svg) {
    width: 1.125rem;
    height: 1.125rem;
  }
  /*
     * カードにしない。高さは画面の残りぜんぶで映像とは揃わないので、枠があると
     * 映像の下端とずれた枠の下端が目立った。地の上に文字だけを置く
     */
  .box {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  .body {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    padding: var(--dp-side-top, var(--dp-side-pad, 0.25rem))
      var(--dp-side-pad, 0.5rem) 1rem;
  }
  /* 上に戻るやリモコンがあるときは、その下は列の中の余白 */
  .back-row + .box .body {
    padding-top: 0.5rem;
  }
  .top:has(:global(*)) + .box .body {
    padding-top: var(--dp-side-pad, 0.25rem);
  }
</style>
