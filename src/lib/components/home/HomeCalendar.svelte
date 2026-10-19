<script lang="ts">
    /**
     * **サイドバーの月のカレンダー** (広い画面だけ。日ごとに並べているときだけ出す — まとめて表示には日付の見出しが無い)。
     *
     * - 行のある日 (一覧に出ている行。絞り込みが効く) は数字の下に点。押すとその日の見出しへ送る
     * - 行の無い日は沈めて押せない。今日は丸で囲む (行が無くても押せる。今日の見出しは「いま」の線と一緒にいつもある)
     * - いま一覧の頭に貼り付いている日は薄く塗る。送ると付いて動き、月もその日の月に替わる
     * - ‹ › は行のある月だけを行き来する (間の空の月は飛ばす)
     *
     * 日の数え方と升目は `#lib/calendar.ts`。どの日を頭に送るか (まだ描いていない古い日を描かせるのも) はホームが持つ
     */
    import { tick } from 'svelte';
    import {
        type DayMark,
        dayAriaLabel,
        monthGrid,
        monthLabel,
        monthOf,
        moveDay,
        navigableMonths,
        stepMonth,
    } from '#lib/calendar.js';
    import Icon from '#lib/components/player/Icon.svelte';
    import ChevronLeft from '~icons/lucide/chevron-left';
    import ChevronRight from '~icons/lucide/chevron-right';

    let {
        marks,
        today,
        pinned,
        onpick,
    }: {
        /** 日ごとの行の数 (鍵はその日の 0 時) */
        marks: Map<number, DayMark>;
        /** 今日の 0 時 */
        today: number;
        /** いま一覧の頭に貼り付いている日 (無ければ null) */
        pinned: number | null;
        /** 日を押した */
        onpick: (day: number) => void;
    } = $props();

    const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

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

    /** 矢印の鍵で動かしている日。Tab で入る升はこれ、無ければ頭の日・今日・その月の最初の押せる日 */
    let focused = $state<number | null>(null);
    const entry = $derived.by(() => {
        const days = weeks.flat().filter((day) => day !== null);
        for (const day of [focused, pinned, today]) if (day !== null && days.includes(day)) return day;
        return days.find(enabled) ?? days[0];
    });

    let table: HTMLTableElement | undefined = $state();
    async function onkeydown(event: KeyboardEvent): Promise<void> {
        const from = Number((event.target as HTMLElement).dataset['day']);
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
        <h2 class="side-label" id="home-calendar-month" data-testid="calendar-month">{monthLabel(month)}</h2>
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
    <table class="cal-grid" aria-labelledby="home-calendar-month" bind:this={table}>
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
                                    class:has={marks.has(day)}
                                    aria-label={dayAriaLabel(day, marks.get(day), today)}
                                    aria-current={day === today ? 'date' : undefined}
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
