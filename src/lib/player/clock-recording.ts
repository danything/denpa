/**
 * **観る画面の時間の軸 (Clock)。尺があり、続きの位置・場面から始める** ([watch.md](../../../docs/watch.md))。
 *
 * ライブ (`clock-live.svelte.ts`) は放送の今へ寄せ、追っかけ (`clock-chase.svelte.ts`) は録れている所まで伸びる。
 * 録画は尺が決まっていて、開く位置が 3 つある。形式・段を選び直して作り直すときの位置 (`switchAt`)、
 * 切り抜きの画面から「この場面から観る」位置 (`?at=`)、どこまで観たか (続きの位置。`ts/watch.ts` の `resumePoint`)。
 * 位置を動かすのは画面で、ここはどこから始めるかを決めるだけ (DOM に触らない)
 */

import { resumePoint } from "#lib/ts/watch.js";

/** 開いたときに出す位置 (`RecordingClock.opening`) */
export interface Opening {
  at: number;
  /** 続きの位置から始めたか (「続きから」を出す)。この場面から観るときは false */
  continued: boolean;
}

export class RecordingClock {
  /** 選び直したときに続ける位置 (秒)。プレイヤーの開始位置に使い、1 度読んだら忘れる */
  switchAt: number | null = null;
  /** 「この場面から観る」で始める位置 (秒)。続きの位置より先に使い、1 度使ったら忘れる。続きからではないので「続きから」とは言わない */
  sceneAt: number | null;

  /** `resumeMs` はどこまで観たか (ms。サーバが覚えている。無ければ null) */
  constructor(
    sceneAt: number | null,
    private readonly resumeMs: () => number | null,
  ) {
    this.sceneAt = sceneAt;
  }

  /** 続きの位置 (秒)。尺 `duration` の終わり近くまで観ていたら、もう続きにしない (`resumePoint`)。無ければ null */
  private resumeAt(duration: number): number | null {
    const ms = this.resumeMs();
    return ms === null ? null : resumePoint(ms / 1000, duration);
  }

  /**
   * プレイヤーを作るときに始める位置 (秒)。切り替えた所か、この場面から観る位置か、続きの位置。先頭からなら null。
   * **切り替えた所とこの場面の位置は 1 度読んだら忘れる**
   */
  startFrom(duration: number): number | null {
    const from = this.switchAt ?? this.sceneAt ?? this.resumeAt(duration);
    this.switchAt = null;
    this.sceneAt = null;
    return from;
  }

  /**
   * 尺が分かったとき (`loadedmetadata`) に出す位置。この場面から観る位置か、続きの位置。無ければ null。
   * この場面の位置は 1 度読んだら忘れる
   */
  opening(duration: number): Opening | null {
    if (this.sceneAt !== null) {
      const at = this.sceneAt;
      this.sceneAt = null;
      return { at, continued: false };
    }
    const at = this.resumeAt(duration);
    return at === null ? null : { at, continued: true };
  }
}
