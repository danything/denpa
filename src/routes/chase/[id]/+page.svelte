<script lang="ts">
    import { onMount } from 'svelte';
    import DriveNotice from '#lib/components/DriveNotice.svelte';
    import ProgramFacts from '#lib/components/ProgramFacts.svelte';
    import { ambientMode } from '#lib/components/player/ambient.svelte.js';
    import { screenAwake } from '#lib/components/player/awake.svelte.js';
    import { backgroundPlayback } from '#lib/components/player/background.svelte.js';
    import CloseLink from '#lib/components/player/CloseLink.svelte';
    import ControlBar from '#lib/components/player/ControlBar.svelte';
    import ControlButton from '#lib/components/player/ControlButton.svelte';
    import ControlRow from '#lib/components/player/ControlRow.svelte';
    import { playerControls } from '#lib/components/player/controls.svelte.js';
    import EdgeButton from '#lib/components/player/EdgeButton.svelte';
    import Extras from '#lib/components/player/Extras.svelte';
    import FactsAside from '#lib/components/player/FactsAside.svelte';
    import { stageFullscreen } from '#lib/components/player/fullscreen.svelte.js';
    import InfoBlock from '#lib/components/player/InfoBlock.svelte';
    import { AUDIO, CAMERA, CAPTION, CODEC, PAUSE, PLAY, SOUND_OFF, SOUND_ON } from '#lib/components/player/icons.js';
    import { playerKeys } from '#lib/components/player/keys.js';
    import MediaStack from '#lib/components/player/MediaStack.svelte';
    import PlayerLayout from '#lib/components/player/PlayerLayout.svelte';
    import PlayerStage from '#lib/components/player/PlayerStage.svelte';
    import PlayerVeil from '#lib/components/player/PlayerVeil.svelte';
    import { pictureInPicture } from '#lib/components/player/pip.svelte.js';
    import SeekBar from '#lib/components/player/SeekBar.svelte';
    import SpeedMenu, { SPEED_KEY, storedSpeed } from '#lib/components/player/SpeedMenu.svelte';
    import StageNote from '#lib/components/player/StageNote.svelte';
    import StageTail from '#lib/components/player/StageTail.svelte';
    import { audioTracks, liveCodecs, subtitles } from '#lib/components/player/settings.js';
    import { snapshotter } from '#lib/components/player/shot.svelte.js';
    import { grabbedFrame, videoFrame } from '#lib/components/player/snapshot.js';
    import { stageTap } from '#lib/components/player/stage-tap.js';
    import Toasts, { type Notice } from '#lib/components/Toasts.svelte';
    import { programDetail, recordingFacts } from '#lib/detail.svelte.js';
    import { driveGate } from '#lib/drive-gate.svelte.js';
    import { clock as clockLabel } from '#lib/format.js';
    import { write as remind } from '#lib/keep.js';
    import { livePlayer } from '#lib/live-player.svelte.js';
    import { liveUpdates } from '#lib/live-updates.svelte.js';
    import { keepResume } from '#lib/resume.js';
    import { stepSpeed } from '#lib/ts/pacing.js';
    import { resolve } from '$app/paths';

    /**
     * 追っかけ再生 ([issue #16](https://github.com/danything/denpa/issues/16))。
     * **録画中の録画を頭から観る。** 元のTSはブラウザで読めないので、プレイヤーはライブと
     * 同じ (fMP4 → WebSocket → MSE、互換モードでは canvas。`live-player.svelte.ts` の chase モード)。
     *
     * ライブとの違いは3つ — 頭から観られる・シークできる・右端が伸びる。
     * シークバーは番組の全長で、右端 (いま録れているところ) は壁時計で伸ばす。
     */
    let { data } = $props();

    /** 運転中の注意 (互換モード。`drive-gate.svelte.ts`)。押すまで再生を始めない */
    const drive = driveGate();
    const player = livePlayer({ confirm: drive.confirm });
    /** 映像と重ねもの (MediaStack が組む)。bind で受けるので開くまでは null */
    let video = $state<HTMLVideoElement | null>(null);
    let still = $state<HTMLCanvasElement | null>(null);
    let overlay = $state<HTMLCanvasElement | null>(null);
    /** 全画面にする枠 (`PlayerStage` が bind する)。キーの `f` から使う */
    let stageEl = $state<HTMLElement | null>(null);
    /** 全画面の出入り (3画面共通。[fullscreen.svelte.ts](../../../lib/components/player/fullscreen.svelte.ts)) */
    const fullscreen = stageFullscreen(() => stageEl);

    /** 右端を伸ばすための時計。1秒刻みで十分 (バーの目盛りより細かい) */
    let clock = $state(Date.now());

    /**
     * **エンコードが終わったら観る画面へ案内する。** 録り終えてからエンコードが終わるまでの間
     * (CM検出・エンコード) もこの画面で観られるが、エンコードが終われば普通の観る画面の
     * ほうがよい (CM飛ばし・チャプター・データ放送が揃い、サーバの ffmpeg も要らない)。
     * 録画の通知 (SSE) が来るたびに状態の API を読み、エンコードできていれば案内を出す。
     * **勝手には移らない** — 観ている最中に画面が切り替わると位置が飛ぶ。
     * 押して移れば、途中の位置は続き再生 (keepResume) が覚えている
     */
    let encoded = $state(false);
    liveUpdates([], {
        recordings: () => {
            void fetch(resolve(`api/recordings/${data.rec.id}`))
                .then((res) => (res.ok ? res.json() : null))
                .then((body: { encoded?: boolean } | null) => {
                    if (body?.encoded === true) encoded = true;
                })
                .catch(() => {});
        },
    });

    /**
     * 右に出す番組の中身 (観る画面と同じ `recordingFacts`)。番組表から引ければ
     * そちらで上書きする (`programDetail`)。追っかけは放送中なので、たいてい引ける。
     */
    const detail = programDetail();
    const facts = $derived(recordingFacts(data.rec));

    onMount(() => {
        want = storedSpeed();
        if (still !== null && overlay !== null) player.attach(still, overlay);
        // 前に途中まで観ていたら、そこから
        if (video !== null) void player.openChase(video, data.rec.id, data.rec.resumeSec);
        // 出演者などは番組表の側にある。押させずに、開いた時点で引く (観る画面と同じ)
        void detail.open(data.rec.program_id, facts);
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
    /** いま録れている長さ (秒)。録画中は通知の値を壁時計で伸ばす */
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
        player.chaseSeek(Math.max(0, Math.min(value, Math.max(0, recorded - 5))));
    }

    /** いまの場所から送る・戻す。キーと端2回タップが使う */
    function seekBy(seconds: number): void {
        seekTo(pos + seconds);
    }

    /**
     * 選んでいる速さ。**端末ごとに覚え、プレイヤーを作り直しても当て直す。**
     *
     * 鍵は観る画面と同じ (`SpeedMenu` の `SPEED_KEY`)。持っておくのは、追っかけのシークが
     * 読み直し (`openChase`) になることがあり、そこで**押した覚えの無いまま
     * 等速へ戻る**ため (`live-player` の `clear`)
     */
    let want = $state(1);

    function setSpeed(value: number): void {
        want = value;
        player.setSpeed(value);
        remind(SPEED_KEY, String(value));
    }

    /** プレイヤーを作り直したあとに当て直す。押されたときは `setSpeed` が先に入れている */
    $effect(() => {
        if (player.state === 'playing' && player.speed !== want) player.setSpeed(want);
    });

    /**
     * 視聴位置をサーバへ (15秒おき)。録り終えてエンコードが終わったら、観る画面の
     * 続き再生がここから読む — 追っかけで観たぶんを二度観ずに済む。
     * 送り方は観る画面と共通 (`#lib/resume.ts`。閉じ際は sendBeacon)
     */
    function sendResume(leaving = false): void {
        if (line === null || pos <= 0) return;
        // 追っかけは元の TS を流す
        keepResume(data.rec.id, pos, total, 'ts', leaving);
    }

    /** 操作列の出し入れ。ライブ・観る画面と同じ */
    const controls = playerControls();
    /** 止めている間も掛けたまま (ライブ・観る画面と同じ。あちらに理由) */
    const awake = screenAwake();
    $effect(() => {
        awake.on = player.state !== 'idle' && player.state !== 'error';
    });

    /** 押したことの読み方は観る画面と同じ (`stage-tap.ts`) */
    const press = stageTap({ toggle: () => player.toggle(), controls: () => controls.toggle(), seekBy });

    /** バックグラウンド再生 (`background.svelte.ts`)。既定は切で、裏に回ったら止め、戻ったら止めた所から */
    const background = backgroundPlayback({
        pip: () => pip.active,
        paused: () => player.paused,
        pause: () => player.toggle(),
        resume: () => player.toggle(),
    });

    /** アンビエントモード (`ambient.svelte.ts`)。ライブと同じ */
    const ambient = ambientMode({
        playing: () => !player.paused,
        canvas: () => (player.canvas ? player : null),
        video: () => video,
    });

    /** 小窓 (PiP)。小窓で押された止める・再開は player に合わせる (ライブと同じ。`pip.svelte.ts`) */
    const pip = pictureInPicture({
        video: () => video,
        raw: () => player.canvas,
        capture: () => player.capture(),
        flow: (on) => player.captureFlow(on),
        paused: () => player.paused,
        toggle: () => player.toggle(),
        auto: () => background.on,
        overlay: () => overlay,
        captions: () => player.captions && player.hasCaptions,
    });
    // 生の音を「再生する音」と言うのは、入れているときと小窓を開いている間だけ (`raw/engine.ts`)
    $effect(() => {
        player.playback = background.on || pip.active;
    });

    /** キーでも動かせるようにする。割り当ては観る画面と共通 (`player/keys.ts`) */
    const keys = playerKeys({
        togglePlay: () => player.toggle(),
        seekBy,
        toggleCaptions: () => player.toggleCaptions(),
        snapshot,
        toggleFull: fullscreen.toggle,
        stepSpeed: (by) => setSpeed(stepSpeed(want, by)),
        // **消音は player 側の印で切り替える。** 映像の要素を直に触ると、繋ぎ直しの
        // たびに `silenced` で上書きされて戻り、ボタンの見た目ともずれる
        toggleMute: () => (player.silenced ? player.unmute() : player.mute()),
    });

    /** いまの1コマを字幕ごと切り抜いて PNG に (ライブ・観る画面と同じ。`snapshot.ts`) */
    const shooter = snapshotter(controls);
    const notices = $derived<Notice[]>([...shooter.notices, ...pip.notices]);
    function snapshot(): void {
        void shooter.take(
            () => (player.canvas ? grabbedFrame(player.grab()) : videoFrame(video)),
            player.captions && player.hasCaptions ? overlay : null,
            data.rec.name,
        );
    }
</script>

<svelte:head>
    <title>{data.rec.name} (追っかけ) - denpa</title>
</svelte:head>

<svelte:window onkeydown={keys} />

<!-- **ライブ・観る画面と同じレイアウト** (PlayerLayout)。映像が左、番組の中身が右 -->
<PlayerLayout>
    <!-- 舞台の配線と映像の束はライブと共通 (PlayerStage / MediaStack) -->
    <PlayerStage {controls} {fullscreen} {ambient} testid="chase" bind:element={stageEl}>
        {#snippet children(stage)}
        <MediaStack
            holding={player.holding}
            captionsOn={player.captions && player.hasCaptions}
            onclick={press}
            prefix="chase"
            bind:video
            bind:still
            bind:overlay
        />

        <!-- 右上の列。**観る画面と同じ並び** (閉じる・切り抜き) -->
        <ControlBar side shown={controls.shown}>
            <CloseLink testid="chase-close" />
            <ControlButton
                icon={CAMERA}
                label="この場面を切り抜く"
                onclick={() => void snapshot()}
            />
        </ControlBar>

        <ControlBar shown={controls.shown} testid="chase-controls">
            <!-- シークバーは番組の全長。**録れていないところ (右側) へは飛べない** (`seekTo`) -->
            <SeekBar value={pos} max={total} step={1} onseek={seekTo} paused={player.paused} />

            <!-- **並びはライブと同じ。** 再生・音・字幕、端 (最新)、読みもの、速さ、再生の設定 (⚙)、全画面 -->
            <ControlRow testid="chase-buttons">
                <ControlButton
                    icon={player.paused ? PLAY : PAUSE}
                    label={player.paused ? '再生' : '一時停止'}
                    testid="chase-play"
                    onclick={() => player.toggle()}
                />
                <!--
                    **畳むとき (狭い枠・一段に入らないとき) に残すのは、再生・最新・読みもの・再生の設定 (⚙)・全画面だけ。**
                    音・字幕と速さ・小窓は「ほか」(⋯) に入れる (`Extras`。観る画面と同じ)
                -->
                <Extras>
                <ControlButton
                    icon={player.silenced ? SOUND_OFF : SOUND_ON}
                    label={player.silenced ? '音を出す' : '音を消す'}
                    testid="chase-sound"
                    onclick={() => (player.silenced ? player.unmute() : player.mute())}
                />
                {#if player.hasCaptions}
                    <ControlButton
                        icon={CAPTION}
                        label={player.captions ? '字幕を消す' : '字幕を出す'}
                        on={player.captions}
                        testid="chase-caption"
                        onclick={() => player.toggleCaptions()}
                    />
                {/if}
                </Extras>

                <!--
                    いま録れているところへ。ライブの「ライブ」に相当し、場所も同じ。

                    **録り終わっていたら出しません。** 「最新」は伸びていく端に
                    張り付くためのもので、録画が終われば端は動かず、ただの
                    「終わりへ飛ぶ」になります。エンコードが終わる前の追っかけでは
                    録り終えたあともこの画面にいられる (録画済みと出る) ので、
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
                        <span class="clock num">{clockLabel(pos)} / {clockLabel(recorded)}</span>
                        {#if line !== null && !line.finished}
                            <!-- 赤はライブの赤丸と同じ出し方。黒帯の上の text-error は沈む -->
                            ・ <span class="rec"><span class="rec-dot"></span>録画中</span>
                        {:else if line !== null}
                            ・ 録画済み
                        {/if}
                    {/snippet}
                </InfoBlock>

                <!--
                    追っかけは常に速さを選べる (録れている範囲の中を進むだけ)。
                    **互換モード (canvas に描く) では出さない** — 音を自前で鳴らしていて、等速だけ
                -->
                {#if !player.canvas}
                    <Extras>
                        <SpeedMenu
                            testid="chase-speed"
                            label="再生の速さ"
                            speed={want}
                            onselect={setSpeed}
                        />
                    </Extras>
                {/if}

                <!--
                    コーデックと音声は再生の設定 (⚙)。コーデックは選び直すと再生していた位置から再エンコード (ライブと同じ)
                -->
                <StageTail
                    prefix="chase"
                    {background}
                    {ambient}
                    {pip}
                    {fullscreen}
                    {stage}
                    codec={liveCodecs({
                        icon: CODEC,
                        codec: player.codec,
                        unavailable: player.unavailable,
                        onselect: (key) => player.setCodec(key),
                    })}
                    audio={player.audios.length > 1
                        ? audioTracks({
                              icon: AUDIO,
                              items: player.audios.map((a) => ({
                                  key: a.id,
                                  label: a.label,
                                  active: a.id === player.audio,
                              })),
                              onselect: (key) => player.setAudio(key),
                          })
                        : undefined}
                    subtitle={player.hasCaptions
                        ? subtitles({
                              icon: CAPTION,
                              on: player.captions,
                              tracks: player.captionTracks,
                              track: player.captionTrack,
                              languages: player.captionLanguages,
                              language: player.captionLanguage,
                              onoff: (on) => player.setCaptions(on),
                              ontrack: (index) => player.setCaptionTrack(index),
                              onlanguage: (index) => player.setCaptionLanguage(index),
                          })
                        : undefined}
                />
            </ControlRow>
        </ControlBar>

        {#if player.state !== 'playing'}
            <!-- 見た目の決まりはライブと共通 (`PlayerVeil`)。前のフレームを貼っている間は塗り潰さない -->
            <PlayerVeil
                holding={player.holding}
                busy={player.state !== 'error'}
                note={player.resuming ? '繋ぎ直しています' : ''}
                error={player.state === 'error' ? player.message : ''}
                testid="chase-status"
            >
                {#snippet actions()}
                    <button type="button"
                        class="small"
                        onclick={() => video !== null && void player.openChase(video, data.rec.id, pos)}
                    >
                        やり直す
                    </button>
                {/snippet}
            </PlayerVeil>
        {/if}
        {/snippet}

        <!-- 映像の上の通知は舞台の列に積む (`PlayerStage` の `notes`)。いくつ出ても重ならない -->
        {#snippet notes()}
            {#if encoded}
                <!--
                    エンコードが終わった。続きは観る画面で (位置は続き再生が覚えている)。
                    この先はみな観る画面の話になるので、これだけを出す。
                    StageNote は押せない表示 (`pointer-events: none`) なので、ここだけ押せるように置く。
                    見た目の決まりは同じ (角丸で黒の半透明)
                -->
                <span class="encoded" data-testid="chase-encoded">
                    <a
                        class="to-watch"
                        href={resolve(`watch/${data.rec.id}`)}
                        data-testid="chase-to-watch"
                    >
                        エンコードが終わりました — 続きは観る画面で
                    </a>
                </span>
            {:else}
                {#if player.chaseEnded}
                    <!-- 録れているところまで観た。録画が終わっていれば、この先はもう来ない -->
                    <StageNote testid="chase-ended">録画済みのところまで観ました</StageNote>
                {/if}
                {#if player.warning}
                    <!-- リクエストどおりにできなかった断り書き (GPU でエンコードできずにソフトウェアへ降りた、など) -->
                    <StageNote testid="chase-warning">{player.warning}</StageNote>
                {/if}
            {/if}
        {/snippet}
    </PlayerStage>

    <!-- 右は番組の中身。枠は観る画面と同じ部品 (FactsAside)、中身も同じ (ProgramFacts) -->
    {#snippet aside()}
        <FactsAside testid="chase-facts">
            <ProgramFacts program={detail.current ?? facts} />
        </FactsAside>
    {/snippet}
</PlayerLayout>

<Toasts
    {notices}
    ondismiss={(key) => {
        shooter.dismiss(key);
        pip.dismiss(key);
    }}
/>

<!-- 運転中の注意 (互換モードで初めて再生する前に1回)。押すまで再生を始めない -->
<DriveNotice open={drive.open} onaccept={drive.accept} />

<style>
    .rec {
        display: inline-flex;
        align-items: baseline;
        gap: 0.25rem;
    }
    /* 録画中の点 (`app.css` の `.rec-dot`。ゆっくり脈打つ) を字の真ん中に */
    .rec :global(.rec-dot) {
        align-self: center;
    }
    /* 通知の列は押せない (`PlayerStage`)。この通知だけ押せるように戻す */
    .encoded {
        display: flex;
        pointer-events: auto;
    }
    .to-watch {
        border-radius: 1rem;
        background: rgb(0 0 0 / 0.6);
        padding: 0.25rem 0.75rem;
        font-size: 0.75rem;
        color: #fff;
        text-decoration: underline;
        text-decoration-color: rgb(255 255 255 / 0.5);
        text-underline-offset: 2px;
    }
    .to-watch:hover {
        background: rgb(0 0 0 / 0.8);
    }
</style>
