<script lang="ts">
  import { SKELETON_COLUMNS, skeletonMask } from "#lib/guide-skeleton.js";
</script>

<!--
    **局の並びもまだ分からないときの、番組表の骨組み** (ほかの画面から番組表へ移る途中。`GuidePending`)。

    局の並びが届いたあとは、番組表そのものが局名の行と時刻の列を本物で出し、マスのところだけ
    骨組みにする (`guide/+page.svelte`)。ここはその形に合わせる — 左に時刻の列 (2.5rem)、上に局名の行、
    列は 11rem から。届いたときに表の位置が飛ばない。
    桝は列ごとに 1 枚の板を切り抜いて作る (`skeletonMask`)。下の端まで埋まる
-->
<div
  class="skeleton guide-skeleton"
  data-testid="guide-skeleton"
  role="status"
  aria-label="番組表を読み込んでいます"
>
  <div class="time" aria-hidden="true"></div>
  {#each { length: SKELETON_COLUMNS } as _, column (column)}
    <div class="column" aria-hidden="true">
      <div class="head"><span class="skeleton-head"></span></div>
      <div class="body" style:mask-image={skeletonMask(column)}></div>
    </div>
  {/each}
</div>

<style>
  /* 表 (`guide/+page.svelte` の `.grid-box`) と同じ場所・同じ地。色と光の筋は `app.css` の `.skeleton` */
  .guide-skeleton {
    display: flex;
    flex: 1 1 0%;
    min-height: 0;
    background: var(--dp-surface);
  }
  /* 時刻の列 (表の `.corner`・`.hour` と同じ幅と線) */
  .time {
    flex: none;
    width: 2.5rem;
    border-right: 1px solid var(--dp-line);
  }
  .column {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    /* 狭い画面では右の列がはみ出すが、外側で切る (本物の表も横に流れる) */
    min-width: 11rem;
  }
  /* 局名の行 (表の `.service` と同じ高さ: 上下 0.5rem + 1.25rem + 線) */
  .head {
    flex: none;
    padding: 0.5rem;
    border-bottom: 1px solid var(--dp-line);
  }
  .head .skeleton-head {
    display: block;
    width: 70%;
    height: 1.25rem;
  }
  /* マスのところ (表の `.cell` と同じく左右に 0.125rem 空ける) */
  .body {
    flex: 1;
    margin: 0.125rem 0.125rem 0;
    background: var(--dp-subtle);
  }
</style>
