<script lang="ts">
    /**
     * 時間軸の見出し: 日付 (`day`)、まとめて表示のときの側 (`side`)、「いま」の線 (`now`)。
     * どれも `h2` なので、読み上げの見出し移動で辿れる
     */
    import NowLine from '#lib/components/NowLine.svelte';
    import { date, time } from '#lib/format.js';
    import { dayName, type TimelineLine } from '#lib/timeline.js';
    import { home, type Item } from './context';

    let { entry }: { entry: TimelineLine<Item> & { kind: 'day' | 'side' | 'now' } } = $props();
    const ctx = home();
</script>

{#if entry.kind === 'day'}
    <!-- 日付の見出し。見出しなので読み上げの見出し移動で辿れる。1日に1つで、今日は線をまたいで1つ (予約か録画かは線の上下で分かる) -->
    <h2 class="t-day" data-testid="timeline-day" data-day={entry.at}>
        <span class="t-day-name">{ctx.dayLabel(entry.at)}</span>
        {#if dayName(entry.at, ctx.clock) !== null}<span class="t-day-date num">{date(entry.at)}</span>{/if}
    </h2>
{:else if entry.kind === 'side'}
    <!-- まとめて表示の側の見出し。番組の見出しには日付が無いので、線から離れたときにどちらの側かを貼り付けて見せる -->
    <h2 class="t-day">
        <span class="t-day-name">{entry.zone === 'future' ? 'これからの予約' : '録画'}</span>
    </h2>
{:else}
    <!--
        「いま」の線。見出しにして、見出し移動でここへ来られるようにする (読み上げは「いま 14:32、次の録画まで 3時間59分」)。
        赤い線で「いま」と分かるので、目に見える字は時刻と、録画中ならあと何分か・無ければ次の録画までの一言だけ
    -->
    <NowLine heading class="t-now" time={time(ctx.clock)} status={ctx.nowStatus} data-testid="timeline-now" />
{/if}
