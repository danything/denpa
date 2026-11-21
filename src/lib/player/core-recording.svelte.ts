/**
 * **再生の核 (観る画面)。録画を読みに行って、MSE・canvas・`<video src>` で再生する。**
 *
 * 層は 4 つに分けてある (docs/architecture.md「再生の層」)。ライブと追っかけの核 (`player/core.svelte.ts`) とは、
 * 出どころの運び方と段の動かし方だけが違う。
 *
 * - 出どころ (Feed) … `player/feed-recording.ts` の `RecordingFeed` (リクエスト先と段 0 のビットレート)。位置を指定して読み出す側は
 *   `remux-player.ts` (その場で流すもの。MSE)・`canvas-player.ts` (互換モードと MPEG-2)・`<video src>` (ファイルの直再生)。
 *   **読みに行く**ので、止めている間は読むのも止まり、飛んだら位置からリクエストし直す
 * - 時間の軸 (Clock) … `player/clock-recording.ts` の `RecordingClock`。尺があり、続きの位置・この場面・選び直した所から始める
 * - 描く先 (Sink) … MSE は `remux-player.ts` が `player/mse-sink.ts` に足し、canvas は `player/canvas-sink.ts` (`raw/engine.ts`)
 * - 核 (ここ) … どれで観るか (`pickOffer`・`pickCanvas`)、読み出し側 (その場で流すもの・canvas・ファイル) の作り直し、段の切り替え (`prepareStep`・`switchTo`)、
 *   ファイルの繋ぎ直し (`recover`)、音声トラック、速さ。字幕 (`CaptionLayer`)・データ放送 (`DataLayer`)・断り書き (`Note`)・
 *   描けなくなったときの移り先 (`fallBackTo`)・繋ぎ直し (`StreamRetry`)・配線に渡すもの (`PlaybackTarget`) はライブと同じものを使う
 *
 * CM 飛ばしとチャプターは画面が持つ (録画の中身の扱いで、再生の仕組みではない)。核はコマを映すたびに `hooks.frame` を呼び、
 * canvas には CM の先頭から先を描かせない (`stopAt`)
 */

import { resolve } from "$app/paths";
import type { ResponseMessage } from "@danything/arib/bml-protocol";
import {
  CAPTION_TEXT_VERSION,
  type CaptionLanguage,
  captionLanguage as languageOf,
  type CaptionPages,
} from "@danything/arib/caption-text";
import { onMount, untrack } from "svelte";

import {
  ADAPT_NOTE,
  type AdaptDecision,
  adaptNote,
  HOLD,
  type Step,
  stepOrder,
  SWITCH_NOTE,
} from "#lib/adapt.js";
import { type CanvasPlayer, canvasPlayer } from "#lib/canvas-player.js";
import { canvasVideo, driveNoticeSeen } from "#lib/canvas-video.js";
import { eachFrame } from "#lib/components/player/frames.js";
import { fitRect } from "#lib/components/player/paint.js";
import { grabbedFrame, videoFrame } from "#lib/components/player/snapshot.js";
import {
  SPEED_KEY,
  storedSpeed,
} from "#lib/components/player/SpeedMenu.svelte";
import { unslipper } from "#lib/components/player/unslip.js";
import type { PlaybackTarget } from "#lib/components/player/wiring.svelte.js";
import { driveGate } from "#lib/drive-gate.svelte.js";
import { handoff, HANDOFF_GIVE_UP, handoffTarget } from "#lib/handoff.js";
import { broadcastHevcPlayable, browserHevcProbe } from "#lib/hevc-4k.js";
import { CODEC_LABEL } from "#lib/hw.js";
import { read as stored, write as remind } from "#lib/keep.js";
import { WATCH_HIDDEN_CODECS } from "#lib/live-choice.js";
import { BROADCAST_HEVC, type LiveCodec } from "#lib/live.js";
import { type MkvSource, openMkv } from "#lib/mkv-source.js";
import { tapSilent } from "#lib/native-audio-choice.js";
import type { OfflineVideo } from "#lib/offline-db.js";
import { loadOffline } from "#lib/offline.svelte.js";
import { fallBackTo } from "#lib/player/canvas-sink.js";
import { CaptionLayer } from "#lib/player/captions.svelte.js";
import { RecordingClock } from "#lib/player/clock-recording.js";
import { DataLayer } from "#lib/player/data.svelte.js";
import { playable, RecordingFeed } from "#lib/player/feed-recording.js";
import { emptyVideo, rangesOf } from "#lib/player/mse-sink.js";
import { Note } from "#lib/player/notes.svelte.js";
import { canvasSupport, rawUnsupported } from "#lib/raw/support.js";
import {
  type RemuxPlayer,
  remuxPlayer,
  type StreamHeard,
} from "#lib/remux-player.js";
import { busyNote, type Pace } from "#lib/rungs.js";
import type { Cue } from "#lib/ts/captions.js";
import type { PlacedMessage } from "#lib/ts/data-timeline.js";
import { pickMediaSource } from "#lib/ts/media-source.js";
import {
  aheadOf,
  type CanvasAbility,
  canvasChoices,
  type CanvasCodec,
  canvasTranscodes,
  type CodecChoice,
  codecChoices,
  failureText,
  type MediaAbility,
  MENU_ORDER,
  offersText,
  pickCanvas,
  type Picked,
  pickedText,
  pickOffer,
  pickStream,
  type PlaybackInfo,
  type PlayCodec,
  STREAM_RETRIES,
  streamForAudio,
  StreamRetry,
  type StreamState,
  transcodes,
} from "#lib/ts/playback.js";
import {
  ADAPT_TICK,
  autoLabel,
  fileIdle,
  watchAdapt,
} from "#lib/watch-adapt.js";

/**
 * 画面が持つもの (CM の跨ぎ・観はじめの判断・どこまで観たか) を呼ぶフック。**核はコマを映すたびに呼ぶ**。
 * 呼ぶ順は、着いたか (`arrive`) → 覆いを外す・映像の遅れを直す・字幕を描く → 飛ぶかの判断 (`frame`)
 */
export interface RecordingHooks {
  /**
   * 映したコマの位置 `at` (秒)。`ready` はそのコマを出せているか (`<video>` は飛んでいる最中でない、canvas は流れている)。
   * `canvas` は canvas の刻みから。CM の先へ飛んだ先が映ったかを数える
   */
  arrive(at: number, ready: boolean, canvas: boolean): void;
  /**
   * コマを映した・刻んだ。`shown` は `<video>` が映したばかりのコマの時刻 (canvas と `timeupdate` は無い)、
   * `flowing` は流れているか (null なら呼んだ間隔を測らない)。CM の手前で飛ぶかを決める
   */
  frame(shown: number | undefined, flowing: boolean | null): void;
  /** CM を跨ぐ間、最後のコマで覆っているか。覆っている間は字幕を描かず、「読み込み中」も出さず、映像の遅れも見ない */
  covering(): boolean;
  /** CM の先へ飛んだ先が映るのを待っているか。待っている間は映像の遅れを見ない */
  waiting(): boolean;
  /** 観はじめの位置が決まった (続きか先頭か)。始まりが CM なら飛ぶ */
  settle(): void;
  /** 末尾まで来た */
  ended(): void;
}

/** 配線 (`wiring.svelte.ts`) のうち、canvas のプレイヤーを作るときに読むもの */
interface WiringState {
  background: { on: boolean };
  pip: { active: boolean };
  volume: { applied: number | null };
}

export interface RecordingPlaybackOptions {
  /** 開いている録画 (`+page.server.ts`) */
  recording: () => {
    id: number;
    resume_ms: number | null;
    library_path: string | null;
  };
  /** 「この場面から観る」で始める位置 (秒。切り抜きの画面から `?at=`)。無ければ null */
  scene: number | null;
  /** 観るものがあるか。エンコード済みか、録り終えた元の TS */
  ready: () => boolean;
  /** 開いた名前が家の中か (サーバが決める)。「自動」の形式を決めるのに使う */
  indoor: () => boolean;
  /** この録画にデータ放送の変化ログがあるか */
  hasData: () => boolean;
  /** 録画の入口に自動起動の指定があるか (`server/recorded-bml.ts` の `recordedAutoStart`) */
  autoStart: () => boolean;
  /** 操作したので操作バーを出しておく (`controls.svelte.ts` の `stir`) */
  stir: () => void;
  /** 配線。核より後に作るので、読むときに受け取る */
  wiring: () => WiringState;
  hooks: RecordingHooks;
}

