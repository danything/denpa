/**
 * **追っかけを元の TS (MPEG-2) で受けるときの決まり** (`live-player.svelte.ts`)。画面に依らないので分けて試す。
 *
 * - 受信バッファの量でサーバに送るのを止めさせる・続けさせる (`nextHold`。`{ type: 'hold' }`)
 * - 届いた PTS から通しの再生位置を出す (`rawChasePosition`)
 */

import { CLOCK, WRAP } from "@danything/arib/pes";

import { sinceHead } from "./ts/seek";

/**
 * 受信バッファがこれ (秒) を超えたらサーバに送るのを止めさせる。worker が圧縮のまま持てる 30 秒
 * (`raw/worker.ts` の `FOLLOW_PENDING_MOST`) より手前で止め、`full` まで行かせない
 */
export const HOLD_ABOVE = 20;
/** 止めさせたあと、受信バッファがこれ (秒) を切ったら送り直させる。倍速で届くので、尽きるまでに十分間に合う */
export const RESUME_BELOW = 10;

/**
 * **サーバに送るのを止めさせておくか。** 一時停止している間と、受信バッファが `HOLD_ABOVE` を超えたら止めさせ、`RESUME_BELOW` を
 * 切ったら続けさせる。間 (10〜20 秒) では今のまま (行き来させない)
 *
 * @param held いま止めさせているか
 * @param lead 受信バッファにあと何秒ぶんあるか (`RawEngine.lead`)
 * @param paused 止めているか
 */
export function nextHold(
  held: boolean,
  lead: number,
  paused: boolean,
): boolean {
  if (paused || lead > HOLD_ABOVE) return true;
  if (lead < RESUME_BELOW) return false;
  return held;
}

/**
 * **通しの再生位置から `base` を引いた秒。** 届いた PTS (`at`。秒。一周を伸ばしてあってよい) から録画の先頭の PTS
 * (`origin`。90kHz。`timeline` の `origin`) を引く (観る画面の MPEG-2 と同じ `sinceHead`)。バイト数から割り出した
 * `base` より正しい
 */
export function rawChasePosition(
  at: number,
  base: number,
  origin: number,
): number {
  return sinceHead(Math.round(at * CLOCK) % WRAP, origin) - base;
}

/**
 * **1 刻みぶんの止めさせる・続けさせる。** `nextHold` で決めた向きが今と違えば `send` で伝え、**送れたときだけ**新しい向きを返す。
 * 繋ぎ直している間 (WebSocket が開く前) は送れないので今のまま返し、繋がってから次の刻みで送り直す。送れなかったのに
 * 送ったつもりになると、`on: true` が届かないままサーバが送り込み続ける
 *
 * @param send 指示を送る。送れたかを返す (`live-player.svelte.ts` の `send`)
 * @returns 送ったあとの向き (サーバに止めさせているか)
 */
export function holdStep(
  held: boolean,
  lead: number,
  paused: boolean,
  send: (on: boolean) => boolean,
): boolean {
  const next = nextHold(held, lead, paused);
  if (next === held) return held;
  return send(next) ? next : held;
}
