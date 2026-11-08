/**
 * **段を替えるときの受け渡し** (観る画面の `prepareStep`。docs/player.md「観る画面は回線に合わせて画質の段を替えます」)。
 *
 * プレイヤーを作り直す段の切り替え (ファイルの直再生・MPEG-2 と変換の行き来、段 0 へ戻す、音声だけとの行き来) は、
 * いまのプレイヤーを映したまま、裏の `<video>` (透明・消音) で次の観かたを用意する。裏は少し先の位置 (`HANDOFF_LEAD`)
 * で止めて待ち、そのコマをデコードできて、表の再生がそこまで来たら、同じコマの間に表と裏を入れ替える。
 * 黒いコマも、止まった間も出さない。
 *
 * ここでは、いま映しているプレイヤーを「表」、用意している `<video>` を「裏」と書く。
 * いまの様子からすることを 1 つ決めるだけ (DOM に触らない)。毎コマ呼ぶ
 */

/** 表が進んでいるとき、裏を待たせる位置の先読み (秒)。変換の立ち上がり (ffmpeg が最初の塊を出すまで 1〜2 秒) より長く */
export const HANDOFF_LEAD = 3;
/** 裏がこれだけ (ms) たっても入れ替えられなければ、裏をやめる (呼ぶ側は作り直しに戻す) */
export const HANDOFF_GIVE_UP = 15_000;
/** 位置のずれを同じとみなす幅 (秒。30 コマ/秒の 1 コマ強) */
const HANDOFF_SLACK = 0.05;
/** 表が詰まってこれだけ (ms) 進まなければ、先で待たせるのをやめて、表の位置で入れ替える */
export const HANDOFF_STUCK = 2_000;

export interface HandoffState {
  /** 裏が `spareAt` のコマをデコードできている (シークしていない) */
  ready: boolean;
  /** 裏の位置 (秒) */
  spareAt: number;
  /** 裏を待たせている位置 (秒) */
  target: number;
  /** 表の位置 (秒) */
  at: number;
  /** 表を止めている (人が止めた) */
  paused: boolean;
  /** 表が詰まって進まなくなってからの長さ (ms)。進んでいれば 0 */
  stuckFor: number;
}

export type HandoffStep =
  /** 待つ */
  | { kind: "wait" }
  /** 裏を `to` へシークして待たせ直す */
  | { kind: "retarget"; to: number }
  /** 表と裏を入れ替える。`play` なら裏を再生する */
  | { kind: "switch"; play: boolean };

/** 裏を待たせる位置。表が進んでいれば先読みのぶん先、止まっていれば表の位置 */
export function handoffTarget(at: number, moving: boolean): number {
  return moving ? at + HANDOFF_LEAD : at;
}

/**
 * **いますること。** 表が待たせた位置まで来たら入れ替える。表が止まっている・詰まっているなら、表の位置で待たせて入れ替える
 * (先で入れ替えると、間の数秒を飛ばす)。表が先へ行きすぎた (裏が間に合わなかった・飛んだ) か、後ろへ飛んだなら待たせ直す
 */
export function handoff(state: HandoffState): HandoffStep {
  const { at, target } = state;
  const stuck = state.stuckFor > 0;
  const moving = !state.paused && !stuck;
  // 表が待たせた位置を過ぎた・後ろへ飛んだ。いまの位置から待たせ直す
  if (at > target + HANDOFF_SLACK || target - at > HANDOFF_LEAD + 0.5)
    return { kind: "retarget", to: handoffTarget(at, moving) };
  /*
   * 人が止めた・しばらく詰まったまま。先で待たせていたら表の位置へ戻す。
   * 詰まってすぐは戻さない (すぐ流れ出すことが多く、戻すと裏がリクエストし直しになる)
   */
  const halted = state.paused || state.stuckFor >= HANDOFF_STUCK;
  if (halted && target - at > HANDOFF_SLACK)
    return { kind: "retarget", to: at };
  const there =
    state.ready && Math.abs(state.spareAt - target) <= HANDOFF_SLACK;
  if (!there) return { kind: "wait" };
  if (halted) return { kind: "switch", play: !state.paused };
  return at >= target - HANDOFF_SLACK
    ? { kind: "switch", play: true }
    : { kind: "wait" };
}
