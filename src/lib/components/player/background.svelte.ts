import { untrack } from "svelte";

import { read, write } from "#lib/keep.js";

import { BACKGROUND_KEY, step, storedBackground } from "./background";
import { nativeBackgroundRecovery } from "./native-background";

/**
 * バックグラウンド再生。**3 画面 (ライブ・追っかけ・観る画面) で同じもの。既定はオフ。**
 *
 * ## オフ (既定)
 *
 * - **裏に回ったら止める** (`visibilitychange` で `hidden`、または `pagehide`)。戻ってきたら、
 *   こちらが止めたときだけ再開する。ライブは放送の今へ戻り (張り付いていたとき)、
 *   追っかけ・録画は止めた所から
 * - **OS・ブラウザに勝手に小窓にさせない** (`disablePictureInPicture`。`pip.svelte.ts` の `auto`)。
 *   全画面からホームへ戻っただけで小窓が出て、鳴り続けていた
 * - **canvas で描くときの音は「再生する音」として鳴らさない** (Safari は Audio Session を `auto` の
 *   まま、ほかはページから直に鳴らす。`raw/engine.ts`)
 *
 * **押して開いた小窓はそのまま使える。** 出している間は裏に回っても止めない (観たいと
 * 言われている)。閉じた時点でまだ裏なら、そこで止める。
 *
 * ## オン
 *
 * 止めない。canvas で描くときの音は「再生する音」として鳴らし (Safari は Audio Session を `playback`、ほかは
 * `<audio>` を通す。Web Audio のままだと裏で止めるブラウザがある)、OS が勝手に小窓にするのも許す。
 *
 * **端末ごとに覚える** (`keep.ts`。速さ・CM スキップと同じ)。手元のスマホでは裏で
 * 聴きたいが、居間のテレビでは要らない、のように端末で変わる
 */
interface Options {
  /** `<video>` で観ているときの要素。canvas に描いているときは null (iOS で止められたら戻す: `native-background.ts`) */
  nativeVideo: () => HTMLVideoElement | null;
  /** 押して開いた小窓を出しているか (`pip.active`) */
  pip: () => boolean;
  /** 止めているか */
  paused: () => boolean;
  /** 消音にしているか。音を `<video>` と別に鳴らす画面 (ライブ) だけ渡す。`<video>` はわざと消音にしてある */
  muted?: () => boolean;
  /** 裏に回ったので止める */
  pause: () => void;
  /** 戻ってきたので再開する */
  resume: () => void;
}

export interface Background {
  /** オンにしているか */
  readonly on: boolean;
  toggle: () => void;
}

export function backgroundPlayback(options: Options): Background {
  /** 開いた端末で決まる。サーバで組むときは無いので、開いてから読む */
  let on = $state(false);
  /** こちらが止めたか。戻ってきたときに再開するのはこれだけ */
  let held = false;
  /** `pagehide` のあと。`visibilityState` がまだ `visible` のまま来ることがある */
  let gone = false;

  $effect(() => {
    on = storedBackground(read(BACKGROUND_KEY));
  });

  function check(): void {
    const hidden = gone || document.visibilityState === "hidden";
    const act = step({
      allowed: on,
      hidden,
      pip: options.pip(),
      paused: options.paused(),
      held,
    });
    if (!hidden) held = false;
    if (act === "pause") {
      held = true;
      options.pause();
    } else if (act === "resume") options.resume();
  }

  $effect(() => {
    const hide = () => {
      gone = true;
      check();
    };
    const show = () => {
      gone = false;
      check();
    };
    document.addEventListener("visibilitychange", check);
    /*
     * 小窓が閉じたことを受ける。**`check()` は「小窓の状態 (on) が null に戻った後」に走らせる。**
     * on を戻すのは video のリスナー (`pip.svelte.ts`)。document のリスナーがそれより先に走ると、
     * `pip` がまだ true で「小窓を出している」と読んで止めない (2.32.0 のキャプチャ版がこれで、
     * 実機では止まらなかった)。
     *
     * - `leavepictureinpicture` は仕様上バブルする (`bubbles: true`。W3C PiP 3.3)。document の
     *   バブル相で受ければ video のリスナーの後に呼ばれるので、on は戻っている
     * - Safari の `webkitpresentationmodechanged` はバブルしない。キャプチャ相でしか拾えないが、
     *   キャプチャ相は video のリスナーより先なので、`setTimeout(…, 0)` で配送の後ろへ回す
     * - バブルしない `leavepictureinpicture` を出す実装に備えて、そちらも同じ受け方で拾う
     *   (二重に `check()` が走るが、`step()` は `held` で守るので止め直しはしない)
     */
    const onLeavePip = (): void => {
      setTimeout(check, 0);
    };
    document.addEventListener("leavepictureinpicture", check);
    document.addEventListener("leavepictureinpicture", onLeavePip, true);
    document.addEventListener(
      "webkitpresentationmodechanged",
      onLeavePip,
      true,
    );
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      document.removeEventListener("visibilitychange", check);
      document.removeEventListener("leavepictureinpicture", check);
      document.removeEventListener("leavepictureinpicture", onLeavePip, true);
      document.removeEventListener(
        "webkitpresentationmodechanged",
        onLeavePip,
        true,
      );
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  });

  // オンで `<video>` で観ている間、iOS がホーム画面へ戻るときに止めたら 1 回だけ戻す
  $effect(() => {
    const video = options.nativeVideo();
    if (!on || video === null) return;
    return untrack(() =>
      nativeBackgroundRecovery({
        video,
        page: window,
        visibility: document,
        media: navigator.mediaSession,
        enabled: () => on && !options.pip() && options.nativeVideo() === video,
        userPaused: options.paused,
        audible: () => !(options.muted?.() ?? video.muted),
        pause: options.pause,
        resume: options.resume,
        interrupted: () =>
          (
            navigator as Navigator & {
              audioSession?: { state?: string };
            }
          ).audioSession?.state === "interrupted",
        now: () => performance.now(),
      }),
    );
  });

  // 小窓を閉じた時点でまだ裏なら、そこで止める
  $effect(() => {
    options.pip();
    untrack(check);
  });

  return {
    get on() {
      return on;
    },
    toggle() {
      on = !on;
      write(BACKGROUND_KEY, on ? "1" : "0");
    },
  };
}
