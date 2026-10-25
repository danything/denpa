import { untrack } from "svelte";

import type { Notice } from "#lib/components/Toasts.svelte";

import { canCompose, compose, type Composed } from "./compose";

/**
 * ピクチャーインピクチャー (PiP)。**3画面 (ライブ・追っかけ・観る画面) で同じもの。**
 *
 * どこでボタンを出さないか・canvas で描いているときと字幕の出し方は docs/player.md (`pip.svelte.ts` の行)。
 *
 * - iPhone / iPad のホーム画面から開いたもの (PWA) は、API が有るように見えて押しても出ないので
 *   `navigator.standalone` で見分ける。標準の API が無い古い Safari は `webkitSetPresentationMode` で出す
 * - canvas で描いているとき (放送のままの MPEG-2・互換モード) は `<video>` が空なので、worker が描いた映像の
 *   ストリームを代わりの `<video>` に映して出す (`RawEngine.pipStream`)。代わりの `<video>` は canvas に切り替えた時点で
 *   1枚目まで用意しておく (`prepare`) — 押されてから待つと iPhone の Safari では「押された直後」が切れて断られる
 * - 字幕はコマごとに重ねたストリームを作って出す (`compose.ts`。Chrome・Edge だけ)。`<video>` の映像は押した時点で
 *   字幕を出して再生しているときだけ、小窓に出している間だけ重ねる
 * - 小窓の再生ボタンは `<video>` を直に止めるので、ライブと追っかけは `paused` / `toggle` で player に合わせる
 * - バックグラウンド再生を切っている間 (`auto` が false) は `disablePictureInPicture` を立て、OS・ブラウザが
 *   勝手に小窓にするのを止める。押して開く小窓には効かせない (リクエストの直前に下ろす)
 */

interface Options {
  /** 映像の `<video>` */
  video: () => HTMLVideoElement | null;
  /** canvas で描いているか。立っている間は `capture` のストリームを出す */
  raw?: () => boolean;
  /** canvas の映像ストリーム (`live-player` の `capture`) */
  capture?: () => MediaStream | null;
  /** canvas の映像を流すか (`live-player` の `captureFlow`)。小窓に出していない間は止める */
  flow?: (on: boolean) => void;
  /** 止めているか (ライブ・追っかけ)。**小窓で押された止める・再開を合わせる先** */
  paused?: () => boolean;
  toggle?: () => void;
  /** OS・ブラウザが自分で小窓にするのを許すか (バックグラウンド再生)。渡さなければ許す */
  auto?: () => boolean;
  /** 字幕を重ねている canvas。**小窓にも重ねる** (`compose.ts`) */
  overlay?: () => HTMLCanvasElement | null;
  /** 字幕を出しているか (持っていて、消していない)。変換した映像を字幕ごと小窓に出すかを決める */
  captions?: () => boolean;
}

/** どこで断られたか。**押しても何も起きない、で終わらせない** — 端末ごとに転ぶ所が違う */
class Refused extends Error {}

function reason(error: unknown): string {
  if (error instanceof Refused) return error.message;
  if (error instanceof DOMException)
    return `ブラウザに許可されませんでした (${error.name}: ${error.message})`;
  return String(error);
}

export interface Pip {
  /** この端末・いまの見え方で出せるか。**出せなければボタンを出さない** */
  readonly available: boolean;
  /** 小窓で出しているか */
  readonly active: boolean;
  toggle: () => void;
  /** 出せなかった理由 (トーストへ混ぜる)。出せていれば空 */
  readonly notices: Notice[];
  dismiss: (key: string) => void;
}

/** Safari だけの API */
type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

const MODE = "picture-in-picture";
/** 字幕を重ねたストリームの1枚目を待つ上限 (ms)。過ぎたら元の video をそのまま出す */
const FIRST_FRAME = 2_000;

/** `captureStream` は Chrome・Firefox にある (型には無い) */
type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream };

/** 標準の APIが使えるか */
function standard(): boolean {
  return document.pictureInPictureEnabled === true;
}

/** Safari の APIが使えるか (標準が無い古い Safari) */
function webkit(video: WebkitVideo): boolean {
  return (
    typeof video.webkitSupportsPresentationMode === "function" &&
    video.webkitSupportsPresentationMode(MODE)
  );
}

function supported(): boolean {
  // iPhone / iPad のホーム画面から開いたもの。Safari が小窓を許していない
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true)
    return false;
  return standard() || webkit(document.createElement("video"));
}

/** 小窓で出しているか (その video が) */
function shown(video: WebkitVideo): boolean {
  return (
    document.pictureInPictureElement === video ||
    video.webkitPresentationMode === MODE
  );
}

