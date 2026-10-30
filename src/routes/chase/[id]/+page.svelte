<script lang="ts">
  import { resolve } from "$app/paths";
  import { onMount, untrack } from "svelte";

  import DriveNotice from "#lib/components/DriveNotice.svelte";
  import { ambientMode } from "#lib/components/player/ambient.svelte.js";
  import { screenAwake } from "#lib/components/player/awake.svelte.js";
  import { backgroundPlayback } from "#lib/components/player/background.svelte.js";
  import CloseLink from "#lib/components/player/CloseLink.svelte";
  import ControlBar from "#lib/components/player/ControlBar.svelte";
  import ControlButton from "#lib/components/player/ControlButton.svelte";
  import ControlRow from "#lib/components/player/ControlRow.svelte";
  import { playerControls } from "#lib/components/player/controls.svelte.js";
  import EdgeButton from "#lib/components/player/EdgeButton.svelte";
  import Extras from "#lib/components/player/Extras.svelte";
  import FactsAside from "#lib/components/player/FactsAside.svelte";
  import { stageFullscreen } from "#lib/components/player/fullscreen.svelte.js";
  import {
    AUDIO,
    CAMERA,
    CAPTION,
    CHECK,
    CODEC,
    PAUSE,
    PLAY,
    SOUND_OFF,
    SPEED,
  } from "#lib/components/player/icons.js";
  import InfoBlock from "#lib/components/player/InfoBlock.svelte";
  import JikkyoLayer from "#lib/components/player/JikkyoLayer.svelte";
  import { playerKeys } from "#lib/components/player/keys.js";
  import MediaStack from "#lib/components/player/MediaStack.svelte";
  import { pictureInPicture } from "#lib/components/player/pip.svelte.js";
  import PlayerLayout from "#lib/components/player/PlayerLayout.svelte";
  import PlayerStage from "#lib/components/player/PlayerStage.svelte";
  import PlayerVeil from "#lib/components/player/PlayerVeil.svelte";
  import SeekBar from "#lib/components/player/SeekBar.svelte";
  import {
    liveAudio,
    liveCodecs,
    liveSubtitle,
    muteRow,
    speedRow,
  } from "#lib/components/player/settings.js";
  import { snapshotter } from "#lib/components/player/shot.svelte.js";
  import {
    captionWords,
    grabbedFrame,
    videoFrame,
  } from "#lib/components/player/snapshot.js";
  import SoundButton from "#lib/components/player/SoundButton.svelte";
  import SpeedMenu, {
    SPEED_KEY,
    storedSpeed,
  } from "#lib/components/player/SpeedMenu.svelte";
  import { stageTap } from "#lib/components/player/stage-tap.js";
  import StageNote from "#lib/components/player/StageNote.svelte";
  import StageTail from "#lib/components/player/StageTail.svelte";
  import { playerVolume } from "#lib/components/player/volume.svelte.js";
  import ProgramFacts from "#lib/components/ProgramFacts.svelte";
  import Toasts, { type Notice } from "#lib/components/Toasts.svelte";
  import { programDetail, recordingFacts } from "#lib/detail.svelte.js";
  import { driveGate } from "#lib/drive-gate.svelte.js";
  import { clock as clockLabel } from "#lib/format.js";
  import { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import { KAKOLOG_LAG } from "#lib/jikkyo/kakolog.js";
  import { jikkyoSwitch } from "#lib/jikkyo/switch.svelte.js";
  import { write as remind } from "#lib/keep.js";
  import { livePlayer } from "#lib/live-player.svelte.js";
  import { liveUpdates } from "#lib/live-updates.svelte.js";
  import { keepResume } from "#lib/resume.js";
  import { stepSpeed } from "#lib/ts/pacing.js";

  /**
   * 追っかけ再生 (録画中の録画を頭から観る)。プレイヤーはライブと同じ (`live-player.svelte.ts` の chase モード)。
   * ライブとの違いは、頭から観られる・シークできる・右端 (いま録れているところ) が壁時計で伸びる
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
   * エンコードが終わったら観る画面へ案内する (CM飛ばし・チャプター・データ放送が揃う)。録画の通知が来るたびに
   * 状態を読む。勝手には移らない — 観ている最中に位置が飛ぶ。途中の位置は続き再生が覚えている
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

  /** 右に出す番組の中身 (観る画面と同じ)。追っかけは放送中なので、たいてい番組表から引ける */
  const detail = programDetail();
  const facts = $derived(recordingFacts(data.rec));

  onMount(() => {
    want = storedSpeed();
    if (still !== null && overlay !== null) player.attach(still, overlay);
    // 前に途中まで観ていたら、そこから
    if (video !== null)
      void player.openChase(video, data.rec.id, data.rec.resumeSec);
    // 出演者などは番組表の側にある。押させずに、開いた時点で引く (観る画面と同じ)
    void detail.open(data.rec.program_id, facts);
    const ticker = setInterval(() => (clock = Date.now()), 1000);
    const keeper = setInterval(() => sendResume(), 15_000);
    const onLeave = () => sendResume(true);
    window.addEventListener("pagehide", onLeave);
    return () => {
      clearInterval(ticker);
      clearInterval(keeper);
      window.removeEventListener("pagehide", onLeave);
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

  /**
   * 実況のコメント (docs/watch.md の「実況のコメント」)。古いところ (10 分より前) は過去ログ API から
   * 開いたときに 1 回、その後は 5 分おきに取り足し、新しいところは NX-Jikkyo の WebSocket から受ける
   */
  const jikkyoOn = jikkyoSwitch();
  const jikkyo = new JikkyoFeed(true);
  const jikkyoActive = $derived(data.jikkyoAllowed && jikkyoOn.on);
  $effect(() => {
    const target = data.jikkyo;
    jikkyo.set(target?.channel ?? null, jikkyoActive);
    if (target !== null && jikkyoActive)
      untrack(() =>
        jikkyo.kakolog(target.head, () => Date.now() - KAKOLOG_LAG, 5 * 60_000),
      );
  });
  onMount(() => () => jikkyo.close());
  /** いま観ている場面の放送時刻 (元の TS の頭の放送時刻 + 追っかけの再生位置) */
  function airTime(): number | null {
    const target = data.jikkyo;
    return target === null ? null : target.head + player.chasePosition * 1000;
  }
  // 過去ログにまだ入っていない新しいところ (10 分以内) を観ているなら、NX-Jikkyo で 1 回だけ遡る
  $effect(() => {
    const w = airTime();
    if (w !== null && jikkyoActive) untrack(() => jikkyo.backfill(w));
  });

  /** シーク。**録れているところより先へは行かせない** (まだ無い) */
  function seekTo(value: number): void {
    player.chaseSeek(Math.max(0, Math.min(value, Math.max(0, recorded - 5))));
  }

  /** いまの場所から送る・戻す。キーと端2回タップが使う */
  function seekBy(seconds: number): void {
    seekTo(pos + seconds);
  }

  /**
   * 選んでいる速さ。端末ごとに覚え (観る画面と同じ `SPEED_KEY`)、プレイヤーを作り直しても当て直す —
   * シークが読み直し (`openChase`) になると、押した覚えの無いまま等速へ戻る (`live-player` の `clear`)
   */
  let want = $state(1);

  function setSpeed(value: number): void {
    want = value;
    player.setSpeed(value);
    remind(SPEED_KEY, String(value));
  }

  /** プレイヤーを作り直したあとに当て直す。押されたときは `setSpeed` が先に入れている */
  $effect(() => {
    if (player.state === "playing" && player.speed !== want)
      player.setSpeed(want);
  });

  /**
   * 視聴位置をサーバへ (15秒おき)。エンコードが終わったら、観る画面の続き再生がここから読む
   * (送り方は観る画面と共通。`#lib/resume.ts`)
   */
  function sendResume(leaving = false): void {
    if (line === null || pos <= 0) return;
    // 追っかけは元の TS を流す
    keepResume(data.rec.id, pos, total, "ts", leaving);
  }

  /** 操作列の出し入れ。ライブ・観る画面と同じ */
  const controls = playerControls();
  /** 止めている間も掛けたまま (ライブ・観る画面と同じ。あちらに理由) */
  const awake = screenAwake();
  $effect(() => {
    awake.on = player.state !== "idle" && player.state !== "error";
  });

  /** 押したことの読み方は観る画面と同じ (`stage-tap.ts`) */
  const press = stageTap({
    toggle: () => player.toggle(),
    controls: () => controls.toggle(),
    seekBy,
  });

  /** バックグラウンド再生 (`background.svelte.ts`)。既定はオフで、裏に回ったら止め、戻ったら止めた所から */
  const background = backgroundPlayback({
    nativeVideo: () => (player.canvas ? null : video),
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
  // MPEG-2 をデコードした音を「再生する音」と言うのは、入れているときと小窓を開いている間だけ (`raw/engine.ts`)
  $effect(() => {
    player.playback = background.on || pip.active;
  });

  /** 音量 (`volume.svelte.ts`)。canvas はエンジンの中で、`<video>` は Web Audio に通して掛ける (ライブと同じ) */
  const volume = playerVolume({
    video: () => (player.canvas ? null : video),
    through: () => background.on || pip.active,
    remote: (paused) => {
      if (paused !== player.paused) player.toggle();
    },
  });
  $effect(() => {
    player.volume = volume.level;
  });

  /** キーでも動かせるようにする。割り当ては観る画面と共通 (`player/keys.ts`) */
  const keys = playerKeys({
    togglePlay: () => player.toggle(),
    seekBy,
    toggleCaptions: () => player.toggleCaptions(),
    snapshot,
    toggleFull: fullscreen.toggle,
    stepSpeed: (by) => setSpeed(stepSpeed(want, by)),
    toggleMute: player.toggleMute,
    stepVolume: volume.step,
  });

  /** いまの1コマを字幕ごと切り抜いてサーバに保存する (ライブ・観る画面と同じ。`shot.svelte.ts`) */
  const shooter = snapshotter(controls);
  const notices = $derived<Notice[]>([...shooter.notices, ...pip.notices]);
  function snapshot(): void {
    void shooter.take(
      () => (player.canvas ? grabbedFrame(player.grab()) : videoFrame(video)),
      player.captions && player.hasCaptions ? overlay : null,
      data.rec.name,
      () => ({
        place: "chase",
        recording: data.rec.id,
        at: pos,
        // 追っかけは元の TS を流す
        source: "ts",
      }),
      player.captions ? captionWords(player.shownCaption) : "",
    );
  }
</script>

<svelte:head>
  <title>{data.rec.name} (追っかけ) - denpa</title>
</svelte:head>

<svelte:window onkeydown={keys} />

<!-- ライブ・観る画面と同じレイアウト (PlayerLayout / PlayerStage / MediaStack)。映像が左、番組の中身が右 -->
<PlayerLayout>
  <PlayerStage
    {controls}
    {fullscreen}
    {ambient}
    testid="chase"
    bind:element={stageEl}
  >
    {#snippet children(stage)}
      <MediaStack
        holding={player.holding}
        captionsOn={player.captions && player.hasCaptions}
        onclick={press}
        prefix="chase"
        bind:video
        bind:still
        bind:overlay
      >
        {#snippet under()}
          <!-- 映像 → 実況 → 字幕。世帯の設定がオンのときだけ置く (ライブと同じ) -->
          {#if data.jikkyoAllowed}
            <JikkyoLayer
              feed={jikkyo}
              air={airTime}
              show={jikkyoActive && data.jikkyo !== null}
              paused={player.paused}
              rate={player.rate}
            />
          {/if}
        {/snippet}
      </MediaStack>

      <!-- 右端の縦の列。**観る画面と同じ並び** (上から閉じる・切り抜き) -->
      <ControlBar side shown={controls.shown}>
        <CloseLink />
        <ControlButton
          icon={shooter.saved ? CHECK : CAMERA}
          label="この場面を切り抜く"
          testid="chase-shot"
          onclick={() => void snapshot()}
        />
      </ControlBar>

      <ControlBar shown={controls.shown} testid="chase-controls">
        <!-- シークバーは番組の全長。**録れていないところ (右側) へは飛べない** (`seekTo`) -->
        <SeekBar
          value={pos}
          max={total}
          step={1}
          onseek={seekTo}
          paused={player.paused}
        />

        <!-- 並びはライブと同じ (`ControlRow`) -->
        <ControlRow testid="chase-buttons">
          <ControlButton
            icon={player.paused ? PLAY : PAUSE}
            label={player.paused ? "再生" : "一時停止"}
            testid="chase-play"
            onclick={() => player.toggle()}
          />
          <!-- 畳むときは音と速さを ⚙ の頭に入れる (`Extras`・`StageTail` の `fold`。字幕は ⚙ の「字幕」) -->
          <Extras>
            <SoundButton
              silenced={player.silenced}
              testid="chase-sound"
              onclick={player.toggleMute}
              {volume}
            />
            {#if player.hasCaptions}
              <ControlButton
                icon={CAPTION}
                label={player.captions ? "字幕を消す" : "字幕を出す"}
                on={player.captions}
                testid="chase-caption"
                onclick={() => player.toggleCaptions()}
              />
            {/if}
          </Extras>

          <!--
                    いま録れているところへ (ライブの「ライブ」の場所)。録り終わっていたら端は動かず、
                    ただの「終わりへ飛ぶ」になるので出さない
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
              <span class="clock num"
                >{clockLabel(pos)} / {clockLabel(recorded)}</span
              >
              {#if line !== null && !line.finished}
                <!-- 赤いのは点だけ (`.rec-dot`)。字まで赤くすると黒い操作バーの上で沈む -->
                ・ <span class="rec"><span class="rec-dot"></span>録画中</span>
              {:else if line !== null}
                ・ 録画済み
              {/if}
            {/snippet}
          </InfoBlock>

          <!-- 速さはいつでも選べる (録れている範囲の中を進むだけ)。互換モードは等速だけ -->
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

          <!-- コーデックは選び直すと再生していた位置から再エンコード (ライブと同じ) -->
          <StageTail
            prefix="chase"
            {volume}
            fold={[
              muteRow(SOUND_OFF, player.silenced, player.toggleMute),
              ...(player.canvas
                ? []
                : [
                    speedRow({
                      icon: SPEED,
                      label: "再生の速さ",
                      speed: want,
                      onselect: setSpeed,
                    }),
                  ]),
            ]}
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
            audio={liveAudio(AUDIO, player)}
            subtitle={liveSubtitle(CAPTION, player)}
            jikkyo={data.jikkyoAllowed
              ? {
                  on: jikkyoOn.on,
                  toggle: jikkyoOn.toggle,
                  missing: data.jikkyo === null,
                  down: jikkyo.down,
                }
              : undefined}
          />
        </ControlRow>
      </ControlBar>

      {#if player.state !== "playing"}
        <!-- 見た目の決まりはライブと共通 (`PlayerVeil`)。前のフレームを貼っている間は塗り潰さない -->
        <PlayerVeil
          holding={player.holding}
          busy={player.state !== "error"}
          note={player.resuming ? "繋ぎ直しています" : ""}
          error={player.state === "error" ? player.message : ""}
          testid="chase-status"
        >
          {#snippet actions()}
            <button
              type="button"
              class="small"
              onclick={() =>
                video !== null &&
                void player.openChase(video, data.rec.id, pos)}
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
                    エンコードが終わったら、この先はみな観る画面の話なのでこれだけを出す。
                    StageNote は押せないので、ここだけ押せる形で置く (見た目は同じ)
                -->
        <span class="encoded" data-testid="chase-encoded">
          <a
            class="stage-note to-watch"
            href={resolve(`watch/${data.rec.id}`)}
            data-testid="chase-to-watch"
          >
            エンコードが終わりました — 続きは観る画面で
          </a>
        </span>
      {:else}
        {#if player.chaseEnded}
          <!-- 録れているところまで観た。録画が終わっていれば、この先はもう来ない -->
          <StageNote>録画済みのところまで観ました</StageNote>
        {/if}
        {#if player.warning}
          <!-- リクエストどおりにできなかった断り書き (GPU でエンコードできずにソフトウェアへ降りた、など) -->
          <StageNote>{player.warning}</StageNote>
        {/if}
        {#if volume.noted}
          <StageNote testid="chase-volume-note">音量 {volume.level}%</StageNote>
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
  .rec .rec-dot {
    align-self: center;
  }
  /* 通知の列は押せない (`PlayerStage`)。この通知だけ押せるように戻す */
  .encoded {
    display: flex;
    pointer-events: auto;
  }
  .to-watch {
    color: var(--dp-on-video);
    text-decoration: underline;
    text-decoration-color: var(--dp-on-video-muted);
    text-underline-offset: 2px;
  }
  .to-watch:hover {
    background: var(--dp-video-veil-strong);
  }
</style>
