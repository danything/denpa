/**
 * **控えから、いまの放送時刻までに書かれたものを順に出す** (画面に触らない所。単体テストで見る)。
 *
 * - **前の W から今の W までに書かれたもの**を出す。W が戻った・大きく飛んだ (シーク・局の切り替え) ときは、
 *   飛んだ先から出し直す (飛んだぶんをまとめて出さない)
 * - 届いたときに W を過ぎていても 10 秒以内なら次に出す (NX-Jikkyo が公式のコメントを取り込むぶん遅れて届く)。
 *   それより古いものは出さない
 */
import { type Comment, CommentStore } from "./comments";

/** 届いたのが遅れても出す幅 */
export const LATE_MS = 10_000;
/** これより大きく W が進んだら、飛んだとみなす (再生の詰まりで 1 回に進む幅より十分大きく) */
export const JUMP_MS = 10_000;
/**
 * これより大きく W が戻ったら、飛んだとみなす。時計の合わせ直し (`clock` の通知) で W は少し戻ることがあり、
 * そのたびに流れているものを消さないように
 */
export const BACK_MS = 1_000;
/** 控えを前後 2 時間に収め直す間隔 (放送時刻の ms)。毎回見るほどのことではない */
const TRIM_EVERY = 60_000;

/** 1 回の `take` の結果 */
export interface Take {
  comments: Comment[];
  /** 飛んだ。流れているものを消して、行を空ける */
  jumped: boolean;
}

export class Cursor {
  store = new CommentStore();
  private last: number | null = null;
  private late: Comment[] = [];
  private trimmedAt = Number.NEGATIVE_INFINITY;

  /** コメントを控えに足す。`span` はその区間を埋めたことにする */
  receive(comments: readonly Comment[], span?: [number, number]): void {
    const added = this.store.add(comments, span);
    const last = this.last;
    if (last === null) return;
    // 届いたときにもう W を過ぎていたもの。10 秒以内なら次の `take` で出す
    for (const comment of added)
      if (comment.at <= last && comment.at > last - LATE_MS)
        this.late.push(comment);
  }

  /** いまの放送時刻 `w` までに書かれたもののうち、まだ出していないもの */
  take(w: number): Take {
    const last = this.last;
    if (last === null || w < last - BACK_MS || w - last > JUMP_MS) {
      this.last = w;
      this.late = [];
      return { comments: [], jumped: last !== null };
    }
    // 少し戻った・進んでいない。遅れて届いたものだけ出し、W は進めない
    const late = this.late.filter((c) => c.at > w - LATE_MS);
    this.late = [];
    if (w <= last) return { comments: late, jumped: false };
    const comments = [...late, ...this.store.between(last, w)];
    this.last = w;
    if (Math.abs(w - this.trimmedAt) > TRIM_EVERY) {
      this.trimmedAt = w;
      this.store.trim(w);
    }
    return { comments, jumped: false };
  }

  /** 流していない間 (オフ) に進んだぶんは出さない。次の `take` で出し直す */
  pause(): void {
    this.last = null;
    this.late = [];
  }

  /** 局が替わった。控えも捨てる */
  reset(): void {
    this.store = new CommentStore();
    this.pause();
  }
}
