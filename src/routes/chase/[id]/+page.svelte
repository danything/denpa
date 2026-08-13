<script lang="ts">
    import { onMount } from 'svelte';
    import { screenAwake } from '$lib/components/player/awake.svelte';
    import ControlBar from '$lib/components/player/ControlBar.svelte';
    import ControlButton from '$lib/components/player/ControlButton.svelte';
    import { playerControls } from '$lib/components/player/controls.svelte';
    import Icon from '$lib/components/player/Icon.svelte';
    import {
        AUDIO,
        CAMERA,
        CAPTION,
        CLOSE,
        EXPAND,
        OVERLAY,
        OVERLAY_BTN,
        PAUSE,
        PLAY,
        SHRINK,
        SOUND_OFF,
        SOUND_ON,
    } from '$lib/components/player/icons';
    import OverlayMenu from '$lib/components/player/OverlayMenu.svelte';
    import { clipFrame } from '$lib/components/player/snapshot';
    import Toasts, { type Notice } from '$lib/components/Toasts.svelte';
    import { time } from '$lib/format';
    import { LIVE_CODECS } from '$lib/live';
    import { livePlayer } from '$lib/live-player.svelte';
    import { SPEEDS } from '$lib/ts/pacing';
    import { DOUBLE_TAP } from '$lib/ts/watch';

    /**
     * 追っかけ再生 ([issue #16](https://github.com/danything/denpa/issues/16))。
     * **録画中の録画を頭から観る。** 生TSはブラウザで読めないので、器はライブと
     * 同じ (fMP4 → WebSocket → MSE、`live-player.svelte.ts` の chase モード)。
     *
     * ライブとの違いは3つ — 頭から観られる・シークできる・右端が伸びる。
     * シークバーは番組の全長で、右端 (いま録れているところ) は壁時計で伸ばす。
     */
    let { data } = $props();

    const player = livePlayer();
    let video: HTMLVideoElement;
    let still: HTMLCanvasElement;
    let overlay: HTMLCanvasElement;
    let frame: HTMLElement;

    /** 右端を伸ばすための時計。1秒刻みで十分 (バーの目盛りより細かい) */
    let clock = $state(Date.now());

    onMount(() => {
        player.attach(still, overlay);
        // 前に途中まで観ていたら、そこから
        void player.openChase(video, data.rec.id, data.rec.resumeSec);
        const ticker = setInterval(() => (clock = Date.now()), 1000);
        const keeper = setInterval(() => void sendResume(), 15_000);
        const onLeave = () => void sendResume();
        window.addEventListener('pagehide', onLeave);
        return () => {
            clearInterval(ticker);
            clearInterval(keeper);
            window.removeEventListener('pagehide', onLeave);
            void sendResume();
            player.stop();
        };
    });

    const line = $derived(player.chaseTimeline);
    /** いま録れている長さ (秒)。録画中は知らせの値を壁時計で伸ばす */
    const recorded = $derived(
        line === null
            ? 0
            : line.finished
              ? line.recordedSec
              : line.recordedSec + Math.max(0, (clock - line.since) / 1000),
    );
    /** バーの全長 (秒)。予定と録れたぶんの長いほう */
    const total = $derived(
        line === null
            ? Math.max(1, (data.rec.end_at - data.rec.start_at) / 1000)
            : Math.max(line.totalSec, recorded),
    );
    const pos = $derived(player.chasePosition);

    /** 分:秒。1時間を超える録画では時も出す */
    function clockLabel(sec: number): string {
        const s = Math.max(0, Math.floor(sec));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const ss = String(s % 60).padStart(2, '0');
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    }

    /** シーク。**録れているところより先へは行かせない** (まだ無い) */
    function seekTo(value: number): void {
        player.chaseSeek(Math.min(value, Math.max(0, recorded - 5)));
    }

    /**
     * 視聴位置をサーバへ (数十秒おき)。録り終えて焼き上がったら、観る画面の
     * 続き再生がここから拾う — 追っかけで観たぶんを二度観ずに済む
     */
    async function sendResume(): Promise<void> {
        if (line === null || pos <= 0) return;
        try {
            await fetch(`/api/recordings/${data.rec.id}/resume`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ at: pos, length: total }),
            });
        } catch {
            // 届かなくても観るのは続けられる。次の便で
        }
    }

    /** 全画面。映像だけでなく操作列も一緒に大きくしたいので、箱ごと入れる */
    let fullscreened = $state(false);
    function full(): void {
        if (frame === undefined) return;
        if (document.fullscreenElement === null) void frame.requestFullscreen().catch(() => {});
        else void document.exitFullscreen().catch(() => {});
    }
    $effect(() => {
        const update = () => (fullscreened = document.fullscreenElement !== null);
        document.addEventListener('fullscreenchange', update);
        return () => document.removeEventListener('fullscreenchange', update);
    });

    /** 操作列の出し入れ。ライブ・観る画面と同じ */
    const controls = playerControls();
    $effect(() => {
        controls.held = player.paused;
    });
    const awake = screenAwake();
    $effect(() => {
        awake.on = !player.paused && player.state === 'playing';
    });
    const controlsShown = $derived(controls.shown);
    const wake = controls.wake;
    const away = controls.away;
    const toggle = controls.toggle;

    /** 真ん中あたりを素早く2回で再生/一時停止 (ライブ・観る画面と同じ癖)。指だけ */
    let centerTapAt = 0;
    function stageTap(event: MouseEvent): void {
        if (window.matchMedia('(pointer: coarse)').matches) {
            const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
            const ratio = (event.clientX - box.left) / Math.max(1, box.width);
            const middle = ratio >= 0.3 && ratio <= 0.7;
            const at = Date.now();
            if (middle && at - centerTapAt < DOUBLE_TAP) {
                centerTapAt = 0;
                player.toggle();
                return;
            }
            centerTapAt = middle ? at : 0;
        }
        toggle();
    }

    /** いまの1コマを字幕ごと切り抜く (ライブ・観る画面と同じ) */
    let shot = $state<Notice | null>(null);
    const notices = $derived<Notice[]>(shot === null ? [] : [shot]);
    async function snapshot(): Promise<void> {
        if (video === undefined) return;
        controls.stir();
        const caption = player.captions && player.hasCaptions ? overlay : null;
        const notice = await clipFrame(video, caption, () => `${data.rec.name} - ${time(Date.now())}`);
        if (notice !== null) shot = notice;
    }
