<script lang="ts">
    /** サイドバーの「選んだ番組」。再生・追っかけ・予約取消をその場に置く */
    import ActionButton from '#lib/components/ActionButton.svelte';
    import Icon from '#lib/components/player/Icon.svelte';
    import { dateTime, duration, durationMs, time } from '#lib/format.js';
    import { resolve } from '$app/paths';
    import Play from '~icons/lucide/play';
    import { home, type Item } from './context';
    import Poster from './Poster.svelte';
    import RowMeta from './RowMeta.svelte';

    let { item }: { item: Item } = $props();
    const ctx = home();

    const rec = $derived(item.kind === 'rec' ? item.rec : null);
    const base = $derived(item.kind === 'rec' ? item.rec : item.res);

    /** 放送の枠 */
    function airing(row: { start_at: number; end_at: number }): string {
        return `${dateTime(row.start_at)}〜${time(row.end_at)} (${duration(row.start_at, row.end_at)})`;
    }
</script>

<h2 class="s-group">
    {#if item.zone === 'now'}いま録画中{:else if item.zone === 'future'}{ctx.untilLabel(base.start_at)}に録画{:else if item.kind === 'missed'}録り逃し{:else}録画済み{/if}
</h2>
<div class="t-detail" data-testid="selected-detail" data-key={item.key}>
    {#if rec !== null && rec.library_path !== null}
        {@const link = ctx.watchLink(rec)}
        {#if link !== null}
            <a class="t-hero" href={link} tabindex="-1" aria-label="再生">
                <Poster id={rec.id} />
                <span class="t-hero-play"><Play /></span>
            </a>
        {/if}
    {/if}
    <p class="t-detail-title broadcast">{base.name}</p>
    <RowMeta service={base.service_name} parts={[airing(base)]} row={base} rule={null} />
    {#if rec !== null && rec.progress !== null && ctx.watchLink(rec) !== null}
        <p class="small muted num">続きから (残り{durationMs(Math.max(0, rec.progress.length - rec.progress.at))})</p>
    {/if}
    {#if base.description}
        <p class="t-desc small broadcast">{base.description}</p>
    {/if}
    <div class="t-detail-actions">
        {#if item.kind === 'rec'}
            {@const link = ctx.watchLink(item.rec)}
            {#if link !== null}
                <a class="button" href={link} data-testid="selected-play"><Icon icon={Play} size="size-4" />再生</a>
            {/if}
            <button type="button" class="secondary outline" onclick={() => ctx.openRecording(item.rec)}>詳細</button>
        {:else if item.kind === 'res'}
            {#if item.res.recording_id !== null}
                <a class="button" href={resolve(`chase/${item.res.recording_id}`)}>追っかけ</a>
            {/if}
            <button type="button" class="secondary outline" onclick={() => ctx.openReservation(item.res)}>詳細</button>
            {#if ctx.cancelable(item.res)}
                <ActionButton action="?/cancel" fields={{ id: item.res.id }} class="outline danger" testid="selected-cancel">
                    予約取消
                </ActionButton>
            {/if}
        {:else}
            <button type="button" class="secondary outline" onclick={() => ctx.openMissed(item.res)}>詳細</button>
        {/if}
    </div>
</div>
