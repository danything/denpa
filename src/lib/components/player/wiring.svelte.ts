import type { GrabSize } from "#lib/raw/messages.js";

import { type Ambient, ambientMode } from "./ambient.svelte.js";
import { screenAwake } from "./awake.svelte.js";
import { type Background, backgroundPlayback } from "./background.svelte.js";
import { pictureInPicture, type Pip } from "./pip.svelte.js";
import { playerVolume, type Volume } from "./volume.svelte.js";

/**
 * **配線がプレイヤーから読むもの・プレイヤーへ渡すもの。** ライブと追っかけは `livePlayer` の戻り値をそのまま渡し、
 * 観る画面は canvas のプレイヤーと `<video>` を束ねた包みを渡す。読むものは `$state` から読ませる (変わったら配線が合わせ直す)
 */
export interface PlaybackTarget {
  /** 開く前・閉じた (`idle`) と、観られない (`error`) の間は、画面を暗くさせない処理を外す */
  readonly state: "idle" | "connecting" | "playing" | "error";
  /** canvas に描いているか (放送のままの MPEG-2・互換モード)。描いている間は `<video>` を使わない */
  readonly canvas: boolean;
  readonly paused: boolean;
  /** 字幕を出しているか・字幕があるか (小窓に字幕を重ねるか) */
  readonly captions: boolean;
  readonly hasCaptions: boolean;
  toggle(): void;
  /** canvas に描いているときのコマ (アンビエントモード) と、小窓に流すストリーム */
  grab(size?: GrabSize): Promise<ImageBitmap | null>;
  capture(): MediaStream | null;
  captureFlow(on: boolean): void;
  /** canvas に描くときの音量 (`<video>` の音量は配線が掛ける) */
  set volume(level: number | null);
  /** canvas に描くときの音を「再生する音」として鳴らすか (バックグラウンド再生・小窓。`raw/engine.ts`) */
  set playback(on: boolean);
}

interface Options {
  target: PlaybackTarget;
  /** 映像の `<video>` と、その上に重ねる字幕の canvas (MediaStack が置く)。開くまでは null */
  video: () => HTMLVideoElement | null;
  overlay: () => HTMLCanvasElement | null;
  /** 裏に回ったので止める・戻ってきたので再開する (`backgroundPlayback`)。省くと止めた所から再開する */
  pause?: () => void;
  resume?: () => void;
  /** `<video>` を Web Audio に通すと無音になるか (WebKit の MSE。`volume.svelte.ts` の `silentTap`) */
  silentTap?: () => boolean;
  /** 音量を変えられない端末か (`volume.svelte.ts` の `fixed`) */
  fixed?: () => boolean;
}

interface Wiring {
  background: Background;
  ambient: Ambient;
  pip: Pip;
  volume: Volume;
}

/**
 * **3 画面の共通の配線。** 画面を暗くさせない処理・バックグラウンド再生・アンビエントモード・小窓 (PiP)・音量をここで 1 度だけつなぐ。
 * 画面ごとに違うのは、裏から戻ったときの再開のしかた (`pause`・`resume`) と、`<video>` を Web Audio に通すと無音になるか (`silentTap`。観る画面はファイルの直再生なら通す)。音量を変えられない端末か (`fixed`) は 3 画面で同じものを渡す。
 * コンポーネントを作るときに呼ぶ (中で `$effect` を使う)
 */
export function playerWiring(options: Options): Wiring {
  const { target } = options;

  /** 画面を暗くさせない。止めている間も掛けたまま (追っかけの始まりで、画面を見ていることが多い)。観られないと分かったら外す */
  const awake = screenAwake();
  $effect(() => {
    awake.on = target.state !== "idle" && target.state !== "error";
  });

  const background = backgroundPlayback({
    nativeVideo: () => (target.canvas ? null : options.video()),
    pip: () => pip.active,
    paused: () => target.paused,
    pause: options.pause ?? (() => target.toggle()),
    resume: options.resume ?? (() => target.toggle()),
  });

  /** アンビエントモード。canvas に描いているときは worker から縮めた 1 枚を受け取る */
  const ambient = ambientMode({
    playing: () => !target.paused && !pip.active,
    canvas: () => (target.canvas ? target : null),
    video: options.video,
  });

  /**
   * 小窓 (PiP)。canvas に描いているとき (MPEG-2・互換モード) は worker の canvas からストリームを取って出す。
   * 小窓で押された止める・再開はプレイヤーに合わせる
   */
  const pip = pictureInPicture({
    video: options.video,
    raw: () => target.canvas,
    capture: () => target.capture(),
    flow: (on) => target.captureFlow(on),
    paused: () => target.paused,
    toggle: () => target.toggle(),
    auto: () => background.on,
    overlay: options.overlay,
    captions: () => target.captions && target.hasCaptions,
  });
  // canvas に描くときの音 (RawEngine が鳴らす) を「再生する音」として扱うのは、バックグラウンド再生がオンのときと小窓を開いている間だけ (`raw/engine.ts`)
  $effect(() => {
    target.playback = background.on || pip.active;
  });

  /** 音量 (`volume.svelte.ts`)。canvas はエンジンの中で、`<video>` は Web Audio に通して掛ける */
  const volume = playerVolume({
    ...(options.silentTap === undefined
      ? {}
      : { silentTap: options.silentTap }),
    ...(options.fixed === undefined ? {} : { fixed: options.fixed }),
    video: () => (target.canvas ? null : options.video()),
    through: () => background.on || pip.active,
    remote: (paused) => {
      if (paused !== target.paused) target.toggle();
    },
  });
  $effect(() => {
    target.volume = volume.applied;
  });

  return { background, ambient, pip, volume };
}
