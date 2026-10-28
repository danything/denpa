/**
 * **実況のコメントを本文と時刻だけにする**、と**時刻つきの控え** (端末の中)。
 *
 * NX-Jikkyo の WebSocket も過去ログ API も、旧ニコ生と同じ形の `chat` を返す
 * (`{ thread, no, vpos, date, date_usec, mail, user_id, premium, anonymity, content }`)。
 * 値は WebSocket が数、過去ログが文字列なので、どちらでも読む。
 * **`user_id`・`mail`・`premium`・`no` などは読んだその場で捨てる** — 持つのは本文と投稿時刻だけ
 */

/** 流すコメント。`at` は投稿時刻 (unix ms。公式のものはニコニコ、ほかは NX-Jikkyo のサーバの時計) */
export interface Comment {
  at: number;
  text: string;
}

/** 数か、数の文字列を数に。読めなければ NaN */
function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/**
 * `chat` の中身を 1 つ読む。**流さないもの** (本文が空・`/nicoad` などの運営のコメント) は null、
 * **形がずれていて読めない**ものは undefined (呼ぶ側がまとめて 1 回だけ警告する)
 */
export function toComment(chat: unknown): Comment | null | undefined {
  if (chat === null || typeof chat !== "object") return undefined;
  const raw = chat as Record<string, unknown>;
  const date = num(raw["date"]);
  const usec = raw["date_usec"] === undefined ? 0 : num(raw["date_usec"]);
  const content = raw["content"];
  if (!Number.isFinite(date) || !Number.isFinite(usec)) return undefined;
  if (typeof content !== "string") return undefined;
  const text = content.trim();
  // 運営のコメント (`/nicoad`・`/gift` など。古い過去ログに入っている) は流さない
  if (text === "" || /^\/[a-z]/.test(text)) return null;
  return { at: date * 1000 + Math.floor(usec / 1000), text };
}

/**
 * `{ chat: {...} }` の並び (過去ログ API の `packet`) を読む。`chat` 以外の行は飛ばす。
 * 形のずれた行は飛ばして、その数を返す
 */
export function readPackets(packets: unknown[]): {
  comments: Comment[];
  odd: number;
} {
  const comments: Comment[] = [];
  let odd = 0;
  for (const packet of packets) {
    if (packet === null || typeof packet !== "object" || !("chat" in packet))
      continue;
    const comment = toComment((packet as { chat: unknown }).chat);
    if (comment === undefined) odd++;
    else if (comment !== null) comments.push(comment);
  }
  return { comments, odd };
}

/** 控えに持つ長さ。前後あわせてこれを超えたら、再生位置から遠いほうから捨てる (長く観てもメモリが増え続けない) */
export const KEEP_SPAN = 2 * 60 * 60_000;

type Span = [from: number, to: number];

/**
 * **時刻つきのコメントの控え。** 観ている局 (録画) ごとに 1 つ。
 *
 * - コメントは投稿時刻の順に並べる。同じ時刻・同じ本文のものは 1 つにする (過去ログと WebSocket の
 *   境目で同じものが 2 度来る。公式から取り込んだものはどちらも同じ投稿時刻を持つ)
 * - **埋めた区間** (`[from, to)` の集まり) も持つ。過去ログに何度も同じ区間を訊かないため
 */
export class CommentStore {
  private readonly list: Comment[] = [];
  private readonly keys = new Set<string>();
  private spans: Span[] = [];

  /** 持っているコメントの数 */
  get size(): number {
    return this.list.length;
  }

  /** 一番古いコメントの時刻。空なら null */
  get first(): number | null {
    return this.list[0]?.at ?? null;
  }

  /**
   * コメントを足す。`span` を渡すと、その区間を「埋めた」ことにする (中にコメントが無くても)。
   * 足したもののうち、前から持っていなかったものを返す
   */
  add(comments: readonly Comment[], span?: Span): Comment[] {
    const added: Comment[] = [];
    for (const comment of comments) {
      const key = `${comment.at}\u0000${comment.text}`;
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      this.list.splice(this.after(comment.at), 0, comment);
      added.push(comment);
    }
    if (span !== undefined && span[0] < span[1]) this.mark(span);
    return added;
  }

  /** `from < at ≤ to` のコメント (時刻の順) */
  between(from: number, to: number): Comment[] {
    return this.list.slice(this.after(from), this.after(to));
  }

  /** `[from, to)` のうち、まだ埋めていない区間 */
  missing(from: number, to: number): Span[] {
    const gaps: Span[] = [];
    let at = from;
    for (const [start, end] of this.spans) {
      if (end <= at) continue;
      if (start >= to) break;
      if (start > at) gaps.push([at, start]);
      at = Math.max(at, end);
      if (at >= to) break;
    }
    if (at < to) gaps.push([at, to]);
    return gaps;
  }

  /**
   * 前後あわせて `KEEP_SPAN` に収める。`center` (いまの放送時刻) を含む窓を残し、
   * 外のコメントと埋めた区間を捨てる
   */
  trim(center: number): void {
    const first = this.list[0]?.at;
    const last = this.list[this.list.length - 1]?.at;
    if (first === undefined || last === undefined) return;
    if (last - first <= KEEP_SPAN) return;
    let lo = center - KEEP_SPAN / 2;
    let hi = center + KEEP_SPAN / 2;
    if (first > lo) [lo, hi] = [first, first + KEEP_SPAN];
    else if (last < hi) [lo, hi] = [last - KEEP_SPAN, last];
    const keep = this.list.filter((c) => c.at >= lo && c.at <= hi);
    for (const comment of this.list)
      if (comment.at < lo || comment.at > hi)
        this.keys.delete(`${comment.at}\u0000${comment.text}`);
    this.list.splice(0, this.list.length, ...keep);
    this.spans = this.spans
      .map(([start, end]): Span => [Math.max(start, lo), Math.min(end, hi)])
      .filter(([start, end]) => start < end);
  }

  /** `at` より後ろに来る最初の位置 (同じ時刻のものの後ろ) */
  private after(at: number): number {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.list[mid]!.at <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private mark(span: Span): void {
    const all = [...this.spans, span].sort((a, b) => a[0] - b[0]);
    const merged: Span[] = [];
    for (const [start, end] of all) {
      const last = merged[merged.length - 1];
      if (last !== undefined && start <= last[1])
        last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    this.spans = merged;
  }
}
