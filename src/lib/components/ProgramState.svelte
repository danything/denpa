<script lang="ts">
  import { badgeClass, stateLabel } from "#lib/format.js";

  /**
   * **番組の詳細の時刻の行に添える状態** (`ProgramDetail` の `status`)。番組表・検索・ホームのどこから開いても同じものを出す。
   *
   * - 予約があればその状態のバッジ (色は一覧と同じ決め方の `badgeClass`。予約済みは色を付けない)
   * - 予約が無く、もう終わった番組なら「放送終了」。予約のボタンを出しても、押した先で
   *   「放送が終わっています」と断られるだけ (reservations.reserve)
   */
  let {
    state,
    ended,
  }: {
    /** 予約の状態。予約が無ければ null */
    state: string | null;
    /** 放送が終わったか */
    ended: boolean;
  } = $props();
</script>

{#if state}
  <span class="tag {badgeClass(state)}" data-testid="detail-state">
    {stateLabel(state)}
  </span>
{:else if ended}
  <span class="tag" data-testid="detail-ended">放送終了</span>
{/if}
