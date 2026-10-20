<script lang="ts">
    /**
     * 行の3段目: いま動いていること・止まっている問題を1段で (`#lib/row-status.ts`)。
     * 頭に点か印、ラベル、「・」の後ろに中身。
     *
     * 狭いときは中身から「…」で縮め (狭い画面は2行まで)、全部は `title` と詳細で読める。
     * 印は飾り (読み上げはラベルと中身で足りる)
     */
    import Icon from '#lib/components/player/Icon.svelte';
    import type { RowStatus } from '#lib/row-status.js';
    import CircleX from '~icons/lucide/circle-x';
    import TriangleAlert from '~icons/lucide/triangle-alert';

    let { status }: { status: RowStatus } = $props();
    const detail = $derived(status.detail ?? '');
</script>

<div
    class="row-activity num {status.tone}"
    data-testid="row-activity"
    data-kind={status.kind}
    title={detail === '' ? status.label : `${status.label}・${detail}`}
>
    {#if status.tone === 'error' || status.tone === 'warning'}
        <span class="act-mark"><Icon icon={status.tone === 'error' ? CircleX : TriangleAlert} size="size-3.5" /></span>
    {:else}
        <span class="act-mark" aria-hidden="true"><span class="act-dot" class:rec-dot={status.running === true}></span></span>
    {/if}
    <span class="act-text"
        ><span class="act-label" data-testid={status.testid}>{status.label}</span>{#if detail !== ''}<span
                class="act-detail"
                data-testid={status.detailTestid}>・{detail}</span
            >{/if}</span
    >
</div>
