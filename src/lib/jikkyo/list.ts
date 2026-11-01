/**
 * **右の列の「コメントの一覧」の決まり** (画面に触らない所。単体テストで見る)。部品は `JikkyoList.svelte`。
 *
 * - 並べるのは、いまの放送時刻 `W` までに書かれたもののうち新しいほうから `LIST_MAX` 件 (`data-lite` の端末では `LIST_MAX_LITE`)。
 *   流れるほうと同じ `W` で控えを読み直すので、シーク・巻き戻し・CM を切った録画にもそのまま合う。流れるほうで行が足りずに
 *   捨てたものも並ぶ。遅れて届いたものも、読み直したときに時刻の位置へ入る
 * - 新しいものが下。「いま」(`W` までの行の下の端が、見えている所の下の端) にいる間は付いていき、巻いて離れた・
 *   指やポインタやフォーカスが乗っている間は止める
 * - **録画では、`W` より後に書かれたもの (この先) も「いま」の下に並べる** (観る画面は録画の終わりまで、追っかけは録れているところまで)。
 *   下へ巻かなければ見えない (先を見せない)。古いほうから `LIST_AHEAD` 件ずつ、下の端に近づいたら足す (`LIST_SPAN` 先まで)
 * - 勢いは `W` までの 1 分に書かれたものの数 (録画でも同じ)
 */
import { pad } from "../format";
import type { Comment } from "./comments";

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
/** この先を一度に並べる件数 (一覧の高さの 3 画面ほど)。下の端に近づいたら同じだけ足し、並べる件数の上限で止める */
export const LIST_AHEAD = 30;
/**
 * 一覧から行を押して飛んだあと、これだけの間は乗っていても並べ直す (ms)。前へ少し飛んだだけでは「飛んだ」(`jumped`) にならず、
 * 押したポインタは一覧に乗ったままなので、並びが飛ぶ前のまま残ってしまう
 */
export const LIST_SEEK_SETTLE = 1_000;
/** 「いま」の巻き位置からこれだけなら、「いま」にいるとみなす (px。端数の丸めで 1px ずれても外れないように) */
export const BOTTOM_SLACK = 8;

/**
 * 「いま」の巻き位置 (`scrollTop`)。この先が無ければいちばん下。あれば、`W` までの行の下の端が見えている所の下の端に来る所
 * (この先は下の外に隠れる)
 */
export function nowTop(
  box: { scrollHeight: number; clientHeight: number },
  /** `W` までの行の下の端 (巻く中身の頭から px)。この先が無ければ null */
  past: number | null,
): number {
  const most = Math.max(0, box.scrollHeight - box.clientHeight);
  return past === null
    ? most
    : Math.min(most, Math.max(0, past - box.clientHeight));
}

/** 「いま」にいるか (上へも下へも巻いて離れていない)。この先が無ければ、いちばん下まで巻いてあるか */
export function atNow(scrollTop: number, now: number): boolean {
  return Math.abs(scrollTop - now) <= BOTTOM_SLACK;
}

/** 下の端まで 1 画面を切ったか (この先を足す) */
export function nearEnd(box: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return (
    box.scrollHeight - box.scrollTop - box.clientHeight <= box.clientHeight
  );
}

/**
 * この先を足すときに求める件数。並べたもの (`shown`) が求めた件数 (`want`) に届いていなければ、端まで並べてあるのでそのまま。
 * 並べる件数の上限 (`most`) で止める
 */
export function moreAhead(want: number, shown: number, most: number): number {
  return shown < want ? want : Math.min(most, want + LIST_AHEAD);
}

/**
 * 並べ直して「いま」へ付いていくか。「いま」にいて (`stuck`)、一覧を使っていない (`held`) ときだけ。
 * 使っている間に増えたぶんは、離れてから付いていく。まだ 1 行も無ければ (`shown` が 0) いつも付いていく
 * (守る読みかけが無い。乗ったまま初めての行が来ても、頭に並べたまま待たない)。
 * 一覧から押して飛んだ直後 (`settling`) は、乗っていても付いていく (`LIST_SEEK_SETTLE`。その間にホイール・指・キーで巻けばやめる)
 */
export function follows(
  stuck: boolean,
  held: boolean,
  shown: number,
  settling = false,
): boolean {
  return shown === 0 || settling || (stuck && !held);
}

/** 同じ行の並びか (読み直すたびに描き直さないように)。控えは足すだけなので、件数と両端で分かる */
export function sameRows(
  a: readonly Comment[],
  b: readonly Comment[],
): boolean {
  return a.length === b.length && a[0] === b[0] && a.at(-1) === b.at(-1);
}

/** 書かれた時刻 (放送時刻の h:mm:ss。端末の時計の時間帯で) */
export function airClock(at: number): string {
  const d = new Date(at);
  return `${d.getHours()}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
