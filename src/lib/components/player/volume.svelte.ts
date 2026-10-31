import { untrack } from "svelte";

import { read, write } from "#lib/keep.js";
import { Outlet, playbackSession } from "#lib/sound.js";
import {
  clampLevel,
  MAX_LEVEL,
  stepLevel,
  storedVolume,
  tapVideo,
  VOLUME_KEY,
  volumeGain,
} from "#lib/volume.js";

/** ↑↓ で変えたときに、映像の上へ今の音量を出しておく長さ (ms) */
const NOTE_FOR = 1_500;

/**
 * 音量。**3画面 (ライブ・追っかけ・観る画面) で同じもの。既定は 100% (放送より +6 dB)。**
 *
 * 放送は動画サイトより小さめにそろえてある (`#lib/volume.ts` の `BOOST_DB`) ので、既定で少し大きく鳴らす。
 * つまみは 0%〜100% で、下げる向きにだけ動く。消音 (`muted`・RawEngine の `mute`) とは別で、消しても音量はそのまま。
 *
 * ## 掛け方
 *
 * - **canvas で描くとき** は RawEngine の中で掛ける (画面が `level` を渡す)
 * - **`<video>` で観るとき** は、`<video>` の音を Web Audio に通して (`createMediaElementSource`) 掛ける。
 *   `video.volume` は 1 より大きくできない。リミッタ・`<audio>` を通すか (バックグラウンド再生・小窓) は
 *   canvas と同じもの (`#lib/sound.ts` の `Outlet`)
 *
 * **AudioContext が鳴らせるようになるまでは通さない** (`tapVideo`)。自動再生の許しが出る前に通すと、
 * `<video>` は鳴っているのに何も聞こえない。それまでは直に鳴らし (放送のままの大きさ。下げていれば
 * `video.volume` で下げる)、ページのどこかが押されたら AudioContext を起こして通す。
 * 通している間は Audio Session を `playback` にする (Safari。Web Audio の音を効果音として扱わせない)。
 *
 * **端末ごとに覚える** (`keep.ts`)。手元のイヤホンと居間のテレビでちょうどいい大きさは違う
 */
interface Options {
  /** `<video>` で観ているときの要素。canvas に描いているとき・まだ無いときは null */
  video: () => HTMLVideoElement | null;
  /** 音を別に鳴らすか (ライブの WebKit。`#lib/native-audio-choice.ts`)。そのときは `<video>` を Web Audio に通さない */
  separateAudio?: () => boolean;
  /** `<audio>` を通すか (バックグラウンド再生をオンにしているか、押して小窓を開いている間) */
  through: () => boolean;
  /** `<audio>` を外 (ロック画面・車の操作) から止められた・再開された */
  remote: (paused: boolean) => void;
}

export interface Volume {
  /** いまの音量 (%) */
  readonly level: number;
  /** ↑↓ で変えた直後か。映像の上に今の音量を出す */
  readonly noted: boolean;
  set: (level: number) => void;
  /** ↑↓ で1刻み (`stepLevel`) */
  step: (direction: number) => void;
}

