<script lang="ts">
  import GuideSkeleton from "#lib/components/GuideSkeleton.svelte";
  import { SERVICE_TYPE_LABEL } from "#lib/format.js";
  import { CHANNEL_TYPES, type ChannelType } from "#lib/types.js";
  import { resolve } from "$app/paths";

  /**
   * **ほかの画面から番組表へ移る途中の姿** (`+layout.svelte` の `pending`)。
   *
   * 番組表の外枠 (日付の並びなど) もサーバから届くので、届くまでは前の画面がそのまま
   * 残り、着いた瞬間に番組表へ飛んでいた (読み直したときは外枠と骨組みが先に出る)。
   * 押したらすぐこれに替えて、読み直したときと同じ「外枠 → 骨組み → 表」に見せる。
   *
   * 出すのは URL だけで決まる種別のタブと骨組み。並びと高さは番組表の操作の1行
   * (`guide/+page.svelte` の `.toolbar`) と同じにしておく — 着いたときに表の位置が飛ばない
   */
  let { url }: { url: URL } = $props();

  const type = $derived(
    CHANNEL_TYPES.find((t) => t === url.searchParams.get("type")) ??
      ("GR" as ChannelType),
  );
</script>

<div class="page" data-testid="guide-pending">
  <div class="toolbar">
    <div role="group" class="segmented">
      {#each CHANNEL_TYPES as each (each)}
        <a
          class="button small {each === type ? '' : 'secondary outline'}"
          aria-current={each === type ? "page" : undefined}
          href={resolve(`guide?type=${each}`)}
        >
          {SERVICE_TYPE_LABEL[each]}
        </a>
      {/each}
    </div>
  </div>
  <GuideSkeleton />
</div>

<style>
  /* 外枠は `guide/+page.svelte` の `.page`・`.toolbar` と同じ (本文の余白を打ち消し、画面の残りをぜんぶ使う) */
  .page {
    --page-h: calc(100% + var(--dp-page-top) + var(--dp-gutter));
    display: flex;
    flex-direction: column;
    margin: calc(-1 * var(--dp-page-top)) calc(-1 * var(--dp-gutter))
      calc(-1 * var(--dp-gutter));
    height: var(--page-h);
  }
  .toolbar {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--dp-space-2);
    padding: var(--dp-space-1) var(--dp-space-3);
  }
  /* 番組表の `.types` と同じ。Pico の `[role=group]` は横いっぱいに広がる */
  .segmented {
    flex: none;
    width: auto;
  }
  @media (min-width: 768px) {
    .toolbar {
      padding-top: var(--dp-page-top);
      padding-bottom: var(--dp-space-2);
    }
  }
  @media (max-width: 767px) {
    .page {
      --page-h: calc(100svh - 3.5rem - env(safe-area-inset-bottom));
    }
    /* 狭い画面では操作の1行は表の下 (下のタブのすぐ上) */
    .toolbar {
      order: 1;
      padding-inline: var(--dp-space-2);
      border-top: 1px solid var(--dp-line);
    }
    .toolbar a.button {
      padding-inline: 0.4rem;
    }
  }
  @media (max-width: 639.98px) {
    .page {
      --page-h: calc(100svh - env(safe-area-inset-top) - var(--dp-tabbar, 0px));
    }
  }
</style>
