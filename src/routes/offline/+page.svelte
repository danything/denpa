<script lang="ts">
    import { onMount } from 'svelte';
    import { arming } from '$lib/arming.svelte';
    import { dateTime, durationMs, percent, size } from '$lib/format';
    import { offline, rememberResume, removeEverywhere, removeLocal, startOffline } from '$lib/offline.svelte';
    import type { OfflineVideo } from '$lib/offline-db';
    import { resumeQueue, videos } from '$lib/offline-db';

    /**
     * 端末に保存した録画。**電波が無くてもここだけは開く** — サービスワーカーが
     * この画面を控えておき、繋がらないときの行き先にする (service-worker.ts)。
     *
     * プレイヤーはこの画面に内蔵する。オフラインでは /watch/<id> へは行けない
     * (あの画面はサーバが組む) ので、ここで直接観られるようにしておく。
     * オンラインで観るぶんには従来どおり /watch が端末のコピーを使う。
     */

    let list = $state<OfflineVideo[]>([]);
    let loading = $state(true);

    /** いま観ているもの。blob の URL は使い終わったら破棄する */
    let playing = $state<OfflineVideo | null>(null);
    let src = $state<string | null>(null);
    let poster = $state<string | null>(null);
    let video = $state<HTMLVideoElement | null>(null);
    /**
     * 消すのは2回押し。挙動は3画面共通 ([arming.svelte.ts](../../lib/arming.svelte.ts))。
     * サーバからも消えることが分かる言葉で聞き返す
     */
    const deleting = arming('[data-testid="offline-delete"]');

    async function load(): Promise<void> {
        list = (await videos.all()).sort((a, b) => b.startAt - a.startAt);
        loading = false;
    }

    onMount(() => {
        startOffline();
        return () => {
            stop();
            for (const url of posterUrls.values()) URL.revokeObjectURL(url);
            posterUrls.clear();
        };
    });

    // 控えが変わったら映し直す。SW の「保存できた」も startOffline が拾って revision に出る
    $effect(() => {
        offline.revision;
        void load();
    });

    function stop(): void {
        if (src !== null) URL.revokeObjectURL(src);
        if (poster !== null) URL.revokeObjectURL(poster);
        src = null;
        poster = null;
        playing = null;
    }

    async function play(item: OfflineVideo): Promise<void> {
        if (item.state !== 'ready' || item.video === undefined) return;
        stop();
        playing = item;
        src = URL.createObjectURL(item.video);
        poster = item.poster === undefined ? null : URL.createObjectURL(item.poster);
        // 前回の続きから。オフライン中の位置は resumeQueue に覚えている
        const kept = await resumeQueue.get(item.id);
        if (kept !== undefined && video !== null) video.currentTime = kept.at;
    }

    /** 視聴位置を覚える (数秒おき)。オンラインに戻ったときにまとめて送る */
    let lastKept = 0;
    function onTime(): void {
        if (playing === null || video === null) return;
        const at = video.currentTime;
        if (Math.abs(at - lastKept) < 5) return;
        lastKept = at;
        void rememberResume(playing.id, at, video.duration || 0);
    }

    async function remove(item: OfflineVideo): Promise<void> {
        if (deleting.armed !== item.id) {
            deleting.arm(item.id);
            return;
        }
        // フォーム送信ではないので、消したら自分で構えを下ろす
        deleting.fire();
        if (playing?.id === item.id) stop();
        await removeEverywhere(item);
        await load();
    }

    const posterUrls = new Map<number, string>();
    /** 一覧のサムネイル。blob から作った URL は使い回し、ページを離れるとき破棄する (onMount) */
    function posterUrl(item: OfflineVideo): string | null {
        if (item.poster === undefined) return null;
        let url = posterUrls.get(item.id);
        if (url === undefined) {
            url = URL.createObjectURL(item.poster);
            posterUrls.set(item.id, url);
        }
        return url;
    }
</script>

<svelte:head>
    <title>端末に保存した録画 - denpa</title>
</svelte:head>

<!-- 聞き返しは他所を触ったら取り下げる (`stand`) -->
<svelte:window onclick={deleting.stand} />

