<script lang="ts">
  import { resolve } from "$app/paths";
  import type { ResponseMessage } from "@danything/arib/bml-protocol";
  import {
    CAPTION_TEXT_VERSION,
    type CaptionLanguage,
    captionLanguage as languageOf,
    type CaptionPage,
    type CaptionPages,
  } from "@danything/arib/caption-text";
  import { onMount, untrack } from "svelte";
  import { MediaQuery } from "svelte/reactivity";

  import { submitting } from "#lib/actions.js";
  import {
    ADAPT_NOTE,
    type AdaptDecision,
    adaptNote,
    HOLD,
    type Step,
    stepOrder,
  } from "#lib/adapt.js";
  import { arming } from "#lib/arming.svelte.js";
  import { type CanvasPlayer, canvasPlayer } from "#lib/canvas-player.js";
  import { canvasVideo, driveNoticeSeen } from "#lib/canvas-video.js";
  import DriveNotice from "#lib/components/DriveNotice.svelte";
  import { ambientMode } from "#lib/components/player/ambient.svelte.js";
  import { screenAwake } from "#lib/components/player/awake.svelte.js";
  import { backgroundPlayback } from "#lib/components/player/background.svelte.js";
  import { CaptionPainter } from "#lib/components/player/caption-draw.js";
  import {
    CAPTION_LANGUAGE_KEY,
    CAPTION_ON_KEY,
    pickLanguage,
    storedCaptionsOn,
  } from "#lib/components/player/caption-pref.js";
  import CloseLink from "#lib/components/player/CloseLink.svelte";
  import ControlBar from "#lib/components/player/ControlBar.svelte";
  import ControlButton from "#lib/components/player/ControlButton.svelte";
  import ControlRow from "#lib/components/player/ControlRow.svelte";
  import { playerControls } from "#lib/components/player/controls.svelte.js";
  import {
    DATA_RECEIVE_KEY,
    storedDataReceive,
  } from "#lib/components/player/data-receive.js";
  import DataBroadcast, {
    pressD,
  } from "#lib/components/player/DataBroadcast.svelte";
  import Extras from "#lib/components/player/Extras.svelte";
  import FactsAside from "#lib/components/player/FactsAside.svelte";
  import { eachFrame } from "#lib/components/player/frames.js";
  import { stageFullscreen } from "#lib/components/player/fullscreen.svelte.js";
  import {
    AUDIO,
    CAMERA,
    CAPTION,
    CHECK,
    CODEC,
    JIKKYO,
    NEXT,
    PAUSE,
    PLAY,
    PREV,
    SOUND_OFF,
    SPEED,
    TRASH,
  } from "#lib/components/player/icons.js";
  import InfoBlock from "#lib/components/player/InfoBlock.svelte";
  import JikkyoLayer from "#lib/components/player/JikkyoLayer.svelte";
  import JikkyoList from "#lib/components/player/JikkyoList.svelte";
  import { playerKeys } from "#lib/components/player/keys.js";
  import { fitRect } from "#lib/components/player/paint.js";
  import { pictureInPicture } from "#lib/components/player/pip.svelte.js";
  import PlayerLayout, {
    PHONE_LANDSCAPE,
  } from "#lib/components/player/PlayerLayout.svelte";
  import PlayerStage from "#lib/components/player/PlayerStage.svelte";
  import PlayerVeil from "#lib/components/player/PlayerVeil.svelte";
  import Remote from "#lib/components/player/Remote.svelte";
  import SeekBar from "#lib/components/player/SeekBar.svelte";
  import {
    audioTracks,
    muteRow,
    recordingCodecs,
    speedRow,
    subtitles,
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
  import { unslipper } from "#lib/components/player/unslip.js";
  import { playerVolume } from "#lib/components/player/volume.svelte.js";
  import ProgramFacts from "#lib/components/ProgramFacts.svelte";
  import Toasts, {
    errorNotice,
    type Notice,
  } from "#lib/components/Toasts.svelte";
  import { programDetail, recordingFacts } from "#lib/detail.svelte.js";
  import { driveGate } from "#lib/drive-gate.svelte.js";
  import {
    clock,
    cmNoteWorthShowing,
    recordedDuration,
    size,
  } from "#lib/format.js";
  import { CODEC_LABEL } from "#lib/hw.js";
  import { JikkyoFeed } from "#lib/jikkyo/feed.svelte.js";
  import { JIKKYO_LIST_KEY, jikkyoSwitch } from "#lib/jikkyo/switch.svelte.js";
  import { read as stored, write as remind } from "#lib/keep.js";
  import { liveUpdates } from "#lib/live-updates.svelte.js";
  import { codecsFor, type LiveCodec } from "#lib/live.js";
  import { type MkvSource, openMkv } from "#lib/mkv-source.js";
  import type { OfflineVideo } from "#lib/offline-db.js";
  import { loadOffline } from "#lib/offline.svelte.js";
  import { canvasSupport, rawUnsupported } from "#lib/raw/support.js";
  import {
    heardOf,
    rangesOf,
    type RemuxPlayer,
    remuxPlayer,
    type StreamUrl,
  } from "#lib/remux-player.js";
  import { keepResume } from "#lib/resume.js";
  import type { Pace } from "#lib/rungs.js";
  import {
    type Cue,
    currentCue,
    showing as captionShowing,
  } from "#lib/ts/captions.js";
  import {
    feedFor,
    type PlacedMessage,
    replayAt,
  } from "#lib/ts/data-timeline.js";
  import { pickMediaSource } from "#lib/ts/media-source.js";
  import { stepSpeed } from "#lib/ts/pacing.js";
  import {
    aheadOf,
    AUDIO_TYPE,
    type CanvasAbility,
    canvasChoices,
    type CanvasCodec,
    canvasTranscodes,
    type CodecChoice,
    codecChoices,
    ENCODED_ORDER,
    type MediaAbility,
    MENU_ORDER,
    pickCanvas,
    type Picked,
    pickOffer,
    type PlaybackInfo,
    type PlayCodec,
    retryWait,
    STREAM_RETRIES,
    streamForAudio,
    transcodes,
  } from "#lib/ts/playback.js";
  import {
    type Chapter,
    chapterAt,
    cmSpans,
    isCm,
    nextChapterAt,
    plainMarks,
    playbackAt,
    prevChapterAt,
    resumePoint,
    type Ruler,
    skipCmAtStart,
    skipTarget,
    toTsTime,
  } from "#lib/ts/watch.js";
  import {
    ADAPT_TICK,
    autoLabel,
    busyNote,
    rungQuery,
    watchAdapt,
  } from "#lib/watch-adapt.js";

  let { data, form } = $props();
  const rec = $derived(data.recording);

  /** 観るものがあるか。エンコード済みか、録り終えた元の TS (`+page.server.ts`) */
  const ready = $derived(data.playable);
  /*
   * 端末に保存してあればオンラインでもそちらを観る (docs/offline.md)。字幕・チャプター・データ放送も
   * 落としてあるものを使う。確かめ終わるまで src を渡さない。先に渡すとサーバから読み始め、
   * あとから blob に差し替わって読み直しになる
   */
  let localSrc = $state<string | null>(null);
  let localChecked = $state(false);
  let localCopy: OfflineVideo | null = null;
  /** 端末に保存したものを探している最中の Promise。字幕・チャプターも探し終えてから読む */
  let localLookup: Promise<OfflineVideo | null> = Promise.resolve(null);
  /**
   * 何で観られるか (`api/recordings/<id>/playback`)。聞けなかった (オフライン) ときは null。
   * どれを使うかはこの画面が決める (`ts/playback.ts` の `pickOffer`)
   */
  let info = $state.raw<PlaybackInfo | null>(null);
  /** いま観ているもの。観られるものが無ければ null */
  let picked = $state.raw<Picked | null>(null);
  /** 人が選んだコーデック (`auto` は端末に合わせる)。端末ごとに覚える (デコードできるものが端末で違う) */
  let choice = $state<CodecChoice | "mpeg2">("auto");
  const CODEC_KEY = "watch-codec";
  /** サーバが混んでいて、その場の変換を断られた (`remux-player.ts` の `busy`) */
  let busy = $state(false);
  /** その場で流しているときのプレイヤー (`remux-player.ts`) */
  let remux: RemuxPlayer | null = null;
  /** 選び直したときに続ける位置 (秒)。プレイヤーの開始位置に使う */
  let switchAt: number | null = null;

  /*
   * ---- 回線に合わせた画質の段 (`watch-adapt.ts`。docs/stream.md「回線に合わせて画質を下げる」) ----
   *
   * 「自動」のときだけ段を動かす。ファイルの直再生・MPEG-2 (段 0) から下げるときは 1 回だけプレイヤーを作り直して変換へ移し、
   * そのあとは同じ MSE のまま替える (`remux-player.ts` の `switchTo`)。音声だけとの行き来は作り直す。
   * 互換モード (canvas に描く) は継ぎ目なく替える経路が無いので、段を替えるたびに canvas のプレイヤーを作り直す (`canvasStep`)
   */
  /** いまの段。0 は下げていない (ファイルの直再生・詰め替え・ふだんの変換) */
  let step = $state<Step>(0);
  /** 段を下げた変換でサーバが選んだコーデック (`X-Denpa-Codec`)。メニューの「自動」の行に添える */
  let stepCodec = $state<string | null>(null);
  /** 送り出しの具合を読む id (`X-Denpa-Pace`)。流していなければ null */
  let paceId: string | null = null;
  /** 段 0 がファイルの直再生か MPEG-2 (canvas に描く) だったとき、その観かた。写すだけのストリームが無いときに戻す先 */
  let fileZero: Picked | null = null;
  /**
   * 互換モードで段を替えて作り直したとき、替える前の段。応答が来たら忘れる (`heard`)。その前に混んでいて断られたら、
   * この段で作り直す (`canvasBusy`)
   */
  let stepFrom: Step | null = null;
  /** canvas のプレイヤーが貯めを使い切って止まっているか (`waiting`)。段を決めるのに渡す */
  let canvasStuck = false;
  /** 段 0 のビットレート (kbit/s)。ファイルの大きさと尺から。分からなければ null */
  let baseKbps: number | null = null;
  /** 段を切り替えている最中か (応答を待っている間は刻まない) */
  let switching = false;
  /** これより前 (ms) は段を動かさない。混んでいて断られたあと、続けてリクエストしない */
  let adaptQuietUntil = 0;
  /** 段の断り書き。しばらくで引っ込める */
  let adaptText = $state<string | null>(null);
  let adaptTimer: ReturnType<typeof setTimeout> | null = null;
  /** 段を替えるために作り直したとき、作り直す前に再生していたか。尺が分かったら続ける (`resume`) */
  let keepPlaying = false;
  /**
   * 「この場面から観る」(切り抜きの画面から `?at=`) で始める位置 (秒)。続きの位置より先に使い、1 度使ったら忘れる。
   * 続きからではないので「続きから」とは言わない
   */
  // svelte-ignore state_referenced_locally
  let sceneAt: number | null = data.scene;

  /*
   * ---- 互換モード (`canvas-video.ts`。docs/player.md) ----
   *
   * `<video>` の再生が止まる端末 (テスラの車載ブラウザ) のため、canvas に描く (`canvas-player.ts`。
   * ライブ・追っかけと同じエンジン)。ここでは `<video>` に戻らない。描けなくなったら MPEG-2 へ、
   * それも無理なら理由を出して止まる。端末に保存したものはその Matroska を読んで描く (`mkv-source.ts`)
   */
  /** 互換モードか。開いたときに決める (⚙ で切り替えたら読み直す。`StageTail`) */
  let compat = $state(false);
  /**
   * 互換モードでないとき、元の TS (MPEG-2) をこの端末でデコードできて、まだ打ち切っていないか (`MediaAbility.mpeg2`)。
   * できれば互換モードと同じく canvas に描く (`pickOffer` の `raw`)。打ち切ったかは `rawGaveUp`
   */
  let rawCapable = $state(false);
  /** MPEG-2 を描いている途中で打ち切ったか。**選び直すまで MPEG-2 にしない** (`canvasFallBack`) */
  let rawGaveUp = $state(false);
  /** この端末で描ける形式 (`raw/support.ts`)。調べるまで null */
  let canvasAbility = $state.raw<CanvasAbility | null>(null);
  /** いま canvas に描いている形式。描いていなければ null (`<video>` で観ている・まだ始めていない) */
  let canvasCodec = $state<CanvasCodec | null>(null);
  /** canvas に描くプレイヤー。`canvasCodec` が決まって、映像の箱ができたら作る */
  let canvas: CanvasPlayer | null = null;
  /** canvas のプレイヤーがあるか (`canvas` は畳み直しの都度替わるので、画面の出し分けはこちらで見る) */
  let drawing = $state(false);
  /** 端末に保存した録画を描くときの読み込み元 (`mkv-source.ts`)。サーバから流しているなら null */
  let localMkv: MkvSource | null = null;
  /** 端末に保存した録画を canvas に描いているか (操作バーの「端末」の印・メニューの出し分け) */
  let drawingLocal = $state(false);
  /** 描いている途中で打ち切った形式。**選び直すまでリクエストし直さない** (戻しては打ち切るを繰り返さない) */
  let canvasGaveUp: CanvasCodec[] = [];
  /** 互換モードで観られない理由。出したら `<video>` には戻らずに止まる */
  let canvasProblem = $state<string | null>(null);
  /** 映像の上に出しておく断り書き (MPEG-2 に切り替えた、など) */
  let warning = $state<string | null>(null);
  /** 運転中の注意 (互換モード。`drive-gate.svelte.ts`)。押すまで再生を始めない */
  const drive = driveGate();

  /** 形式の名前 (メニュー・混んでいるときの勧め) */
  function codecLabel(codec: PlayCodec): string {
    return codec === "mpeg2" ? "MPEG-2" : CODEC_LABEL[codec];
  }

  /**
   * 互換モードの支度。運転中の注意をまだ見せていなければ見せて待ち、描ける形式を調べて、どれで観るかを決める
   * (`ts/playback.ts` の `pickCanvas`)。端末に保存したものがあれば、まずそれを描く (下)
   */
  async function prepareCompat(got: PlaybackInfo | null): Promise<void> {
    if (got === null && localCopy?.video === undefined) {
      canvasProblem = "サーバに繋がらないため、再生できません";
      return;
    }
    if (!driveNoticeSeen()) await drive.confirm();
    const [support, problem] = await Promise.all([
      canvasSupport(),
      rawUnsupported(),
    ]);
    canvasAbility = { ...support, mpeg2: problem === null };
    // 端末に保存したものはオンラインでも描く。描けない形式か読めなければ、サーバから流すものへ
    if (localCopy?.video !== undefined) {
      const source = await openMkv(localCopy.video).catch(() => null);
      if (source?.codec != null && canvasAbility[source.codec]) {
        localMkv = source;
        canvasCodec = source.codec;
        return;
      }
    }
    const codec = got === null ? null : pickCanvas(got, canvasAbility, choice);
    if (codec === null) canvasProblem = "再生できる形式がありません";
    else canvasCodec = codec;
  }

  /** canvas に描くプレイヤーを作って流しはじめる。**続きの位置からリクエストする** (選び直し・切り替えならその位置) */
  $effect(() => {
    const codec = canvasCodec;
    // 端末に保存したものはオフラインでも描く (`playback` が聞けなくてよい)
    if (
      codec === null ||
      (info === null && localMkv === null) ||
      mediaBox === null ||
      canvas !== null
    )
      return;
    untrack(() => startCanvas(codec));
  });

  /**
   * 尺 (秒)。**端末に保存したものを描いているなら、そのファイルに書いてある長さ** (描いているのはそのファイル。
   * 尻の手前へ飛ぶと終わりにするので、違う長さを使うと途中で終わる)。それ以外は `playback`
   */
  function canvasLength(): number {
    if (localMkv !== null)
      return localMkv.duration ?? (localCopy?.durationMs ?? 0) / 1000;
    return info?.duration ?? 0;
  }

  function startCanvas(codec: CanvasCodec): void {
    const local = localMkv;
    const duration = canvasLength();
    // 選び直し・切り替えは観はじめではない。この場面から観るのは観はじめなので `settle` を通す
    const fresh = switchAt === null;
    const scene = sceneAt !== null;
    const from = startFrom(duration);
    let made: CanvasPlayer;
    try {
      made = canvasPlayer({
        host: mediaBox as HTMLElement,
        before: jikkyoSlot ?? overlay,
        input:
          local !== null
            ? "mkv"
            : codec === "mpeg2" && step === 0
              ? "ts-mpeg2"
              : "fmp4",
        request: (at, audio, signal) =>
          local !== null
            ? Promise.resolve(local.request(at))
            : fetch(canvasUrl(codec, at, audio), { signal }),
        heard: (response) => {
          const heard = heardOf(response);
          stepCodec = heard.codec;
          paceId = heard.pace;
          stepFrom = null;
        },
        duration,
        // 端末に保存した録画の Blob は読むのが速すぎる。観ている位置の少し先までしか読まない (`canvas-player.ts` の `room`)
        ...(local !== null && localCopy?.video !== undefined && duration > 0
          ? { bytesPerSecond: localCopy.video.size / duration }
          : {}),
        start: from ?? 0,
        audio: streamAudio(audioIndex),
        background: background.on || pip.active,
        paused: false,
        state: (state) => {
          // 段を替えようとして作り直したが、混んでいて断られた。替える前の段で作り直して続ける
          if (state === "busy" && stepFrom !== null) {
            canvasBusy();
            return;
          }
          resuming = state === "retrying";
          busy = state === "busy";
          if (state !== "failed") return;
          // 読めない中身・繋ぎ直しを使い切った。理由を出して止まる (`<video>` には戻らない)
          stopCanvas();
          canvasProblem = "録画を読み込めませんでした";
        },
        gaveUp: canvasFallBack,
        remote: (stop) => (stop ? pauseMedia() : playMedia()),
        waiting: (on) => {
          canvasStuck = on;
          if (on) stall();
          else flowing();
        },
        ended: () => {
          playing = false;
          finished();
        },
        tick: canvasTick,
      });
    } catch (error) {
      canvasFallBack(
        `再生を始められませんでした (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    canvas = made;
    drawing = true;
    if (muted) made.mute(true);
    made.volume(volume.level);
    drawingLocal = local !== null;
    length = duration;
    at = from ?? 0;
    playing = !made.paused;
    syncAudio();
    place();
    controls.stir();
    if (!fresh || resumed) return;
    resumed = true;
    if (from !== null && !scene) showContinued();
    settle();
  }

  /**
   * canvas のプレイヤーのリクエスト先。段 0 は選んだ形式そのまま。段を下げるなら変換で、コーデックはサーバが
   * 描ける形式 (`canvasPlayable`) から選ぶ (MPEG-2 からは H.264 の変換としてリクエストする。`rungQuery`)
   */
  function canvasUrl(codec: CanvasCodec, at: number, audio: string): string {
    // 互換モードは音声だけにしない (`decideStep`)
    if (step === 0 || step === "audio") return streamUrl(codec, at, audio);
    return (
      streamUrl(codec === "mpeg2" ? "h264" : codec, at, audio) +
      rungQuery(step, canvasPlayable())
    );
  }

  /** 互換モードで描けるコーデック (`?playable=`)。描いている途中で打ち切ったものは外す。H.265 は描かない (`raw/support.ts`) */
  function canvasPlayable(): LiveCodec[] {
    const can = canvasAbility;
    if (can === null) return [];
    return (["av1", "h264"] as const).filter(
      (codec) => can[codec] && !canvasGaveUp.includes(codec),
    );
  }

  /**
   * **互換モードで段を替える。** canvas のプレイヤーには継ぎ目なく替える経路が無いので、いまの位置から作り直す
   * (新しいプレイヤーが描き始めるまで、映像と音は止まる)。替えたら true
   */
  function canvasStep(next: Step): boolean {
    const codec = canvasCodec;
    if (codec === null || localMkv !== null) return false;
    const position = mediaTime();
    const from = step;
    stopCanvas();
    stepFrom = from;
    step = next;
    stepCodec = null;
    paceId = null;
    switchAt = position;
    canvasCodec = codec;
    startCanvas(codec);
    return true;
  }

  /** 互換モードで段を替えようとして、混んでいて断られた。替える前の段で作り直し、しばらく段を動かさない */
  function canvasBusy(): void {
    const back = stepFrom;
    if (back === null) return;
    const down = stepOrder(step) > stepOrder(back);
    adaptQuietUntil = Date.now() + HOLD;
    canvasStep(back);
    // 前の段に戻すのは段の切り替えではない。この作り直しが断られたら、ふだんどおり「混んでいる」と出す
    stepFrom = null;
    noteAdapt(busyNote(down));
  }

  /** canvas のプレイヤーを畳む (切り替える・打ち切る) */
  function stopCanvas(): void {
    canvas?.destroy();
    canvas = null;
    canvasStuck = false;
    // 作り直しの途中で畳んだ (失敗した・打ち切った・選び直した)。替える前の段は忘れる (残すと段を動かさなくなる)
    stepFrom = null;
    drawing = false;
    drawingLocal = false;
    canvasCodec = null;
    playing = false;
    flowing();
  }

  /**
   * 描くのを打ち切った。理由は断り書きに残す。ライブと同じ順で替える (`live-player.svelte.ts` の `fallBack`)。
   * H.264 / AV1 を打ち切ったら MPEG-2 へ、MPEG-2 を打ち切ったら描ける H.264 / AV1 へ。端末に保存した録画なら
   * サーバから流すものへ。どれも無理なら理由を出して止まる (`<video>` には戻らない)。
   *
   * 互換モードでないのに描いているのは MPEG-2 を選んだときだけ (`pickOffer` の `raw`)。打ち切ったらこの画面を開いている間は
   * MPEG-2 を外し (`rawGaveUp`)、自動と同じ決め方で `<video>` に戻す
   */
  function canvasFallBack(reason: string): void {
    const failed = canvasCodec;
    const position = mediaTime();
    const wasLocal = localMkv !== null;
    stopCanvas();
    // 描けなくなったのは端末のデコードの都合 (`raw/budget.ts`)。回線の段とは混ぜず、段 0 から決め直す
    step = 0;
    stepCodec = null;
    stepFrom = null;
    if (!compat) {
      rawGaveUp = true;
      const fresh =
        info === null ? null : pickOffer(info, ability(), "auto", data.indoor);
      warning =
        fresh === null
          ? reason
          : `${reason}。${codecLabel(fresh.codec)} に切り替えました`;
      replay(fresh, position);
      return;
    }
    let next: CanvasCodec | null = null;
    if (wasLocal) {
      localMkv = null;
      if (info !== null && canvasAbility !== null)
        next = pickCanvas(info, canvasAbility, choice, canvasGaveUp);
    } else {
      if (failed !== null) canvasGaveUp = [...canvasGaveUp, failed];
      const usable =
        info === null || canvasAbility === null
          ? []
          : canvasChoices(info, canvasAbility).filter(
              (item) => item.drawable && !canvasGaveUp.includes(item.codec),
            );
      next =
        failed === "mpeg2"
          ? (usable.find((item) => item.codec !== "mpeg2")?.codec ?? null)
          : usable.some((item) => item.codec === "mpeg2")
            ? "mpeg2"
            : null;
    }
    if (next === null) {
      canvasProblem = reason;
      return;
    }
    warning = wasLocal
      ? reason
      : `${reason}。${codecLabel(next)} に切り替えました`;
    switchAt = position;
    canvasCodec = next;
  }

  /** canvas のプレイヤーの刻み。`<video>` の `timeupdate` と映した 1 枚ごとの追いかけ (`follow`) の代わり */
  function canvasTick(): void {
    if (canvas === null) return;
    const now = canvas.currentTime;
    if (Math.abs(now - at) >= 0.05) at = now;
    // 自動再生で断られて音を出せていない。消音にしておき、押して出してもらう (ライブと同じ)
    if (!muted && canvas.blocked && !canvas.paused) muted = true;
    // 飛んだ先に着いた (流れ出した)。CM の跨ぎを待つのをやめる
    if (waiting && canvas.flowing && now >= hopTo) {
      if (++settled >= SETTLED) open();
    }
    if (canvas.flowing && !hopping) askCaptions();
    paint();
    hopCm();
    feedData();
  }

  /*
   * ---- 再生の操作 ----
   *
   * `<video>` と canvas のプレイヤーのどちらで観ていても、位置・飛ぶ・止める・再開はここを通す
   */
  /** いまの位置 (秒。物差しの上) */
  function mediaTime(): number {
    return canvas?.currentTime ?? video?.currentTime ?? 0;
  }

  /** 飛ぶ。canvas は持っているものを捨ててリクエストし直す */
  function seekMedia(to: number): void {
    if (canvas !== null) {
      canvas.seek(to);
      at = to;
      paint();
      feedData();
      return;
    }
    if (video !== null) {
      video.currentTime = to;
      // 時刻の表示も飛んだ先へ。`timeupdate` を待つと、つまみを離したあと一瞬元の時刻に戻って見える
      at = to;
    }
  }

  function mediaPaused(): boolean {
    return canvas !== null ? canvas.paused : (video?.paused ?? true);
  }

  function playMedia(): void {
    if (canvas !== null) {
      canvas.play();
      playing = true;
      controls.stir();
      return;
    }
    void video?.play().catch(() => undefined);
  }

  function pauseMedia(): void {
    if (canvas !== null) {
      canvas.pause();
      /*
       * **止めた位置を時計にすぐ出す。** 刻み (`canvasTick`) を待つと、押した直後は 1 つ前の刻みの位置が
       * 出ていて、次の刻みで 1 秒進んだように見えた。0.05 秒より小さな差は刻みでは直さないので、
       * 止めている間ずっとずれたままのこともあった (`<video>` は止めたときに `timeupdate` が来る)
       */
      at = canvas.currentTime;
      playing = false;
      flowing();
      return;
    }
    video?.pause();
  }

  /** 音を消す・出す。canvas はプレイヤーの音 (自動再生で断られていても、押されたここなら鳴らせる) */
  function toggleMute(): void {
    if (canvas !== null) {
      muted = !muted;
      canvas.mute(muted);
      return;
    }
    if (video !== null) video.muted = !video.muted;
  }

  /** ブラウザへの問い合わせ (`ts/playback.ts`)。DOM が要るので開いてから */
  function ability(): MediaAbility {
    return {
      play: (type) => document.createElement("video").canPlayType(type) !== "",
      mse: (type) => pickMediaSource()?.Source.isTypeSupported(type) ?? false,
      mpeg2: rawCapable && !rawGaveUp,
    };
  }

  onMount(() => {
    localLookup = loadOffline(rec.id).catch(() => null);
    const asked = stored(CODEC_KEY);
    // メニューから外したコーデック (世帯の設定) を選んでいた端末は、自動として扱う
    choice =
      (asked === "h264" ||
        asked === "hevc" ||
        asked === "av1" ||
        asked === "mpeg2") &&
      !data.hidden.some((codec) => codec === asked)
        ? asked
        : "auto";
    void (async () => {
      const [held, got] = await Promise.all([
        localLookup,
        ready ? loadPlayback() : null,
      ]);
      localCopy = held;
      info = got;
      // 互換モードは canvas に描く (`prepareCompat`)。端末に保存したものも canvas に描く
      compat = ready && canvasVideo();
      if (compat) {
        await prepareCompat(got);
        localChecked = true;
        return;
      }
      // 元の TS をそのまま流せるなら、この端末でデコードできるかを先に確かめる (MPEG-2 を並べる・選ぶ元)
      if (got?.offers.some((offer) => offer.way === "raw") === true)
        rawCapable = (await rawUnsupported()) === null;
      /*
       * 聞けなかった (オフライン) ときは、今までどおりエンコード済みをそのまま渡す。
       * 端末に保存したものがあればそちら (下)
       */
      picked =
        got !== null
          ? pickOffer(got, ability(), choice, data.indoor)
          : rec.library_path?.endsWith(".mkv") === true ||
              localCopy?.video !== undefined
            ? { way: "file", codec: "av1", source: "encoded" }
            : null;
      // 端末のコピーはエンコード済みの主。そのまま読むときだけ使う (選んだコーデックがあれば選んだほう)
      if (
        localCopy?.video !== undefined &&
        picked?.way === "file" &&
        choice === "auto"
      ) {
        localSrc = URL.createObjectURL(localCopy.video);
      }
      // 元の TS は互換モードと同じく canvas に描く (`startCanvas`)
      if (picked?.way === "raw") canvasCodec = "mpeg2";
      if (ready && picked === null) broken = true;
      localChecked = true;
    })();
    return () => {
      if (localSrc !== null) URL.revokeObjectURL(localSrc);
      remux?.destroy();
      canvas?.destroy();
      canvas = null;
    };
  });

  /** 何で観られるか (`api/recordings/<id>/playback`)。聞けなければ null */
  async function loadPlayback(): Promise<PlaybackInfo | null> {
    try {
      const res = await fetch(resolve(`api/recordings/${rec.id}/playback`));
      return res.ok ? ((await res.json()) as PlaybackInfo) : null;
    } catch {
      return null;
    }
  }

  const src = $derived(
    localChecked && picked?.way === "file"
      ? (localSrc ??
          resolve(`api/recordings/${rec.id}/file?source=${picked.source}`))
      : undefined,
  );

  /** その場で流すもの (`/stream`) のリクエスト先。`at` 秒から、`audio` (`streamAudio`) の音声で */
  function streamUrl(
    codec: PlayCodec | "audio",
    at: number,
    audio: string,
  ): string {
    return resolve(
      `api/recordings/${rec.id}/stream?codec=${codec}&from=${at.toFixed(3)}&audio=${encodeURIComponent(audio)}`,
    );
  }

  /**
   * プレイヤーを作るときに始める位置 (秒)。コーデックを切り替えた所か、この場面から観る位置か、続きの位置。頭からなら null。
   * **切り替えた所は 1 度読んだら忘れる**
   */
  function startFrom(duration: number): number | null {
    const from =
      switchAt ??
      sceneAt ??
      (rec.resume_ms === null
        ? null
        : resumePoint(rec.resume_ms / 1000, duration));
    switchAt = null;
    sceneAt = null;
    return from;
  }

  /** **黙って途中から始めない。** 続きから始めたと言って、しばらくで引っ込める */
  function showContinued(): void {
    continued = true;
    setTimeout(() => (continued = false), 4000);
  }

  /** その場で流すときにリクエストする音声 (`playback` の `audios` の `id`) */
  function streamAudio(index: number): string {
    // 端末に保存した録画はトラックの何本目か (`mkv-source.ts`)
    if (localMkv !== null) return String(index);
    return info?.audios[index]?.id ?? info?.audios[0]?.id ?? "0";
  }

  /** その場で流すなら、プレイヤーを作って流しはじめる。**続きの位置からリクエストする** (頭から読んで捨てない) */
  $effect(() => {
    const plan = picked;
    if (
      !localChecked ||
      plan?.way !== "stream" ||
      info === null ||
      video === null ||
      remux !== null
    )
      return;
    const source = pickMediaSource();
    if (source === null) return;
    const total = info.duration;
    const from = startFrom(total);
    const at = untrack(() => step);
    remux = remuxPlayer(video, source, {
      url: stepUrl(at, plan),
      codecs: stepType(at, plan),
      duration: total,
      start: from ?? 0,
      audio: streamAudio(audioIndex),
      state: (state) => {
        // 段を下げようとして作り直したが、混んでいて断られた。ファイルの直再生に戻して続ける
        if (state === "busy" && step !== 0 && fileZero !== null) {
          backToFile(busyNote(true));
          return;
        }
        resuming = state === "retrying";
        busy = state === "busy";
        if (state === "failed") broken = true;
      },
      heard: (stream) => {
        stepCodec = stream.codec;
        paceId = stream.pace;
      },
    });
  });

  /** 端末が MSE で受け取れるコーデック (`?playable=`。段を下げたときはこの中からサーバが選ぶ) */
  function playable(): LiveCodec[] {
    const source = pickMediaSource();
    if (source === null) return [];
    return ENCODED_ORDER.filter((codec) =>
      source.Source.isTypeSupported(codecsFor(codec)),
    );
  }

  /** その段のリクエスト先。段 0 は選んだもの (`plan`) そのまま */
  function stepUrl(
    at: Step,
    plan: Extract<Picked, { way: "stream" }>,
  ): StreamUrl {
    if (at === "audio") return (from, audio) => streamUrl("audio", from, audio);
    const query = rungQuery(at, playable());
    return (from, audio) => streamUrl(plan.codec, from, audio) + query;
  }

  /** その段の MSE の型。段を下げた変換はサーバがコーデックを選ぶので、応答を受けてから決める (null) */
  function stepType(
    at: Step,
    plan: Extract<Picked, { way: "stream" }>,
  ): string | null {
    if (at === "audio") return AUDIO_TYPE;
    return at === 0 ? plan.type : null;
  }

  /** 段の断り書きを出す。しばらくで引っ込める */
  function noteAdapt(text: string): void {
    adaptText = text;
    if (adaptTimer !== null) clearTimeout(adaptTimer);
    adaptTimer = setTimeout(() => {
      adaptTimer = null;
      adaptText = null;
    }, ADAPT_NOTE);
  }

  /**
   * 段を替えるためにプレイヤーを作り直す。いまの位置から観直し、再生していたなら続ける。
   * 作り直したばかりで再生を待っている間 (`keepPlaying` が残っている) も続ける
   */
  function swap(fresh: Picked): void {
    keepPlaying = keepPlaying || (video !== null && !video.paused);
    replay(fresh);
  }

  /** 段を下げた変換をやめて、ファイルの直再生か MPEG-2 に戻す (作り直す) */
  function backToFile(note: string | null): void {
    const back = fileZero;
    if (back === null) return;
    fileZero = null;
    step = 0;
    stepCodec = null;
    paceId = null;
    adaptQuietUntil = Date.now() + HOLD;
    swap(back);
    // MPEG-2 は canvas のプレイヤーが止めずに始める。`<video>` を続けるための印は残さない
    if (back.way === "raw") keepPlaying = false;
    if (note !== null) noteAdapt(note);
  }

  /** ファイルの大きさから段 0 のビットレートを読む (`HEAD`)。読めなければ null のまま */
  async function readBaseKbps(source: string, duration: number): Promise<void> {
    try {
      const res = await fetch(
        resolve(`api/recordings/${rec.id}/file?source=${source}`),
        { method: "HEAD" },
      );
      const bytes = Number(res.headers.get("Content-Length"));
      if (res.ok && bytes > 0 && duration > 0)
        baseKbps = (bytes * 8) / duration / 1000;
    } catch {
      // 分からなければ `adapt.ts` の目安を使う
    }
  }

  /** `adapt.ts` が決めたことを受ける。段を動かせたら断り書きを出す */
  function decideStep(decision: AdaptDecision): void {
    const from = step;
    if (decision.reason === "encode" || decision.reason === "pinned") {
      noteAdapt(adaptNote(decision, from));
      return;
    }
    if (decision.step === from) return;
    /*
     * 互換モードは音声だけにせず、段 3 のまま流す (追っかけと同じ)。映像の無い fMP4 を canvas のプレイヤーで
     * 鳴らす経路を確かめていない
     */
    if (decision.step === "audio" && compat) return;
    void moveStep(decision.step).then((moved) => {
      if (moved) noteAdapt(adaptNote(decision, from));
    });
  }

  /** 段を `next` に替える。替えたら true */
  async function moveStep(next: Step): Promise<boolean> {
    // 互換モードは canvas のプレイヤーを作り直す
    if (compat) return canvasStep(next);
    const plan = picked;
    if (info === null || plan === null) return false;
    // MPEG-2 (canvas に描いている) から下げる。ファイルの直再生と同じく、1 回だけ `<video>` の変換に作り直す
    if (plan.way === "raw") {
      if (next === 0) return false;
      const fresh = streamForAudio(info, ability(), "h264");
      if (fresh === null) return false;
      fileZero = plan;
      step = next;
      keepPlaying = canvas !== null && !canvas.paused;
      swap(fresh);
      return true;
    }
    // ファイルの直再生から下げる。1 回だけプレイヤーを作り直して変換へ (同じコーデックの詰め替えを先に)
    if (plan.way === "file") {
      if (next === 0) return false;
      const fresh = streamForAudio(info, ability(), plan.codec);
      if (fresh === null) return false;
      fileZero = plan;
      if (baseKbps === null && plan.source !== undefined)
        void readBaseKbps(plan.source, info.duration);
      step = next;
      swap(fresh);
      return true;
    }
    if (plan.way !== "stream") return false;
    // 段 0 へ戻す。写すだけのストリームが無ければ (ファイルを変換していた) ファイルに戻す
    if (next === 0 && fileZero !== null && transcodes(info, plan)) {
      backToFile(null);
      return true;
    }
    // 音声だけとの行き来は作り直す (MSE は SourceBuffer の中のトラックの数を替えられない)
    if (next === "audio" || step === "audio" || remux === null) {
      step = next;
      // 同じ中身でも新しいオブジェクトにする (同じものを入れ直しても、プレイヤーを作り直す `$effect` が動かない)
      swap({ ...plan });
      return true;
    }
    switching = true;
    const result = await remux.switchTo(
      stepType(next, plan),
      stepUrl(next, plan),
    );
    switching = false;
    if (result === "switched") {
      step = next;
      return true;
    }
    adaptQuietUntil = Date.now() + HOLD;
    if (result === "busy")
      noteAdapt(busyNote(stepOrder(next) > stepOrder(step)));
    return false;
  }

  /**
   * いまの様子 (`watch-adapt.ts` の `sample`)。段を動かさない間は null。
   * 端末に保存したもの・止めている間・断られて止まっている間。canvas に描いているときは `canvasSample`
   */
  function adaptSample() {
    if (compat || canvas !== null) return canvasSample();
    const target = video;
    const plan = picked;
    if (
      target === null ||
      info === null ||
      plan === null ||
      (plan.way !== "file" && plan.way !== "stream") ||
      localSrc !== null ||
      localMkv !== null ||
      switching ||
      broken ||
      busy ||
      target.paused ||
      target.ended ||
      Date.now() < adaptQuietUntil ||
      playable().length === 0
    )
      return null;
    return {
      current: step,
      manual: choice !== "auto",
      throughput: remux?.throughput() ?? null,
      ahead: aheadOf(rangesOf(target.buffered), target.currentTime),
      waiting:
        target.readyState < HTMLMediaElement.HAVE_FUTURE_DATA &&
        !target.seeking,
      paceId: plan.way === "stream" ? paceId : null,
      // 段 0 が変換 (エンコード済みが無い録画) なら分からない
      baseKbps: fileZero !== null || plan.way === "file" ? baseKbps : null,
    };
  }

  /**
   * canvas に描いているときの様子 (互換モードと MPEG-2)。端末に保存したもの・作り直している最中・止めている間・
   * 鳴らし始める前・断られて止まっている間は null。下げた先の H.264 を受け取れなければ (互換モードは描けなければ) 動かさない
   */
  function canvasSample() {
    const player = canvas;
    if (
      player === null ||
      info === null ||
      localMkv !== null ||
      stepFrom !== null ||
      busy ||
      player.paused ||
      (!player.flowing && !canvasStuck) ||
      Date.now() < adaptQuietUntil ||
      // 段を下げた先は、GPU でエンコードできるものが無ければソフトウェアの H.264 (`server/live.ts` の `rungCodec`)
      !(compat ? canvasPlayable() : playable()).includes("h264")
    )
      return null;
    return {
      current: step,
      manual: choice !== "auto",
      throughput: player.throughput(),
      ahead: player.lead,
      waiting: canvasStuck,
      paceId,
      baseKbps: null,
    };
  }

  const adapt = watchAdapt({
    sample: adaptSample,
    readPace: async (id) => {
      const res = await fetch(
        resolve(`api/playback/pace?id=${encodeURIComponent(id)}`),
      );
      return res.ok ? ((await res.json()) as Pace) : null;
    },
    decide: decideStep,
  });

  onMount(() => {
    const timer = setInterval(() => adapt.tick(), ADAPT_TICK);
    return () => {
      clearInterval(timer);
      if (adaptTimer !== null) clearTimeout(adaptTimer);
    };
  });

  /**
   * **コーデックを選び直す** (コーデックのメニュー)。選んだものは端末ごとに覚える。
   * 観られる方式が変わるなら、いまの位置から観直す (プレイヤーを作り直す)
   */
  function chooseCodec(next: CodecChoice | "mpeg2"): void {
    choice = next;
    remind(CODEC_KEY, next);
    controls.stir();
    if (info === null) return;
    if (compat) {
      chooseCanvas(next);
      return;
    }
    // 選んだものは打ち切っていても試す (互換モードの `chooseCanvas` と同じ)
    if (next === "mpeg2") rawGaveUp = false;
    const fresh = pickOffer(info, ability(), next, data.indoor);
    if (JSON.stringify(fresh) === JSON.stringify(picked) && !busy && step === 0)
      return;
    warning = null;
    // 選び直したら段 0 から (下げた段は「自動」が回線を見て決め直す)
    step = 0;
    stepCodec = null;
    fileZero = null;
    replay(fresh);
  }

  /**
   * 観るものを `fresh` に替えて、いまの位置 (`position`。省けばいま再生している位置) から観直す。
   * 元の TS (`raw`) は canvas に描き、それ以外は `<video>` で観る。描いていた canvas は畳む
   */
  function replay(fresh: Picked | null, position = mediaTime()): void {
    if (canvas !== null || canvasCodec !== null) stopCanvas();
    remux?.destroy();
    remux = null;
    // 端末のコピーは自動のときだけ (主のエンコード済み)
    if (localSrc !== null) {
      URL.revokeObjectURL(localSrc);
      localSrc = null;
    }
    busy = false;
    broken = false;
    // ファイルなら尺が分かったところで戻す (`resume`)。その場で流すならプレイヤーの開始位置
    retryAt = position;
    switchAt = position;
    picked = fresh;
    if (fresh?.way !== "raw") return;
    // `<video>` で観ていたものは止める (src を外しただけでは読み込んだぶんを鳴らし続ける)
    if (video !== null) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    canvasCodec = "mpeg2";
  }

  /**
   * 互換モードで選び直す。**選んだものは打ち切っていても試す** (選び直すまでリクエストし直さない、の「選び直し」)。
   * 描く形式が変わるなら、いまの位置からプレイヤーを作り直す
   */
  function chooseCanvas(next: CodecChoice | "mpeg2"): void {
    if (info === null || canvasAbility === null) return;
    const fresh = pickCanvas(
      info,
      canvasAbility,
      next,
      next === "auto" ? canvasGaveUp : [],
    );
    if (fresh === canvasCodec && !busy && canvasProblem === null && step === 0)
      return;
    const position = mediaTime();
    stopCanvas();
    busy = false;
    canvasProblem = null;
    warning = null;
    if (fresh === null) {
      canvasProblem = "再生できる形式がありません";
      return;
    }
    canvasGaveUp = canvasGaveUp.filter((codec) => codec !== fresh);
    // 選び直したら段 0 から (`chooseCodec` と同じ)
    step = 0;
    stepCodec = null;
    stepFrom = null;
    switchAt = position;
    canvasCodec = fresh;
  }

  /**
   * メニューに並べるもの。この端末で観られる方式があるコーデックが 2 つ以上あるときだけ出す。
   * 互換モードは流せるもの (H.264・AV1・MPEG-2) を並べて描けない形式は押せなくし (ライブと同じ)、
   * 端末に保存したものを描いている間は出さない。世帯の設定で外したもの (H.264・H.265。`data.hidden`) は並べない (自動では選ぶ)
   */
  const codecMenu = $derived.by(
    (): { key: string; label: string; disabled?: boolean }[] => {
      if (info === null || !localChecked) return [];
      if (compat && (canvasAbility === null || drawingLocal)) return [];
      const items =
        compat && canvasAbility !== null
          ? canvasChoices(info, canvasAbility)
              .filter(
                (item) => !data.hidden.some((codec) => codec === item.codec),
              )
              // 並びはほかのメニューと同じ (`MENU_ORDER`)。`canvasChoices` の並びは選ぶ順 (`pickCanvas`) のまま
              .sort(
                (a, b) =>
                  MENU_ORDER.indexOf(a.codec) - MENU_ORDER.indexOf(b.codec),
              )
              .map((item) => ({
                key: item.codec,
                label: codecLabel(item.codec),
                disabled: !item.drawable,
              }))
          : codecChoices(info, ability(), data.hidden).map((codec) => ({
              key: codec,
              label: codecLabel(codec),
            }));
      return items.length < 2 ? [] : [{ key: "auto", label: "自動" }, ...items];
    },
  );

  /** 混んでいて断られたとき、サーバに変換させずに観られるもの (エンコード済み・詰め替え) */
  const lighter = $derived.by((): PlayCodec[] => {
    if (info === null || !busy) return [];
    // 互換モードは描ける形式のうち、変換させないもの (詰め替え・元の TS)
    if (compat) {
      if (canvasAbility === null) return [];
      const plan = info;
      return canvasChoices(plan, canvasAbility)
        .filter((item) => item.drawable && !canvasTranscodes(plan, item.codec))
        .map((item) => item.codec);
    }
    const can = ability();
    return codecChoices(info, can).filter((codec) => {
      const way = pickOffer(info as PlaybackInfo, can, codec);
      return (
        way !== null &&
        way.codec === codec &&
        !transcodes(info as PlaybackInfo, way)
      );
    });
  });

  let video = $state<HTMLVideoElement | null>(null);
  /** 映像とその上の操作をまとめた箱。全画面にするのはこちら */
  let stage = $state<HTMLElement | null>(null);
  /** 全画面の出入り (3 画面共通。[fullscreen.svelte.ts](../../../lib/components/player/fullscreen.svelte.ts)) */
  const fullscreen = stageFullscreen(() => stage);

  /*
   * --- 録画のデータ放送 ---
   *
   * エンコードするときに取り出しておいた変化ログを、再生位置に合わせて流し直す (`ts/data-timeline`、
   * `server/recorded-bml.ts`)。描くのはライブと同じ `DataBroadcast`
   */
  /** d ボタンで出しているか */
  let showData = $state(false);
  /**
   * データ放送を常に受信するか (再生の設定の行。ライブと同じ 1 つを端末ごとに覚える。`data-receive.ts`)。
   * 開く前から変化ログを取得して流し、入口の文書を裏で動かす (`DataBroadcast` の `receive`)
   */
  let receiveData = $state(false);
  /** 常に受信していて、この録画にデータ放送があるか */
  const receiving = $derived(receiveData && data.hasData);
  /** 映像を入れる箱。BML はこれを動かす (`DataBroadcast` の place) */
  let mediaBox = $state<HTMLElement | null>(null);
  /** リモコンのキーを渡す関数と、d を文書へ渡す関数 (`DataBroadcast` の press / pressD) */
  let dataPress = $state<((code: number) => void) | null>(null);
  let dataButton = $state<(() => boolean) | null>(null);
  /** データ放送を作り直す合図 (`DataBroadcast` の channel)。戻ったら変えて、その時点まで積み直す */
  let dataChannel = $state<string | null>(null);
  /** 変化ログ。押されてから取得する */
  let dataTimeline: PlacedMessage[] = [];
  /** エンジンへ流す関数。`DataBroadcast` が open のたびに預けてくる */
  let dataEmit: ((message: ResponseMessage) => void) | null = null;
  /** どこまで流したか (再生位置 ms)。まだなら -1 */
  let dataFed = -1;

  function nowMs(): number {
    return Math.round(mediaTime() * 1000);
  }

  /** データ放送を出す/消す。d ボタンの振る舞いは `pressD` (DataBroadcast) */
  async function setData(on: boolean): Promise<void> {
    showData = on;
    // 常に受信しているなら、閉じてもエンジンは残す (入口から出直すのは `DataBroadcast`)
    if (showData || receiving) await startData();
    else dataChannel = null;
  }

  /** 常に受信するかを切り替える。ライブと同じ 1 つを端末ごとに覚える (`data-receive.ts`) */
  function toggleReceiveData(): void {
    receiveData = !receiveData;
    remind(DATA_RECEIVE_KEY, receiveData ? "1" : "0");
    if (receiving) void startData();
    else if (!showData) dataChannel = null;
  }

  // 開いた端末で決まる。常に受信する端末は、開く前から流し始める
  $effect(() => {
    receiveData = storedDataReceive(stored(DATA_RECEIVE_KEY));
    untrack(() => {
      if (receiving) void startData();
    });
  });

  /**
   * 変化ログを取得して、エンジンを作らせる。**もう流していれば何もしない**。常に受信しているところで開いたときは、
   * 作り直さずに開く操作だけを届ける (`DataBroadcast` の `opened`)
   */
  async function startData(): Promise<void> {
    if (dataChannel !== null) return;
    // 取得は 1 回だけ。開いた直後 (常に受信) と押したのが重なっても二重に取らない
    dataLoading ??= loadTimeline();
    await dataLoading;
    // 取得している間に、閉じて常に受信もやめていたら作らない
    if (!showData && !receiving) return;
    dataFed = -1;
    // エンジンを作らせる。open のあと listenData が呼ばれて、いまの位置まで積み直す
    dataChannel = `${rec.id}`;
  }

  /** 変化ログを取得している最中の Promise (`startData`) */
  let dataLoading: Promise<void> | null = null;

  /**
   * 変化ログを取得する。**端末に保存したものを探し終えてから**。常に受信する端末は開いた直後に呼ぶので、
   * 探し終える前に見るとオフラインでもサーバから取得しようとして空になる。取れなければ空 (次に押したら取り直す)
   */
  async function loadTimeline(): Promise<void> {
    const copy = await localLookup;
    if (Array.isArray(copy?.databroadcast)) {
      // 端末に保存したものから。オフラインでも d が効く
      dataTimeline = copy.databroadcast as PlacedMessage[];
    } else {
      const response = await fetch(
        resolve(`api/recordings/${rec.id}/databroadcast`),
      ).catch(() => null);
      dataTimeline = response?.ok ? await response.json() : [];
    }
    if (dataTimeline.length === 0) dataLoading = null;
  }

  /**
   * `DataBroadcast` がエンジンへの入口を預けてくる (作り直すたびに新しいものを)。
   * **預かった直後に、いまの再生位置まで積んで追いつく** (`replayAt`)
   */
  function listenData(emit: ((message: ResponseMessage) => void) | null): void {
    dataEmit = emit;
    if (emit === null) return;
    const to = nowMs();
    for (const message of replayAt(dataTimeline, to)) emit(message);
    dataFed = to;
  }

  /**
   * 再生が進んだぶんのデータ放送を流す。**戻っていたらエンジンを作り直す** (開いているかは持ち越し、入口から出直す)。
   * 先へ飛んだ (シーク・CM 飛ばし) ときは、その間の変化を足す
   */
  function feedData(): void {
    if (dataEmit === null) return;
    const to = nowMs();
    const feed = feedFor(dataTimeline, dataFed, to);
    if (feed.reset) {
      // channel を変えると close→open して listenData が積み直す
      dataChannel = `${rec.id}:${to}`;
      return;
    }
    for (const message of feed.messages) dataEmit(message);
    dataFed = to;
  }

  let playing = $state(false);
  let at = $state(0);
  /** シークバーをつまんで動かしている間の位置 (`SeekBar` の `scrub`)。触っていなければ `null` */
  let scrub = $state<number | null>(null);
  let length = $state(0);
  let muted = $state(false);
  /**
   * 選べる音声トラック (主音声・副音声など)。ブラウザが Matroska の音声を `video.audioTracks` に出せれば
   * それを切り替える (サーバはエンコードし直さない)。出せない端末 (Chrome・Firefox の既定) では `playback` の
   * 名前で並べ、選んだらその場で流すほうへ移る (`moveForAudio`)。押しても効かない操作を並べないため、
   * 2 本以上あるときだけ出す
   */
  let audios = $state<string[]>([]);
  let audioIndex = $state(0);
  /** 字幕を出しているか。既定は出す (ライブと同じ)。端末ごとに覚える (`caption-pref.ts`) */
  let captions = $state(true);
  /**
   * 受け取った字幕 (全部の言語。`captions.json`)。持っていなければ null。持っているかは取ってみるまで
   * 分からない (無ければ 404)。持っているときだけボタンを出す (ライブと同じ)
   */
  let captionText = $state.raw<CaptionPages | null>(null);
  /**
   * 載っている言語。第 1 言語は `pages`、第 2 言語から後ろは `others`。
   * 名前が分からない第 1 言語 (古いサーバ・端末に保存した古いコピー) は「字幕 1」
   */
  const captionLanguages = $derived<CaptionLanguage[]>(
    captionText === null
      ? []
      : [
          captionText.language ?? languageOf(1, ""),
          ...(captionText.others ?? []).filter((o) => o.pages.length > 0),
        ],
  );
  /** 出している言語 (`CaptionLanguage.index`) */
  let captionLanguage = $state(1);
  /** 文字の配置。時刻の順 */
  const cues = $derived<Cue[]>(
    captionText === null
      ? []
      : captionLanguage === 1
        ? captionText.pages
        : (captionText.others?.find((o) => o.index === captionLanguage)
            ?.pages ?? captionText.pages),
  );
  const hasCaptions = $derived(
    captionText !== null &&
      (captionText.pages.length > 0 ||
        (captionText.others ?? []).some((o) => o.pages.length > 0)),
  );
  /** 文字の配置を描く係 (`overlay` ができたら作る) */
  let painter: CaptionPainter | null = null;
  /** いま描いている文字の配置。同じものを描き直さない */
  let shownPage: CaptionPage | null = null;
  $effect(() => {
    if (overlay === null) return;
    const made = new CaptionPainter(overlay);
    painter = made;
    return () => {
      made.close();
      if (painter === made) painter = null;
    };
  });
  /** 字幕を重ねる先 */
  let overlay = $state<HTMLCanvasElement | null>(null);
  /** 実況の層の置き場。canvas で描くときの映像はこの手前に差し込む (映像 → 実況 → 字幕) */
  let jikkyoSlot = $state<HTMLElement | null>(null);

  /**
   * 実況のコメント (docs/watch.md の「実況のコメント」)。世帯の設定と端末の ⚙ の両方がオンなら、
   * 録画の区間のコメントを過去ログ API から開いたときに 1 回で取り、再生位置の放送時刻に合わせて流す
   */
  const jikkyoOn = jikkyoSwitch();
  const jikkyo = new JikkyoFeed(false);
  $effect(() => jikkyo.setNg(data.jikkyoNg));
  const jikkyoActive = $derived(data.jikkyoAllowed && jikkyoOn.on);
  $effect(() => {
    const target = data.jikkyo;
    jikkyo.set(target?.channel ?? null, jikkyoActive);
    // 録画の終わりは予定なので、少し後ろまで訊く (今より後は fetchKakolog が切る)
    if (target !== null && jikkyoActive)
      untrack(() => jikkyo.kakolog(target.head, () => target.end + 60_000));
  });
  onMount(() => () => jikkyo.close());

  /**
   * 右の列の「コメントの一覧」(`JikkyoList`)。流しているときと同じ条件で、映像の右端の列のボタンで出す (端末ごとに覚える)。
   * 右の列の無い形 (横にしたスマホ・全画面) では出さず、ボタンも置かない。時刻は録画の中の再生位置で出し、押すとそこへ飛ぶ
   */
  const jikkyoList = jikkyoSwitch(JIKKYO_LIST_KEY);
  const phoneLandscape = new MediaQuery(PHONE_LANDSCAPE);
  const canList = $derived(
    jikkyoActive &&
      data.jikkyo !== null &&
      !phoneLandscape.current &&
      !fullscreen.active,
  );
  /**
   * 放送時刻 `at` が、観ているもの (エンコードしたもの・元の TS) のどこか (`airTime` の逆)。
   * 録画の頭より前は「開始前」、切った CM の中は「CM」で、飛べない
   */
  function placeAir(at: number): number | "before" | "cut" {
    if (info === null) return "before";
    return playbackAt((at - data.head) / 1000, ruler(info));
  }

  /** 観ているものの物差し (`Ruler`)。元の TS なら null */
  function ruler(plan: PlaybackInfo): Ruler | null {
    return plan.axis === "encoded"
      ? { kept: rec.cm_kept, skip: rec.encode_skip ?? 0 }
      : null;
  }

  /**
   * いま観ている場面の放送時刻。再生位置を元の TS の秒に直して (CM を切ったものは切った区間を戻して) 先頭の放送時刻に足す。
   * 実況のコメントとデータ放送の時計 (`clock`) が使う。**切った CM の区間は飛び越すので、そこに書かれたコメントは流れない**
   */
  function airTime(): number | null {
    if (info === null) return null;
    return data.head + toTsTime(mediaTime(), ruler(info)) * 1000;
  }
  /** 貼り直しを追わせている映像。二重に回さないための目印 (`follow`) */
  let following: HTMLVideoElement | null = null;
  /** 映像だけ遅れたら飛び直す (`unslip.ts`)。段を替えてデコーダが作り直されると、Android の Chrome で映像だけ取り残される */
  const unslip = unslipper();
  /** 読めなかったとき。黙って黒いままにしない */
  let broken = $state(false);
  /**
   * 読み込み待ちで止まっているか (「読み込み中」を出す)。出すまでの間は幕の側が持つ (`PlayerVeil`。ライブ・追っかけと同じ 1.5 秒)。
   * コマ落ち程度の詰まりで毎回出すと点滅するだけになる
   */
  let buffering = $state(false);
  /**
   * 観られないわけ (幕の文言)。無ければ空。
   * サーバが混んでいて、その場の変換を断られた (同時に変換する本数の上限) ときは、待っても空くとは限らないので、
   * サーバに変換させずに観られるもの (`lighter`) を勧める。
   * 互換モードで出せないとき (`canvasProblem`) は、互換モードが `<video>` の止まる端末のためのものなので、ほかのブラウザを勧めない
   */
  const problem = $derived(
    busy
      ? lighter.length > 0
        ? "サーバが混んでいます"
        : "サーバが混んでいます。しばらくしてから開き直してください"
      : (canvasProblem ??
          (broken
            ? "このブラウザでは再生できませんでした。Chrome・Edge か、テレビのアプリ (denpa-tv) で観てください"
            : "")),
  );
  /** 繋ぎが切れて繋ぎ直している最中か (`recover`) */
  let resuming = $state(false);
  /** 続けて何回繋ぎ直したか。繋ぎ直しを打ち切る分かれ目 */
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 繋ぎ直したあとに戻る位置 (秒)。0 は「戻る先は無い」 */
  let retryAt = 0;
  let chapters = $state<Chapter[]>([]);

  /** 操作バーの出し入れ ([controls.svelte.ts](../../../lib/components/player/controls.svelte.ts)) */
  const controls = playerControls();

  /** 画面を落とさせない。観るためだけに開く画面なので、開いている間はずっと */
  const awake = screenAwake();
  $effect(() => {
    awake.on = true;
  });

  /**
   * 小窓 (PiP。[pip.svelte.ts](../../../lib/components/player/pip.svelte.ts))。互換モードは canvas の
   * プレイヤーからストリームを取って出す。`paused` で `playing` を読むのは、操作バーで止めた・再開したときに
   * 小窓の側も合わせ直させるため
   */
  const pip = pictureInPicture({
    video: () => video,
    raw: () => drawing,
    capture: () => canvas?.pipStream() ?? null,
    flow: (on) => canvas?.pipFlow(on),
    paused: () => {
      void playing;
      return mediaPaused();
    },
    toggle: togglePlay,
    auto: () => background.on,
    overlay: () => overlay,
    captions: () => captions && hasCaptions,
  });

  // canvas の音を「再生する音」と言うのは、バックグラウンド再生がオンのときと小窓を開いている間だけ (`raw/engine.ts`)
  $effect(() => {
    const on = background.on || pip.active;
    if (drawing) canvas?.background(on);
  });

  /** 音量 (`volume.svelte.ts`)。canvas はプレイヤーの中で、`<video>` は Web Audio に通して掛ける (ライブ・追っかけと同じ) */
  const volume = playerVolume({
    video: () => (drawing ? null : video),
    through: () => background.on || pip.active,
    remote: (stop) => (stop ? pauseMedia() : playMedia()),
  });
  $effect(() => {
    const level = volume.level;
    if (drawing) canvas?.volume(level);
  });

  /** バックグラウンド再生 ([background.svelte.ts](../../../lib/components/player/background.svelte.ts)) */
  const background = backgroundPlayback({
    nativeVideo: () => (drawing ? null : video),
    pip: () => pip.active,
    paused: mediaPaused,
    pause: pauseMedia,
    resume: playMedia,
  });

  /** アンビエントモード。canvas に描いているときはプレイヤーから縮めた 1 枚をもらう */
  const ambient = ambientMode({
    playing: () => playing && !pip.active,
    canvas: () => canvas,
    video: () => video,
  });

  /**
   * 早送りの速さ (追っかけと同じ並び。`ts/pacing` の `SPEEDS`)。選んだ値は端末ごとに覚える。
   * 倍速で観る人はたいてい次も倍速で、手元の端末と居間のテレビで好みが違う
   */
  let speed = $state(1);

  /**
   * **選んだ速さは既定の速さ (`defaultPlaybackRate`) にも入れる。** src を入れ替えると
   * (端末のコピーへの差し替え・読み直し) ブラウザは速さを既定の速さへ戻す。`loadstart` で
   * 掛け直していた頃は、src を入れてから `loadstart` が来るまでの間だけ 1 倍に戻っていた。
   * `<video>` ができた (作り直された) ときも、ここで掛かる
   */
  $effect(() => {
    if (video === null) return;
    video.defaultPlaybackRate = speed;
    video.playbackRate = speed;
  });

  /**
   * CM を自動で飛ばすか (CM を残してエンコードした録画のため)。端末ごとに覚える。
   * 観はじめに入れるかどうかは `skipCmAtStart` (ロゴでの判定に失敗した 1 本は切って始める)
   */
  const SKIP_CM_KEY = "watch-skip-cm";
  let skipCm = $state(false);
  /** CM を飛ばしたことを短く言う。黙って飛ぶと壊れたように見える */
  let skipped = $state(false);
  let skipNotice: ReturnType<typeof setTimeout> | null = null;
  /**
   * 跨いでいる間、最後の本編のコマで覆う面。先読み (`CM_LEAD`) だけでは、コンポジタへ渡し済みの
   * コマが出てしまう。黒で塗らないのは、止まったコマのほうが飛んだように見えるため
   */
  let cover = $state<HTMLCanvasElement | null>(null);
  /** 覆っているか */
  let hopping = $state(false);
  /**
   * 飛んだ先が映るのを待っているか。`hopping` とは別。開いた直後は覆いだけ先に出してチャプターを待つが、
   * まだ飛ぶ判断はしていないので、覆いを理由に `hopCm` を止めてはいけない
   */
  let waiting = false;
  /** 覆いが黒塗りか (写したコマではないか。`shut`) */
  let blanked = false;
  /** 飛んだ先 (秒)。ここまで来たら覆いを外す */
  let hopTo = 0;
  /** 飛んだ先に着いたと数えたコマ数。`SETTLED` まで数えてから覆いを外す */
  let settled = 0;
  /**
   * 覆いを外すまでに待つコマ数。`requestVideoFrameCallback` はコンポジタへ渡したところで呼ばれ、
   * Windows の Chrome / Edge は映像を DOM と別の面に出すので、1 コマで外すと画面だけ CM のまま残る
   * (実機)。4 コマ (0.13 秒) なら飛んだ間合いに紛れる。`mediaTime` の無いブラウザは `currentTime` で数える
   */
  const SETTLED = 4;
  /** 覆いの外し忘れ止め。飛んだ先が来ないまま止まっても、いつかは外す */
  let hopGiveUp: ReturnType<typeof setTimeout> | null = null;
  /** 覆っておく上限 (ms) */
  const HOP_GIVE_UP = 2_000;

  /** どこまで観たかを書き送る間隔 (ms) */
  const REMEMBER = 15_000;
  /** 続きから出したか。画面にも言う */
  let continued = $state(false);

  /** 押し間違い防止に 2 回押させる (どの画面とも同じ。`arming.svelte.ts`) */
  const deleting = arming('[data-testid^="watch-delete"]');

  const detail = programDetail();

  /**
   * 開いたら、そのまま観はじめる。一覧の行を押した勢い (user activation) がまだ効いているので
   * `play()` も全画面も通る。読み込み直したときだけ通らないので、どちらも失敗しても無視する
   */
  onMount(() => {
    setSpeed(storedSpeed(), false);
    skipCm = skipCmAtStart(rec.cm_note, stored(SKIP_CM_KEY));
    // チャプターが来るまで覆っておく (頭が CM のことが多い。`settle`)
    if (skipCm) shut();
    void loadChapters().then(() => {
      chaptersReady = true;
      settle();
    });
    void detail.open(rec.program_id, facts);
    // 字幕は消していても取ってくる (持っているかどうかで ⚙ の字幕の行と字幕ボタンを出す)。観はじめてから (`askCaptions`)
    captions = storedCaptionsOn(stored(CAPTION_ON_KEY));
    if (video !== null) follow(video);
    if (!ready) {
      askCaptions();
      return;
    }
    captionWait = setTimeout(askCaptions, CAPTION_WAIT);
    // 端末に保存したものはサーバを読まないので、待たずに取る
    void localLookup.then((copy) => {
      if (copy !== null) askCaptions();
    });
    video?.play().catch(() => undefined);
    // 指のときは最初から全画面 (観るために置いてある画面)。画面の幅では決めない。狭い窓の PC まで全画面になる
    if (window.matchMedia("(pointer: coarse)").matches) fullscreen.enter();
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    // 閉じ際にも書き送る (15 秒おきだと最後の十数秒が落ちる)。`unload` はスマホで来ないことがある
    const onLeave = () => remember(true);
    window.addEventListener("pagehide", onLeave);
    const ticker = setInterval(() => {
      if (playing) remember();
    }, REMEMBER);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pagehide", onLeave);
      // 貼り直しの追いかけを畳む。外さないと画面を離れたあとも回り続ける
      following = null;
      clearInterval(ticker);
      remember(true);
      deleting.fire();
      if (skipNotice !== null) clearTimeout(skipNotice);
      if (hopGiveUp !== null) clearTimeout(hopGiveUp);
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (captionWait !== null) clearTimeout(captionWait);
    };
  });

  // 音声トラックは後から増えることがある (最初のフレームをデコードしたあとで `addtrack` が来るブラウザ)
  $effect(() => {
    const tracks = audioTrackList();
    if (tracks === null) return;
    const update = (): void => syncAudio();
    const kinds = ["addtrack", "removetrack", "change"];
    for (const kind of kinds) tracks.addEventListener(kind, update);
    return () => {
      for (const kind of kinds) tracks.removeEventListener(kind, update);
    };
  });

  /**
   * **どこまで観たかを覚える。** 覚えるかどうかの判断は `ts/watch.ts` が持つ
   * (サーバも同じものを見る)。送り方は追っかけと共通 (`#lib/resume.ts`)
   */
  function remember(leaving = false): void {
    if (!ready) return;
    if (canvas !== null) {
      keepResume(rec.id, canvas.currentTime, length, info?.axis, leaving);
      return;
    }
    if (video === null) return;
    keepResume(rec.id, video.currentTime, video.duration, info?.axis, leaving);
  }

  /**
   * **末尾まで来たことを、その場で覚える** (`onended`)。控えは 15 秒おきで流れている間だけなので、
   * 末尾の CM を自動で飛ぶと終端の控えが書かれず、一覧で観かけのまま残っていた (`ts/watch.ts` の `resumePoint`)。
   * `remember` を直に渡すと `leaving` にイベントが入って真になるので包む
   */
  function finished(): void {
    remember();
  }

  /**
   * 観ていたところから出す。尺が分かってから (`loadedmetadata`)、1 回だけ
   * (もう一度来ると観ている最中に引き戻される)
   */
  let resumed = false;
  function resume(): void {
    length = video?.duration ?? 0;
    place();
    // 接続が切れて読み直したところ。観ていた位置へ戻して続ける (`recover`)
    if (retryAt > 0 && video !== null) {
      video.currentTime = retryAt;
      retryAt = 0;
      void video.play().catch(() => undefined);
      return;
    }
    // 回線に合わせて段を替えるために作り直した (`moveStep`)。再生していたなら続ける
    if (keepPlaying && video !== null) {
      keepPlaying = false;
      void video.play().catch(() => undefined);
    }
    if (resumed || video === null) return;
    resumed = true;
    // この場面から観るときも `settle` を通す (通らないと覆いが待つ上限の時間まで残る)
    if (sceneAt !== null) {
      video.currentTime = sceneAt;
      sceneAt = null;
    } else {
      const at = rec.resume_ms === null ? null : rec.resume_ms / 1000;
      if (at !== null && resumePoint(at, video.duration) !== null) {
        video.currentTime = at;
        showContinued();
      }
    }
    settle();
  }

  /** `video.audioTracks`。実装が揃っておらず TypeScript の DOM 型にも無いので自前で受ける。無ければ `null` */
  interface AudioTrackLike {
    label: string;
    language: string;
    enabled: boolean;
  }
  interface AudioTrackListLike {
    readonly length: number;
    [index: number]: AudioTrackLike;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  }
  function audioTrackList(): AudioTrackListLike | null {
    return (
      (video as unknown as { audioTracks?: AudioTrackListLike } | null)
        ?.audioTracks ?? null
    );
  }

  /** トラックの見出し。コンテナに入っている名前 (主音声/副音声) → 言語 → 連番の順で選ぶ */
  function audioLabel(name: string, language: string, i: number): string {
    return name.trim() || language.trim() || `音声 ${i + 1}`;
  }

  /** `playback` の音声の名前で並べる */
  function offeredAudios(): string[] {
    return (info?.audios ?? []).map((audio, i) =>
      audioLabel(audio.label, "", i),
    );
  }

  /** いま観ているものが持っている音声トラックを読み直す (`loadedmetadata` と `addtrack` から) */
  function syncAudio(): void {
    // 端末に保存した録画を canvas に描いているなら、そのトラックの名前
    if (localMkv !== null) {
      audios = localMkv.audios.map((track, i) =>
        audioLabel(track.name, track.language, i),
      );
      return;
    }
    // その場で流しているものは選んだ 1 本だけなので、`audioTracks` には 1 本しか出ない (`remux-player.ts`)
    if (picked?.way === "stream" || canvas !== null) {
      audios = offeredAudios();
      return;
    }
    const tracks = audioTrackList();
    if (tracks === null) {
      /*
       * **ブラウザが入れ物の音声を出さない** (Chrome・Firefox の既定)。流すほうへ移れるなら
       * `playback` の名前で並べ、選んだら移る (`selectAudio`)。移れなければ出さない
       */
      audios = audioFallback() === null ? [] : offeredAudios();
      return;
    }
    const list: string[] = [];
    let enabled = 0;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (track === undefined) continue;
      list.push(audioLabel(track.label, track.language, i));
      if (track.enabled) enabled = i;
    }
    audios = list;
    audioIndex = enabled;
  }

  /** 音声を選ぶ。**選んだものだけ有効にする** (ブラウザはそれで切り替える)。その場で流しているならリクエストし直す */
  function selectAudio(index: number): void {
    const player = remux ?? canvas;
    if (player !== null) {
      player.setAudio(streamAudio(index));
      audioIndex = index;
      return;
    }
    const tracks = audioTrackList();
    if (tracks === null) {
      moveForAudio(index);
      return;
    }
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (track !== undefined) track.enabled = i === index;
    }
    audioIndex = index;
  }

  /** 音声を選ぶために移る先 (`streamForAudio`)。ファイルをそのまま読んでいないなら null */
  function audioFallback(): Picked | null {
    if (info === null || picked?.way !== "file") return null;
    return streamForAudio(info, ability(), picked.codec);
  }

  /** ファイルのままでは選べない音声を、その場で流すほうへ移って選ぶ。いまの音声を選んだだけなら何もしない */
  function moveForAudio(index: number): void {
    if (index === audioIndex) return;
    const fresh = audioFallback();
    if (fresh === null) return;
    audioIndex = index;
    replay(fresh);
  }

  /**
   * チャプターの位置 (`api/recordings/<id>/chapters`)。CM もチャプターなので、そのまま CM 飛ばしになる。
   * 無い録画もあり、取れなければ送りのボタンを出さないだけ
   */
  async function loadChapters(): Promise<void> {
    try {
      // 端末に保存したものがあればそちら (オフラインでも CM 飛ばしが効く)。探し終えるのを待ってから
      const copy = await localLookup;
      const held = copy?.chapters as { chapters?: typeof chapters } | undefined;
      if (held?.chapters !== undefined) {
        chapters = held.chapters;
        return;
      }
      // 前に読んだものを持っていても、変わっていないか確かめさせる (CM 検出のやり直しは同じファイルを書き直す)
      const res = await fetch(resolve(`api/recordings/${rec.id}/chapters`), {
        cache: "no-cache",
      });
      if (!res.ok) return;
      chapters = (await res.json()).chapters ?? [];
    } catch {
      // 出せないだけ。観るのに支障は無い
    }
  }

  /**
   * CM 検出をやり直したら、チャプターだけ取り直す (`chapters` の通知)。位置も再生も触らない
   * (いまいる所が CM になれば次のコマで `hopCm` が飛ぶ)。端末に保存したものは落としたときのまま
   */
  liveUpdates([], {
    chapters: (payload) => {
      if ((payload as { recordingId?: unknown }).recordingId === rec.id)
        void loadChapters();
    },
  });

  /**
   * 配信が切れたら (サーバの入れ替えなど) 同じ所から読み直し、切れた瞬間の位置へ戻す。
   * 繋ぎ直すのは接続が切れたときだけ。読めない形式・壊れたファイルは何度やっても同じなので `broken`
   */
  function recover(): void {
    if (video === null) return;
    // 映像は出せていない。字幕のボタンは出せるように取る
    askCaptions();
    const code = video.error?.code ?? 0;
    // その場で流しているときの切れ目は `remux-player.ts` が繋ぎ直す。ここに来るのは読めない中身
    if (
      remux !== null ||
      code !== MediaError.MEDIA_ERR_NETWORK ||
      retries >= STREAM_RETRIES
    ) {
      broken = true;
      resuming = false;
      return;
    }
    retryAt = video.currentTime;
    const wait = retryWait(retries);
    retries++;
    resuming = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      // 同じ src を読み直す。位置を戻すのは尺が分かってから (`resume`)
      video?.load();
    }, wait);
  }

  /** 早送りの速さを変える。音は残す (ブラウザは倍速でも音程を保つ)。canvas に描いているときは等速だけ */
  function setSpeed(value: number, remember = true): void {
    if (drawing) return;
    speed = value;
    if (remember) remind(SPEED_KEY, String(value));
    controls.stir();
  }

  /** CM 飛ばしのオン/オフ。いま CM の中にいればその場で飛ぶ (「CM が始まったから押した」がいちばん多い) */
  function toggleSkipCm(): void {
    skipCm = !skipCm;
    remind(SKIP_CM_KEY, skipCm ? "1" : "0");
    if (skipCm) hopCm();
    controls.stir();
  }

  /**
   * CM を跨ぐ手前で飛ぶための先読み (秒。30 コマ/秒で 3 コマ)。入ってから飛ぶと必ず CM のコマが見え、
   * コンポジタに渡し済みのコマもあるので 1 コマぶんでは間に合わない。本編の末尾 0.1 秒が静止画になるが、
   * 境目は場面の切れ目なので分からない
   */
  const CM_LEAD = 0.1;

  /** CM の中にいたら、その終わりまで飛ぶ (続いている CM はまとめて。判断は `ts/watch.ts`) */
  function hopCm(): void {
    // 飛んだ先を待っている最中と、シークバーをつまんでいる最中 (離したら着いた先で決める) は飛ばない
    if (waiting || !skipCm || (video === null && canvas === null)) return;
    if (scrub !== null) return;
    const to = skipTarget(chapters, mediaTime(), CM_LEAD);
    if (to === null) return;
    /*
     * canvas は覆わない。プレイヤーは飛び先より前のフレームを捨て、描けるまで本編の最後のコマを
     * 出したままにする (`raw/worker.ts` の `floor`)。字幕だけ消す
     */
    if (canvas === null) shut();
    else clearCaptions();
    hopTo = to;
    waiting = true;
    seekMedia(to);
    // 続きから始めたばかりなら、そちらだけ言う (CM を跨いだのは中の都合)
    if (continued) return;
    skipped = true;
    if (skipNotice !== null) clearTimeout(skipNotice);
    skipNotice = setTimeout(() => (skipped = false), 2500);
  }

  /**
   * いま映っているコマを写して覆う (飛ぶ前に呼ぶ)。写すのは本編にいるときだけ。CM の中
   * (チャプターがまだ無いときも) で写すと覆いが CM の 1 コマになる。写せないときは黒で塗って枠ごと覆う。
   * CM の字幕も一緒に消す
   */
  function shut(): void {
    const here = video === null ? null : chapterAt(chapters, video.currentTime);
    const source =
      video !== null &&
      here !== null &&
      !isCm(here.title) &&
      video.videoWidth > 0
        ? video
        : null;
    const ctx = cover?.getContext("2d") ?? null;
    if (cover !== null && ctx !== null) {
      cover.width = source?.videoWidth ?? 16;
      cover.height = source?.videoHeight ?? 9;
      if (source !== null) {
        try {
          ctx.drawImage(source, 0, 0, cover.width, cover.height);
        } catch {
          // 写せなかった。黒いままなので、下は見えない
        }
      } else {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, cover.width, cover.height);
      }
    }
    blanked = source === null;
    hopping = true;
    clearCaptions();
    place();
    if (hopGiveUp !== null) clearTimeout(hopGiveUp);
    hopGiveUp = setTimeout(open, HOP_GIVE_UP);
  }

  /** 覆いを外す。飛んだ先が映ったとき (`follow`) と、待つ上限の時間を過ぎたとき */
  function open(): void {
    hopping = false;
    waiting = false;
    settled = 0;
    if (hopGiveUp !== null) {
      clearTimeout(hopGiveUp);
      hopGiveUp = null;
    }
  }

  /**
   * 観はじめの 1 回。チャプターが揃い、始める位置 (続きか頭か。`resume`) も決まってから、始まりが CM なら飛ぶ。
   * 取得している間は黒く覆っておく (本編前の CM が一瞬流れていた)。位置を待たないと頭の CM を
   * 飛んでから続きへ移り、リロードのたびに「CM を飛ばしました」が出ていた。両方から呼び、遅いほうで決める
   */
  let chaptersReady = false;
  function settle(): void {
    if (!chaptersReady || !resumed) return;
    hopCm();
    // 飛ばなかった (CM ではなかった・切ってある)。覆いは要らない
    if (!waiting) open();
  }

  function togglePlay(): void {
    if (mediaPaused()) playMedia();
    else pauseMedia();
  }

  function toggleCaptions(): void {
    setCaptions(!captions);
    controls.stir();
  }

  /** 字幕を出す・消す。端末ごとに覚える (`caption-pref.ts`) */
  function setCaptions(on: boolean): void {
    captions = on;
    remind(CAPTION_ON_KEY, on ? "1" : "0");
    if (on) {
      if (captionsFailed) {
        captionsFailed = false;
        captionsAsked = false;
      }
      askCaptions();
      paint();
    } else {
      clearCaptions();
    }
  }

  /** 字幕の言語を選ぶ。言語の名前 (ISO 639) で端末に覚える (`caption-pref.ts`) */
  function setCaptionLanguage(index: number): void {
    const code = captionLanguages.find((l) => l.index === index)?.code ?? "";
    if (code !== "") remind(CAPTION_LANGUAGE_KEY, code);
    captionLanguage = index;
    clearCaptions();
    paint();
  }

  /** 字幕を取得したか。取得は 1 回だけ */
  let captionsAsked = false;
  /** 取得しようとして繋がらなかったか。字幕を入れ直したときだけ取り直す */
  let captionsFailed = false;
  /** 映像が出ないまま待つ上限の時計 (`CAPTION_WAIT`) */
  let captionWait: ReturnType<typeof setTimeout> | null = null;
  /** 映像が出るのを待つ上限 (ms)。自動再生を断られて止まっている・読めない、でも字幕のボタンは出したい */
  const CAPTION_WAIT = 3_000;

  /**
   * **字幕は映像が出てから取る** (最初のコマ・読めなかった・互換モードで流れ出した・待つ上限の時間を過ぎた、の早いほう)。
   * サーバは字幕を抜くのに動画を丸ごと読む (`captions.json`。初回は 1 時間の録画で 1 秒ほど)。
   * 開いた時点で取っていた頃は、観はじめの読み込み (続きの位置・CM の先へ飛んだ先) とディスクを
   * 取り合い、最初のコマが字幕の応答を待つように遅れていた (実機で canplay から 0.8 秒)
   */
  function askCaptions(): void {
    if (captionWait !== null) {
      clearTimeout(captionWait);
      captionWait = null;
    }
    if (captionsAsked) return;
    captionsAsked = true;
    void loadCaptions();
  }

  /**
   * 字幕を取ってくる (`askCaptions` から 1 回)。端末に保存したものがあればそちら。字幕を持たない番組は 404 (ボタンを出さないだけ)
   */
  async function loadCaptions(): Promise<void> {
    if (captionText !== null) return;
    try {
      const copy = await localLookup;
      const text =
        copy !== null
          ? (copy.captionText as CaptionPages | undefined)
          : await fetch(resolve(`api/recordings/${rec.id}/captions.json`)).then(
              (res) =>
                res.ok ? (res.json() as Promise<CaptionPages>) : undefined,
            );
      if (text?.v === CAPTION_TEXT_VERSION) {
        captionText = text;
        // 覚えている言語が載っていればそれ、無ければ第 1 言語
        captionLanguage = pickLanguage(
          captionLanguages,
          stored(CAPTION_LANGUAGE_KEY),
        );
        paint();
      }
    } catch (error) {
      // 出せないだけ。観るのに支障は無い
      console.warn("[captions] 取れませんでした", error);
      // 繋がらなかった。字幕を入れ直したときに取り直す (`setCaptions`。コマごとには取り直さない)
      captionsFailed = true;
    }
  }

  /** 詰まった。「読み込み中」は幕が少し待ってから出す (`PlayerVeil`) */
  function stall(): void {
    // CM を跨いでいる間は覆いがある。そちらに任せる
    if (hopping || buffering) return;
    buffering = true;
  }

  /** 動き出した。「読み込み中」を引っ込める */
  function flowing(): void {
    if (buffering) buffering = false;
  }

  function clearCaptions(): void {
    shownPage = null;
    painter?.show(null);
  }

  /**
   * 字幕の貼り直しと CM の跨ぎを、映した 1 枚ごとに追わせる ([frames.ts](../../../lib/components/player/frames.ts)。
   * ライブと同じ作り)。`timeupdate` (250ms ごと) 任せだった頃は字幕が遅れ、CM も数コマ見えていた
   */
  function follow(target: HTMLVideoElement): void {
    if (following === target) return;
    following = target;
    eachFrame(target, (meta) => {
      // 別の映像に移った (画面を閉じた) ら、こちらは畳む
      if (following !== target) return false;
      /*
       * 映したコマの時刻 (`mediaTime`) で外す。`currentTime` は代入した時点で飛んだ先を返すのに、
       * 画面にはまだ手前のコマが出ていて、CM の尻が 1 コマ見えていた
       */
      if (waiting) {
        const there =
          !target.seeking && (meta?.mediaTime ?? target.currentTime) >= hopTo;
        if (!there) settled = 0;
        else if (++settled >= SETTLED) open();
      }
      // 映像だけ遅れていたら飛び直す。CM の先へ飛んでいる最中と、canvas に描いている間 (`<video>` は空) は見ない
      if (meta !== undefined && !waiting && !hopping && !drawing)
        unslip.check(target, meta.mediaTime);
      // 最初のコマが出た (開いた直後に CM の先へ飛ぶなら、飛んだ先が出てから)
      if (!hopping && target.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
        askCaptions();
      paint();
      hopCm();
      return true;
    });
  }

  /** 字幕と CM の覆いを映像が出ているところにぴったり重ねる (`fitRect`) */
  function place(): void {
    if (video === null) return;
    // canvas に描いているときは `<video>` は空なので、放送の 16:9 とみなす
    const [width, height] = drawing
      ? [16, 9]
      : [video.videoWidth, video.videoHeight];
    const rect = fitRect(video.clientWidth, video.clientHeight, width, height);
    // 画面の画素の境目に揃える (端数だと字の縁が滲む)。端は外へ丸め、覆いが映像の縁を残さず覆うように
    const dpr = window.devicePixelRatio || 1;
    const left = Math.floor((video.offsetLeft + rect.left) * dpr) / dpr;
    const top = Math.floor((video.offsetTop + rect.top) * dpr) / dpr;
    const right =
      Math.ceil((video.offsetLeft + rect.left + rect.width) * dpr) / dpr;
    const bottom =
      Math.ceil((video.offsetTop + rect.top + rect.height) * dpr) / dpr;
    for (const layer of [overlay, cover]) {
      if (layer === null) continue;
      layer.style.left = `${left}px`;
      layer.style.top = `${top}px`;
      layer.style.width = `${right - left}px`;
      layer.style.height = `${bottom - top}px`;
    }
    // 黒塗りの覆いは枠ごと覆う (開いた直後はまだ映像の大きさが分からず、`fitRect` が当てにならない)
    if (blanked && cover !== null) {
      cover.style.left = "0";
      cover.style.top = "0";
      cover.style.width = "100%";
      cover.style.height = "100%";
    }
  }

  /*
   * 全画面の出入り (iPhone で広げたときは `resize` が来ない) と、映像の箱の伸び縮み
   * (二段組の切り替わり・データ放送の小窓) で測り直す
   */
  $effect(() => {
    void fullscreen.active;
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  });
  $effect(() => {
    const target = video;
    if (target === null) return;
    const watcher = new ResizeObserver(() => place());
    watcher.observe(target);
    return () => watcher.disconnect();
  });

  /**
   * いまの位置に合う 1 枚を重ねる (描き方はライブと同じ `caption-draw.ts`)。変わったときだけ描く。
   * 覆いの下では描かない (CM の字幕を仕込むことになる)
   */
  function paint(): void {
    if (hopping || !captions || overlay === null) return;
    const at = mediaTime();
    const page = captionShowing(currentCue(cues, at), at);
    if (page === shownPage) return;
    shownPage = page;
    place();
    painter?.show(page);
  }

  /** 秒で動かす。**端は超えさせない** (超えると勝手に終わる) */
  function seekBy(by: number): void {
    if (video === null && canvas === null) return;
    seekMedia(
      Math.min(Math.max(mediaTime() + by, 0), length || video?.duration || 0),
    );
    controls.stir();
  }

  function seekTo(seconds: number | null): void {
    if ((video === null && canvas === null) || seconds === null) return;
    seekMedia(seconds);
    controls.stir();
  }

  /**
   * シークバーをつまんで動かしている間の下見 (`SeekBar` の `preview`)。`<video>` だけ。
   * 粗くてよいので、持っていれば `fastSeek` (近くのキーフレーム) を使う。飛び終わり (`seeked`) で
   * Promise を終え、シークバーはそれから次をリクエストする。離したときは `seekTo` でちゃんと飛ぶ。
   * **canvas のプレイヤーには渡さない**。飛ぶたびに持っているものを捨てて取り直すので、離したときだけにする
   */
  function previewSeek(to: number): Promise<void> {
    const target = video;
    if (target === null || canvas !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        target.removeEventListener("seeked", done);
        resolve();
      };
      // 着かないまま (読めない・遅い) でも次へ進めるように
      const timer = setTimeout(done, 1000);
      target.addEventListener("seeked", done);
      if (typeof target.fastSeek === "function") target.fastSeek(to);
      else target.currentTime = to;
    });
  }

  /** 映像を押されたときの読み方は追っかけと同じ (`stage-tap.ts`) */
  const press = stageTap({
    toggle: togglePlay,
    controls: () => controls.toggle(),
    seekBy,
  });

  /**
   * キーでも動かせるようにする。全画面のときはこれがいちばん早い。
   * **割り当てはライブ・追っかけと共通** (`player/keys.ts`。修飾キーの扱いもあちら)。
   * データ放送を出している間の十字キーはあちらのカーソル (`DataBroadcast`) なので、送りには使わない
   */
  const playerKey = playerKeys({
    togglePlay,
    seekBy,
    toggleCaptions,
    snapshot: () => void snapshot(),
    toggleFull: fullscreen.toggle,
    stepSpeed: (by) => setSpeed(stepSpeed(speed, by)),
    toggleMute,
    stepVolume: volume.step,
  });
  function keys(event: KeyboardEvent): void {
    if (showData && event.key.startsWith("Arrow")) return;
    playerKey(event);
  }

  const current = $derived(chapterAt(chapters, at));
  /** CM の入っている録画でだけ、飛ばすボタンを出す (押しても何も起きない操作を並べない) */
  const hasCm = $derived(chapters.some((chapter) => isCm(chapter.title)));
  /** シークバーで琥珀に塗る CM の区間と、それ以外の切れ目 */
  const cmOnBar = $derived(cmSpans(chapters));
  const marksOnBar = $derived(plainMarks(chapters));

  /** あと何分で終わるか。倍速のぶんは割る (2 倍で「残り 30 分」と出ても掛かるのは 15 分) */
  const remaining = $derived(
    Math.max(0, (length - at) / (drawing ? 1 : speed || 1)),
  );

  /** 右に出す中身。録画の行が持っているぶん (追っかけと同じ)。番組表から引けたら `detail` が差し替える */
  const facts = $derived(recordingFacts(rec));

  /** 切り抜き。保存できたか・端末に保存したかを言う */
  const shooter = snapshotter(controls);

  /**
   * **録画の再生中は選局できない。** データ放送が「この局へ」と言ってきたら (epgTune)、文書には失敗を
   * 返し (`DataBroadcast` の tune)、観ている人にはそう知らせる
   */
  let tuneRefused = $state<Notice | null>(null);
  function refuseTune(): boolean {
    tuneRefused = {
      key: `tune-${Date.now()}`,
      kind: "info",
      text: "録画の再生中は選局できません",
    };
    return false;
  }

  /** 削除は断られたときだけ知らせる (消せたら一覧へ戻る) */
  const notices = $derived<Notice[]>([
    ...errorNotice(form, "watch-delete"),
    ...shooter.notices,
    ...pip.notices,
    ...(tuneRefused === null ? [] : [tuneRefused]),
  ]);

  /**
   * いまの 1 コマを字幕・コメントごと切り抜いてサーバに保存する (3 画面共通。[shot.svelte.ts](../../../lib/components/player/shot.svelte.ts))。
   * canvas に描いているときはプレイヤーから 1 枚もらう (`<video>` は空)
   */
  function snapshot(): void {
    const drawn = captions && shownPage !== null;
    void shooter.take(
      () => (canvas !== null ? grabbedFrame(canvas.grab()) : videoFrame(video)),
      drawn ? overlay : null,
      rec.name,
      () => ({
        place: "watch",
        recording: rec.id,
        at: mediaTime(),
        source: info?.axis,
      }),
      drawn ? captionWords(shownPage) : "",
    );
  }