/** `types` のどれかが来たら `listener` を呼ぶ。外す関数を返す */
function listenAll(
  target: EventTarget,
  types: string[],
  listener: () => void,
): () => void {
  for (const type of types) target.addEventListener(type, listener);
  return () => {
    for (const type of types) target.removeEventListener(type, listener);
  };
}

/** 止める・再開する (再開を断られても気にしない) */
function playOrPause(video: HTMLVideoElement, paused: boolean): void {
  if (paused) video.pause();
  else void video.play().catch(() => undefined);
}

export function pictureInPicture(options: Options): Pip {
  /** 開いた端末で決まる。サーバで組むときは無いので、開いてから測る */
  let able = $state(false);
  /** 小窓に出している video (本体か、canvas のときの代わり)。出していなければ null */
  let on = $state<HTMLVideoElement | null>(null);
  /** canvas のとき・字幕を重ねるときに小窓へ出す代わりの video。要るときに作る */
  let proxy: HTMLVideoElement | null = null;
  /** canvas のストリームに字幕を重ねたもの (`prepare`)。重ねられない端末では null (canvas のストリームをそのまま出す) */
  let rawComposed: Composed | null = null;
  /** 小窓をリクエストしている最中か (`toggle`) */
  let entering = false;
  /** 変換した映像に字幕を重ねたもの (`composeBaked`)。**小窓に出している間だけ** ある */
  let baked = $state<Composed | null>(null);
  /**
   * 用意できなかった理由 (`prepare`)。**立っている間はボタンを出さない** — Firefox は MPEG-2 の
   * 映像ストリームを取れず、押せても必ず断られる
   */
  let unprepared = $state<Refused | null>(null);
  /** 出せなかった理由 */
  let refused = $state<Notice | null>(null);

  const canCapture =
    typeof HTMLCanvasElement !== "undefined" &&
    "captureStream" in HTMLCanvasElement.prototype;
  const raw = (): boolean => options.raw?.() ?? false;
  /** いま小窓に出すのは代わりの video か (canvas で描いているもの、または字幕を重ねた変換映像) */
  const proxied = (): boolean => raw() || baked !== null;

  $effect(() => {
    able = supported();
  });

  /** 出た・引っ込んだを受け取る。**閉じるのは小窓の × からも来る** ので、こちらで押したかに頼らない */
  function listen(video: WebkitVideo): () => void {
    return listenAll(
      video,
      [
        "enterpictureinpicture",
        "leavepictureinpicture",
        "webkitpresentationmodechanged",
      ],
      () => {
        if (shown(video)) on = video;
        else if (on === video) on = null;
        if (video === proxy && on !== proxy) {
          flowing(false);
          // 変換した映像に重ねていたなら畳む。小窓に出していない間まで重ねない
          dropBaked();
        }
      },
    );
  }

  /**
   * 小窓で押された止める・再開を player に伝える。小窓に出している間だけ (canvas へ移るときの `pause` は
   * まだ `on` のまま届くので、`proxied` で見分ける)。player が自分で止めたときは `paused` が既に合っている
   */
  function follow(video: HTMLVideoElement): () => void {
    const { paused, toggle } = options;
    return listenAll(video, ["pause", "play"], () => {
      if (on !== video || (video === proxy) !== proxied()) return;
      if (paused !== undefined && toggle !== undefined) {
        if (video.paused !== paused()) toggle();
        return;
      }
      // 観る画面で、字幕を重ねた小窓 (代わりの video) で押された。元の video を合わせる
      const main = options.video();
      if (video === proxy && main !== null && main.paused !== video.paused)
        playOrPause(main, video.paused);
    });
  }

  $effect(() => {
    const video = options.video();
    if (video === null) return;
    const unlisten = listen(video);
    const unfollow = follow(video);
    /*
     * 観る画面で、字幕を重ねた小窓を出している間に操作バーで止めた・再開した。小窓の
     * 再生ボタンの見た目を合わせる (ライブと追っかけは下の `paused` の $effect が合わせる)
     */
    const unmirror = listenAll(video, ["pause", "play"], () => {
      if (
        options.paused === undefined &&
        baked !== null &&
        proxy !== null &&
        on === proxy
      )
        playOrPause(proxy, video.paused);
    });
    return () => {
      unlisten();
      unfollow();
      unmirror();
    };
  });

  /**
   * **canvas に移った・`<video>` に戻ったら小窓を閉じる。** 出しているほうにはもう映像が
   * 流れてこない (canvas では `<video>` は空、戻れば canvas は畳まれる)。黙って残すと、
   * 止まった映像の小窓が居座る
   */
  $effect(() => {
    const isRaw = raw();
    if (on === null) return;
    // 字幕を重ねた小窓は `<video>` の映像なので、canvas のものではない
    if ((on === proxy && baked === null) !== isRaw) leave();
  });

  /** canvas に移ったら代わりの video を用意しておく。出たら畳む (canvas ごと無くなる) */
  $effect(() => {
    if (!able || !raw() || !canCapture || options.capture === undefined) return;
    untrack(prepare);
    return release;
  });

  /** 押さずに小窓にされないようにする (上の説明)。出している video は下ろしたまま */
  function guard(): void {
    const allow = options.auto?.() ?? true;
    for (const video of [options.video(), proxy])
      if (video !== null)
        video.disablePictureInPicture = !allow && on !== video;
  }
  $effect(guard);

  /** canvas のとき、代わりの video も止める・再開を合わせる (押されたのが操作バーのボタンのとき) */
  $effect(() => {
    const paused = options.paused?.() ?? false;
    if (proxy !== null && on === proxy) playOrPause(proxy, paused);
  });

  /*
   * 画面を離れたら閉じる。player は止まるので、小窓に残しても映像は来ない。
   * **ストリームもここで止める** — canvas のときの `$effect` の後始末が先に走るとは限らない
   */
  $effect(() => () => {
    leave();
    release();
    proxy?.remove();
    proxy = null;
  });

  /** 代わりの video を用意する。**画面の外に、見えない大きさで置く** (文書に無いと出せない) */
  function makeProxy(): HTMLVideoElement {
    if (proxy !== null) return proxy;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-hidden", "true");
    video.dataset["testid"] = "pip-raw";
    video.style.cssText =
      "position:fixed; left:0; top:0; width:1px; height:1px; opacity:0; pointer-events:none;";
    document.body.append(video);
    listen(video);
    follow(video);
    proxy = video;
    guard();
    return video;
  }

  /**
   * 代わりの video にストリームを繋いで、1枚目まで受け取っておく。**押されてからでは遅い** (上の説明)。
   * 1枚目が来たらストリームを切る — 小窓に出すまで写し続けない
   */
  function prepare(): void {
    unprepared = null;
    const stream = options.capture?.() ?? null;
    if (stream === null) {
      unprepared = new Refused("MPEG-2 の映像を取り出せません (captureStream)");
      return;
    }
    if (stream.getVideoTracks().length === 0) {
      unprepared = new Refused("MPEG-2 の映像が空です");
      return;
    }
    const video = makeProxy();
    // 字幕を重ねられる端末では重ねたものを出す (字幕が出ていないコマは素通し。`compose.ts`)
    const track = stream.getVideoTracks()[0];
    rawComposed?.stop();
    rawComposed =
      options.overlay === undefined || track === undefined
        ? null
        : compose(track, options.overlay);
    video.srcObject = rawComposed?.stream ?? stream;
    video.addEventListener(
      "loadedmetadata",
      () => on !== video && flowing(false),
      { once: true },
    );
    void video.play().catch((error: unknown) => {
      unprepared = new Refused(
        `代わりの映像を再生できません (${reason(error)})`,
      );
    });
  }

  /** 代わりの video へ映像を流すか。**切っても1枚目の大きさは覚えたまま** (`readyState` は下がらない) */
  function flowing(flow: boolean): void {
    const stream = proxy?.srcObject;
    if (stream instanceof MediaStream)
      for (const track of stream.getVideoTracks()) track.enabled = flow;
    options.flow?.(flow);
  }

  /** 代わりの video を畳む。canvas で描くのをやめたとき (canvas ごと無くなる) */
  function release(): void {
    rawComposed?.stop();
    rawComposed = null;
    dropBaked();
    if (proxy === null) return;
    const stream = proxy.srcObject;
    if (stream instanceof MediaStream)
      for (const track of stream.getTracks()) track.stop();
    proxy.srcObject = null;
  }

  /**
   * 変換した映像に字幕を重ねるか。**押した時点で字幕を出しているときだけ** (上の説明)。
   * 止めている間も重ねない — `captureStream` は止まった `<video>` からコマを出さないので、
   * 1枚目を待ちきれずに元の `<video>` へ落ちるだけになる
   */
  function composable(video: HTMLVideoElement): boolean {
    return (
      !video.paused &&
      standard() &&
      canCompose() &&
      options.overlay !== undefined &&
      options.captions?.() === true &&
      typeof (video as CapturableVideo).captureStream === "function"
    );
  }

  /**
   * 変換した映像に字幕を重ねて、代わりの video に1枚目まで受け取る。**押されてから作る** —
   * 重ねられるのは Chrome・Edge だけで、あちらは「押された直後」が数秒続く (Safari と違って
   * 待っても断られない)。小窓に出していない間まで重ね続けないため。
   * 作れなければ null (元の video をそのまま出す)
   */
  async function composeBaked(
    video: HTMLVideoElement,
  ): Promise<HTMLVideoElement | null> {
    let track: MediaStreamTrack | undefined;
    try {
      track = (video as CapturableVideo).captureStream?.().getVideoTracks()[0];
    } catch {
      return null;
    }
    if (track === undefined || options.overlay === undefined) return null;
    const composed = compose(track, options.overlay);
    if (composed === null) {
      track.stop();
      return null;
    }
    dropBaked();
    const target = makeProxy();
    baked = composed;
    target.srcObject = composed.stream;
    const ready = new Promise<boolean>((done) => {
      if (target.readyState >= HTMLMediaElement.HAVE_METADATA)
        return done(true);
      const timer = setTimeout(() => done(false), FIRST_FRAME);
      target.addEventListener(
        "loadedmetadata",
        () => {
          clearTimeout(timer);
          done(true);
        },
        { once: true },
      );
    });
    void target.play().catch(() => undefined);
    if (!(await ready) || baked !== composed) {
      if (baked === composed) dropBaked();
      return null;
    }
    return target;
  }

  /** 変換した映像に重ねていたら畳む。**元のストリーム (`captureStream`) も止める** */
  function dropBaked(): void {
    const composed = baked;
    if (composed === null) return;
    baked = null;
    composed.stop();
    if (proxy !== null && proxy.srcObject === composed.stream)
      proxy.srcObject = null;
  }

  /**
   * 小窓に出す。**リクエストするまでに `await` を挟まない** — 挟むと Safari は「押された直後」と
   * 見なさなくなって断る (`NotAllowedError`)。字幕を重ねるときだけ1枚目を待つ
   * (`composeBaked`。そこへ来るのは待っても断られない Chrome・Edge だけ)
   */
  async function enter(): Promise<void> {
    let video: WebkitVideo | null = options.video();
    if (raw()) {
      if (unprepared !== null) throw unprepared;
      if (proxy === null || proxy.srcObject === null)
        throw new Refused("MPEG-2 の映像の準備ができていません");
      if (proxy.readyState < HTMLMediaElement.HAVE_METADATA)
        throw new Refused(
          "MPEG-2 の映像がまだ届いていません。少し待ってからもう一度押してください",
        );
      video = proxy;
      flowing(true);
      playOrPause(video, options.paused?.() === true);
    } else if (video !== null && composable(video))
      video = (await composeBaked(video)) ?? video;
    if (video === null) return;
    // 押して開くものは止めない (勝手に開かせないための印。上の説明)
    video.disablePictureInPicture = false;
    if (standard()) await video.requestPictureInPicture();
    else if (webkit(video)) {
      /*
       * Safari の APIは断っても何も言わない。切り替わったかを見て言う。
       * **一度でも切り替わったかで見る** — 1秒の間に閉じられた・画面を離れたものまで
       * 「切り替わらなかった」と言っていた
       */
      const target = video;
      let reached = false;
      const mark = () => {
        if (shown(target)) reached = true;
      };
      target.addEventListener("webkitpresentationmodechanged", mark);
      target.webkitSetPresentationMode?.(MODE);
      setTimeout(() => {
        target.removeEventListener("webkitpresentationmodechanged", mark);
        if (!reached && on !== target)
          refuse(
            new Refused(
              "Safari で小窓に切り替えられませんでした (webkitSetPresentationMode)",
            ),
          );
      }, 1000);
    }
  }

  /** 出せなかった理由を言う。**コンソールにも残す** (端末によってはトーストより読みやすい) */
  function refuse(error: unknown): void {
    console.warn("[pip]", error);
    refused = {
      key: `pip-${Date.now()}`,
      kind: "error",
      text: `小窓を出せませんでした: ${reason(error)}`,
    };
    flowing(false);
    // 字幕を重ねて用意したものは、出せなかったなら畳む
    if (on === null) dropBaked();
    // リクエストする前に下ろした印を戻す (`enter`)
    guard();
  }

  function leave(): void {
    const video = on as WebkitVideo | null;
    if (video === null) return;
    if (document.pictureInPictureElement === video)
      void document.exitPictureInPicture().catch(() => undefined);
    else if (video.webkitPresentationMode === MODE)
      video.webkitSetPresentationMode?.("inline");
    if (video === proxy) flowing(false);
  }

  return {
    get available() {
      return (
        able &&
        (!raw() ||
          (canCapture && options.capture !== undefined && unprepared === null))
      );
    },
    get active() {
      return on !== null;
    },
    toggle() {
      refused = null;
      if (on !== null) leave();
      // 字幕を重ねる用意 (1枚目待ち) の間に押し直されたら、二重にリクエストしない
      else if (!entering) {
        entering = true;
        void enter()
          .catch(refuse)
          .finally(() => {
            entering = false;
          });
      }
    },
    get notices() {
      return refused === null ? [] : [refused];
    },
    dismiss(key: string) {
      if (refused?.key === key) refused = null;
    },
  };
}
