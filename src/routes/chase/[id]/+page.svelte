<script lang="ts">
    import { onMount } from 'svelte';
    import ProgramFacts from '$lib/components/ProgramFacts.svelte';
    import AudioMenu from '$lib/components/player/AudioMenu.svelte';
    import { screenAwake } from '$lib/components/player/awake.svelte';
    import CodecMenu from '$lib/components/player/CodecMenu.svelte';
    import ControlBar from '$lib/components/player/ControlBar.svelte';
    import ControlButton from '$lib/components/player/ControlButton.svelte';
    import { centerTap } from '$lib/components/player/center-tap';
    import { playerControls } from '$lib/components/player/controls.svelte';
    import EdgeButton from '$lib/components/player/EdgeButton.svelte';
    import FactsAside from '$lib/components/player/FactsAside.svelte';
    import Icon from '$lib/components/player/Icon.svelte';
    import InfoBlock from '$lib/components/player/InfoBlock.svelte';
    import {
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
    import PlayerStage from '$lib/components/player/PlayerStage.svelte';
    import PlayerVeil from '$lib/components/player/PlayerVeil.svelte';
    import SpeedMenu from '$lib/components/player/SpeedMenu.svelte';
    import StageNote from '$lib/components/player/StageNote.svelte';
    import { snapshotter } from '$lib/components/player/shot.svelte';
    import Toasts, { type Notice } from '$lib/components/Toasts.svelte';
    import { programDetail } from '$lib/detail.svelte';
    import { clock as clockLabel, time } from '$lib/format';
    import { livePlayer } from '$lib/live-player.svelte';
    import { liveUpdates } from '$lib/live-updates.svelte';
    import { keepResume } from '$lib/resume';

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

    /**
     * **焼き上がったら観る画面へ案内する。** 録り終えてから焼き上がるまでの間
     * (CM検出・エンコード) もこの器で観られるが、焼き上がれば普通の観る画面の
     * ほうがよい (シークも字幕も揃い、サーバの ffmpeg も要らない)。
     * 録画の知らせ (SSE) が来るたびに1つの口を読み、焼けていれば札を出す。
     * **勝手には移らない** — 観ている最中に画面が切り替わると位置が飛ぶ。
     * 押して移れば、途中の位置は続き再生 (keepResume) が覚えている
     */
    let encoded = $state(false);
    liveUpdates([], {
        recordings: () => {
            void fetch(`/api/recordings/${data.rec.id}`)
                .then((res) => (res.ok ? res.json() : null))
                .then((body: { encoded?: boolean } | null) => {
                    if (body?.encoded === true) encoded = true;
                })
                .catch(() => {});
        },
    });

    /**
     * 右に出す番組の中身 (観る画面と同じ考え方)。録画の行が持っているぶんで
     * 組み立てて、番組表から引ければそちらで上書きする (`programDetail`)。
     * 追っかけは放送中なので、たいてい引ける。
     */
    const detail = programDetail();
    const facts = $derived({
        name: data.rec.name,
        service_name: data.rec.service_name,
        start_at: data.rec.start_at,
        end_at: data.rec.end_at,
        description: data.rec.description,
        extended: null,
        genre_detail: data.rec.genre_detail,
        audios: data.rec.audios,
        video_type: null,
        video_resolution: null,
        is_free: 1,
    });

    onMount(() => {
        if (still !== null && overlay !== null) player.attach(still, overlay);
        // 前に途中まで観ていたら、そこから
        if (video !== null) void player.openChase(video, data.rec.id, data.rec.resumeSec);
        // 出演者などは番組表の側にある。押させずに、開いた時点で引く (観る画面と同じ)
        void detail.open(data.rec.program_id, {
            name: data.rec.name,
            service_name: data.rec.service_name,
            start_at: data.rec.start_at,
            end_at: data.rec.end_at,
            description: data.rec.description,
        });
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
     * 視聴位置をサーバへ (15秒おき)。録り終えて焼き上がったら、観る画面の
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

<!-- **ライブ・観る画面と同じ形。** 映像が左、番組の中身が右。決めごとは watch/[id] のコメント -->
<div class="flex flex-col gap-4 md:h-full md:min-h-0 md:flex-row">
    <section class="flex min-w-0 flex-1 flex-col md:min-h-0">
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

            <!-- **並びはライブと同じ。** 再生・音・字幕、焼き方・音声・端 (最新)、読みもの、速さ、全画面 -->
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

                <!-- 焼き方。ライブと同じ場所・同じ見た目で、選び直すと居た場所から焼き直し -->
                <CodecMenu
                    testid="chase-codec"
                    codec={player.codec}
                    onselect={(key) => player.setCodec(key)}
                />
                {#if player.audios.length > 1}
                    <AudioMenu
                        testid="chase-audio"
                        items={player.audios.map((a) => ({
                            key: a.id,
                            label: a.label,
                            active: a.id === player.audio,
                        }))}
                        onselect={(key) => player.setAudio(key)}
                    />
                {/if}

                <!--
                    いま録れているところへ。ライブの「ライブ」に相当し、場所も同じ。

                    **録り終わっていたら出しません。** 「最新」は伸びていく端に
                    張り付くためのもので、録画が終われば端は動かず、ただの
                    「終わりへ飛ぶ」になります。焼き上がる前の追っかけでは
                    録り終えたあともこの画面に居られる (録画済みと出る) ので、
                    そのとき意味の無いボタンが残っていました
                -->
                {#if line !== null && !line.finished}
                    <EdgeButton
                        active={recorded - pos < 20}
                        label="最新"
                        onclick={() => seekTo(recorded)}
                        testid="chase-edge"
                    />
                {/if}

                <!-- 読みものは3画面共通の二段 (InfoBlock)。上が番組、下が位置 -->
                <InfoBlock
                    range={{ start: data.rec.start_at, end: data.rec.end_at }}
                    service={data.rec.service_name}
                    title={data.rec.name}
                    titleTestid="chase-title"
                >
                    {#snippet status()}
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
                    {/snippet}
                </InfoBlock>

                <!-- 追っかけは常に速さを選べる (録れている範囲の中を進むだけ) -->
                <SpeedMenu
                    testid="chase-speed"
                    label="再生の速さ"
                    speed={player.speed}
                    onselect={(speed) => player.setSpeed(speed)}
                />

                <ControlButton
                    path={stage.fullscreened ? SHRINK : EXPAND}
                    label={stage.fullscreened ? '全画面をやめる' : '全画面'}
                    testid="chase-full"
                    onclick={() => stage.full()}
                />
            </div>
        </ControlBar>

        {#if encoded}
            <!--
                焼き上がった。続きは観る画面で (位置は続き再生が覚えている)。
                StageNote は押せない札 (pointer-events-none) なので、ここだけ押せる形で置く。
                見た目の決まりは同じ (rounded-box bg-black/60)
            -->
            <div class="absolute inset-x-0 top-0 z-10 flex justify-center p-2" data-testid="chase-encoded">
                <a
                    class="rounded-box bg-black/60 px-3 py-1 text-xs text-white underline decoration-white/50 underline-offset-2 hover:bg-black/80"
                    href="/watch/{data.rec.id}"
                    data-testid="chase-to-watch"
                >
                    焼き上がりました — 観る画面で続きを ▶
                </a>
            </div>
        {:else if player.chaseEnded}
            <!-- 録れているところまで観た。録画が終わっていれば、この先はもう来ない -->
            <StageNote testid="chase-ended">録れているところまで観ました</StageNote>
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
    </section>

    <!-- 右は番組の中身。枠は観る画面と同じ部品 (FactsAside)、中身も同じ (ProgramFacts) -->
    <FactsAside testid="chase-facts">
        <ProgramFacts program={detail.current ?? facts} />
    </FactsAside>
</div>

<Toasts {notices} />
