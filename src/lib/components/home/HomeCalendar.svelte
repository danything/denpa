<script lang="ts">
  /**
   * **サイドバーの月のカレンダー** (広い形だけ。日ごとに並べているときだけ出す — まとめて表示には日付の見出しが無い)。
   *
   * - 行のある日 (一覧に出ている行。絞り込みが効く) は本文の字。押すとその日の見出しへ送る
   * - 行の無い日は控えた字で押せない。今日は赤い点 (行が無くても押せる。今日の見出しは「いま」の線と一緒にいつもある)
   * - いま一覧の頭に貼り付いている日は主の色の下線と太字。送ると付いて動き、月もその日の月に替わる
   * - ‹ › は行のある月だけを行き来する (間の空の月は飛ばす)
   *
   * 日の数え方と升目は `#lib/calendar.ts`。どの日を頭に送るか (まだ描いていない古い日を描かせるのも) はホームが持つ。
   * 切り抜きの画面 (`/clips`) も同じものを使う (撮った日を押すとその日で絞る。選んでいる日が `pinned`)
   */
  import "@anyblades/blades/content/table";
  import { tick } from "svelte";
  import ChevronLeft from "~icons/lucide/chevron-left";
  import ChevronRight from "~icons/lucide/chevron-right";

  import {
    dayAriaLabel,
    type DayMark,
    monthGrid,
    monthLabel,
    monthOf,
    moveDay,
    navigableMonths,
    stepMonth,
  } from "#lib/calendar.js";
  import Icon from "#lib/components/player/Icon.svelte";
  import { WEEKDAYS } from "#lib/format.js";

  let {
    marks,
    today,
    pinned,
    onpick,
    describe = (day) =>
      dayAriaLabel(day, marks.get(day) as DayMark | undefined, today),
  }: {
    /** 日ごとの行の数 (鍵はその日の 0 時)。切り抜きの画面は日ごとの枚数 (`describe` で読み上げを替える) */
    marks: Map<number, DayMark | number>;
    /** 今日の 0 時 */
    today: number;
    /** いま一覧の頭に貼り付いている日 (無ければ null) */
    pinned: number | null;
    /** 日を押した */
    onpick: (day: number) => void;
    /** 日の読み上げ。既定は録画の一覧の数え方 (`calendar.dayAriaLabel`) */
    describe?: (day: number) => string;
  } = $props();

  // svelte-ignore state_referenced_locally
  let month = $state(monthOf(pinned ?? today));
  // 頭の日が替わったら、その日の月を出す (‹ › で離れても、送ればまた付いてくる)
  $effect(() => {
    if (pinned !== null) month = monthOf(pinned);
  });

  const months = $derived(navigableMonths(marks.keys(), [monthOf(today)]));
  const prev = $derived(stepMonth(months, month, -1));
  const next = $derived(stepMonth(months, month, 1));
  const weeks = $derived(monthGrid(month));
  function go(to: number | null): void {
    if (to !== null) month = to;
  }

  const enabled = (day: number) => marks.has(day) || day === today;

  /** 矢印キーで動かしている日。Tab で入る升はこれ、無ければ頭の日・今日・その月の最初の押せる日 */
  let focused = $state<number | null>(null);
  const entry = $derived.by(() => {
    const days = weeks.flat().filter((day) => day !== null);
    for (const day of [focused, pinned, today])
      if (day !== null && days.includes(day)) return day;
    return days.find(enabled) ?? days[0];
  });

  let table: HTMLTableElement | undefined = $state();
  async function onkeydown(event: KeyboardEvent): Promise<void> {
    const from = Number((event.target as HTMLElement).dataset["day"]);
    const to = Number.isNaN(from) ? null : moveDay(from, event.key);
    if (to === null) return;
    event.preventDefault();
    // 月の外へは出ない (‹ › は行のある月だけなので、矢印で空の月へ行けないように)
    if (monthOf(to) !== month) return;
    focused = to;
    await tick();
    table?.querySelector<HTMLElement>(`[data-day="${to}"]`)?.focus();
  }
</script>

