<script lang="ts" module>
  import { navigating } from "$app/state";

  import { CHANNEL_TYPES, type ChannelType, GUIDE_TYPES } from "#lib/types.js";

  /**
   * 最後に開いた番組表の種別のタブ (`guide/+page.server.ts` の `types`。CATV と SKY は局があるときだけ)。
   * 移る途中の姿もこのタブを並べ、着いたときにタブの数が変わらないようにする。
   * まだ番組表を開いていなければ、いつも並ぶ地上波・BS・CS
   */
  let lastTabs = $state<readonly ChannelType[]>(CHANNEL_TYPES);

  /** 番組表が開いた種別のタブを覚える (`guide/+page.svelte`) */
  export function rememberGuideTabs(types: readonly ChannelType[]): void {
    lastTabs = types;
  }

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

  /**
   * **ほかの画面から番組表へ移る途中の姿** (`+layout.svelte` の `pending`)。
   *
   * 番組表の外枠 (日付の並びなど) もサーバから届くので、届くまでは前の画面がそのまま
   * 残り、着いた瞬間に番組表へ飛んでいた (読み直したときは外枠と骨組みが先に出る)。
   * 押したらすぐこれに替えて、読み直したときと同じ「外枠 → 骨組み → 表」に見せる。
   *
   * 出すのは種別のタブ (最後に開いた番組表のタブと、URL の種別) と骨組み。外枠と操作の 1 行は番組表と同じ
   * (`app.css` の `.guide-frame`・`.guide-bar`)
   */
  let { url }: { url: URL } = $props();

  const type = $derived(
    GUIDE_TYPES.find((t) => t === url.searchParams.get("type")) ??
      ("GR" as ChannelType),
  );
  const tabs = $derived(
    GUIDE_TYPES.filter((t) => lastTabs.includes(t) || t === type),
  );
</script>

<div class="guide-frame" data-testid="guide-pending">
  <!-- `toolbar` は e2e の目印 (49-guide-skeleton) -->
  <div class="toolbar guide-bar dock">
    <div role="group" class="segmented">
      {#each tabs as each (each)}
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