</script>

<svelte:head><title>{rec.name} - denpa</title></svelte:head>
<svelte:window onclick={deleting.stand} onkeydown={keys} />

<!-- ライブ (`/live`) と同じレイアウト (PlayerLayout)。映像が左、読むものが右 -->
<PlayerLayout testid="watch">
  {#if !ready}
    <!-- 録っている最中は load が追っかけへ送るので、ここに来るのはエンコード済みも元の TS も無い録画 -->
    <div class="panel stack not-ready">
      <h2>まだ観られません</h2>
      <p class="small muted">観られるファイルがありません。</p>
      {#if rec.encode_error}
        <p class="small muted">{rec.encode_error}</p>
      {/if}
    </div>
  {:else}
    <PlayerStage
      {controls}
      {fullscreen}
      {ambient}
      testid="watch-stage"
      bind:element={stage}
    >
      {#snippet children(layout)}
        <!-- svelte-ignore a11y_media_has_caption -->
        <!--
                    **映像の箱。データ放送はこれを小窓へ寄せる** (`DataBroadcast` の `placeVideo`)。ライブと同じ。
                    押すのは映像そのもので、ボタンはその上に重ねる (z-index 10)
                -->
        <div
          bind:this={mediaBox}
          style="position:absolute; inset:0; width:100%; height:100%;"
        >
          <video
            bind:this={video}
            {src}
            style="width:100%; height:100%; background:var(--dp-video);"
            playsinline
            onclick={press}
            onplay={() => {
              playing = true;
              if (video !== null) follow(video);
              // 出たので、繋ぎ直しは済み。次に切れたらまた 1 秒から待つ
              retries = 0;
              resuming = false;
              controls.stir();
            }}
            onpause={() => {
              playing = false;
              // 止めたのは詰まりではない。「読み込み中」は引っ込める
              flowing();
            }}
            onended={finished}
            onwaiting={stall}
            onstalled={stall}
            onseeking={() => {
              stall();
              // シーク・CM スキップのあとは測り直す。段は持ち越す
              adapt.reset();
            }}
            onplaying={flowing}
            oncanplay={flowing}
            ontimeupdate={() => {
              at = video?.currentTime ?? 0;
              hopCm();
              paint();
              feedData();
            }}
            onseeked={feedData}
            onloadedmetadata={() => {
              resume();
              syncAudio();
            }}
            onvolumechange={() => (muted = video?.muted ?? false)}
            onerror={recover}
            data-testid="watch-video"
          >
          </video>
          <div bind:this={jikkyoSlot} style="display:contents">
            {#if data.jikkyoAllowed}
              <JikkyoLayer
                feed={jikkyo}
                air={airTime}
                show={jikkyoActive && data.jikkyo !== null && !showData}
                paused={!playing}
                rate={speed}
                ahead
              />
            {/if}
          </div>
          <!--
                    字幕は `<track>` ではなく canvas に放送の置き場所のまま描く (左右の位置・背景の箱・外字が落ちるため)。
                    映像と同じ箱に入れて、データ放送の小窓へ一緒に縮ませる (ライブの `MediaStack` と同じ)。
                    位置と大きさは `place` が書く。段は実況 (8) より上、操作バーのボタン (10) より下 (`ControlBar`)
                -->
          <canvas
            bind:this={overlay}
            style="position:absolute; z-index:9; pointer-events:none;"
            data-testid="watch-captions-canvas"
            data-on={captions && hasCaptions}
            aria-hidden="true"
          ></canvas>
          <!--
                    CM を跨ぐ間の覆い。字幕の上、操作バーや通知 (z-index 10) の下。出し入れは `hidden` で。
                    style に式を書くと `hopping` が変わるたびに書き直され、`place` が書いた位置と大きさが消える
                -->
          <canvas
            bind:this={cover}
            style="position:absolute; z-index:9; pointer-events:none;"
            hidden={!hopping}
            aria-hidden="true"
          ></canvas>
        </div>
        <!--
                    録画のデータ放送。エンコードするときに取り出した変化ログ (`data.hasData`) を再生位置に合わせて流す
                    (`feedData`/`listenData`)。双方向は使わない (送り先が生きていない)
                -->
        <DataBroadcast
          on={showData}
          receive={receiving}
          channel={dataChannel}
          media={mediaBox}
          listen={listenData}
          bind:press={dataPress}
          bind:pressD={dataButton}
          postal={data.broadcast.postalCode}
          prefecture={data.broadcast.prefecture}
          network={false}
          clock={airTime}
          tune={refuseTune}
        />

        <!--
                    観られないわけと、待っていることを言う幕 (`problem`)。見た目の決まりはライブ・追っかけと共通 (`PlayerVeil`)。
                    観られないときは映像を暗く覆い、詰まりと繋ぎ直しの最中は映っている映像を覆わずに回るものだけを出す。
                    黙って止まっていると壊れたように見え、待てばいいのかが決められない (サーバの入れ替えでは数十秒帰ってこない)
                -->
        {#if problem !== "" || buffering || resuming}
          <PlayerVeil
            holding={problem === ""}
            busy
            note={resuming ? "繋ぎ直しています" : "読み込み中"}
            error={problem}
            actions={busy && lighter.length > 0 ? lighterChoices : undefined}
            testid="watch-status"
          />
        {/if}

        <!--
                    右端の縦の列は観る流れの外の操作 (上から閉じる・切り抜き・コメントの一覧・削除。理由は `ControlBar`)。
                    削除はいちばん下 (当たっても聞き返しがある)。データ放送 (d) は ⚙ の中
                -->
        <ControlBar side shown={controls.shown} testid="watch-side">
          <CloseLink testid="watch-close" />
          <ControlButton
            icon={shooter.saved ? CHECK : CAMERA}
            label="この場面を切り抜く"
            testid="watch-shot"
            onclick={() => void snapshot()}
          />
          <!-- 右の列の先頭に「コメントの一覧」を出す・しまう (`canList`) -->
          {#if canList}
            <ControlButton
              icon={JIKKYO}
              label="コメントの一覧"
              on={jikkyoList.on}
              testid="watch-jikkyo-list"
              onclick={jikkyoList.toggle}
            />
          {/if}
          <!-- 観終わったその場で消せるように。2 回目も同じ大きさの丸 (`icons.ts` の `OVERLAY_DANGER`) -->
          <form method="POST" action="?/delete" use:submitting>
            <input type="hidden" name="id" value={rec.id} />
            {#if deleting.armed !== null}
              <ControlButton
                icon={CHECK}
                label="削除を確定"
                danger
                submit
                testid="watch-delete-confirm"
              />
            {:else}
              <ControlButton
                icon={TRASH}
                label="削除"
                testid="watch-delete"
                onclick={() => deleting.arm(rec.id)}
              />
            {/if}
          </form>
        </ControlBar>

        <!-- 下端の操作バー。並びは 3 画面で同じ (`ControlBar`・`ControlRow`) -->
        <ControlBar shown={controls.shown} testid="watch-controls">
          <!--
                        シークバーの CM は琥珀で塗る (denpa-tv と同じ)。送りを何回押すかが分かる。
                        色だけに頼らず、読み上げでは位置にいまのチャプターの名前を添える
                    -->
          <SeekBar
            value={at}
            max={length || 0}
            step={0.1}
            onseek={seekTo}
            preview={drawing ? undefined : previewSeek}
            bind:scrub
            cm={cmOnBar}
            marks={marksOnBar}
            valuetext={current === null
              ? undefined
              : `${clock(at)}、${current.title}`}
            paused={!playing}
            testid="watch-seek"
          />

          <ControlRow testid="watch-buttons">
            <!--
                            10 秒送り・戻しは置いていない。PC は矢印キー、指は左右の端を素早く 2 回
                            (`ts/watch.ts` の `tap`) でできる
                        -->
            <ControlButton
              icon={playing ? PAUSE : PLAY}
              label={playing ? "一時停止" : "再生"}
              testid="watch-play"
              onclick={togglePlay}
            />
            <!-- 畳むときは音と速さを ⚙ の先頭に入れる (`Extras`・`StageTail` の `fold`。字幕は ⚙ の「字幕」) -->
            <Extras>
              <SoundButton
                silenced={muted}
                testid="watch-sound"
                onclick={toggleMute}
                {volume}
              />

              <!-- 字幕を持っている録画でだけ出す。押しても何も起きない操作を並べない (`/live` と同じ) -->
              {#if hasCaptions}
                <ControlButton
                  icon={CAPTION}
                  label={captions ? "字幕を消す" : "字幕を出す"}
                  on={captions}
                  testid="watch-captions"
                  onclick={toggleCaptions}
                />
              {/if}
            </Extras>

            <!--
                            チャプター送りは入っているときだけ (CM を切ってエンコードしたものには無い)。
                            畳むときも残す。CM や本編の始まりへ毎回のように使う
                        -->
            {#if chapters.length > 1}
              <ControlButton
                icon={PREV}
                label="前のチャプター"
                onclick={() => seekTo(prevChapterAt(chapters, at))}
              />
              <ControlButton
                icon={NEXT}
                label="次のチャプター"
                testid="watch-next-chapter"
                onclick={() => seekTo(nextChapterAt(chapters, at))}
              />
            {/if}

            <InfoBlock
              range={{ start: rec.start_at, end: rec.end_at }}
              service={rec.service_name}
              title={rec.name}
              titleTestid="watch-name"
            >
              {#snippet prefix()}
                {#if localSrc !== null || drawingLocal}
                  <!-- サーバではなく端末のコピーで観ている。事実なのでバッジにせず控えた字 (docs/design.md の「印の意味」) -->
                  <span class="local">端末</span><span class="local">・</span>
                {/if}
              {/snippet}
              {#snippet status()}
                <!-- 残りは倍速のぶんを割った実際に掛かる時間 (`remaining`)。狭い枠では `.long` を省く -->
                <span class="clock" data-testid="watch-clock">
                  {clock(scrub ?? at)} / {clock(length)}<span class="long"
                    >{"・残り "}{clock(remaining)}</span
                  >
                </span>
                {#if current !== null}
                  <span class="long">{"・"}<span>{current.title}</span></span>
                {/if}
              {/snippet}
            </InfoBlock>

            <!-- 早送りは追っかけと同じ。canvas に描くとき (互換モード・MPEG-2) は等速だけ -->
            {#if !compat && !drawing}
              <Extras>
                <SpeedMenu
                  testid="watch-speed"
                  label="再生の速さ"
                  {speed}
                  onselect={(value) => setSpeed(value)}
                />
              </Extras>
            {/if}

            <!--
                            ⚙ の行は使えるときだけ出す: CM スキップは CM の入った録画、コーデックは観られる方式が
                            2 つ以上 (`codecMenu`)、音声は 2 本以上 (`syncAudio`)
                        -->
            <StageTail
              prefix="watch"
              {volume}
              fold={[
                muteRow(SOUND_OFF, muted, toggleMute),
                ...(compat || drawing
                  ? []
                  : [
                      speedRow({
                        icon: SPEED,
                        label: "再生の速さ",
                        speed,
                        onselect: (value) => setSpeed(value),
                      }),
                    ]),
              ]}
              {background}
              {ambient}
              {pip}
              {fullscreen}
              stage={layout}
              cm={hasCm ? { on: skipCm, toggle: toggleSkipCm } : undefined}
              data={data.hasData
                ? {
                    on: showData,
                    toggle: () =>
                      pressD(showData, dataButton, (on) => void setData(on)),
                  }
                : undefined}
              receive={data.hasData
                ? { on: receiveData, toggle: toggleReceiveData }
                : undefined}
              jikkyo={data.jikkyoAllowed
                ? {
                    on: jikkyoOn.on,
                    toggle: jikkyoOn.toggle,
                    missing: data.jikkyo === null,
                    down: jikkyo.down,
                  }
                : undefined}
              subtitle={hasCaptions
                ? subtitles({
                    icon: CAPTION,
                    on: captions,
                    languages: captionLanguages,
                    language: captionLanguage,
                    onoff: (on) => setCaptions(on),
                    onlanguage: (index) => setCaptionLanguage(index),
                  })
                : undefined}
              codec={codecMenu.length > 0
                ? recordingCodecs({
                    icon: CODEC,
                    choices: codecMenu,
                    selected: codecMenu.some((item) => item.key === choice)
                      ? choice
                      : "auto",
                    // 「自動」で段を下げている間は、いまの形式と高さを添える (「自動 (H.264 540p)」)
                    auto:
                      choice === "auto" ? autoLabel(step, stepCodec) : "自動",
                    onpick: (key) => chooseCodec(key as CodecChoice | "mpeg2"),
                  })
                : undefined}
              audio={audios.length > 1
                ? audioTracks({
                    icon: AUDIO,
                    items: audios.map((label, i) => ({
                      key: i,
                      label,
                      active: i === audioIndex,
                    })),
                    onselect: (key) => selectAudio(key),
                  })
                : undefined}
            />
          </ControlRow>
        </ControlBar>
      {/snippet}

      <!-- 映像の上の通知は舞台の列に積む (`PlayerStage` の `notes`)。黙って途中から始めたり飛んだりすると壊れて見える -->
      {#snippet notes()}
        {#if continued}
          <StageNote testid="watch-resumed">続きから再生しています</StageNote>
        {/if}
        {#if skipped}
          <StageNote testid="watch-skipped">CM を飛ばしました</StageNote>
        {/if}
        {#if warning !== null}
          <!-- 互換モードの断り書き (切り替えた理由)。ライブと同じ出し方 -->
          <StageNote>{warning}</StageNote>
        {/if}
        {#if adaptText !== null}
          <!-- 回線に合わせて段を替えた理由 (`watch-adapt.ts`) -->
          <StageNote testid="watch-adapt">{adaptText}</StageNote>
        {/if}
        {#if volume.noted}
          <StageNote testid="watch-volume-note">音量 {volume.level}%</StageNote>
        {/if}
      {/snippet}
    </PlayerStage>
  {/if}

  <!--
        右は番組の中身。観ながら読めるよう、映像に被せず全部ここに出す。押すものはこの録画の切り抜きへのリンクだけ
        (閉じる・削除は映像の上の列。全画面のタブレットで映像から出ずに押す)
    -->
  {#snippet aside()}
    <FactsAside testid="watch-facts">
      {#snippet top()}
        <!-- データ放送のリモコンは、出している間だけ右の列の先頭に出す (ライブと同じ) -->
        {#if dataPress !== null}
          <Remote press={dataPress} />
        {/if}
        <!-- 実況のコメントの一覧も、出している間は列の先頭 (リモコンの下) -->
        {#if canList && jikkyoList.on}
          <JikkyoList
            feed={jikkyo}
            air={airTime}
            place={placeAir}
            seek={seekTo}
            edge={() => data.jikkyo?.end ?? null}
          />
        {/if}
      {/snippet}

      <!-- 出演者などは番組表の側にある。引き直せたらそちら、引けない古い録画は行のぶんだけ -->
      <ProgramFacts
        program={detail.current ?? facts}
        cmNote={cmNoteWorthShowing(rec.cm_note) ? rec.cm_note : null}
        fps={rec.fps}
      />

      <div class="small muted meta num" data-testid="watch-meta">
        {recordedDuration(rec)}・{size(rec.ts_size)}
      </div>
      {#if data.clips > 0}
        <a
          class="small clips-link"
          href={resolve(`clips?recording=${rec.id}`)}
          data-testid="watch-clips"
          >この録画の切り抜き <span class="num">({data.clips})</span></a
        >
      {/if}
    </FactsAside>
  {/snippet}
</PlayerLayout>

<!-- サーバが混んでいるときに勧める、変換させずに観られるもの (幕の「サーバが混んでいます」の下) -->
{#snippet lighterChoices()}
  <div class="cluster choices">
    {#each lighter as codec (codec)}
      <button
        type="button"
        class="small"
        data-testid="watch-busy-switch"
        onclick={() => chooseCodec(codec)}
      >
        {codecLabel(codec)} で観る
      </button>
    {/each}
  </div>
{/snippet}

<Toasts
  {notices}
  source={form}
  ondismiss={(key) => {
    shooter.dismiss(key);
    pip.dismiss(key);
    if (tuneRefused?.key === key) tuneRefused = null;
  }}
/>

<!-- 運転中の注意 (互換モードで初めて再生する前に 1 回。ライブ・追っかけと同じ)。押すまで再生を始めない -->
<DriveNotice open={drive.open} onaccept={drive.accept} />

<style>
  .not-ready h2 {
    font-size: var(--dp-text-base);
  }
  /* 幕の押しものは文言の下の真ん中に (`PlayerVeil`) */
  .choices {
    justify-content: center;
  }
  /* 時間帯・局と同じ並びに、控えた字で「・」でつなぐ (「・」の両側は並びの隙間で、InfoBlock の `.sep` と同じ空き) */
  .local {
    flex-shrink: 0;
    color: var(--dp-on-video-muted);
  }
  .meta {
    margin-top: 0.75rem;
  }
  /* この録画の切り抜きへ。押せる高さは一覧の行の操作と同じ 40px */
  .clips-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 2.5rem;
    margin-top: 0.25rem;
  }
</style>
