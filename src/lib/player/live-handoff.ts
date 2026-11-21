/**
 * **ライブの段を替えるときの受け渡し** (`live-player.svelte.ts` の `stageStep`。docs/stream.md「段を替えるときは、裏の `<video>` で用意してから入れ替えます」)。
 *
 * いまの段を映したまま、別の WebSocket で次の段をリクエストし、裏の `<video>` (透明・消音) の MSE に溜める。
 * 裏は表の少し先 (`LIVE_HANDOFF_LEAD`) で止めて待ち、そのコマをデコードできて、表の再生がそこまで来たら入れ替える。
 *
 * 表と裏は別の ffmpeg がエンコードしたもので、物差しの 0 が違う。サーバが送る時計 (`clock` の通知。物差しの位置と
 * サーバが受け取った時刻の組) で、裏の位置を表の物差しに直して比べる (`spareOffset`)。
 * ここでは、いま映している側を「表」、用意している側を「裏」と書く。DOM には触らない
 */

/**
 * 表の位置から、裏を待たせる先 (秒)。**ライブの裏は表とほぼ同じ所までしか持たない** (どちらも放送の今を実時間で受ける)。
 * 表の手元のバッファは 0.2 秒ほど (`ts/pacing.ts` の `FLOOR`) なので、それより先には待たせられない。裏のシークが終わる間に足りる短さにする
 */
export const LIVE_HANDOFF_LEAD = 0.1;
/** 位置のずれを同じとみなす幅 (秒。30 コマ/秒の 1 コマ強。`handoff.ts` と同じ) */
const SLACK = 0.05;

/** 物差しの位置 `at` (秒) と、そのコマをサーバが受け取った時刻 (unix ms。`clock` の通知) */
export interface StreamClock {
  at: number;
  unixMs: number;
}

/**
 * 裏の物差しの位置に足すと表の物差しの位置になる量 (秒)。同じ局の同じ放送の時計 (PCR) から作った組なので、
 * 受け取った時刻を介して突き合わせられる
 */
export function spareOffset(front: StreamClock, spare: StreamClock): number {
  return front.at - spare.at + (spare.unixMs - front.unixMs) / 1000;
}

/** 位置はどれも表の物差しに直したもの (秒) */
export interface LiveHandoffState {
  /** 表の位置 */
  at: number;
  /** 裏を待たせている位置。まだ待たせていなければ null */
  target: number | null;
  /** 裏が持っている先頭と末尾。まだ何も無ければ null */
  start: number | null;
  end: number | null;
  /** 裏の位置 */
  spareAt: number;
  /** 裏が `spareAt` のコマをデコードできている (シークしていない) */
  ready: boolean;
}

export type LiveHandoffStep =
  /** 待つ */
  | { kind: "wait" }
  /** 裏を `to` へシークして待たせる */
  | { kind: "seat"; to: number }
  /** 表と裏を入れ替える (裏を再生する) */
  | { kind: "switch" };

const WAIT: LiveHandoffStep = { kind: "wait" };

/**
 * **いますること。** 裏が表の少し先を持ったら、そこで待たせる。裏の先頭が表より先なら先頭で待たせ、表が来るのを待つ
 * (間を飛ばさない)。表が待たせた位置を過ぎた (裏が間に合わなかった) ら待たせ直す。表がそこまで来たら入れ替える
 */
export function liveHandoff(state: LiveHandoffState): LiveHandoffStep {
  const { at, target, start, end } = state;
  if (start === null || end === null) return WAIT;
  if (target === null || at > target + SLACK) {
    const want = Math.max(at + LIVE_HANDOFF_LEAD, start + SLACK);
    // 裏にまだそこまで届いていない。届くのを待つ
    if (want > end) return WAIT;
    return { kind: "seat", to: want };
  }
  const there = state.ready && Math.abs(state.spareAt - target) <= SLACK;
  if (!there) return WAIT;
  return at >= target - SLACK ? { kind: "switch" } : WAIT;
}
