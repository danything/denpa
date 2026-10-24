<script lang="ts" module>
  import { navigating } from "$app/state";

  /**
   * 番組表 (`/guide`) へ移っている途中なら、その行き先。着いた・取り消されたら null。
   * 終わりは `navigating.complete` で見る (`navigating` は畳まれた遷移で真のまま残るので当てにしない。
   * [reload.svelte.ts](../reload.svelte.ts))。土台 (`+layout.svelte`) と番組表が使う
   */
  export function guideNavigation(): { readonly to: URL | null } {
    let to = $state<URL | null>(null);
    $effect(() => {
      const done = navigating.complete;
      const next = navigating.to;
      if (done === null || next === null || next.route.id !== "/guide") {
        to = null;
        return;
      }
      to = next.url;
      let stale = false;
      const settle = (): void => {
        if (!stale) to = null;
      };
      void done.then(settle, settle);
      return () => {
        stale = true;
      };
    });
    return {
      get to() {
        return to;
      },
    };
  }
</script>

<script lang="ts">
  import { resolve } from "$app/paths";

  import GuideSkeleton from "#lib/components/GuideSkeleton.svelte";
  import { SERVICE_TYPE_LABEL } from "#lib/format.js";
  import { CHANNEL_TYPES, type ChannelType } from "#lib/types.js";

  /**
   * **ほかの画面から番組表へ移る途中の姿** (`+layout.svelte` の `pending`)。
   *
   * 番組表の外枠 (日付の並びなど) もサーバから届くので、届くまでは前の画面がそのまま
   * 残り、着いた瞬間に番組表へ飛んでいた (読み直したときは外枠と骨組みが先に出る)。
   * 押したらすぐこれに替えて、読み直したときと同じ「外枠 → 骨組み → 表」に見せる。
   *
   * 出すのは URL だけで決まる種別のタブと骨組み。外枠と操作の1行は番組表と同じ (`app.css` の `.guide-frame`・`.guide-bar`)
   */
  let { url }: { url: URL } = $props();

  const type = $derived(
    CHANNEL_TYPES.find((t) => t === url.searchParams.get("type")) ??
      ("GR" as ChannelType),
  );
</script>

<div class="guide-frame" data-testid="guide-pending">
  <!-- `toolbar` は e2e の目印 (49-guide-skeleton) -->
  <div class="toolbar guide-bar">
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
