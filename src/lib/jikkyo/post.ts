/**
 * **NX-Jikkyo へ書き込むときの決まり** (画面に触らない所。単体テストで見る)。送るのは `nx.ts` の `post`、
 * 画面は `JikkyoCompose`。決まりの理由は docs/watch.md の「実況に書き込む」。
 *
 * - 長さは 60 文字まで (書記素で数える。絵文字や結合文字も 1 文字)。NX-Jikkyo のサーバは長さを確かめないので、
 *   NX-Jikkyo と KonomiTV の書き込みの欄 (どちらも tsukumijima さんの DPlayer v1.33 の `maxlength="60"`) に合わせた。
 *   あちらは UTF-16 の単位で数えるので、絵文字の多いものはこちらのほうが少し長く書ける
 * - 空・空白だけ・改行や制御文字を含むもの、`/` と英小文字で始まるもの (運営のコメントの形) は送らない
 * - 端末ごとに 3 秒以上空ける。NX-Jikkyo は 0.5 秒以内の連投を成功に見せて黙って捨て、それが 3 回を超えると
 *   その接続の書き込みをすべて捨てる
 * - 書けるのはライブで「いま」に追い付いているとき (映しているコマが放送の今から 30 秒以内) だけ
 */

/** 長さの上限 (書記素。上の説明) */
export const MAX_LENGTH = 60;
/** 残りの字数を出し始める所 (残りがこれを切ったら) */
export const SHOW_LEFT = 10;
/** 次に送れるまでの間 (ms) */
export const POST_GAP = 3_000;
/** 返事を待つ長さ (ms)。過ぎたら「送れたか分かりません」 */
export const REPLY_WAIT = 5_000;
/** 「いま」に追い付いているとみなす遅れ (秒) */
export const CAUGHT_UP = 30;
/** 自分の書き込みが戻ってきたものを捨てる間 (ms)。送れてからこの間に、本文が同じものを 1 回だけ */
export const ECHO_SPAN = 60_000;

/** 書いた結果。`sent` のほかは本文を欄に残す */
export type PostResult =
  /** 受け付けられた */
  | "sent"
  /** 5 秒待っても返事が無い・待っている間に切れた */
  | "unknown"
  /** スレッドが替わった (`NOT_ON_AIR`) */
  | "not-on-air"
  /** 受け付けられなかった (`INVALID_MESSAGE`) */
  | "rejected"
  /** 繋がっていない・前のものの返事を待っている */
  | "closed";

let segmenter: Intl.Segmenter | null = null;

/** 書記素の数 */
export function graphemes(text: string): number {
  segmenter ??= new Intl.Segmenter("ja", { granularity: "grapheme" });
  return Array.from(segmenter.segment(text)).length;
}

/** 改行・制御文字 (結合に使う ZWJ などの書式の文字は含めない。絵文字が組めなくなる) */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * 送れない理由 (画面に 1 行で出す)。送れるなら null。空・空白だけは空の文字 (言うことは無いが、送れない)。
 * 送るのは前後の空白を落とした本文
 */
export function refusal(text: string): string | null {
  const body = text.trim();
  if (body === "") return "";
  if (CONTROL.test(text)) return "改行や制御文字は送れません";
  if (/^\/[a-z]/.test(body)) return "「/」と英小文字で始まるものは送れません";
  if (graphemes(body) > MAX_LENGTH) return `${MAX_LENGTH} 文字までです`;
  return null;
}

/** 映しているコマが「いま」に追い付いているか。`lag` は放送からの遅れ (秒。分からなければ null) */
export function caughtUp(lag: number | null, paused: boolean): boolean {
  return !paused && lag !== null && lag <= CAUGHT_UP;
}

/** 書き込みの `vpos` (スレッドの頭 `vposBaseTime` からの 1/100 秒) */
export function vpos(now: number, base: number): number {
  return Math.round((now - base) / 10);
}

/** 送る間隔。**端末の中で 1 つ** (下の `spacing`)。送るたびに `mark` し、次は `left` が 0 になってから */
export class Spacing {
  private last = Number.NEGATIVE_INFINITY;

  /** 次に送れるまでの残り (ms)。0 なら送れる */
  left(now: number): number {
    return Math.max(0, this.last + POST_GAP - now);
  }

  mark(now: number): void {
    this.last = now;
  }
}

/** 端末の中で 1 つの間隔 (局を替えて繋ぎ直しても数え直さない) */
export const spacing = new Spacing();

/**
 * **自分の書き込みが戻ってきたものを 1 回だけ捨てる。** 送れたらすぐ自分で流すので、NX-Jikkyo から
 * `yourpost: 1` で戻ってくる同じものは流さない。送ってから `ECHO_SPAN` の間に、本文が同じものを 1 件ずつ
 */
export class Echoes {
  private readonly waiting: { text: string; until: number }[] = [];

  /** 送った (返事の前に戻ってくることもあるので、送るときに覚える) */
  expect(text: string, now: number): void {
    this.waiting.push({ text, until: now + ECHO_SPAN });
  }

  /** 送れなかった。覚えたものを 1 つ忘れる */
  forget(text: string): void {
    const at = this.waiting.findIndex((w) => w.text === text);
    if (at >= 0) this.waiting.splice(at, 1);
  }

  /** 戻ってきた自分の書き込み。覚えていたものなら忘れて true (捨てる) */
  take(text: string, now: number): boolean {
    for (let i = this.waiting.length - 1; i >= 0; i--)
      if (this.waiting[i]!.until < now) this.waiting.splice(i, 1);
    const at = this.waiting.findIndex((w) => w.text === text);
    if (at < 0) return false;
    this.waiting.splice(at, 1);
    return true;
  }
}
