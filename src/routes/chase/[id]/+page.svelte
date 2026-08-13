<script lang="ts">
    import { onMount } from 'svelte';
    import { screenAwake } from '$lib/components/player/awake.svelte';
    import ControlBar from '$lib/components/player/ControlBar.svelte';
    import ControlButton from '$lib/components/player/ControlButton.svelte';
    import { centerTap } from '$lib/components/player/center-tap';
    import { playerControls } from '$lib/components/player/controls.svelte';
    import EdgeButton from '$lib/components/player/EdgeButton.svelte';
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
    import MediaStack from '$lib/components/player/MediaStack.svelte';
    import OverlayMenu from '$lib/components/player/OverlayMenu.svelte';
    import PlayerStage from '$lib/components/player/PlayerStage.svelte';
    import PlayerVeil from '$lib/components/player/PlayerVeil.svelte';
    import { snapshotter } from '$lib/components/player/shot.svelte';
    import Toasts, { type Notice } from '$lib/components/Toasts.svelte';
    import { clock as clockLabel, time } from '$lib/format';
    import { LIVE_CODECS } from '$lib/live';
    import { livePlayer } from '$lib/live-player.svelte';
    import { keepResume } from '$lib/resume';
    import { SPEEDS } from '$lib/ts/pacing';

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
    /** 映像と重ねもの (MediaStack が組む)。bind で受けるので開くまでは null */
    let video = $state<HTMLVideoElement | null>(null);
    let still = $state<HTMLCanvasElement | null>(null);
    let overlay = $state<HTMLCanvasElement | null>(null);

    /** 右端を伸ばすための時計。1秒刻みで十分 (バーの目盛りより細かい) */
    let clock = $state(Date.now());

    onMount(() => {
        if (still !== null && overlay !== null) player.attach(still, overlay);
        // 前に途中まで観ていたら、そこから
        if (video !== null) void player.openChase(video, data.rec.id, data.rec.resumeSec);
        const ticker = setInterval(() => (clock = Date.now()), 1000);
        const keeper = setInterval(() => sendResume(), 15_000);
        const onLeave = () => sendResume(true);
        window.addEventListener('pagehide', onLeave);
        return () => {
            clearInterval(ticker);
            clearInterval(keeper);
            window.removeEventListener('pagehide', onLeave);
            sendResume();
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

    /** シーク。**録れているところより先へは行かせない** (まだ無い) */
    function seekTo(value: number): void {
        player.chaseSeek(Math.min(value, Math.max(0, recorded - 5)));
    }

    /**
     * 視聴位置をサーバへ (数十秒おき)。録り終えて焼き上がったら、観る画面の
     * 続き再生がここから拾う — 追っかけで観たぶんを二度観ずに済む。
     * 送り方は観る画面と共通 (`$lib/resume.ts`。閉じ際は sendBeacon)
     */
    function sendResume(leaving = false): void {
        if (line === null || pos <= 0) return;
        keepResume(data.rec.id, pos, total, leaving);
    }

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
    const toggle = controls.toggle;

    /** 真ん中あたりを素早く2回で再生/一時停止 (`center-tap.ts`)。1回目は操作列の出し入れ */
    const stageTap = centerTap(() => player.toggle(), toggle);

    /** いまの1コマを字幕ごと切り抜く (ライブ・観る画面と同じ) */
    const shooter = snapshotter(controls);
    const notices = $derived<Notice[]>(shooter.notices);
    function snapshot(): void {
        void shooter.take(
            video,
            player.captions && player.hasCaptions ? overlay : null,
            () => `${data.rec.name} - ${time(Date.now())}`,
        );
    }
</script>

<svelte:head>
    <title>{data.rec.name} (追っかけ) - denpa</title>
</svelte:head>

<div class="mx-auto max-w-5xl">
    <!-- 舞台の配線と映像の束はライブと共通 (PlayerStage / MediaStack) -->
    <PlayerStage {controls} testid="chase">
        {#snippet children(stage)}
        <MediaStack
            holding={player.holding}
            captionsOn={player.captions && player.hasCaptions}
            onclick={stageTap}
            prefix="chase"
            bind:video
            bind:still
            bind:overlay
        />

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
                            <ControlButton path={AUDIO} label="音声を選ぶ" testid="chase-audio">
                                <span class="hidden max-w-28 truncate sm:inline">
                                    {player.audios.find((a) => a.id === player.audio)?.label ?? '音声'}
                                </span>
                            </ControlButton>
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
                            <!-- 赤はライブの赤丸と同じ出し方。黒帯の上の text-error は沈む -->
                            ・ <span class="inline-flex items-baseline gap-1"
                                ><span class="bg-error inline-block size-1.5 self-center rounded-full"
                                ></span>録画中</span
                            >
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
                        <ControlButton label="焼き方を選ぶ" testid="chase-codec">
                            <span class="text-xs font-semibold">
                                {LIVE_CODECS.find((c) => c.id === player.codec)?.label ?? 'H.264'}
                            </span>
                        </ControlButton>
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
                        <ControlButton label="再生の速さ" testid="chase-speed" on={player.speed !== 1}>
                            <span class="tabular-nums">{player.speed}×</span>
                        </ControlButton>
                    {/snippet}
                </OverlayMenu>

                <!-- いま録れているところへ。ライブの「ライブ」に相当 -->
                <EdgeButton
                    active={recorded - pos < 20}
                    label="最新"
                    onclick={() => seekTo(recorded)}
                    testid="chase-edge"
                />

                <ControlButton
                    path={stage.fullscreened ? SHRINK : EXPAND}
                    label={stage.fullscreened ? '全画面をやめる' : '全画面'}
                    testid="chase-full"
                    onclick={() => stage.full()}
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

        {#if player.state !== 'playing'}
            <!-- 見た目の決まりは3画面共通 (`PlayerVeil`)。前の絵を貼っている間は塗り潰さない -->
            <PlayerVeil
                holding={player.holding}
                busy={player.state !== 'error'}
                note={player.resuming ? '繋ぎ直しています' : ''}
                error={player.state === 'error' ? player.message : ''}
                testid="chase-status"
            >
                {#snippet actions()}
                    <button type="button"
                        class="btn btn-sm"
                        onclick={() => video !== null && void player.openChase(video, data.rec.id, pos)}
                        data-testid="chase-retry"
                    >
                        やり直す
                    </button>
                {/snippet}
            </PlayerVeil>
        {/if}
        {/snippet}
    </PlayerStage>
</div>

<Toasts {notices} />
