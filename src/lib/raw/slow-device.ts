/**
 * **MPEG-2 のデコードが間に合わずに打ち切った端末を覚える** (`budget.ts`)。覚えている間は「自動」で MPEG-2 を選ばない
 * (ライブ・追っかけ・録画の観る画面で同じ)。
 *
 * デコードの速さは端末で決まり、開き直しても変わらない。画面を開いている間だけ覚えていた頃は、開き直すたびに MPEG-2 から
 * 始まって数十秒〜数分で打ち切り、そのたびに映像が 1 秒ほど止まって断り書きが出ていた (Galaxy S25 のブラウザ)。
 *
 * - 置き場は localStorage のキー 1 つ (`keep.ts`)。値は打ち切った時刻 (ms)
 * - 覚えるのは `SLOW_KEEP` (30 日) まで。ブラウザやデコーダが新しくなると間に合うようになることがあるので、ずっとは外さない
 * - メニューで MPEG-2 を選ぶと忘れて試し直す。また打ち切れば覚え直す。選んだ MPEG-2 はこの記憶では外さない
 * - 覚えるのは間に合わなかったときだけ。デコーダが無い・音が来ないのは、サーバや回線の都合のこともあるので覚えない
 */

import { forget, read, write } from "#lib/keep.js";

const SLOW_KEY = "raw-slow";
/** 覚えておく長さ (ms) */
export const SLOW_KEEP = 30 * 24 * 60 * 60 * 1000;

/** 覚えた値 (打ち切った時刻 ms の文字列) が、`now` の時点でまだ効いているか */
export function slowAt(saved: string | null, now: number): boolean {
  if (saved === null) return false;
  const at = Number(saved);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now >= at && now - at < SLOW_KEEP;
}

/** この端末で MPEG-2 を打ち切ったことを覚えているか */
export function slowDevice(now = Date.now()): boolean {
  return slowAt(read(SLOW_KEY), now);
}

/** 打ち切ったことを覚える */
export function rememberSlow(now = Date.now()): void {
  write(SLOW_KEY, String(now));
}

/** 忘れる (メニューで MPEG-2 を選んだとき) */
export function forgetSlow(): void {
  forget(SLOW_KEY);
}
