<script lang="ts">
  /**
   * 時間軸の見出し: 日付 (`day`)、まとめて表示のときの側 (`side`)、「いま」の線 (`now`)。
   * どれも `h2` なので、読み上げの見出し移動で辿れる
   */
  import NowLine from "#lib/components/NowLine.svelte";
  import { fullDate, time } from "#lib/format.js";
  import { dayName, type TimelineLine } from "#lib/timeline.js";

  import { home, type Item } from "./context";

  let {
    entry,
  }: { entry: TimelineLine<Item> & { kind: "day" | "side" | "now" } } =
    $props();
  const ctx = home();
</script>

{#if entry.kind === "day"}
  <!-- 日付の見出し。1 日に 1 つで、今日は線をまたいで 1 つ (予約か録画かは線の上下で分かる) -->
  <h2 class="t-day day-head" data-testid="timeline-day" data-day={entry.at}>
    <span class="day-head-chip">
      <span class="day-head-name">{ctx.dayLabel(entry.at)}</span>
      {#if dayName(entry.at, ctx.clock) !== null}<span class="day-head-date num"
          >{fullDate(entry.at)}</span
        >{/if}
    </span>
  </h2>
{:else if entry.kind === "side"}
  <!-- まとめて表示の側の見出し。番組の見出しには日付が無いので、線から離れたときにどちらの側かを貼り付けて見せる -->
  <h2 class="t-day day-head">
    <span class="day-head-chip">
      <span class="day-head-name"
        >{entry.zone === "future" ? "これからの予約" : "録画"}</span
      >
    </span>
  </h2>
{:else}
  <!--
        「いま」の線 (読み上げは「いま 14:32、次の録画まで 3 時間 59 分」)。
        赤い点と赤い時刻で「いま」と分かるので、目に見える字は時刻と次の録画までの一言だけ (線は引かない)。
        録画中の行は線のすぐ上にあり、あと何分かは行の 3 段目が言う (線では言わない)。
        **録画中は線を見せない**。いまは録っている番組の途中なので、時刻はその行の進み具合のバーの先に出す
        (`TimelineRow` の `row-bar-now`)。見出しとしては残す (読み上げの見出し移動で来られる)
    -->
  <NowLine
    heading
    class="t-now {ctx.firstLiveKey === null ? '' : 'visually-hidden'}"
    time={time(ctx.clock)}
    status={ctx.nowStatus}
    data-testid="timeline-now"
  />
{/if}
