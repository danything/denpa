import { untrack } from "svelte";

import { read, write } from "#lib/keep.js";
import { GESTURES } from "#lib/raw/gesture-context.js";
import { Outlet, playbackSession } from "#lib/sound.js";
import {
  clampLevel,
  MAX_LEVEL,
  stepLevel,
  storedVolume,
  VOLUME_KEY,
  volumeGain,
} from "#lib/volume.js";

/** ↑↓ で変えたときに、映像の上へ今の音量を出しておく長さ (ms) */
const NOTE_FOR = 1_500;

/**
 * 音量。**3 画面 (ライブ・追っかけ・観る画面) で同じもの。既定は 100% (放送より +6 dB)。**
 *
 * 放送は動画サイトより小さめにそろえてある (`#lib/volume.ts` の `BOOST_DB`) ので、既定で少し大きく鳴らす。
 * つまみは 0%〜100% で、下げる向きにだけ動く。消音 (`muted`・RawEngine の `mute`) とは別で、消しても音量はそのまま。
 *
 * ## 掛け方
 *
 * - **canvas で描くとき** は RawEngine の中で掛ける (画面が `applied` を渡す)
 * - **`<video>` で観るとき** は、`<video>` の音を Web Audio に通して (`createMediaElementSource`) 掛ける。
 *   `video.volume` は 1 より大きくできない。リミッタ・`<audio>` を通すか (バックグラウンド再生・小窓) は
 *   canvas と同じもの (`#lib/sound.ts` の `Outlet`)
 *
 * **AudioContext が鳴らせる (`running`) まで通さない。** 一度通した要素の音は Web Audio からしか出ないので、
 * 自動再生の許可が出る前に通すと、`<video>` は鳴っているのに何も聞こえない。それまでは直に鳴らし (放送のままの大きさ。下げていれば
 * `video.volume` で下げる)、ページのどこかが押されたら AudioContext を起こして通す。
 * 通している間は Audio Session を `playback` にする (Safari。Web Audio の音を効果音として扱わせない)。
 *
 * **端末ごとに覚える** (`keep.ts`)。手元のイヤホンと居間のテレビでちょうどいい大きさは違う
 *
 * ## 音量を変えられない端末 (`fixed`)
 *
 * iOS と iPadOS は、ページから `<video>` の音量を変えられない (`#lib/native-audio-choice.ts` の `fixedMediaVolume`)。
 * 観る画面と追っかけでは、**この端末ではつまみを使わず、本体の音量ボタンに任せる**。canvas に描いている間も
 * つまみの値を掛けず、放送のままの大きさで鳴らす (`applied` が null)。`<video>` に移っても大きさが変わらない。
 * `<video>` は Web Audio に通さず、つまみ (`SoundButton`・`StageTail`) も出さない。↑↓ も何もしない。消音は効く。
 * ライブは渡さない。音を別に鳴らす (`raw/native-audio.ts`) ので、この端末でもつまみが効く
 */
interface Options {
  /** `<video>` で観ているときの要素。canvas に描いているとき・まだ無いときは null */
  video: () => HTMLVideoElement | null;
  /** 音を別に鳴らすか (ライブの WebKit。`#lib/native-audio-choice.ts`)。そのときは `<video>` を Web Audio に通さない */
  separateAudio?: () => boolean;
  /**
   * 通すと無音になるか (WebKit の MSE。観る画面のその場で流すものと追っかけ。`#lib/native-audio-choice.ts` の `tapSilent`)。そのときは通さず、
   * 下げるぶんは `video.volume` で掛ける
   */
  silentTap?: () => boolean;
  /** 音量を変えられない端末か (観る画面・追っかけ。`#lib/native-audio-choice.ts` の `fixedMediaVolume`)。ライブは渡さない */
  fixed?: () => boolean;
  /** `<audio>` を通すか (バックグラウンド再生をオンにしているか、押して小窓を開いている間) */
  through: () => boolean;
  /** `<audio>` を外 (ロック画面・車の操作) から止められた・再開された */
  remote: (paused: boolean) => void;
}

export interface Volume {
  /** いまの音量 (%)。つまみの値 */
  readonly level: number;
  /** 音量を変えられない端末か。つまみを出さない */
  readonly fixed: boolean;
  /** canvas に描くときに掛ける音量 (%)。音量を変えられない端末では null (放送のまま) */
  readonly applied: number | null;
  /** ↑↓ で変えた直後か。映像の上に今の音量を出す */
  readonly noted: boolean;
  set: (level: number) => void;
  /** ↑↓ で 1 刻み (`stepLevel`) */
  step: (direction: number) => void;
}