<div class="cal" data-testid="home-calendar">
  <div class="cal-head">
    <h2
      class="side-label"
      id="home-calendar-month"
      data-testid="calendar-month"
    >
      {monthLabel(month)}
    </h2>
    <button
      type="button"
      class="cal-step"
      aria-label="前の月"
      disabled={prev === null}
      onclick={() => go(prev)}
      data-testid="calendar-prev"
    >
      <Icon icon={ChevronLeft} size="size-4" />
    </button>
    <button
      type="button"
      class="cal-step"
      aria-label="次の月"
      disabled={next === null}
      onclick={() => go(next)}
      data-testid="calendar-next"
    >
      <Icon icon={ChevronRight} size="size-4" />
    </button>
  </div>
  <table
    class="cal-grid"
    aria-labelledby="home-calendar-month"
    bind:this={table}
  >
    <thead>
      <tr>
        {#each WEEKDAYS as name (name)}
          <th scope="col" abbr={`${name}曜日`}>{name}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each weeks as week, w (w)}
        <tr>
          {#each week as day, d (d)}
            <td>
              {#if day !== null}
                <button
                  type="button"
                  class="cal-day num"
                  class:today={day === today}
                  class:pinned={day === pinned}
                  aria-label={describe(day)}
                  aria-current={day === today ? "date" : undefined}
                  aria-disabled={!enabled(day)}
                  tabindex={day === entry ? 0 : -1}
                  onclick={() => enabled(day) && onpick(day)}
                  onfocus={() => {
                    focused = day;
                  }}
                  {onkeydown}
                  data-testid="calendar-day"
                  data-day={day}
                >
                  {new Date(day).getDate()}
                </button>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  /*
   * サイドバーの月のカレンダー (`HomeCalendar`)。行は 48px にしない (升は 32px。幅は 7 等分で 40px ほどあるので、押す所は升いっぱい)。
   * 見出しはほかのグループと同じ太字で、右に ‹ ›。日の印は下の「日のマス」
   */
  .cal-head {
    display: flex;
    align-items: center;
    margin-top: 1.75rem;
  }
  .cal-head .side-label {
    flex: 1;
    margin: 0;
  }
  .cal-step {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--dp-radius);
    background: transparent;
    box-shadow: none;
    color: var(--dp-fg);
    transition: background-color var(--dp-duration);
  }
  .cal-step:hover:not(:disabled) {
    background: var(--dp-hover-soft);
  }
  .cal-step:disabled {
    background: transparent;
    color: var(--dp-muted);
    opacity: 0.4;
  }
  .cal-grid {
    width: calc(100% - 0.75rem);
    margin: 0.25rem 0 0 0.75rem;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .cal-grid :is(th, td) {
    padding: 0;
    border: 0;
    background: transparent;
    text-align: center;
  }
  .cal-grid th {
    height: 1.5rem;
    color: var(--dp-muted);
    font-size: 0.6875rem;
    font-weight: var(--dp-weight);
  }
  /*
   * 日のマス。**印は 1 つの意味に 1 つ** (docs/design.md):
   * - 行のある日は本文の字。行の無い日 (今日を除く) は押せず (読み上げには aria-disabled)、控えた字にして指を乗せても塗らない
   * - 今日は赤い点 (「いま」の線と同じ赤)
   * - 選んでいる日は主の色の下線と主の色の太字 (ほかの選んでいるものと同じ。塗らない)。下線が点の代わり
   */
  .cal-day {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 2rem;
    margin: 0;
    padding: 0 0 0.25rem;
    border: 0;
    border-radius: var(--dp-radius);
    background: transparent;
    box-shadow: none;
    color: var(--dp-fg);
    font-size: 0.8125rem;
    font-weight: var(--dp-weight);
    transition: background-color var(--dp-duration);
  }
  .cal-day[aria-disabled="true"] {
    color: var(--dp-muted);
    cursor: default;
  }
  .cal-day.today::after {
    content: "";
    position: absolute;
    bottom: 0.3125rem;
    left: 50%;
    width: 0.25rem;
    height: 0.25rem;
    border-radius: 50%;
    background: var(--dp-rec);
    transform: translateX(-50%);
  }
  .cal-day:not([aria-disabled="true"]):hover {
    background: var(--dp-hover-soft);
  }
  .cal-day.pinned {
    color: var(--dp-primary-text);
    font-weight: var(--dp-weight-bold);
  }
  .cal-day.pinned::after {
    content: "";
    position: absolute;
    bottom: 0.25rem;
    left: 50%;
    width: 1rem;
    height: 2px;
    border-radius: 1px;
    background: var(--pico-primary);
    transform: translateX(-50%);
  }
</style>