<div class="page">
    <h1>端末に保存した録画</h1>
    <p class="lead small muted">
        電波の無いところでも観られます。ここで削除すると、
        <strong>次にオンラインへ戻ったときサーバの録画も消えます</strong>。
    </p>

    {#if playing !== null && src !== null}
        <div class="player">
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
                bind:this={video}
                {src}
                poster={poster ?? undefined}
                controls
                autoplay
                playsinline
                ontimeupdate={onTime}
                data-testid="offline-player"
            ></video>
            <div class="player-bar">
                <span class="name small">{playing.name}</span>
                <button type="button" class="ghost xs" onclick={stop}>閉じる</button>
            </div>
        </div>
    {/if}

    {#if loading}
        <p class="muted">読み込んでいます…</p>
    {:else if list.length === 0}
        <div class="empty">
            <p>まだ何も保存していません。</p>
            <p class="small muted">
                録画一覧の「端末に保存」を押すと、オフラインでも観られるようになります。
            </p>
        </div>
    {:else}
        <ul class="list" data-testid="offline-list">
            {#each list as item (item.id)}
                <li class="row" data-testid="offline-row">
                    {#if posterUrl(item) !== null}
                        <img src={posterUrl(item)} alt="" class="thumb" />
                    {:else}
                        <div class="thumb blank"></div>
                    {/if}
                    <div class="info">
                        <div class="name small">{item.name}</div>
                        <div class="tiny muted">
                            {item.serviceName} ・ {dateTime(item.startAt)}
                            {#if item.durationMs !== null}
                                ・ {durationMs(item.durationMs)}
                            {/if}
                            {#if item.video !== undefined}
                                ・ {size(item.video.size)}
                            {/if}
                            {#if item.source === 'alt'}
                                ・ H.264
                            {/if}
                        </div>
                    </div>
                    {#if item.state === 'downloading'}
                        {@const progress = offline.entries[item.id]?.progress ?? null}
                        <span class="tag keep">
                            保存中{progress === null ? '…' : ` ${percent(progress)}`}
                        </span>
                    {:else if item.state === 'failed'}
                        <span class="tag error keep">保存に失敗</span>
                    {:else}
                        <button
                            type="button"
                            class="small keep"
                            onclick={() => play(item)}
                            data-testid="offline-play"
                        >
                            観る
                        </button>
                    {/if}
                    {#if item.state === 'failed'}
                        <!-- 失敗した控えの片付け。**サーバの録画には触らない** (中身が無いだけ) -->
                        <button
                            type="button"
                            class="ghost small keep"
                            onclick={async () => {
                                await removeLocal(item.id);
                                await load();
                            }}
                            data-testid="offline-delete-failed"
                        >
                            失敗した保存データを消す
                        </button>
                    {:else}
                        <button
                            type="button"
                            class="small keep {deleting.armed === item.id ? 'danger' : 'ghost'}"
                            onclick={() => remove(item)}
                            data-testid="offline-delete"
                        >
                            {deleting.armed === item.id ? '端末とサーバから消す' : '削除'}
                        </button>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}

    {#if Object.keys(offline.pendingDelete).length > 0}
        <p class="pending tiny muted">
            サーバからの削除が {Object.keys(offline.pendingDelete).length} 件、次にオンラインへ戻ったときに行われます。
        </p>
    {/if}
</div>

<style>
    .page {
        max-width: 48rem;
        margin: 0 auto;
    }
    h1 {
        margin-bottom: 0.25rem;
        font-size: 1.25rem;
    }
    .lead {
        margin-bottom: 1rem;
    }
    .player {
        margin-bottom: 1rem;
    }
    .player video {
        display: block;
        width: 100%;
        border-radius: 0.5rem;
        background: #000;
    }
    .player-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 0.25rem;
    }
    .name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 500;
    }
    .empty {
        padding: 1.5rem;
        border-radius: 0.5rem;
        background: var(--dp-surface);
        text-align: center;
    }
    .empty p:first-child {
        margin-bottom: 0.25rem;
    }
    .list {
        margin: 0;
        padding: 0;
        list-style: none;
        border-radius: 0.5rem;
        background: var(--dp-surface);
    }
    .row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin: 0;
        padding: 0.75rem;
        list-style: none;
    }
    .row + .row {
        border-top: 1px solid var(--dp-base-200);
    }
    .thumb {
        width: 5rem;
        height: 3rem;
        border-radius: 0.25rem;
        object-fit: cover;
    }
    .thumb.blank {
        background: var(--dp-base-300);
    }
    .info {
        min-width: 0;
        flex: 1 1 0%;
    }
    .keep {
        flex-shrink: 0;
    }
    .pending {
        margin-top: 0.75rem;
    }
</style>
