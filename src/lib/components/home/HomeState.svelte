<script lang="ts">
    /**
     * **状態** (次の録画・エンコード・空き)。押せない並び。広い画面はサイドバーのいちばん下、
     * 狭い画面は「⋯」の頭に同じものを出す (`where` で testid を分ける)
     */
    import { encodeLive } from '#lib/encode-live.svelte.js';
    import { eta, percent, time } from '#lib/format.js';
    import { home, type Rec, type Res } from './context';

    let {
        encoding,
        nextRes,
        capacity,
        where,
    }: {
        /** エンコードを待っている・している録画 (動いているものが先) */
        encoding: Rec[];
        nextRes: Res | null;
        capacity: { free: string; hours: string | null } | null;
        where: 'side' | 'menu';
    } = $props();
    const ctx = home();

    const running = $derived(encoding.find((rec) => rec.job_state === 'running') ?? null);
    const live = $derived(running === null ? undefined : encodeLive.entries[running.id]);
    const left = $derived(running === null ? null : (live?.etaMs ?? running.job_eta_ms));
</script>

<dl class="side-list a-state" data-testid={where === 'side' ? 'summary' : 'menu-summary'}>
    <div class="side-item static">
        <dt>次の録画</dt>
        <dd class="side-sub num">{nextRes === null ? 'なし' : `${time(nextRes.start_at)}・${ctx.untilLabel(nextRes.start_at)}`}</dd>
    </div>
    {#if encoding.length > 0}
        <div class="side-item static">
            <dt>エンコード</dt>
            <dd class="side-sub num" data-testid={where === 'side' ? 'aside-encode' : undefined}>
                {#if running !== null}
                    {percent(live?.percent ?? running.job_percent ?? 0)}{#if eta(left)}・{eta(left)}{/if}
                {:else}
                    待ち
                {/if}
                {#if encoding.length > 1}<span class="muted">(ほか {encoding.length - 1} 本)</span>{/if}
            </dd>
        </div>
    {/if}
    {#if capacity !== null}
        <div class="side-item static">
            <dt>空き</dt>
            <dd class="side-sub num" data-testid={where === 'side' ? 'recordings-capacity' : 'recordings-capacity-menu'}>
                {capacity.free.replace(/^空き\s*/, '')}{capacity.hours === null ? '' : `・${capacity.hours}`}
            </dd>
        </div>
    {/if}
</dl>
