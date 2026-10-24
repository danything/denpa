/**
 * 操作列を出しておくか消すかの決め方 (3画面で同じ。DOM も映像も触らない)。触っていない間は引っ込める。
 * 止めていても引っ込める — 一時停止はたいてい映像の中の文字を見るためで、押さないと消せないほうが邪魔だった。
 * 残すのはキーボードで触っている間だけ (映像を押して出し直す手が無い)
 */

import { getContext } from "svelte";

/**
 * 触らなくなってから消えるまで (ms)。指もマウスも同じ長さ (指だけ押すまで留めていた頃は、消すのに毎回
 * 映像を押すことになった)
 */
const LINGER = 2500;

/** 消す時刻を跨ぐためだけの目覚まし。出ている間しか回さない */
const TICK = 250;

/** 舞台 (`PlayerStage`) が context に置き、その中のメニュー (`stageMenu`) が読む鍵 */
export const PLAYER_CONTROLS = Symbol("player-controls");

/** 舞台の枠そのもの。**メニューを枠の中に収める**のに使う (`stageMenu`) */
export const PLAYER_STAGE = Symbol("player-stage");

export interface PlayerControls {
  /** いま出ているか */
  readonly shown: boolean;
  /** 押されたり動かされたりしたとき。出して、時計を巻き直す */
  wake: (event: PointerEvent) => void;
  /** 出ていく先で消す。**指のときは消さない** */
  away: (event: PointerEvent) => void;
  /** キーボードで触っている間は残す */
  keyboard: boolean;
  /** メニューが開いている間は残す。**選んでいる最中に消えては選べない** */
  hold: boolean;
  /** その場で出し直す (ボタンを押した直後など) */
  stir: () => void;
  /** その場で消す (指で1回押して引っ込めるとき) */
  hide: () => void;
  /**
   * 指で映像を押した。**押す前に出ていたかで決める** (`wake` の項)。
   * マウスのときは何もしない
   */
  toggle: () => void;
}

export function playerControls(): PlayerControls {
  let touched = $state(Date.now());
  let now = $state(Date.now());
  /** 直前に触ったのが指 (かペン) か。**マウスの繋がっていない端末もある** */
  let byTouch = $state(false);
  /** 押される直前に出ていたか。`toggle` が読む */
  let wasShown = false;
  let keyboard = $state(false);
  let hold = $state(false);
  /** 前にいた場所。**動いていない `pointermove` を捨てる**のに使う (`wake`) */
  let lastX = Number.NaN;
  let lastY = Number.NaN;

  // 見るのは「触ったか」だけ (キーボードと開いているメニューを除く。再生の状態は混ぜない)
  const shown = $derived(keyboard || hold || now - touched < LINGER);

  $effect(() => {
    if (!shown) return;
    const timer = setInterval(() => (now = Date.now()), TICK);
    return () => clearInterval(timer);
  });

  function stir(): void {
    touched = Date.now();
    now = touched;
  }

  function hide(): void {
    touched = 0;
    now = Date.now();
  }

  return {
    get shown(): boolean {
      return shown;
    },
    get keyboard(): boolean {
      return keyboard;
    },
    set keyboard(value: boolean) {
      keyboard = value;
    },
    get hold(): boolean {
      return hold;
    },
    set hold(value: boolean) {
      hold = value;
    },
    /**
     * 指は押したときだけ出す (滑らせただけでは何もしない)。マウスは本当に動いたときだけ出す — 止まったカーソルの
     * 下で中身が動いただけでも `pointermove` が来るので、全画面のまま操作列が消えなくなっていた
     */
    wake(event: PointerEvent): void {
      if (event.pointerType !== "mouse") {
        if (event.type !== "pointerdown") return;
        byTouch = true;
        // 巻き直す前に読む。`toggle` は「押す前に出ていたか」で決める
        wasShown = shown;
        stir();
        return;
      }
      if (event.clientX === lastX && event.clientY === lastY) return;
      lastX = event.clientX;
      lastY = event.clientY;
      byTouch = false;
      stir();
    },
    // 指を離すと `pointerleave` が必ず飛ぶので、消すのはマウスが外へ出たときだけ
    away(event: PointerEvent): void {
      if (event.pointerType === "mouse") touched = 0;
    },
    stir,
    hide,
    // 押す前に出ていたかで決める (いまの状態で決めると `wake` が出したものを見て消し、指では出せなかった)
    toggle(): void {
      if (byTouch && wasShown) hide();
    },
  };
}

/**
 * 舞台の中のメニュー (`OverlayMenu`・`SettingsMenu`) の決まり。**部品の初めに呼ぶ** (context と `$effect` を使う)。
 *
 * - **開いている間は操作列を残す。** 操作列は触らなくなって 2.5 秒で引っ込むが、メニューは
 *   操作列の中にあるので、選んでいる最中に**メニューごと消えて**いた。舞台の外では何もしない
 * - **メニューは舞台の枠の中に収める。** 枠の外へ出ると、上はページの見出しにかぶる。
 *   スマホの縦で全画面をやめると枠は 224px しか無く、速さのメニューが上へはみ出していた。
 *   返す枠を `Menu` の `boundary` に渡すと、入りきらなければメニューの中を巻き取る。
 *   舞台の外 (と、枠がまだ無いうち) は画面に収める
 */
export function stageMenu(
  isOpen: () => boolean,
): (() => HTMLElement | null) | undefined {
  const controls = getContext<(() => PlayerControls) | undefined>(
    PLAYER_CONTROLS,
  );
  $effect(() => {
    if (controls === undefined) return;
    controls().hold = isOpen();
    return () => {
      controls().hold = false;
    };
  });
  return getContext<(() => HTMLElement | null) | undefined>(PLAYER_STAGE);
}
