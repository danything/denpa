<script lang="ts">
    /** 時間軸に描く1つ (`#lib/timeline.ts` の `TimelineLine`): 見出し・番組の見出し・行 */
    import type { TimelineLine } from '#lib/timeline.js';
    import type { Item } from './context';
    import GroupHead from './GroupHead.svelte';
    import TimelineHeading from './TimelineHeading.svelte';
    import TimelineRow from './TimelineRow.svelte';

    let { entry }: { entry: TimelineLine<Item> } = $props();
</script>

{#if entry.kind === 'day' || entry.kind === 'side' || entry.kind === 'now'}
    <TimelineHeading {entry} />
{:else if entry.kind === 'head'}
    <GroupHead group={entry.group} zone={entry.zone} open={entry.open} />
{:else}
    <TimelineRow item={entry.item} nested={entry.nested} />
{/if}
