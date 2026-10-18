<script lang="ts">
    import ActionButton from '#lib/components/ActionButton.svelte';
    import Lead from '#lib/components/Lead.svelte';
    import { dateTime } from '#lib/format.js';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();
</script>

<!--
    テレビのアプリ (danything/denpa-tv) に渡したアクセストークン。家の外から OIDC 越しに使うテレビは
    QR でペアリングしてアクセストークンを持つ (信頼するネットワークの中なら要らない)。
    なくしたテレビ・手放したテレビはここで止める
-->
<div class="sections readable">
    <section class="section" data-testid="devices-card">
        <div class="section-head">
            <h2>テレビのアプリ</h2>
        </div>
        <Lead>QR でペアリングしたテレビです。取り消すと、そのテレビはペアリングし直しになります</Lead>
        <!-- 使ってよいのは同じ世帯の中だけ (README「使ってよい範囲」・docs/auth.md) -->
        <Lead>ログインのアカウントもペアリングするテレビも、同じ世帯の人の分だけにしてください</Lead>
        {#if data.devices.length === 0}
            <p class="small muted">まだありません</p>
        {:else}
            <div class="rows" data-testid="device-list">
                {#each data.devices as device (device.id)}
                    <div class="row device" data-testid="device-row">
                        <div class="grow">
                            <div class="small"><strong>{device.name}</strong></div>
                            <div class="tiny muted">
                                ペアリング {dateTime(device.created_at)} ・ 最後に使った
                                {device.last_used_at === null ? 'まだ' : dateTime(device.last_used_at)}
                            </div>
                        </div>
                        <div class="row-actions">
                            <ActionButton action="?/revokeDevice" fields={{ id: device.id }} class="small outline danger" testid="device-revoke">
                                取消
                            </ActionButton>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </section>
</div>

<style>
    .rows > .row + .row {
        border-top: 1px solid var(--dp-line);
    }
    .device {
        display: flex;
        align-items: center;
        gap: var(--dp-space-3);
        padding-block: 0.5rem;
    }
</style>