export function playerVolume(options: Options): Volume {
  /** 開いた端末で決まる。サーバで組むときは無いので、開いてから読む */
  let level = $state(MAX_LEVEL);
  let noted = $state(false);
  let noteTimer: ReturnType<typeof setTimeout> | null = null;

  let context: AudioContext | null = null;
  let outlet: Outlet | null = null;
  /** 要素ごとの入口。**一度作ったら作り直せない** (同じ要素からは1つしか作れない) */
  const sources = new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>();
  /** いま Web Audio に通している `<video>` */
  let tapped: HTMLVideoElement | null = null;
  let current: HTMLVideoElement | null = null;
  /** Audio Session を `playback` にしたか。畳むときに戻す */
  let session = false;

  $effect(() => {
    level = storedVolume(read(VOLUME_KEY));
  });

  /** 押されたら AudioContext を起こす (自動再生の許しは押したときに出る) */
  const wake = (): void => {
    if (context !== null && context.state !== "running")
      void context.resume().catch(() => undefined);
  };

  function open(): AudioContext | null {
    if (context !== null) return context;
    try {
      const made = new AudioContext();
      outlet = new Outlet(
        made,
        (audio) => document.body.append(audio),
        options.remote,
        "video-sound",
      );
      made.onstatechange = () => {
        /*
         * 通したあとに止められた (iOS の割り込み・裏で止められた) なら起こし直す。通した `<video>` の音は
         * Web Audio からしか出ないので、止まったままだと押すまで無音になる
         */
        if (made.state === "closed") return;
        if (tapped !== null && made.state !== "running") wake();
        sync();
      };
      context = made;
    } catch {
      return null;
    }
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("keydown", wake, true);
    wake();
    return context;
  }

  /** 通すか・どこへ鳴らすか・大きさを、いまの状態に合わせる */
  function sync(): void {
    const video = current;
    if (video === null) {
      // canvas に描いている。`<video>` は空なので、切り離して `<audio>` も止めておく
      if (tapped !== null) sources.get(tapped)?.disconnect();
      tapped = null;
      outlet?.hold(true);
      return;
    }
    /*
     * 音は別に鳴らす (`raw/native-audio.ts`)。`<video>` は通さない — WebKit では通しても無音しか来ない。
     * 別に鳴らせず `<video>` の音に戻ったとき (`live-player.svelte.ts`) のために、下げるぶんは `video.volume` でも掛ける
     * (macOS の Safari は効く。iOS は `video.volume` を変えられない)
     */
    if (options.separateAudio?.()) {
      if (tapped !== null) sources.get(tapped)?.disconnect();
      tapped = null;
      outlet?.hold(true);
      video.volume = Math.min(1, volumeGain(level));
      return;
    }
    const made = open();
    if (made === null || outlet === null) {
      video.volume = Math.min(1, volumeGain(level));
      return;
    }
    outlet.level = level;
    if (tapped !== video) {
      if (!tapVideo({ video: true, state: made.state })) {
        // まだ鳴らせない。直に鳴らしておく (1 より大きくはできない)
        video.volume = Math.min(1, volumeGain(level));
        return;
      }
      if (tapped !== null) sources.get(tapped)?.disconnect();
      let source = sources.get(video);
      try {
        source ??= made.createMediaElementSource(video);
      } catch {
        video.volume = Math.min(1, volumeGain(level));
        return;
      }
      sources.set(video, source);
      source.connect(outlet.input);
      tapped = video;
      // 大きさは Web Audio の側で掛ける。二重に下げない
      video.volume = 1;
      playbackSession(true);
      session = true;
    }
    outlet.want(options.through());
    outlet.hold(video.paused);
  }

  $effect(() => {
    const video = options.video();
    void level;
    void options.through();
    void options.separateAudio?.();
    untrack(() => {
      current = video;
      sync();
    });
    if (video === null) return;
    // 止めた・再開したら `<audio>` も合わせる (外から見て「止まっている」と分かるように)
    const follow = () => outlet?.hold(video.paused);
    video.addEventListener("play", follow);
    video.addEventListener("pause", follow);
    return () => {
      video.removeEventListener("play", follow);
      video.removeEventListener("pause", follow);
    };
  });

  // 画面を離れたら畳む
  $effect(() => () => {
    window.removeEventListener("pointerdown", wake, true);
    window.removeEventListener("keydown", wake, true);
    if (noteTimer !== null) clearTimeout(noteTimer);
    outlet?.destroy();
    void context?.close().catch(() => undefined);
    if (session) playbackSession(false);
  });

  function set(next: number): void {
    level = clampLevel(next);
    write(VOLUME_KEY, String(level));
  }

  return {
    get level() {
      return level;
    },
    get noted() {
      return noted;
    },
    set,
    step(direction: number) {
      set(stepLevel(level, direction));
      noted = true;
      if (noteTimer !== null) clearTimeout(noteTimer);
      noteTimer = setTimeout(() => (noted = false), NOTE_FOR);
    },
  };
}