export function recordingPlayback(options: RecordingPlaybackOptions) {
  const { hooks } = options;
  const rec = $derived(options.recording());
  /** 映像を入れる箱。canvas で描くときは映像の canvas をここに差し込み、BML はこれを動かす (`DataBroadcast` の `placeVideo`) */
  let mediaBox = $state<HTMLElement | null>(null);
  /**
   * 覆い。段を替えるためにプレイヤーを作り直す間 (`hold`) と、CM を跨ぐ間 (画面の `shut`) に、最後のコマか黒で覆う面。
   * 先読み (`ts/watch.ts` の `cmLead`) だけでは、コンポジタへ渡し済みのコマが出てしまう。黒で塗らないのは、止まったコマのほうが飛んだように見えるため
   */
  let cover = $state<HTMLCanvasElement | null>(null);
  /** 覆いが黒塗りか (写したコマではないか)。黒塗りの覆いは枠ごと覆う (`place`) */
  let blanked = $state(false);
  /** 録画をサーバから読む所 (`player/feed-recording.ts`)。リクエスト先と、段 0 のビットレートを持つ */
  const recordingFeed = new RecordingFeed(() => rec.id);
  /** 開く位置 (`player/clock-recording.ts`)。選び直したときに続ける位置・この場面から観る位置 (切り抜きの画面から `?at=`)・続きの位置 */
  const recordingClock = new RecordingClock(options.scene, () => rec.resume_ms);

  /** 観るものがあるか。エンコード済みか、録り終えた元の TS (`+page.server.ts`) */
  const ready = $derived(options.ready());
  /*
   * 端末に保存してあればオンラインでもそちらを観る (docs/offline.md)。字幕・チャプター・データ放送も
   * 端末に保存してあるものを使う。確かめ終わるまで src を渡さない。先に渡すとサーバから読み始め、
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

  /*
   * ---- 回線に合わせた画質の段 (`watch-adapt.ts`。docs/stream.md「回線に合わせて画質を下げる」) ----
   *
   * 「自動」のときだけ段を動かす。ファイルの直再生・MPEG-2 (段 0) から下げる、段 0 へ戻す、音声だけとの行き来は、
   * 裏の `<video>` で用意してから入れ替える (`prepareStep`)。段 1〜3 の間は同じ MSE のまま替える (`remux-player.ts` の `switchTo`)。
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
  /** canvas のプレイヤーがバッファを使い切って止まっているか (`waiting`)。段を決めるのに渡す */
  let canvasStuck = false;
  /** 段を切り替えている最中か (応答を待っている間は刻まない) */
  let switching = false;
  /** これより前 (ms) は段を動かさない。混んでいて断られたあと、続けてリクエストしない */
  let adaptQuietUntil = 0;
  /**
   * ファイルの直再生で、ブラウザが最後にファイルを読むのを止めた時刻 (ms。`suspend`)。刻みの間に読み足して止めたぶんも
   * `adapt.ts` に「読むのを止めている」(`idle`) と渡す
   */
  let suspendAt = Number.NEGATIVE_INFINITY;
  /** 段の断り書き (`player/notes.svelte.ts`)。`ADAPT_NOTE` で引っ込める */
  const adaptText = new Note();
  /** 段を替えるために作り直したとき、作り直す前に再生していたか。尺が分かったら続ける (`resume`) */
  let keepPlaying = false;

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
  /**
   * 4K の局を録った元の TS を詰め替えたもの (放送の HEVC。`PlaybackInfo.broadcast`) を再生できるか。`isTypeSupported` に加えて
   * `decodingInfo` に放送の値を渡して決める (`#lib/hevc-4k.ts`。ライブの 4K の局と同じ)。4K の局の録画を開いたときに調べる
   */
  let broadcastHevc = false;
  /** MPEG-2 を描いている途中で打ち切ったか。**選び直すまで MPEG-2 にしない** (`canvasFallBack`) */
  let rawGaveUp = $state(false);
  /** この端末で描ける形式 (`raw/support.ts`)。調べるまで null */
  let canvasAbility = $state.raw<CanvasAbility | null>(null);
  /** いま canvas に描いている形式。描いていなければ null (`<video>` で観ている・まだ始めていない) */
  let canvasCodec = $state<CanvasCodec | null>(null);
  /** canvas に描くプレイヤー。`canvasCodec` が決まって、映像の箱ができたら作る */
  let canvas: CanvasPlayer | null = null;
  /** canvas のプレイヤーがあるか (`canvas` は作り直しの都度替わるので、画面の出し分けはこちらで見る) */
  let drawing = $state(false);
  /** 端末に保存した録画を描くときの読み込み元 (`mkv-source.ts`)。サーバから流しているなら null */
  let localMkv: MkvSource | null = null;
  /** 端末に保存した録画を canvas に描いているか (操作バーの「端末」の印・メニューの出し分け) */
  let drawingLocal = $state(false);
  /** 描いている途中で打ち切った形式。**選び直すまでリクエストし直さない** (戻しては打ち切るを繰り返さない) */
  let canvasGaveUp: CanvasCodec[] = [];
  /** 互換モードで観られない理由。出したら `<video>` には戻らずに止まる */
  let canvasProblem = $state<string | null>(null);
  /** 映像の上に出しておく断り書き (MPEG-2 に切り替えた、など)。`SWITCH_NOTE` で引っ込める (`note`。ライブと同じ) */
  const warning = new Note();
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
    const support = await canvasSupport();
    canvasAbility = { ...support, mpeg2: rawUnsupported() === null };
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
   * 末尾の手前へ飛ぶと終わりにするので、違う長さを使うと途中で終わる)。それ以外は `playback`
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
    const fresh = recordingClock.switchAt === null;
    const scene = recordingClock.sceneAt !== null;
    const from = recordingClock.startFrom(duration);
    /*
     * 元の TS のビットレートを読んでおく (`adapt.ts` が測った速さと比べる)。読めなければ目安 (10.5 Mbit/s) と比べるので、
     * MPEG-2 (13〜24 Mbit/s) に足りない回線でも足りていると見て、詰まっても下げなくなる
     */
    if (
      codec === "mpeg2" &&
      local === null &&
      recordingFeed.baseOf("ts") === null
    )
      void recordingFeed.readBaseKbps("ts", duration);
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
        // `offset` は元の TS の続きをリクエストするとき (`canvas-player.ts` の `resume`)
        request: (at, audio, signal, offset) =>
          local !== null
            ? Promise.resolve(local.request(at))
            : fetch(
                canvasUrl(codec, at, audio) +
                  (offset === undefined ? "" : `&offset=${offset}`),
                { signal },
              ),
        heard: (heard) => {
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
        background:
          options.wiring().background.on || options.wiring().pip.active,
        muted,
        volume: options.wiring().volume.applied,
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
          hooks.ended();
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
    drawingLocal = local !== null;
    length = duration;
    at = from ?? 0;
    playing = !made.paused;
    syncAudio();
    place();
    options.stir();
    if (!fresh || resumed) return;
    resumed = true;
    if (from !== null && !scene) showContinued();
    hooks.settle();
  }

  /** canvas のプレイヤーのリクエスト先 (`RecordingFeed.canvasUrl`)。段を下げるなら、サーバは描ける形式 (`canvasPlayable`) から選ぶ */
  function canvasUrl(codec: CanvasCodec, at: number, audio: string): string {
    return recordingFeed.canvasUrl(step, codec, at, audio, canvasPlayable());
  }

  /** 互換モードで描けるコーデック (`?playable=`)。描いている途中で打ち切ったものは外す。H.265 は描かない (`raw/support.ts`) */
  function canvasPlayable(): LiveCodec[] {
    const can = canvasAbility;
    if (can === null) return [];
    return (["av1", "h264"] as const).filter(
      (codec) => can[codec] && !canvasGaveUp.includes(codec),
    );
  }

  /** この録画で描けて、まだ打ち切っていない形式 (`canvasChoices` の並び。描けなくなったときの移り先を決める `fallBackTo` に渡す) */
  function canvasUsable(): CanvasCodec[] {
    if (info === null || canvasAbility === null) return [];
    return canvasChoices(info, canvasAbility)
      .filter((item) => item.drawable && !canvasGaveUp.includes(item.codec))
      .map((item) => item.codec);
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
    recordingClock.switchAt = position;
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

  /** canvas のプレイヤーを閉じる (切り替える・打ち切る) */
  function stopCanvas(): void {
    canvas?.destroy();
    canvas = null;
    canvasStuck = false;
    // 作り直しの途中で閉じた (失敗した・打ち切った・選び直した)。替える前の段は忘れる (残すと段を動かさなくなる)
    stepFrom = null;
    drawing = false;
    drawingLocal = false;
    canvasCodec = null;
    playing = false;
    flowing();
  }

  /**
   * 描くのを打ち切った。理由は断り書きに残す。ライブと同じ決め方で替える (`player/canvas-sink.ts` の `fallBackTo`)。
   * H.264 / AV1 を打ち切ったら MPEG-2 へ、MPEG-2 を打ち切ったら描ける H.264 / AV1 へ。端末に保存した録画なら
   * サーバから流すものへ (`pickCanvas`)。どれも無理なら理由を出して止まる (`<video>` には戻らない)。
   *
   * 互換モードでないのに描いているのは、MPEG-2 を選んだとき (`pickOffer` の `raw`) と、端末に保存した Matroska を `<video>` が
   * 読めなかったとき (`recover`)。MPEG-2 を打ち切ったらこの画面を開いている間は MPEG-2 を外し (`rawGaveUp`)、自動と同じ決め方で
   * `<video>` に戻す。ファイルを読めなかったあとはストリームから選ぶ (`pickStream`)。
   *
   * 間に合わずに打ち切ったとき (`slow` がある) は、掛かった条件をコンソールに出力する
   */
  function canvasFallBack(reason: string, slow?: string): void {
    const failed = canvasCodec;
    const position = mediaTime();
    const wasLocal = localMkv !== null;
    stopCanvas();
    if (slow !== undefined)
      console.warn(`[watch] ${failed ?? ""} を打ち切りました: ${slow}`);
    // 描けなくなったのは端末のデコードの都合 (`raw/budget.ts`)。回線の段とは混ぜず、段 0 から決め直す
    step = 0;
    stepCodec = null;
    stepFrom = null;
    let next: CanvasCodec | "video" | null;
    if (wasLocal && compat) {
      localMkv = null;
      // 互換モードで端末に保存したものをやめた。サーバから流すものを、開いたときと同じ決め方で選ぶ
      next =
        info !== null && canvasAbility !== null
          ? pickCanvas(info, canvasAbility, choice, canvasGaveUp)
          : null;
    } else {
      // 端末に保存したものを描いていた (`<video>` が読めなかったあと。`recover`)。MPEG-2 は外さない
      if (wasLocal) localMkv = null;
      else if (!compat) rawGaveUp = true;
      else if (failed !== null) canvasGaveUp = [...canvasGaveUp, failed];
      next = fallBackTo(
        failed === "mpeg2" ? "mpeg2" : "encoded",
        canvasUsable(),
        compat,
      );
    }
    if (next === "video") {
      const fresh =
        info === null
          ? null
          : fileFailed
            ? pickStream(info, ability(), options.indoor())
            : pickOffer(info, ability(), "auto", options.indoor());
      note(
        fresh === null
          ? reason
          : `${reason}。${codecLabel(fresh.codec)} に切り替えました`,
      );
      replay(fresh, position);
      // 替える先が無い。断り書きが消えたあとも黒いままにせず、観られないことを幕に出す (開いたときの `picked === null` と同じ)
      if (fresh === null)
        giveUp(
          `${wasLocal ? "端末に保存した " : ""}${codecLabel(failed ?? "mpeg2")}: ${reason}`,
        );
      return;
    }
    if (next === null) {
      canvasProblem = reason;
      return;
    }
    note(wasLocal ? reason : `${reason}。${codecLabel(next)} に切り替えました`);
    recordingClock.switchAt = position;
    canvasCodec = next;
  }

  /** canvas のプレイヤーの刻み。`<video>` の `timeupdate` と映した 1 枚ごとの追いかけ (`follow`) の代わり */
  function canvasTick(): void {
    if (canvas === null) return;
    const now = canvas.currentTime;
    if (Math.abs(now - at) >= 0.05) at = now;
    // 自動再生で断られて音を出せていない。消音にしておき、押して出してもらう (ライブと同じ)
    if (!muted && canvas.blocked && !canvas.paused) muted = true;
    // 飛んだ先に着いた (流れ出した) か。CM を跨ぐのを待つのをやめる (画面の `arrive`)
    hooks.arrive(now, canvas.flowing, true);
    if (canvas.flowing && !hooks.covering()) askCaptions();
    // 作り直したプレイヤーが流れ出した (描き始めた)
    if (canvas.flowing) release(now);
    paint();
    hooks.frame(undefined, canvas.flowing);
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
    // 作り直している最中に後ろへ飛んだ。覆いは飛んだ先が映ったら外す
    if (holding) holdAt = Math.min(holdAt, to);
    if (canvas !== null) {
      canvas.seek(to);
      // `<video>` の `seeking` と同じく、飛んだあとは測り直す。段は持ち越す
      adapt.reset();
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
      options.stir();
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
      mse: (type) =>
        type === BROADCAST_HEVC
          ? broadcastHevc
          : (pickMediaSource()?.Source.isTypeSupported(type) ?? false),
      mpeg2: rawCapable && !rawGaveUp,
    };
  }

  onMount(() => {
    localLookup = loadOffline(rec.id).catch(() => null);
    const asked = stored(CODEC_KEY);
    // メニューに並べない H.264・H.265 (`WATCH_HIDDEN_CODECS`) を前に選んでいた端末は、自動として扱う
    choice = asked === "av1" || asked === "mpeg2" ? asked : "auto";
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
        rawCapable = rawUnsupported() === null;
      if (got?.broadcast === "hevc") {
        broadcastHevc = await broadcastHevcPlayable(
          browserHevcProbe(pickMediaSource()?.Source),
        );
      }
      /*
       * 聞けなかった (オフライン) ときは、今までどおりエンコード済みをそのまま渡す。
       * 端末に保存したものがあればそちら (下)
       */
      picked =
        got !== null
          ? pickOffer(got, ability(), choice, options.indoor())
          : rec.library_path?.endsWith(".mkv") === true ||
              localCopy?.video !== undefined
            ? { way: "file", codec: "av1", source: "encoded" }
            : null;
      /*
       * 端末のコピーはエンコード済みの主。そのまま読むときだけ使う (選んだコーデックがあれば選んだほう)。
       * 観方をサーバから受け取れなかった (オフライン) ときは、コーデックを選んでいても端末のコピーしか読めない
       */
      if (
        localCopy?.video !== undefined &&
        picked?.way === "file" &&
        (choice === "auto" || got === null)
      ) {
        localSrc = URL.createObjectURL(localCopy.video);
      }
      // 元の TS は互換モードと同じく canvas に描く (`startCanvas`)
      if (picked?.way === "raw") canvasCodec = "mpeg2";
      if (ready && picked === null) giveUp(nothingToPlay());
      localChecked = true;
    })();
    return () => {
      if (localSrc !== null) URL.revokeObjectURL(localSrc);
      remux?.destroy();
      canvas?.destroy();
      canvas = null;
    };
  });

  /** `playback` を取得できなかった理由 (`HTTP 500` など)。観られないときの幕に添える */
  let playbackMiss = "";

  /** 何で観られるか (`api/recordings/<id>/playback`)。聞けなければ null */
  async function loadPlayback(): Promise<PlaybackInfo | null> {
    try {
      const res = await fetch(recordingFeed.playbackUrl);
      if (res.ok) return (await res.json()) as PlaybackInfo;
      playbackMiss = `HTTP ${res.status}`;
      return null;
    } catch (error) {
      playbackMiss = failureText(null, error);
      return null;
    }
  }

  /** 開いたときに観られるものが無かった理由。サーバが出せるもの (`offersText`) と、取得できなかった理由 */
  function nothingToPlay(): string {
    const offers = offersText(info);
    return info === null && playbackMiss !== ""
      ? `${offers} (${playbackMiss})`
      : offers;
  }

  const src = $derived(
    localChecked && picked?.way === "file"
      ? (localSrc ?? recordingFeed.fileUrl(picked.source))
      : undefined,
  );

  /** 「続きから」を消す時計。続けて出したら前の時計は止める (先に消さない)。画面を離れたら止める */
  let continuedTimer: ReturnType<typeof setTimeout> | null = null;
  /** **途中から始めたら、そう出す。** 続きから始めたと出し、しばらくで引っ込める */
  function showContinued(): void {
    continued = true;
    if (continuedTimer !== null) clearTimeout(continuedTimer);
    continuedTimer = setTimeout(() => (continued = false), 4000);
  }

  /** その場で流すときにリクエストする音声 (`playback` の `audios` の `id`) */
  function streamAudio(index: number): string {
    // 端末に保存した録画はトラックの何本目か (`mkv-source.ts`)
    if (localMkv !== null) return String(index);
    return info?.audios[index]?.id ?? info?.audios[0]?.id ?? "0";
  }

  /** その場で流すなら、プレイヤーを作って流しはじめる。**続きの位置からリクエストする** (先頭から読んで捨てない) */
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
    const from = recordingClock.startFrom(total);
    const at = untrack(() => step);
    remux = remuxPlayer(video, source, {
      url: recordingFeed.stepUrl(at, plan),
      codecs: recordingFeed.stepType(at, plan),
      duration: total,
      start: from ?? 0,
      audio: streamAudio(audioIndex),
      state: streamState,
      heard: streamHeard,
    });
  });

  /** その場で流しているプレイヤーの様子を受ける (`remux-player.ts` の `state`) */
  function streamState(state: StreamState, reason?: string): void {
    // 段を下げようとして作り直したが、混んでいて断られた。ファイルの直再生に戻して続ける
    if (state === "busy" && step !== 0 && fileZero !== null) {
      backToFile(busyNote(true));
      return;
    }
    resuming = state === "retrying";
    busy = state === "busy";
    if (state === "failed")
      giveUp(
        failedWith(
          reason ?? `${STREAM_RETRIES} 回繋ぎ直しても繋がりませんでした`,
        ),
      );
  }

  /** 観られない。幕に出し (`broken`)、何を再生しようとして何で止まったかを添えてコンソールにも出力する */
  function giveUp(why: string): void {
    broken = true;
    brokenWhy = why;
    console.warn(`[watch] 再生できませんでした: ${why}`);
  }

  /** いま再生しようとしているもの (`pickedText`) と、止まった理由をつなぐ */
  function failedWith(reason: string): string {
    const plan = picked;
    if (plan === null) return reason;
    return `${pickedText(info, plan, localSrc !== null)}: ${reason}`;
  }

  /** その場で流しているストリームのヘッダを受ける (サーバが選んだコーデックと、送り出しの具合を読む id) */
  function streamHeard(stream: StreamHeard): void {
    stepCodec = stream.codec;
    paceId = stream.pace;
  }

  /** 形式を切り替えた断り書きを出す。`SWITCH_NOTE` で引っ込める (ライブの `note` と同じ。切り替えた先はメニューの行に残る) */
  function note(text: string): void {
    warning.show(text, SWITCH_NOTE);
  }

  /** 段の断り書きを出す。しばらくで引っ込める */
  function noteAdapt(text: string): void {
    adaptText.show(text, ADAPT_NOTE);
  }

  /**
   * 段を替えるためにプレイヤーを作り直す。いまの位置から観直し、再生していたなら続ける。
   * 作り直したばかりで再生を待っている間 (`keepPlaying` が残っている) も続ける
   */
  function swap(fresh: Picked): void {
    keepPlaying = keepPlaying || (video !== null && !video.paused);
    // 作り直したプレイヤーが映すまで、最後のコマで覆っておく (黒い一瞬を出さない)
    hold();
    replay(fresh);
  }

  /*
   * ---- 段を替えるときの受け渡し (`handoff.ts`) ----
   *
   * プレイヤーを作り直す段の切り替えは、いまのプレイヤーを映したまま、映していない側の `<video>` で次の観かたを
   * 用意してから入れ替える。用意している間はサーバの読み出しとデコードが 2 本ぶんになる
   */
  /** 用意している最中の受け渡し。やめるときに呼ぶ。用意していなければ null */
  let staged: (() => void) | null = null;
  /** 映していない側の src (ファイルの直再生へ移るとき)。その場で流すなら `remux-player.ts` が入れる */
  let spareSrc = $state<string | undefined>(undefined);

  /** 用意している最中の受け渡しをやめる。いまのプレイヤーはそのまま */
  function dropStep(): void {
    const cancel = staged;
    staged = null;
    cancel?.();
  }

  /**
   * いまのプレイヤーが詰まって進んでいないか (止めている間は詰まりではない)。届いたぶんの末尾まで観終えた
   * (`ended`) のも詰まりに数える。人が止めたのではないので、入れ替えたら続ける
   */
  function mediaStuck(): boolean {
    if (canvas !== null) return !canvas.paused && !canvas.flowing;
    if (video === null) return false;
    if (video.ended) return true;
    return (
      !video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
    );
  }

  /** 人が止めているか (末尾まで観終えて止まったのは数えない。`mediaStuck`) */
  function heldByUser(): boolean {
    return mediaPaused() && !(canvas === null && video?.ended === true);
  }

  /**
   * **段を `next` に替えて `fresh` で観る。** いまのプレイヤーを映したまま、映していない側の `<video>` (透明・消音) で
   * `fresh` を少し先の位置に用意し、いまの再生がそこまで来たら入れ替える (`handoff.ts`)。黒いコマも、止まった間も出さない。
   * `zero` は入れ替えたあとの `fileZero`。
   *
   * 用意できないとき (描く先が canvas・小窓を出している・裏に回っている) と、待つ上限 (`HANDOFF_GIVE_UP`) までに
   * 入れ替えられなかったときは `rebuild` (いまのプレイヤーを作り直す) に任せる。替えたら true。
   * 混んでいて断られた・読めなかったら、いまのプレイヤーのまま false
   */
  function prepareStep(
    fresh: Picked,
    next: Step,
    zero: Picked | null,
    rebuild: () => void,
  ): Promise<boolean> {
    dropStep();
    const spare = spareVideo();
    const plan = info;
    const source = fresh.way === "stream" ? pickMediaSource() : null;
    if (
      spare === null ||
      plan === null ||
      fresh.way === "raw" ||
      (fresh.way === "stream" && source === null) ||
      options.wiring().pip.active ||
      document.hidden
    ) {
      rebuild();
      return Promise.resolve(true);
    }
    const down = stepOrder(next) > stepOrder(step);
    const last = Math.max(0, plan.duration - 1);
    let target = Math.min(
      handoffTarget(mediaTime(), !heldByUser() && !mediaStuck()),
      last,
    );
    let made: RemuxPlayer | null = null;
    let heard: StreamHeard | null = null;
    let stuckSince: number | null = null;
    let frame = 0;
    let done = false;
    /** 待ち始めた時刻。裏に回っていた間 (刻みが止まる) はそのぶん後ろへずらし、待った長さに数えない */
    let started = Date.now();
    let ticked = started;
    const seat = (): void => {
      spare.currentTime = target;
    };
    spare.muted = true;
    spare.defaultPlaybackRate = speed;
    spare.playbackRate = speed;
    return new Promise<boolean>((settle) => {
      const finish = (moved: boolean): void => {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        spare.removeEventListener("loadedmetadata", seat);
        spare.removeEventListener("error", broke);
        if (staged === drop) staged = null;
        settle(moved);
      };
      // 用意していたものを捨てる
      const clear = (): void => {
        made?.destroy();
        made = null;
        spareSrc = undefined;
        emptyVideo(spare, { mute: true });
      };
      const drop = (): void => {
        if (done) return;
        clear();
        finish(false);
      };
      // 混んでいて断られた・読めなかった。いまのプレイヤーのまま、しばらく段を動かさない
      const refuse = (crowded: boolean): void => {
        if (done) return;
        drop();
        adaptQuietUntil = Date.now() + HOLD;
        if (crowded) noteAdapt(busyNote(down));
      };
      const broke = (): void => refuse(false);
      staged = drop;
      spare.addEventListener("error", broke);
      if (fresh.way === "stream" && source !== null) {
        made = remuxPlayer(spare, source, {
          url: recordingFeed.stepUrl(next, fresh),
          codecs: recordingFeed.stepType(next, fresh),
          duration: plan.duration,
          start: target,
          audio: streamAudio(audioIndex),
          // 入れ替えたあとは、いつものプレイヤーと同じに受ける
          state: (state, reason) => {
            if (done) streamState(state, reason);
            else if (state === "busy") refuse(true);
            else if (state === "failed") refuse(false);
          },
          heard: (stream) => {
            if (done) streamHeard(stream);
            else heard = stream;
          },
        });
      } else if (fresh.way === "file") {
        spare.addEventListener("loadedmetadata", seat);
        spareSrc = recordingFeed.fileUrl(fresh.source);
      }
      const tick = (): void => {
        if (done) return;
        frame = requestAnimationFrame(tick);
        const now = Date.now();
        // 裏に回っていた (`requestAnimationFrame` が止まる)。いまのプレイヤーは鳴り続けているので、待ちは戻ってから数え直す
        if (now - ticked > 1_000) started += now - ticked;
        ticked = now;
        // 間に合わなかった。いまのプレイヤーを作り直す (これまでの切り替え)
        if (now - started > HANDOFF_GIVE_UP) {
          clear();
          finish(true);
          rebuild();
          return;
        }
        if (!mediaStuck()) stuckSince = null;
        else stuckSince ??= Date.now();
        const verdict = handoff({
          ready:
            spare.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            !spare.seeking,
          spareAt: spare.currentTime,
          target,
          at: mediaTime(),
          paused: heldByUser(),
          stuckFor:
            stuckSince === null ? 0 : Math.max(1, Date.now() - stuckSince),
        });
        if (verdict.kind === "retarget") {
          target = Math.min(verdict.to, last);
          spare.currentTime = target;
          return;
        }
        if (verdict.kind === "wait") return;
        const player = made;
        made = null;
        finish(true);
        handOver(spare, fresh, next, zero, player, heard, verdict.play);
      };
      frame = requestAnimationFrame(tick);
    });
  }

  /**
   * **用意できた側に入れ替える** (`prepareStep`)。同じコマの間に、映す側と音を出す側を替え、いままでのプレイヤーを閉じる。
   * 位置は用意した側のまま (いまの再生と同じ所)。いままでの `<video>` を空にして出るイベントは、映していない側のものなので受けない
   */
  function handOver(
    spare: HTMLVideoElement,
    fresh: Picked,
    next: Step,
    zero: Picked | null,
    player: RemuxPlayer | null,
    heard: StreamHeard | null,
    play: boolean,
  ): void {
    const old = video;
    if (canvas !== null || canvasCodec !== null) stopCanvas();
    remux?.destroy();
    remux = player;
    busy = false;
    broken = false;
    brokenWhy = "";
    retryAt = 0;
    recordingClock.switchAt = null;
    keepPlaying = false;
    fileZero = zero;
    step = next;
    stepCodec = heard?.codec ?? null;
    paceId = heard?.pace ?? null;
    // 映す側を替える。新しい側の src は用意したときと同じ値なので、読み直さない
    front = 1 - front;
    picked = fresh;
    spareSrc = undefined;
    spare.muted = muted;
    length = Number.isFinite(spare.duration) ? spare.duration : length;
    at = spare.currentTime;
    if (play) void spare.play().catch(() => undefined);
    else playing = false;
    unslip.seeked();
    follow(spare);
    if (old !== null) emptyVideo(old, { mute: true });
    syncAudio();
    place();
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

  /** 段 0 で観るファイルの `?source=`。MPEG-2 は元の TS、その場で流すもの (段 0 が変換) は null */
  function zeroSource(plan: Picked): string | null {
    if (plan.way === "file") return plan.source;
    return plan.way === "raw" ? "ts" : null;
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

  /**
   * 段を `next` に替える。替えたら true。
   *
   * プレイヤーを作り直す切り替え (ファイルの直再生・MPEG-2 から下げる、段 0 へ戻す、音声だけとの行き来) は、
   * いまのプレイヤーを映したまま裏で用意して入れ替える (`prepareStep`)。段 1〜3 の間は同じ MSE のまま替える (`switchTo`)
   */
  async function moveStep(next: Step): Promise<boolean> {
    if (compat) return compatStep(next);
    const plan = picked;
    if (info === null || plan === null) return false;
    switching = true;
    try {
      return await shiftStep(info, plan, next);
    } finally {
      switching = false;
    }
  }

  /** `moveStep` の中身 (互換モードでないとき) */
  async function shiftStep(
    plan: PlaybackInfo,
    now: Picked,
    next: Step,
  ): Promise<boolean> {
    // MPEG-2 (canvas に描いている) から下げる。ファイルの直再生と同じく、1 回だけ `<video>` の変換に移る
    if (now.way === "raw") {
      if (next === 0) return false;
      const fresh = streamForAudio(plan, ability(), "h264");
      if (fresh === null) return false;
      return prepareStep(fresh, next, now, () => {
        fileZero = now;
        step = next;
        keepPlaying = canvas !== null && !canvas.paused;
        swap(fresh);
      });
    }
    // ファイルの直再生から下げる。1 回だけ変換へ移る (同じコーデックの詰め替えを先に)
    if (now.way === "file") {
      if (next === 0) return false;
      const fresh = streamForAudio(plan, ability(), now.codec);
      if (fresh === null) return false;
      if (recordingFeed.baseOf(now.source) === null)
        void recordingFeed.readBaseKbps(now.source, plan.duration);
      return prepareStep(fresh, next, now, () => {
        fileZero = now;
        step = next;
        swap(fresh);
      });
    }
    /*
     * 段 0 へ戻す。ファイルの直再生・MPEG-2 から下げていたなら、そこへ戻す。
     * 同じ MSE のまま段 0 の詰め替えへ替えると、詰め替えは要求した位置の手前のキーフレームから始まるので、
     * 溜めてあった下げた段のコマを途中から上書きし、デコーダも再生の途中で替わる。新しいプレイヤーで始め直せば、どちらも起きない
     */
    if (next === 0) {
      const back = fileZero;
      const fresh = back ?? { ...now };
      const moved = await prepareStep(fresh, 0, null, () => {
        if (back !== null) {
          backToFile(null);
          return;
        }
        step = 0;
        swap(fresh);
      });
      if (moved) adaptQuietUntil = Date.now() + HOLD;
      return moved;
    }
    // 音声だけとの行き来は作り直す (MSE は SourceBuffer に入れたトラックの数を替えられない)
    if (next === "audio" || step === "audio" || remux === null) {
      // 同じ中身でも新しいオブジェクトにする (同じものを入れ直しても、プレイヤーを作り直す `$effect` が動かない)
      const fresh = { ...now };
      return prepareStep(fresh, next, fileZero, () => {
        step = next;
        swap(fresh);
      });
    }
    const result = await remux.switchTo(
      recordingFeed.stepType(next, now),
      recordingFeed.stepUrl(next, now),
    );
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
   * 互換モードで段を替える。canvas のプレイヤーは裏で用意しない (デコーダを 2 つ並べると、非力な端末では
   * どちらも間に合わない。`raw/budget.ts`) ので作り直し、作り直したプレイヤーが描き始めるまで最後のコマで覆う
   */
  async function compatStep(next: Step): Promise<boolean> {
    const player = canvas;
    if (player === null) return false;
    const frame = await player.grab();
    if (canvas !== player) {
      frame?.close();
      return false;
    }
    hold(frame);
    frame?.close();
    const moved = canvasStep(next);
    if (!moved) unhold();
    return moved;
  }

  /**
   * いまの様子 (`watch-adapt.ts` の `sample`)。段を動かさない間は null。
   * 端末に保存したもの・止めている間・断られて止まっている間。canvas に描いているときは `canvasSample`。
   * 映像の無い録画 (`info.video` が false) は音声だけなので動かさない
   */
  function adaptSample() {
    if (info?.video === false) return null;
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
      /*
       * ファイルの直再生は受け取りの速さを測れない。ブラウザが先を読み終えて読むのを止めていれば、回線は足りている
       * (ファイルの終わり際や、飛んだ先をデコードしている間の詰まりを回線のせいにしない)。
       * いまの位置をまだ読んでいない間と、飛んでいる最中は数えない (`fileIdle`)
       */
      idle:
        plan.way === "file" &&
        fileIdle(
          {
            networkState: target.networkState,
            seeking: target.seeking,
            buffered: rangesOf(target.buffered),
            currentTime: target.currentTime,
          },
          suspendAt,
          Date.now(),
        ),
      // 段 0 が変換 (エンコード済みが無い録画) なら分からない
      baseKbps: recordingFeed.baseOf(zeroSource(fileZero ?? plan)),
      codec: stepCodec ?? plan.codec,
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
      switching ||
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
      // 段 0 が MPEG-2 なら元の TS のビットレート (`startCanvas` で読む)。互換モードの変換は分からない
      baseKbps: canvasCodec === "mpeg2" ? recordingFeed.baseOf("ts") : null,
      codec: stepCodec ?? canvasCodec,
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
      adaptText.close();
      warning.close();
    };
  });

  /**
   * **コーデックを選び直す** (コーデックのメニュー)。選んだものは端末ごとに覚える。
   * 観られる方式が変わるなら、いまの位置から観直す (プレイヤーを作り直す)
   */
  function chooseCodec(next: CodecChoice | "mpeg2"): void {
    choice = next;
    remind(CODEC_KEY, next);
    options.stir();
    if (info === null) return;
    if (compat) {
      chooseCanvas(next);
      return;
    }
    // 選んだものは打ち切っていても試す (互換モードの `chooseCanvas` と同じ)
    if (next === "mpeg2") rawGaveUp = false;
    const fresh = pickOffer(info, ability(), next, options.indoor());
    if (JSON.stringify(fresh) === JSON.stringify(picked) && !busy && step === 0)
      return;
    warning.clear();
    // 選び直したら段 0 から (下げた段は「自動」が回線を見て決め直す)
    step = 0;
    stepCodec = null;
    fileZero = null;
    replay(fresh);
  }

  /**
   * 観るものを `fresh` に替えて、いまの位置 (`position`。省けばいま再生している位置) から観直す。
   * 元の TS (`raw`) は canvas に描き、それ以外は `<video>` で観る。描いていた canvas は破棄する
   */
  function replay(fresh: Picked | null, position = mediaTime()): void {
    // 段を替えるために裏で用意していたものは捨てる (選び直したほうを観る)
    dropStep();
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
    brokenWhy = "";
    // ファイルなら尺が分かったところで戻す (`resume`)。その場で流すならプレイヤーの開始位置
    retryAt = position;
    recordingClock.switchAt = position;
    picked = fresh;
    if (fresh?.way !== "raw") return;
    // `<video>` で観ていたものは止める
    stopVideo();
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
    warning.clear();
    if (fresh === null) {
      canvasProblem = "再生できる形式がありません";
      return;
    }
    canvasGaveUp = canvasGaveUp.filter((codec) => codec !== fresh);
    // 選び直したら段 0 から (`chooseCodec` と同じ)
    step = 0;
    stepCodec = null;
    stepFrom = null;
    recordingClock.switchAt = position;
    canvasCodec = fresh;
  }

  /**
   * メニューに並べるもの。この端末で観られる方式があるコーデックが 2 つ以上あるときだけ出す。
   * 互換モードは流せるもの (H.264・AV1・MPEG-2) を並べて描けない形式は押せなくし (ライブと同じ)、
   * 端末に保存したものを描いている間は出さない。H.264・H.265 (`WATCH_HIDDEN_CODECS`) は並べない (自動では選ぶ)
   */
  const codecMenu = $derived.by(
    (): { key: string; label: string; disabled?: boolean }[] => {
      if (info === null || !localChecked) return [];
      if (compat && (canvasAbility === null || drawingLocal)) return [];
      const items =
        compat && canvasAbility !== null
          ? canvasChoices(info, canvasAbility)
              .filter(
                (item) =>
                  !WATCH_HIDDEN_CODECS.some((codec) => codec === item.codec),
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
          : codecChoices(info, ability(), WATCH_HIDDEN_CODECS).map((codec) => ({
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

  /**
   * `<video>` は 2 つ置く。段を替えるときは、映していない側 (透明・消音) で次の観かたを用意してから入れ替える
   * (`prepareStep`)。`video` はいま映している側で、もう 1 つは用意している間だけ読み込む
   */
  let videos = $state<(HTMLVideoElement | null)[]>([null, null]);
  /** いま映している側 (`videos` の何番目か) */
  let front = $state(0);
  const video = $derived(videos[front] ?? null);
  /** 映していない側の `<video>` */
  function spareVideo(): HTMLVideoElement | null {
    return videos[1 - front] ?? null;
  }

  /*
   * --- 録画のデータ放送 ---
   *
   * エンコードするときに取り出しておいた変化ログを、再生位置に合わせて流し直す (`ts/data-timeline`、
   * `server/recorded-bml.ts`)。描くのはライブと同じ `DataBroadcast`
   */
  /**
   * データ放送の受け口 (`player/data.svelte.ts`。ライブと同じ)。d ボタンで出しているかと、自動で受信するか
   * (⚙ の「データ放送」を長押しして切り替える。ライブと同じ 1 つを端末ごとに覚える) と、変化ログを持つ。
   * 録画の入口に自動起動の指定があれば (`data.autoStart`)、開く前から変化ログを取得して流し、入口の文書を裏で動かす
   * (`DataBroadcast` の `receive`)
   */
  const broadcastData = new DataLayer();
  /** 自動で受信していて、この録画にデータ放送があり、入口に自動起動の指定があるか */
  const receiving = $derived(
    broadcastData.receive && options.hasData() && options.autoStart(),
  );
  /** データ放送を作り直す合図 (`DataBroadcast` の channel)。戻ったら変えて、その時点まで積み直す */
  let dataChannel = $state<string | null>(null);

  function nowMs(): number {
    return Math.round(mediaTime() * 1000);
  }

  /** データ放送を出す/消す。d ボタンの振る舞いは `pressD` (DataBroadcast) */
  async function setData(on: boolean): Promise<void> {
    broadcastData.show = on;
    // 自動で受信しているなら、閉じてもエンジンは残す (入口から出直すのは `DataBroadcast`)
    if (on || receiving) await startData();
    else dataChannel = null;
  }

  /**
   * 自動で受信するかを切り替える (⚙ の「データ放送」を長押し・Shift+D)。ライブと同じ 1 つを端末ごとに覚える (`data-receive.ts`)。
   * 切り替えた通知は画面が出す
   */
  function toggleReceiveData(): void {
    broadcastData.toggleReceive();
    if (receiving) void startData();
    else if (!broadcastData.show) dataChannel = null;
  }

  // 開いた端末で決まる。自動で受信する端末は、入口に自動起動の指定がある録画なら開く前から流し始める
  $effect(() => {
    broadcastData.restore();
    untrack(() => {
      if (receiving) void startData();
    });
  });

  /**
   * 変化ログを取得して、エンジンを作らせる。**もう流していれば何もしない**。自動で受信しているところで開いたときは、
   * 作り直さずに開く操作だけを届ける (`DataBroadcast` の `opened`)
   */
  async function startData(): Promise<void> {
    if (dataChannel !== null) return;
    // 取得は 1 回だけ。開いた直後 (自動で受信) と押したのが重なっても二重に取らない
    dataLoading ??= loadTimeline();
    await dataLoading;
    // 取得している間に、閉じて自動で受信もやめていたら作らない
    if (!broadcastData.show && !receiving) return;
    broadcastData.rewind();
    // エンジンを作らせる。open のあと listenData が呼ばれて、いまの位置まで積み直す
    dataChannel = `${rec.id}`;
  }

  /** 変化ログを取得している最中の Promise (`startData`) */
  let dataLoading: Promise<void> | null = null;

  /**
   * 変化ログを取得する。**端末に保存したものを探し終えてから**。自動で受信する端末は開いた直後に呼ぶので、
   * 探し終える前に見るとオフラインでもサーバから取得しようとして空になる。取れなければ空 (次に押したら取り直す)
   */
  async function loadTimeline(): Promise<void> {
    const copy = await localLookup;
    if (Array.isArray(copy?.databroadcast)) {
      // 端末に保存したものから。オフラインでも d が効く
      broadcastData.timeline = copy.databroadcast as PlacedMessage[];
    } else {
      const response = await fetch(recordingFeed.timelineUrl).catch(() => null);
      broadcastData.timeline = response?.ok ? await response.json() : [];
    }
    if (broadcastData.timeline.length === 0) dataLoading = null;
  }

  /**
   * `DataBroadcast` がエンジンへの入口を渡してくる (作り直すたびに新しいものを)。
   * **預かった直後に、いまの再生位置まで積んで追いつく** (`replayAt`)
   */
  function listenData(emit: ((message: ResponseMessage) => void) | null): void {
    broadcastData.listenAt(emit, nowMs());
  }

  /**
   * 再生が進んだぶんのデータ放送を流す。**戻っていたらエンジンを作り直す** (開いているかは持ち越し、入口から出直す)。
   * 先へ飛んだ (シーク・CM 飛ばし) ときは、その間の変化を足す
   */
  function feedData(): void {
    const to = nowMs();
    // 戻っていた。channel を変えると close→open して listenData が積み直す
    if (!broadcastData.follow(to)) dataChannel = `${rec.id}:${to}`;
  }

  let playing = $state(false);
  let at = $state(0);
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
  /**
   * 字幕の受け口 (`player/captions.svelte.ts`。ライブと同じ)。出しているか (既定は出す。端末ごとに覚える)・載っている言語・
   * 出している言語・描く先を持つ
   */
  const captions = new CaptionLayer();
  /**
   * 受け取った字幕 (全部の言語。`captions.json`)。持っていなければ null。持っているかは取ってみるまで
   * 分からない (無ければ 404)。持っているときだけボタンを出す (ライブと同じ)
   */
  let captionText = $state.raw<CaptionPages | null>(null);
  /**
   * 載っている言語。第 1 言語は `pages`、第 2 言語から後ろは `others`。
   * 名前が分からない第 1 言語 (古いサーバ・端末に保存した古いコピー) は「字幕 1」
   */
  function languagesOf(text: CaptionPages): CaptionLanguage[] {
    return [
      text.language ?? languageOf(1, ""),
      ...(text.others ?? []).filter((o) => o.pages.length > 0),
    ];
  }
  /** 言語 `index` の文字の配置。時刻の順 */
  function cuesOf(text: CaptionPages | null, index: number): Cue[] {
    if (text === null) return [];
    if (index === 1) return text.pages;
    return text.others?.find((o) => o.index === index)?.pages ?? text.pages;
  }
  const hasCaptions = $derived(
    captionText !== null &&
      (captionText.pages.length > 0 ||
        (captionText.others ?? []).some((o) => o.pages.length > 0)),
  );
  // 文字の配置を描くもの (`overlay` ができたら作る)
  $effect(() => {
    if (overlay === null) return;
    captions.attach(overlay);
    return () => captions.close();
  });
  /** 字幕を重ねる先 */
  let overlay = $state<HTMLCanvasElement | null>(null);
  /** 実況の層の置き場。canvas で描くときの映像はこの手前に差し込む (映像 → 実況 → 字幕) */
  let jikkyoSlot = $state<HTMLElement | null>(null);

  /**
   * 実況のコメント (docs/watch.md の「実況のコメント」)。世帯の設定と端末の ⚙ の両方がオンなら、

  /** 字幕を貼り直す処理を回している映像。二重に回さないための目印 (`follow`) */
  let following: HTMLVideoElement | null = null;
  /** 映像だけ遅れたら飛び直す (`unslip.ts`)。段を替えてデコーダが作り直されると、Android の Chrome で映像だけ取り残される */
  const unslip = unslipper();
  /** 読めなかったとき。何も出さずに黒いままにしない */
  let broken = $state(false);
  /**
   * 観られなかったわけの詳しいところ (`giveUp`)。何を再生しようとして (コーデック・出し方・codecs)、何で止まったか
   * (`MediaError` の定数名など)。幕の文言の下に小さく出す。報告の画面写真だけで、どの形式で止まったかを読み分けるため
   */
  let brokenWhy = $state("");
  /** ファイルをそのまま読めなかった (`recover`)。このあとはストリームから選ぶ (`pickStream`) */
  let fileFailed = false;
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
  /**
   * ファイルを直に再生しているときの繋ぎ直し (`recover`。ライブと同じ `StreamRetry`)。`STREAM_RETRIES` 回で打ち切る。
   * 録画は読めない形式・壊れたファイルでも同じ所で切れるので、読み直し続けずに観られる先を案内する。
   * その場で流しているもの (`remux-player.ts`)・canvas に描いているもの (`canvas-player.ts`) は、それぞれが同じ数で繋ぎ直す
   */
  const fileRetry = new StreamRetry((next) => {
    resuming = next === "retrying";
  });
  /** 繋ぎ直したあとに戻る位置 (秒)。0 は「戻る先は無い」 */
  let retryAt = 0;

  /**
   * 配線 (`wiring.svelte.ts`) に渡す包み。canvas のプレイヤー (互換モード・MPEG-2) と `<video>` を、ライブと同じ形にそろえる。
   * `paused` で `playing` を読むのは、操作バーで止めた・再開したときに小窓とアンビエントモードを合わせ直させるため
   * (canvas のプレイヤーと `<video>` の `paused` は `$state` ではない)
   */
  const target: PlaybackTarget = {
    // 観られない幕 (`problem`) を出したら、画面を暗くさせない処理を外す (ライブ・追っかけの `error` と同じ)
    get state() {
      return problem === "" ? "playing" : "error";
    },
    get canvas() {
      return drawing;
    },
    get paused() {
      void playing;
      return mediaPaused();
    },
    get captions() {
      return captions.on;
    },
    get hasCaptions() {
      return hasCaptions;
    },
    toggle: togglePlay,
    grab: (size) => canvas?.grab(size) ?? Promise.resolve(null),
    capture: () => canvas?.pipStream() ?? null,
    captureFlow: (on) => canvas?.pipFlow(on),
    set volume(level: number | null) {
      if (drawing) canvas?.volume(level);
    },
    set playback(on: boolean) {
      if (drawing) canvas?.background(on);
    },
  };

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
   * 段を替えるためにプレイヤーを作り直している間、最後のコマで覆っているか (`hold`)。CM の跨ぎ (`hopping`) とは別で、
   * 覆っている間は CM を飛ばない。作り直した直後のプレイヤーは位置 0 などを返すことがあり、そこが CM だと
   * 観ていない CM を飛んで「CM を飛ばしました」と出ていた
   */
  let holding = $state(false);
  /** 作り直したプレイヤーがこの位置 (秒) のコマを出したら、覆いを外す */
  let holdAt = 0;
  let holdGiveUp: ReturnType<typeof setTimeout> | null = null;
  /** 作り直す間、覆っておく上限 (ms)。変換の立ち上がりを待つので、CM の跨ぎより長い */
  const HOLD_GIVE_UP = 10_000;
  /** 作り直したプレイヤーが覆いを外す位置に着いたとみなす幅 (秒)。始まりはキーフレームに寄ることがある */
  const HOLD_SLACK = 0.5;

  /** 続きから出したか。画面にも言う */
  let continued = $state(false);

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
    const opening = recordingClock.opening(video.duration);
    if (opening !== null && !opening.continued) video.currentTime = opening.at;
    else if (opening !== null) {
      /*
       * その場で流すときは、remux-player が続きの位置からリクエストし、溜まってから入れる (`remux-player.ts` の `startAt`)。
       * ここで入れ直すと、まだ先頭 (init segment) しか無いうちに飛ぶことになり、macOS の WebKit は seeking のまま止まる
       */
      if (remux === null) video.currentTime = opening.at;
      showContinued();
    }
    hooks.settle();
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
   * 配信が切れたら (サーバの入れ替えなど) 同じ所から読み直し、切れた瞬間の位置へ戻す。
   * 繋ぎ直すのは接続が切れたときだけ。読めない形式・壊れたファイルは何度やっても同じなので `broken`。
   *
   * **ファイルをそのまま読めなかったら、1 度だけほかの出し方に移る** (`fallBackFromFile`)。`canPlayType` が読めると
   * 答えても、`<video>` が入れ物を読めないことがある (iPhone の Safari は Matroska を WebM としてしか読まない)
   */
  function recover(): void {
    if (video === null) return;
    // 映像は出せていない。字幕のボタンは出せるように取る
    askCaptions();
    const code = video.error?.code ?? 0;
    // その場で流しているなら、開いた直後か飛んだ・切り替えたあとかと、何秒の位置かを添える
    const why = failedWith(
      [failureText(video.error), remux?.origin() ?? ""]
        .filter((part) => part !== "")
        .join("。"),
    );
    if (
      remux === null &&
      picked?.way === "file" &&
      code !== MediaError.MEDIA_ERR_NETWORK &&
      !fileFailed
    ) {
      fileFailed = true;
      resuming = false;
      fallBackFromFile(why);
      return;
    }
    // その場で流しているときの切れ目は `remux-player.ts` が繋ぎ直す。ここに来るのは読めない中身
    if (
      remux !== null ||
      code !== MediaError.MEDIA_ERR_NETWORK ||
      fileRetry.spent
    ) {
      giveUp(why);
      resuming = false;
      return;
    }
    retryAt = video.currentTime;
    fileRetry.cancel();
    fileRetry.schedule(() => {
      // 同じ src を読み直す。位置を戻すのは尺が分かってから (`resume`)
      video?.load();
    });
  }

  /**
   * **ファイルをそのまま読めなかった。** サーバに繋がっていれば、MSE が受け取れるストリーム (詰め替えを先に) か元の TS へ移る
   * (`pickStream`)。繋がっていない (オフライン) か移る先が無く、端末に保存したものを読んでいたなら、その Matroska を canvas に
   * 描く (互換モードと同じ。`mkv-source.ts`)。どれも無理なら観られないと出す
   */
  function fallBackFromFile(why: string): void {
    console.warn(`[watch] ファイルのままでは再生できませんでした: ${why}`);
    const position = video?.currentTime ?? 0;
    const fresh =
      info === null ? null : pickStream(info, ability(), options.indoor());
    if (fresh !== null) {
      note(
        `ファイルのままでは再生できないため、${codecLabel(fresh.codec)} に切り替えました`,
      );
      stopVideo();
      replay(fresh, position);
      return;
    }
    if (localSrc !== null) {
      void drawLocal(why, position);
      return;
    }
    giveUp(`${why}。${nothingToPlay()}`);
  }

  /** いまの `<video>` を止めて空にする */
  function stopVideo(): void {
    if (video !== null) emptyVideo(video);
  }

  /** 端末に保存した Matroska を canvas に描く (`<video>` が読めなかったとき。`fallBackFromFile`)。描けなければ観られないと出す */
  async function drawLocal(why: string, position: number): Promise<void> {
    const blob = localCopy?.video;
    if (blob === undefined) {
      giveUp(why);
      return;
    }
    const [support, source] = await Promise.all([
      canvasSupport(),
      openMkv(blob).catch(() => null),
    ]);
    const can: CanvasAbility = { ...support, mpeg2: false };
    if (source?.codec == null || !can[source.codec]) {
      giveUp(
        source?.codec == null
          ? `${why}。保存したファイルを読めませんでした`
          : `${why}。${codecLabel(source.codec)} を canvas に描けません`,
      );
      return;
    }
    stopVideo();
    if (localSrc !== null) URL.revokeObjectURL(localSrc);
    localSrc = null;
    // `<video>` には渡さない (`src` を外す)。canvas のプレイヤーは `canvasCodec` が決まったら作る
    picked = null;
    localMkv = source;
    if (position > 0) recordingClock.switchAt = position;
    canvasCodec = source.codec;
  }

  /** 早送りの速さを変える。音は残す (ブラウザは倍速でも音程を保つ)。canvas に描いているときは等速だけ */
  function setSpeed(value: number, remember = true): void {
    if (drawing) return;
    speed = value;
    if (remember) remind(SPEED_KEY, String(value));
    options.stir();
  }

  /**
   * **作り直す前に、いま映っているコマで覆う** (段を替えるときの作り直し。`swap`・`compatStep`)。作り直したプレイヤーが
   * 元の位置のコマを出すまで覆い (`release`)、その間は CM を飛ばない。canvas のコマは `frame` で受け取る (`grab`)。
   * 写せないときは覆わない (これまでどおり)
   */
  function hold(frame: ImageBitmap | null = null): void {
    const source =
      frame ??
      (!drawing && video !== null && video.videoWidth > 0 ? video : null);
    const ctx = cover?.getContext("2d") ?? null;
    if (source === null || cover === null || ctx === null) return;
    const width = frame?.width ?? video?.videoWidth ?? 16;
    const height = frame?.height ?? video?.videoHeight ?? 9;
    cover.width = width;
    cover.height = height;
    try {
      ctx.drawImage(source, 0, 0, width, height);
    } catch {
      return;
    }
    blanked = false;
    holding = true;
    holdAt = mediaTime();
    clearCaptions();
    place();
    if (holdGiveUp !== null) clearTimeout(holdGiveUp);
    holdGiveUp = setTimeout(unhold, HOLD_GIVE_UP);
  }

  /** 作り直したプレイヤーが `at` 秒のコマを出した。元の位置に着いていれば覆いを外す */
  function release(at: number): void {
    if (holding && at >= holdAt - HOLD_SLACK) unhold();
  }

  /** 作り直す間の覆いを外す */
  function unhold(): void {
    holding = false;
    if (holdGiveUp !== null) {
      clearTimeout(holdGiveUp);
      holdGiveUp = null;
    }
  }

  function togglePlay(): void {
    if (mediaPaused()) playMedia();
    else pauseMedia();
  }

  function toggleCaptions(): void {
    setCaptions(!captions.on);
    options.stir();
  }

  /** 字幕を出す・消す。端末ごとに覚える (`caption-pref.ts`) */
  function setCaptions(on: boolean): void {
    captions.setOn(on);
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
    captions.remember(index);
    captions.language = index;
    captions.load(cuesOf(captionText, index));
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
          : await fetch(recordingFeed.captionsUrl).then((res) =>
              res.ok ? (res.json() as Promise<CaptionPages>) : undefined,
            );
      if (text?.v === CAPTION_TEXT_VERSION) {
        captionText = text;
        // 覚えている言語が載っていればそれ、無ければ第 1 言語
        captions.languages = languagesOf(text);
        captions.language = captions.preferred(captions.languages);
        captions.load(cuesOf(text, captions.language));
        paint();
      }
    } catch (error) {
      // 出せないだけ。観るのに支障は無い
      console.warn("[captions] 取得できませんでした", error);
      // 繋がらなかった。字幕を入れ直したときに取り直す (`setCaptions`。コマごとには取り直さない)
      captionsFailed = true;
    }
  }

  /** 詰まった。「読み込み中」は幕が少し待ってから出す (`PlayerVeil`) */
  function stall(): void {
    // CM を跨いでいる間は覆いがある。そちらに任せる
    if (hooks.covering() || buffering) return;
    buffering = true;
  }

  /** 動き出した。「読み込み中」を引っ込める */
  function flowing(): void {
    buffering = false;
  }

  function clearCaptions(): void {
    captions.hide();
  }

  /**
   * 字幕の貼り直しと CM の跨ぎを、映した 1 枚ごとに追わせる ([frames.ts](../components/player/frames.ts)。
   * ライブと同じ作り)。`timeupdate` (250ms ごと) 任せだった頃は字幕が遅れ、CM も数コマ見えていた
   */
  function follow(target: HTMLVideoElement): void {
    if (following === target) return;
    following = target;
    eachFrame(target, (meta) => {
      // 別の映像に移った (画面を閉じた) ら、こちらは閉じる
      if (following !== target) return false;
      /*
       * 映したコマの時刻 (`mediaTime`) で外す。`currentTime` は代入した時点で飛んだ先を返すのに、
       * 画面にはまだ手前のコマが出ていて、CM の最後の 1 コマが見えていた
       */
      hooks.arrive(
        meta?.mediaTime ?? target.currentTime,
        !target.seeking,
        false,
      );
      // 作り直したプレイヤーが元の位置のコマを出した
      if (
        holding &&
        !target.seeking &&
        target.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      )
        release(meta?.mediaTime ?? target.currentTime);
      // 映像だけ遅れていたら飛び直す。CM の先へ飛んでいる最中と、canvas に描いている間 (`<video>` は空) は見ない
      if (
        meta !== undefined &&
        !hooks.waiting() &&
        !hooks.covering() &&
        !drawing
      )
        unslip.check(target, meta.mediaTime);
      // 最初のコマが出た (開いた直後に CM の先へ飛ぶなら、飛んだ先が出てから)
      if (
        !hooks.covering() &&
        target.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      )
        askCaptions();
      paint();
      hooks.frame(meta?.mediaTime, !target.paused && !target.seeking);
      return true;
    });
  }

  /** 字幕と CM の覆いを映像が出ているところにぴったり重ねる (`fitRect`) */
  function place(): void {
    if (video === null) return;
    // canvas に描いているときは `<video>` は空なので、放送の 16:9 とみなす
    // 作り直している最中は `<video>` の大きさが 0 に戻る。覆いに写したコマの大きさで合わせる
    const [width, height] = drawing
      ? [16, 9]
      : holding && cover !== null && video.videoWidth === 0
        ? [cover.width, cover.height]
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

  // 映像の箱の伸び縮み (二段組の切り替わり・データ放送の小窓) で測り直す。全画面の出入りは画面が `place` を呼ぶ
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
    if (hooks.covering() || !captions.on || overlay === null) return;
    captions.paint(mediaTime(), place);
  }

  /** 秒で動かす。**端は超えさせない** (超えると勝手に終わる) */
  function seekBy(by: number): void {
    if (video === null && canvas === null) return;
    seekMedia(
      Math.min(Math.max(mediaTime() + by, 0), length || video?.duration || 0),
    );
    options.stir();
  }

  function seekTo(seconds: number | null): void {
    if ((video === null && canvas === null) || seconds === null) return;
    seekMedia(seconds);
    options.stir();
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
    return new Promise((arrived) => {
      const done = () => {
        clearTimeout(timer);
        target.removeEventListener("seeked", done);
        arrived();
      };
      // 着かないまま (読めない・遅い) でも次へ進めるように
      const timer = setTimeout(done, 1000);
      target.addEventListener("seeked", done);
      if (typeof target.fastSeek === "function") target.fastSeek(to);
      else target.currentTime = to;
    });
  }

  /**
   * 開いたら、そのまま観はじめる。一覧の行を押したことで得た許可 (user activation) がまだ効いているので
   * `play()` が通る。読み込み直したときだけ通らないので、失敗しても無視する
   */
  onMount(() => {
    setSpeed(storedSpeed(), false);
    // 字幕は消していても取ってくる (持っているかどうかで ⚙ の字幕の行と字幕ボタンを出す)。観はじめてから (`askCaptions`)
    captions.restore();
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
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      // 字幕を貼り直す処理を止める。外さないと画面を離れたあとも回り続ける
      following = null;
      if (continuedTimer !== null) clearTimeout(continuedTimer);
      if (holdGiveUp !== null) clearTimeout(holdGiveUp);
      dropStep();
      fileRetry.cancel();
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

  /** `event` が映している側の `<video>` から来たか。用意している側 (透明・消音) のものは受けない (空にした側の位置 0 で CM を飛んだりしない) */
  function fromFront(event: Event): HTMLVideoElement | null {
    const target = event.currentTarget as HTMLVideoElement;
    return target === video ? target : null;
  }

  /** `<video>` のイベント。2 つとも同じものを渡し、映している側のものだけ受ける (`fromFront`) */
  const events = {
    play(event: Event): void {
      const target = fromFront(event);
      if (target === null) return;
      playing = true;
      follow(target);
      // 出たので、繋ぎ直しは済み。次に切れたらまた 1 秒から待つ
      fileRetry.flowing();
      resuming = false;
      options.stir();
    },
    pause(event: Event): void {
      if (fromFront(event) === null) return;
      playing = false;
      // 止めたのは詰まりではない。「読み込み中」は引っ込める
      flowing();
    },
    ended(event: Event): void {
      if (fromFront(event) !== null) hooks.ended();
    },
    waiting(event: Event): void {
      if (fromFront(event) !== null) stall();
    },
    seeking(event: Event): void {
      if (fromFront(event) === null) return;
      stall();
      // シーク・CM スキップのあとは測り直す。段は持ち越す
      adapt.reset();
      // 飛んだ先はまだ読んでいない
      suspendAt = Number.NEGATIVE_INFINITY;
      // 飛んだ直後の 1 コマは飛ぶ前の時刻を持っていることがあるので、映像の遅れに数えない (`unslipper`)
      unslip.seeked();
    },
    flowing(event: Event): void {
      if (fromFront(event) !== null) flowing();
    },
    timeupdate(event: Event): void {
      const target = fromFront(event);
      if (target === null) return;
      // 作り直している最中の位置 (0 に戻る) は時計に出さない (`hold`)
      if (!holding) at = target.currentTime;
      hooks.frame(undefined, null);
      paint();
      feedData();
    },
    seeked(event: Event): void {
      if (fromFront(event) === null) return;
      feedData();
      // 飛んだ先に着いてからも 3 秒は数えない。飛んだ先を出すまでのデコードが長い (AV1) と、着いた直後にまだ詰まる
      adapt.reset();
    },
    suspend(event: Event): void {
      if (fromFront(event) !== null) suspendAt = Date.now();
    },
    loadedmetadata(event: Event): void {
      if (fromFront(event) === null) return;
      resume();
      syncAudio();
    },
    volumechange(event: Event): void {
      const target = fromFront(event);
      if (target !== null) muted = target.muted;
    },
    error(event: Event): void {
      if (fromFront(event) !== null) recover();
    },
  };

  /** いまの位置と尺 (どこまで観たかを覚える。`resume.ts`)。canvas は作ったときの尺。観るものが無ければ null */
  function progress(): { at: number; duration: number } | null {
    if (canvas !== null) return { at: canvas.currentTime, duration: length };
    if (video === null) return null;
    return { at: video.currentTime, duration: video.duration };
  }

  return {
    /** `<video>` の 2 つ (`bind:this`)。映していない側は、段を替えるときに次の観かたを用意する間だけ読み込む (`prepareStep`) */
    get videos() {
      return videos;
    },
    /** 映している側 (`videos` の何番目か) */
    get front() {
      return front;
    },
    /** 映している `<video>` */
    get video() {
      return video;
    },
    /** 映している側の src。その場で流すなら `remux-player.ts` が入れる */
    get src() {
      return src;
    },
    /** 映していない側の src (ファイルの直再生へ移るとき) */
    get spareSrc() {
      return spareSrc;
    },
    events,
    get mediaBox() {
      return mediaBox;
    },
    set mediaBox(box: HTMLElement | null) {
      mediaBox = box;
    },
    /** 字幕を重ねる先 */
    get overlay() {
      return overlay;
    },
    set overlay(canvas: HTMLCanvasElement | null) {
      overlay = canvas;
    },
    /** 実況の層の置き場。canvas で描くときの映像はこの手前に差し込む (映像 → 実況 → 字幕) */
    get jikkyoSlot() {
      return jikkyoSlot;
    },
    set jikkyoSlot(slot: HTMLElement | null) {
      jikkyoSlot = slot;
    },
    get cover() {
      return cover;
    },
    set cover(canvas: HTMLCanvasElement | null) {
      cover = canvas;
    },
    get blanked() {
      return blanked;
    },
    set blanked(on: boolean) {
      blanked = on;
    },
    /** 段を替えるために作り直している間、最後のコマで覆っているか (`hold`)。覆っている間は CM を飛ばない */
    get holding() {
      return holding;
    },
    /** 配線に渡すもの (`wiring.svelte.ts`) */
    target,
    pause: pauseMedia,
    play: playMedia,
    /** WebKit は MSE の `<video>` を通すと無音になる。その場で流しているもの (`remux-player.ts`) は通さない */
    silentTap: (): boolean =>
      typeof navigator !== "undefined" &&
      tapSilent(navigator.userAgent, picked?.way === "stream"),
    /** 運転中の注意 (互換モード)。押すまで再生を始めない */
    drive,
    get info() {
      return info;
    },
    get playing() {
      return playing;
    },
    get at() {
      return at;
    },
    get length() {
      return length;
    },
    get muted() {
      return muted;
    },
    get speed() {
      return speed;
    },
    /** canvas のプレイヤーで描いているか (互換モード・MPEG-2) */
    get drawing() {
      return drawing;
    },
    get compat() {
      return compat;
    },
    /** 端末に保存したもので観ているか (操作バーの「端末」の印) */
    get local() {
      return localSrc !== null || drawingLocal;
    },
    get problem() {
      return problem;
    },
    /** 観られなかったわけの詳しいところ。混んでいるとき・互換モードで出せないときは出さない */
    get problemDetail() {
      return broken && !busy && canvasProblem === null ? brokenWhy : "";
    },
    get buffering() {
      return buffering;
    },
    get resuming() {
      return resuming;
    },
    get lighter() {
      return lighter;
    },
    get codecMenu() {
      return codecMenu;
    },
    get choice() {
      return choice;
    },
    /** 「自動」の行に添えるいまの形式と高さ (「自動 (H.264 540p)」) */
    get autoLabel() {
      return choice === "auto" ? autoLabel(step, stepCodec) : "自動";
    },
    get audios() {
      return audios;
    },
    get audioIndex() {
      return audioIndex;
    },
    /** 形式を切り替えた断り書き */
    get warning() {
      return warning.text;
    },
    /** 段を替えた断り書き */
    get adaptNote() {
      return adaptText.text;
    },
    /** 続きから始めたか (しばらくで引っ込める) */
    get continued() {
      return continued;
    },
    /** 観はじめの位置が決まったか */
    get resumed() {
      return resumed;
    },
    captions,
    get hasCaptions() {
      return hasCaptions;
    },
    get showData() {
      return broadcastData.show;
    },
    get receiveData() {
      return broadcastData.receive;
    },
    /** 自動で受信していて、この録画にデータ放送があり、入口に自動起動の指定があるか (`DataBroadcast` の `receive`) */
    get receiving() {
      return receiving;
    },
    /** データ放送を作り直す合図 (`DataBroadcast` の channel) */
    get dataChannel() {
      return dataChannel;
    },
    /** 録画をサーバから読む所 (チャプターのリクエスト先) */
    feed: recordingFeed,
    /** 端末に保存したものを探している最中の Promise。チャプターも探し終えてから読む */
    get localLookup() {
      return localLookup;
    },
    codecLabel,
    chooseCodec,
    selectAudio,
    toggleMute,
    togglePlay,
    toggleCaptions,
    setCaptions,
    setCaptionLanguage,
    setSpeed,
    seekBy,
    seekTo,
    seekMedia,
    previewSeek,
    mediaTime,
    place,
    clearCaptions,
    setData,
    toggleReceiveData,
    listenData,
    progress,
    /** canvas のプレイヤーで描いているか (作り直しの都度替わる中身。`drawing` と違って `$state` ではない) */
    hasCanvas: (): boolean => canvas !== null,
    /** 観ているものがあるか (`<video>` か canvas のプレイヤー) */
    hasMedia: (): boolean => video !== null || canvas !== null,
    /** canvas のプレイヤーに、`at` 秒から先は描かせない (CM の先頭。`canvas-player.ts` の `stopAt`)。null で外す */
    stopAt(at: number | null): void {
      canvas?.stopAt(at);
    },
    /** いまの 1 コマ (切り抜き)。canvas に描いているときはプレイヤーから 1 枚もらう (`<video>` は空) */
    frame() {
      return canvas !== null ? grabbedFrame(canvas.grab()) : videoFrame(video);
    },
  };
}
