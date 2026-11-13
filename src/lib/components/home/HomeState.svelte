<script lang="ts">
  /**
   * **状態** (エンコード・空き)。押せない並び。次の録画は「いま」の行に出す (`NowMark`)。広い形はサイドバーのカレンダーの下、
   * スマホの形は「⋯」の先頭に同じものを出す (`where` で testid を分ける)
   */
  import { encodeLive } from "#lib/encode-live.svelte.js";
  import { encodeDetail } from "#lib/format.js";

  import type { HomeControls } from "./context";

  let {
    encoding,
    capacity,
    where,
  }: Pick<HomeControls, "encoding" | "capacity"> & {
    where: "side" | "menu";
  } = $props();

  const running = $derived(
    encoding.find((rec) => rec.job_state === "running") ?? null,
  );
</script>

<dl
  class="side-list a-state"
  data-testid={where === "side" ? "summary" : "menu-summary"}
>
  {#if encoding.length > 0}
    <div class="side-item static">
      <dt>エンコード</dt>
      <dd
        class="side-sub num"
        data-testid={where === "side" ? "aside-encode" : undefined}
      >
        {#if running !== null}
          <!-- 一覧の行と同じ決まりで出す (`encodeDetail`) -->
          {encodeDetail(encodeLive.entries[running.id], running)}
        {:else}
          待ち
        {/if}
        {#if encoding.length > 1}<span class="muted"
            >(ほか {encoding.length - 1} 本)</span
          >{/if}
      </dd>
    </div>
  {/if}
  {#if capacity !== null}
    <div class="side-item static">
      <dt>空き</dt>
      <dd
        class="side-sub num"
        data-testid={where === "side"
          ? "recordings-capacity"
          : "recordings-capacity-menu"}
      >
        {capacity.free}{capacity.hours === null ? "" : `・${capacity.hours}`}
      </dd>
    </div>
  {/if}
</dl>
