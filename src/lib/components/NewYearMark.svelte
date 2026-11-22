<!--
  **正月の飾り (門松)**。1 月 1〜3 日にヘッダーのロゴの横に出す (`Shell.svelte`。docs/design.md「季節の演出」)。
  自前で描いた形で、色はロゴの名前と同じ本文の字の色 (`currentColor`)。節と縄は地の色で抜く。明暗どちらのテーマでも読める濃さになる。
  飾りなので読み上げず、押せない
-->
<script lang="ts">
  let { testid = "new-year-mark" }: { testid?: string } = $props();
</script>

<svg
  class="new-year-mark"
  viewBox="0 0 24 24"
  aria-hidden="true"
  data-testid={testid}
>
  <!-- 斜めに切った竹が 3 本。真ん中がいちばん高い -->
  <g class="bamboo">
    <path d="M6.5 14V8.5L9.5 6.5V14z" />
    <path d="M10.5 14V4L13.5 2V14z" />
    <path d="M14.5 14V8.5L17.5 6.5V14z" />
  </g>
  <!-- 竹の節 -->
  <g class="node">
    <path d="M6.5 11.5h3M10.5 9h3M14.5 11.5h3" />
  </g>
  <!-- 藁を巻いた台。竹とは少し離し、縄の 1 本は地の色で抜く -->
  <path class="base" d="M5 14.5h14l-1.5 7h-11z" />
  <path class="rope" d="M5.6 17.5h12.8" />
</svg>

<style>
  .new-year-mark {
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
  }
  .bamboo {
    fill: currentColor;
  }
  .node,
  .rope {
    fill: none;
    stroke: var(--dp-bg);
    stroke-width: 0.75;
  }
  .base {
    fill: currentColor;
  }
</style>
