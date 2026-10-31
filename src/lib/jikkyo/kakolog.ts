/**
 * **ニコニコ実況 過去ログ API から取得する** (端末から直接。CORS は `*`。denpa のサーバは通らない)。
 *
 * - 運営者の負担を考え、細かく何度も取らない。API はリクエストのたびに Hugging Face から日のファイルを読む。
 *   録画は開いたときに 1 回で全区間を取り、録画中の追っかけは 5 分おきに新しいところだけ取り足す (`feed.svelte.ts`)
 * - 1 回に 3 日まで。`endtime` は今より後にできない (誤りになる) ので切る
 * - 誤りも HTTP 200 で `{"error": …}` が返る。`{"packet": []}` は誤りではなく「コメントなし」
 * - `credentials: "omit"`・`referrerPolicy: "no-referrer"` で呼ぶ (Cookie も denpa のページの URL も渡さない)
 */
import { type Comment, readPackets } from "./comments";
import { kakologUrl } from "./endpoints";

/** 過去ログに入るまでの遅れ。5 分おきに集め、集めるのに 3 分ほどかかる (案内ページ) のに余裕を足した */
export const KAKOLOG_LAG = 10 * 60_000;
/** 1 回に取ってよい長さ */
const MAX_SPAN = 3 * 24 * 60 * 60_000;

/** `[from, to)` を取る (unix ms)。`to` は `now` で切る。形式のずれた行の数も返す */
export async function fetchKakolog(
  channel: string,
  from: number,
  to: number,
  opts: { now?: number; fetch?: typeof fetch } = {},
): Promise<{ comments: Comment[]; odd: number }> {
  const now = opts.now ?? Date.now();
  const get = opts.fetch ?? fetch;
  const end = Math.min(to, now);
  const comments: Comment[] = [];
  let odd = 0;
  for (let start = from; start < end; start += MAX_SPAN) {
    const stop = Math.min(start + MAX_SPAN, end);
    const res = await get(
      kakologUrl(
        channel,
        Math.floor(start / 1000),
        // 今より後にはできない。秒に切り上げると今を越えることがあるので、今で頭打ち
        Math.min(Math.ceil(stop / 1000), Math.floor(now / 1000)),
      ),
      { credentials: "omit", referrerPolicy: "no-referrer" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { packet?: unknown; error?: unknown };
    if (body.error !== undefined) throw new Error(String(body.error));
    if (!Array.isArray(body.packet))
      throw new Error("過去ログの返事の形式が違います");
    const read = readPackets(body.packet);
    comments.push(...read.comments.filter((c) => c.at >= start && c.at < stop));
    odd += read.odd;
  }
  return { comments, odd };
}
