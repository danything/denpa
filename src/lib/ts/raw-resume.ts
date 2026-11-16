/**
 * **元の TS (MPEG-2) をどこまで受け取ったか** (`canvas-player.ts` の `ts-mpeg2`)。録画を流している途中で接続が切れたら、
 * 受け取ったバイトの続きから `/stream?codec=mpeg2&offset=` でリクエストし直す。手元に溜まっているぶんは捨てずに再生し続け、
 * 続きが届けば継ぎ目なく繋がる (捨てて秒で探し直すと、切れるたびに止まって見える)。
 *
 * - 続きはバイト単位でちょうど続くので、継ぎ目でパケットが重なることも欠けることもない。パケット (188 バイト) の途中で
 *   切れても、続きはその途中から届く (worker の TS を読む側は、塊の切れ目がパケットの切れ目でなくても読める)
 * - 位置は応答の `X-Denpa-Offset` (流し始めたバイト位置) に、エンジンへ渡したバイト数を足したもの
 * - 続きの応答は、物差しの 0 (`X-Denpa-Origin`) と流し始めた位置が前と同じときだけ使う。違えば (ファイルが替わった)
 *   続きとしては使わず、観ていた位置から読み直す
 */

import { OFFSET_HEADER, ORIGIN_HEADER } from "./playback";

/** 元の TS を流す応答のヘッダで分かること */
export interface RawHeard {
  /** 物差しの 0 にあたる PTS (`ORIGIN_HEADER`) */
  origin: number;
  /** 流し始めたバイト位置 (`OFFSET_HEADER`)。無ければ null (続きはリクエストできない) */
  offset: number | null;
}

/** 応答のヘッダを読む。物差しの 0 が無ければ null (時刻を物差しに直せない) */
export function rawHeard(headers: Headers): RawHeard | null {
  const head = headers.get(ORIGIN_HEADER);
  const origin = head === null ? Number.NaN : Number(head);
  if (!Number.isFinite(origin)) return null;
  const at = headers.get(OFFSET_HEADER);
  const offset = at === null ? Number.NaN : Number(at);
  return {
    origin,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : null,
  };
}

export class RawCursor {
  private origin: number | null = null;
  private next: number | null = null;

  /** 続きをリクエストする位置 (バイト)。分からなければ null (観ていた位置から読み直す) */
  get resumeAt(): number | null {
    return this.next;
  }

  /** 飛んだ・読み直す。続きは無い */
  clear(): void {
    this.origin = null;
    this.next = null;
  }

  /**
   * 応答を受けた。`at` は続きとしてリクエストした位置で、飛んだあとの最初のリクエストなら null。
   * **続きとして使えなければ false** (物差しの 0 か流し始めた位置が違う)。そのときは続きを忘れる
   */
  open(heard: RawHeard, at: number | null): boolean {
    if (at === null) {
      this.origin = heard.origin;
      this.next = heard.offset;
      return true;
    }
    if (heard.origin === this.origin && heard.offset === at) return true;
    this.clear();
    return false;
  }

  /** `bytes` バイトをエンジンへ渡した */
  take(bytes: number): void {
    if (this.next !== null) this.next += bytes;
  }
}