export function playerVolume(options: Options): Volume {
  /** 端末ごとに覚えた値 (`keep.ts`) と、音量を変えられない端末か。どちらもサーバで組むときは読めないので、開いてから読む */
  let level = $state(MAX_LEVEL);
  let fixed = $state(false);
  let noted = $state(false);
  let noteTimer: ReturnType<typeof setTimeout> | null = null;

  let context: AudioContext | null = null;
  let outlet: Outlet | null = null;
  /** 要素ごとの入口。**一度作ったら作り直せない** (同じ要素からは 1 つしか作れない) */
  const sources = new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>();
  /** いま Web Audio に通している `<video>` */
  let tapped: HTMLVideoElement | null = null;
  let current: HTMLVideoElement | null = null;
  /** Audio Session を `playback` にしたか。破棄するときに戻す */
  let session = false;

  $effect(() => {
    level = storedVolume(read(VOLUME_KEY));
    fixed = options.fixed?.() ?? false;
  });

  /**
   * 押されたら AudioContext を起こす (自動再生の許可は押したときに出る)。**`<video>` がまだ無い間に押されたら作っておく。**
   * Safari は押したとき以外に作った AudioContext を止めたまま始める (iOS で確かめた)。canvas から段を下げて `<video>` に
   * 移ってから作ると、次に押すまで通せない。通さない画面 (`separateAudio`・`silentTap`・`fixed`) では作らない。
   *
   * 読み込み中 (`<video>` をまだ渡されていない間) に押されても作るので、押した後で作っても鳴らせるブラウザ (Chromium など) でも
   * 早めに作る。そのまま `<video>` に移れば同じものを通すので、作るのが少し早くなるだけで済む。最後まで canvas に描いたときは、
   * 何も繋がない AudioContext が画面を離れるまで 1 つ残る。ブラウザで分けると決まりが 2 つになるので、この程度の無駄は受け入れる
   */
  const wake = (): void => {
    if (context === null) {
      if (
        current === null &&
        !fixed &&
        !options.separateAudio?.() &&
        !options.silentTap?.()
      )
        open();
      return;
    }
    if (context.state !== "running")
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
    wake();
    return context;
  }

  /** `<video>` を Web Audio から外し、`<audio>` も止めておく */
  function untap(): void {
    if (tapped !== null) sources.get(tapped)?.disconnect();
    tapped = null;
    outlet?.hold(true);
  }

  /** 通すか・どこへ鳴らすか・大きさを、いまの状態に合わせる */
  function sync(): void {
    const video = current;
    // canvas に描いている。`<video>` は空
    if (video === null) {
      untap();
      return;
    }
    /*
     * 音量を変えられない端末。通さずに放送のままの大きさで鳴らす (`video.volume` は変わらないが、1 にそろえておく)。
     * この端末は Safari なので、通していてもバックグラウンド再生・小窓で `<audio>` は通さない (`throughAudio`)。
     * 通さない `<video>` はそのまま「再生する音」で、裏でも止まらず、ロック画面の操作も `<video>` に届く
     */
    if (fixed) {
      untap();
      video.volume = 1;
      return;
    }
    /** 通さずに直に鳴らすときの大きさ。1 より大きくはできない */
    const direct = Math.min(1, volumeGain(level));
    /*
     * 音は別に鳴らす (`raw/native-audio.ts`)。`<video>` は通さない。WebKit では通しても無音しか来ない。
     * 別に鳴らせず `<video>` の音に戻ったとき (`live-player.svelte.ts`) のために、下げるぶんは `video.volume` でも掛ける
     * (macOS の Safari は効く。iOS は `video.volume` を変えられない)。
     *
     * 通すと無音になるとき (`silentTap`) も同じにする。一度通した要素は Web Audio からしか鳴らないので、通した要素のまま
     * MSE に移ると無音になる。観る画面は段を替えるとき映していない側の `<video>` に移るので、ふつうはまだ通していない要素になる
     */
    if (options.separateAudio?.() || options.silentTap?.()) {
      untap();
      video.volume = direct;
      return;
    }
    const made = open();
    if (made === null || outlet === null) {
      video.volume = direct;
      return;
    }
    outlet.level = level;
    if (tapped !== video) {
      // まだ鳴らせない。直に鳴らしておく
      if (made.state !== "running") {
        video.volume = direct;
        return;
      }
      if (tapped !== null) sources.get(tapped)?.disconnect();
      let source = sources.get(video);
      try {
        source ??= made.createMediaElementSource(video);
      } catch {
        video.volume = direct;
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
    void fixed;
    void options.through();
    void options.separateAudio?.();
    void options.silentTap?.();
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

  // 押したと見なす出来事 (`raw/gesture-context.ts`) と押し始め (`pointerdown`) で起こす
  $effect(() => {
    const listening = new AbortController();
    for (const type of ["pointerdown", ...GESTURES])
      window.addEventListener(type, wake, {
        capture: true,
        passive: true,
        signal: listening.signal,
      });
    return () => listening.abort();
  });

  // 画面を離れたら後始末する
  $effect(() => () => {
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
    get fixed() {
      return fixed;
    },
    get applied() {
      return fixed ? null : level;
    },
    get noted() {
      return noted;
    },
    set,
    step(direction: number) {
      if (fixed) return;
      set(stepLevel(level, direction));
      noted = true;
      if (noteTimer !== null) clearTimeout(noteTimer);
      noteTimer = setTimeout(() => (noted = false), NOTE_FOR);
    },
  };
}
