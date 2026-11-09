import type { livePlayer } from "#lib/live-player.svelte.js";

import { type Ambient, ambientMode } from "./ambient.svelte.js";
import { screenAwake } from "./awake.svelte.js";
import { type Background, backgroundPlayback } from "./background.svelte.js";
import { pictureInPicture, type Pip } from "./pip.svelte.js";
import { playerVolume, type Volume } from "./volume.svelte.js";

interface Options {
  player: ReturnType<typeof livePlayer>;
  /** 映像と字幕の重ね (MediaStack が組む)。開くまでは null */
  video: () => HTMLVideoElement | null;
  overlay: () => HTMLCanvasElement | null;
  /** 裏に回ったので止める・戻ってきたので再開する (`backgroundPlayback`)。省くと止めた所から再開する */
  pause?: () => void;
  resume?: () => void;
  /** 音を `<video>` と別に鳴らすか (ライブの WebKit。`#lib/native-audio-choice.ts`)。追っかけは渡さない */
  separateAudio?: () => boolean;
}

export interface LiveWiring {
  background: Background;
  ambient: Ambient;
  pip: Pip;
  volume: Volume;
}

/**
 * **ライブと追っかけの共通の配線。** どちらも同じプレイヤー (`live-player.svelte.ts`) なので、
 * 画面を暗くさせない処理・バックグラウンド再生・アンビエントモード・小窓 (PiP)・音量をここで 1 度だけつなぐ。
 * 画面ごとに違うのは、裏から戻ったときの再開のしかた (`pause`・`resume`) と、音を別に鳴らすか (`separateAudio`)。
 * コンポーネントを作るときに呼ぶ (中で `$effect` を使う)
 */
export function liveWiring(options: Options): LiveWiring {
  const { player } = options;

  /** 画面を暗くさせない。止めている間も掛けたまま (追っかけの始まりで、画面を見ていることが多い) */
  const awake = screenAwake();
  $effect(() => {
    awake.on = player.state !== "idle" && player.state !== "error";
  });

  const background = backgroundPlayback({
    nativeVideo: () => (player.canvas ? null : options.video()),
    pip: () => pip.active,
    paused: () => player.paused,
    // 音を `<video>` と別に鳴らすときだけ、消音を伝える (`<video>` はわざと消音にしてある)
    ...(options.separateAudio === undefined
      ? {}
      : { muted: () => player.silenced }),
    pause: options.pause ?? (() => player.toggle()),
    resume: options.resume ?? (() => player.toggle()),
  });

  /** アンビエントモード。canvas に描いているときは worker から縮めた 1 枚を受け取る */
  const ambient = ambientMode({
    playing: () => !player.paused && !pip.active,
    canvas: () => (player.canvas ? player : null),
    video: options.video,
  });

  /**
   * 小窓 (PiP)。canvas に描いているとき (MPEG-2・互換モード) は worker の canvas からストリームを取って出す。
   * 小窓で押された止める・再開は player に合わせる
   */
  const pip = pictureInPicture({
    video: options.video,
    raw: () => player.canvas,
    capture: () => player.capture(),
    flow: (on) => player.captureFlow(on),
    paused: () => player.paused,
    toggle: () => player.toggle(),
    auto: () => background.on,
    overlay: options.overlay,
    captions: () => player.captions && player.hasCaptions,
  });
  // canvas に描くときの音 (RawEngine が鳴らす) を「再生する音」として扱うのは、バックグラウンド再生がオンのときと小窓を開いている間だけ (`raw/engine.ts`)
  $effect(() => {
    player.playback = background.on || pip.active;
  });

  /** 音量 (`volume.svelte.ts`)。canvas はエンジンの中で、`<video>` は Web Audio に通して掛ける */
  const volume = playerVolume({
    ...(options.separateAudio === undefined
      ? {}
      : { separateAudio: options.separateAudio }),
    video: () => (player.canvas ? null : options.video()),
    through: () => background.on || pip.active,
    remote: (paused) => {
      if (paused !== player.paused) player.toggle();
    },
  });
  $effect(() => {
    player.volume = volume.level;
  });

  return { background, ambient, pip, volume };
}
