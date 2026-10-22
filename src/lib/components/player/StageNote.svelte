<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * 映像の上に浮かせる短い通知。**見た目は3画面+データ放送で同じ**
   * (角丸の黒いラベル。テーマ色を映像に乗せない)。
   *
   * **置き場は持たない。** 舞台の「通知の列」(`PlayerStage` の `notes`) に積む。
   * 通知ごとに絶対配置していた頃は、置き場ごとに上からの距離を書いていて、同時に
   * 2つ出ると重なっていた (観る画面の「続きから」と「CMを飛ばしました」など)。
   * 列に積めば、いくつ出ても縦に並ぶ。データ放送の「取得中」は列の外 (右上の隅) に
   * 置くので、置き場はそちら (`DataBroadcast`) が持つ
   */
  let {
    testid,
    children,
  }: {
    testid?: string;
    children: Snippet;
  } = $props();
</script>

<span class="stage-note note" data-testid={testid}>{@render children()}</span>

<style>
  /* 見た目は app.css の `.stage-note` (押せる通知も同じ形にする) */
  .note {
    pointer-events: none;
  }
</style>
