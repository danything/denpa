import { pad } from "../format";
/**
 * **右の列の「コメントの一覧」の決まり** (画面に触らない所。単体テストで見る)。部品は `JikkyoList.svelte`。
 *
 * - 並べるのは、いまの放送時刻 `W` までに書かれたもののうち新しいほうから `LIST_MAX` 件 (`data-lite` の端末では `LIST_MAX_LITE`)。
 *   流れるほうと同じ `W` で控えを読み直すので、シーク・巻き戻し・CM を切った録画にもそのまま合う。流れるほうで行が足りずに
 *   捨てたものも並ぶ。遅れて届いたものも、読み直したときに時刻の位置へ入る
 * - 新しいものが下。いちばん下にいる間は下へ付いていき、上へ巻いた・指やポインタやフォーカスが乗っている間は止める
 * - 勢いは `W` までの 1 分に書かれたものの数 (録画でも同じ)
 */
import type { Comment } from "./comments";
import { BACK_MS, JUMP_MS } from "./cursor";

/** 並べるのは `W` からこれだけ前まで (静かな局でも何件かは並ぶように長めに。見るのは新しいほうから要るぶんだけ) */
export const LIST_SPAN = 30 * 60_000;
/** 並べる件数 */
export const LIST_MAX = 200;
/** 並べる件数 (`data-lite` の端末。行を描くのが重い) */
export const LIST_MAX_LITE = 50;
/** 読み直す間隔 (ms)。流れるほう (0.1 秒) ほど細かくなくてよい */
export const LIST_EVERY = 250;
/** 勢いを数える幅 (1 分あたりのコメント数) */
export const FORCE_SPAN = 60_000;
/** これだけ下の端に近ければ、いちばん下にいるとみなす (px。端数の丸めで 1px ずれても外れないように) */
export const BOTTOM_SLACK = 8;

/** いちばん下まで巻いてあるか */
export function atBottom(box: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= BOTTOM_SLACK;
}

/**
 * 並べ直したあと、いちばん下へ付いていくか。いちばん下にいて (`stuck`)、一覧を使っていない (`held`) ときだけ。
 * 使っている間に増えたぶんは、離れてから付いていく
 */
export function follows(stuck: boolean, held: boolean): boolean {
  return stuck && !held;
}

/** 同じ行の並びか (読み直すたびに描き直さないように)。控えは足すだけなので、件数と両端で分かる */
export function sameRows(
  a: readonly Comment[],
  b: readonly Comment[],
): boolean {
  return a.length === b.length && a[0] === b[0] && a.at(-1) === b.at(-1);
}

/** 行の鍵。控えも同じ時刻・同じ本文のものを 1 つにしている */
export function rowKey(comment: Comment): string {
  return `${comment.at}\u0000${comment.text}`;
}

/** 書かれた時刻 (放送時刻の h:mm:ss。端末の時計の時間帯で) */
export function airClock(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 放送時刻が飛んだか (シーク・局の切り替え。流すほうの `Cursor` と同じ幅)。飛んだら、上へ巻いていても
 * いちばん下 (飛んだ先のいま) へ戻す
 */
export function jumped(last: number | null, w: number): boolean {
  return last !== null && (w < last - BACK_MS || w - last > JUMP_MS);
}
