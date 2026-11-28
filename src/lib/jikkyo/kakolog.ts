/**
 * **録画の実況のコメント (過去ログ) を denpa のサーバから取得する。** サーバは denpa-hub に渡し、hub がニコニコ実況 過去ログ API から取得して
 * まとめて持つ (端末は外へ繋がない。`/api/jikkyo/kakolog`)。hub の独自コメントも同じ返事に入る。
 *
 * - 運営者の負担を考え、細かく何度も取らない。録画は開いたときに 1 回で全区間を取り、録画中の追っかけは 5 分おきに新しいところだけ取り足す (`feed.svelte.ts`)
 * - 1 回に 3 日まで (過去ログ API の決まり)。`to` は今で切る
 * - 返事の `complete` が false なら、hub が過去ログ API から取得しきれなかった所がある。取れた分は流し、埋めたことにはしない (60 秒後に取り直す)
 */
import { type LiveComment, readLiveComment } from "./live";

/** 過去ログに入るまでの遅れ。5 分おきに集め、集めるのに 3 分ほどかかる (案内ページ) のに余裕を足した */
export const KAKOLOG_LAG = 10 * 60_000;
/** 1 回に取ってよい長さ */
const MAX_SPAN = 3 * 24 * 60 * 60_000;

/** `[from, to)` を取る (unix ms)。`to` は `now` で切る。形式のずれた行の数と、取りきれたかも返す */
export async function fetchKakolog(
  url: string,
  channel: string,
  from: number,
  to: number,
  opts: { now?: number; fetch?: typeof fetch } = {},
): Promise<{ comments: LiveComment[]; odd: number; complete: boolean }> {
  const now = opts.now ?? Date.now();
  const get = opts.fetch ?? fetch;
  const end = Math.min(to, now);
  const comments: LiveComment[] = [];
  let odd = 0;
  let complete = true;
  for (let start = from; start < end; start += MAX_SPAN) {
    const stop = Math.min(start + MAX_SPAN, end);
    const query = new URLSearchParams({
      channel,
      from: String(Math.floor(start)),
      to: String(Math.ceil(stop)),
    });
    const res = await get(`${url}?${query}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      comments?: unknown;
      complete?: unknown;
    };
    if (!Array.isArray(body.comments))
      throw new Error("過去ログの返事の形式が違います");
    if (body.complete !== true) complete = false;
    for (const raw of body.comments as unknown[]) {
      const comment = readLiveComment(raw);
      if (comment === undefined) odd++;
      else if (comment !== null && comment.at >= start && comment.at < stop)
        comments.push(comment);
    }
  }
  return { comments, odd, complete };
}