</script>

<svelte:head>
    <title>{data.rec.name} (追っかけ) - denpa</title>
</svelte:head>

<div class="mx-auto max-w-5xl">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        bind:this={frame}
        class="bg-base-300 relative aspect-video max-h-full overflow-hidden
               {controlsShown ? '' : 'cursor-none'}"
        onpointermove={wake}
        onpointerdown={wake}
        onpointerleave={away}
        onfocusin={() => (controls.keyboard = true)}
        onfocusout={() => (controls.keyboard = false)}
        data-testid="chase"
    >
        <!-- svelte-ignore a11y_media_has_caption -->
        <!-- 器の作りはライブと同じ (`live/+page.svelte` の説明)。字幕は絵なので canvas に重ねる -->
        <video
            bind:this={video}
            style="width:100%; height:100%; background:#000;"
            playsinline
            onclick={stageTap}
            data-testid="chase-video"
        ></video>
        <canvas
            bind:this={still}
            style="position:absolute; inset:0; width:100%; height:100%;
                   object-fit:contain; pointer-events:none;
                   transition:opacity 150ms; opacity:{player.holding ? 1 : 0};"
            aria-hidden="true"
        ></canvas>
        <canvas
            bind:this={overlay}
            style="position:absolute; inset:0; width:100%; height:100%;
                   object-fit:contain; pointer-events:none;"
            data-testid="chase-captions"
            aria-hidden="true"
        ></canvas>

        <!-- 右上の列。**観る画面と同じ並び** (閉じる・切り抜き) -->
        <ControlBar side shown={controlsShown} testid="chase-side">
            <a class="{OVERLAY_BTN} btn-circle {OVERLAY}" href="/" aria-label="一覧へ戻る" data-testid="chase-close">
                <Icon path={CLOSE} />
            </a>
            <ControlButton
                path={CAMERA}
                label="この場面を切り抜く"
                testid="chase-shot"
                onclick={() => void snapshot()}
            />
        </ControlBar>

        <ControlBar shown={controlsShown} testid="chase-controls">
            <!-- 帯は番組の全長。**録れていないところ (右側) へは跳べない** (`seekTo`) -->
            <input
                type="range"
                class="range range-xs range-primary w-full"
                min="0"
                max={total}
                step="1"
                value={pos}
                oninput={(event) => seekTo(Number(event.currentTarget.value))}
                aria-label="再生位置"
                data-testid="chase-seek"
            />

            <div class="mt-1 flex flex-wrap items-center gap-1 text-white">
                <ControlButton
                    path={player.paused ? PLAY : PAUSE}
                    label={player.paused ? '再生' : '一時停止'}
                    testid="chase-play"
                    onclick={() => player.toggle()}
                />
                <ControlButton
                    path={player.silenced ? SOUND_OFF : SOUND_ON}
                    label={player.silenced ? '音を出す' : '音を消す'}
                    testid="chase-sound"
                    onclick={() => (player.silenced ? player.unmute() : player.mute())}
                />
                {#if player.hasCaptions}
                    <ControlButton
                        path={CAPTION}
                        label={player.captions ? '字幕を消す' : '字幕を出す'}
                        on={player.captions}
                        testid="chase-caption"
                        onclick={() => player.toggleCaptions()}
                    />
                {/if}
                {#if player.audios.length > 1}
                    <OverlayMenu
                        testid="chase-audio"
                        attrName="audio"
                        items={player.audios.map((a) => ({
                            key: a.id,
                            label: a.label,
                            active: a.id === player.audio,
                        }))}
                        onselect={(key) => player.setAudio(key)}
                    >
                        {#snippet trigger()}
                            <button type="button"
                                class="{OVERLAY_BTN} gap-1.5 {OVERLAY}"
                                aria-label="音声を選ぶ"
                                data-testid="chase-audio"
                            >
                                <Icon path={AUDIO} />
                            </button>
                        {/snippet}
                    </OverlayMenu>
                {/if}

                <!-- **読みものは二段で** (ライブと同じ)。上が番組、下が位置 -->
                <div class="min-w-0 grow basis-0 px-2 leading-tight text-white/80">
                    <div class="truncate text-sm whitespace-nowrap">
                        {data.rec.service_name} ・ {data.rec.name}
                    </div>
                    <div class="truncate text-xs tabular-nums text-white/60">
                        <span data-testid="chase-clock">{clockLabel(pos)} / {clockLabel(recorded)}</span>
                        {#if line !== null && !line.finished}
                            ・ <span class="text-error">録画中</span>
                        {:else if line !== null}
                            ・ 録画済み
                        {/if}
                    </div>
                </div>

                <!-- 焼き方。ライブと同じで、選び直すと居た場所から焼き直し -->
                <OverlayMenu
                    testid="chase-codec"
                    attrName="codec"
                    menuClass="w-36 text-base"
                    items={LIVE_CODECS.map((c) => ({
                        key: c.id,
                        label: c.label,
                        active: c.id === player.codec,
                    }))}
                    onselect={(key) => player.setCodec(key)}
                >
                    {#snippet trigger()}
                        <button type="button"
                            class="{OVERLAY_BTN} gap-1.5 {OVERLAY}"
                            aria-label="焼き方を選ぶ"
                            data-testid="chase-codec"
                        >
                            <span class="text-xs font-semibold">
                                {LIVE_CODECS.find((c) => c.id === player.codec)?.label ?? 'H.264'}
                            </span>
                        </button>
                    {/snippet}
                </OverlayMenu>

                <!-- 追っかけは常に速さを選べる (録れている範囲の中を進むだけ) -->
                <OverlayMenu
                    testid="chase-speed"
                    attrName="speed"
                    position="dropdown-top dropdown-end"
                    menuClass="w-24 gap-1 text-lg"
                    optionClass="tabular-nums justify-center py-2"
                    items={SPEEDS.map((value) => ({
                        key: value,
                        label: `${value}×`,
                        active: value === player.speed,
                    }))}
                    onselect={(key) => player.setSpeed(key)}
                >
                    {#snippet trigger()}
                        <button type="button"
                            class="{OVERLAY_BTN} tabular-nums {OVERLAY}"
                            aria-label="再生の速さ"
                            data-testid="chase-speed"
                        >
                            {player.speed}×
                        </button>
                    {/snippet}
                </OverlayMenu>

                <!-- いま録れているところへ。ライブの「ライブ」に相当 (見た目も同じ決まり) -->
                <button type="button"
                    class="{OVERLAY_BTN} gap-1 px-3 {recorded - pos < 20
                        ? 'border-0 shadow-none btn-error'
                        : OVERLAY}"
                    onclick={() => seekTo(recorded)}
                    data-testid="chase-edge"
                >
                    <span
                        class="inline-block size-2 rounded-full {recorded - pos < 20
                            ? 'bg-error-content'
                            : 'bg-error'}"
                    ></span>
                    <span class="text-xs font-semibold">最新</span>
                </button>

                <ControlButton
                    path={fullscreened ? SHRINK : EXPAND}
                    label={fullscreened ? '全画面をやめる' : '全画面'}
                    testid="chase-full"
                    onclick={() => full()}
                />
            </div>
        </ControlBar>

        {#if player.chaseEnded}
            <!-- 録れているところまで観た。録画が終わっていれば、この先はもう来ない -->
            <div class="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
                <span class="rounded-box bg-black/60 px-3 py-1 text-xs text-white" data-testid="chase-ended">
                    録れているところまで観ました
                </span>
            </div>
        {/if}

        {#if player.state !== 'playing' && !player.holding}
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 text-white">
                {#if player.state === 'error'}
                    <p data-testid="chase-error">{player.message}</p>
                    <button type="button"
                        class="btn btn-sm"
                        onclick={() => void player.openChase(video, data.rec.id, pos)}
                    >
                        やり直す
                    </button>
                {:else}
                    <span class="loading loading-spinner loading-lg" data-testid="chase-loading"></span>
                {/if}
            </div>
        {/if}
    </div>
</div>

<Toasts {notices} />
