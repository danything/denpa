/**
 * **公式のニコニコ実況に書く (端末の側)。** ニコニコと連携している世帯で、書き込みの欄 (`JikkyoCompose`) が使う。
 * 端末はトークンも接続先も持たず、denpa のサーバに頼む (`/api/jikkyo/niconico/…`。繋ぐのはサーバ。`server/niconico-live.ts`)。
 *
 * - 欄が開いている間、`HEARTBEAT` おきと局が替わったときに `session` を呼んで接続を保ち、状態を受け取る
 * - 書き込みは `comments` に送り、結果 (`PostResult`) を受け取る
 */
import type { PostStyle } from "./command";
import type { PostResult } from "./post";

/** 接続を保つために呼ぶ間隔 (ms)。サーバは 2 分呼ばれなければ閉じる */
export const HEARTBEAT = 30_000;

/** サーバが言う接続の状態 (`server/niconico-live.ts` の `LiveState`) */
export type OfficialState = "connecting" | "ready" | "unlinked" | "down";

const STATES: readonly OfficialState[] = [
  "connecting",
  "ready",
  "unlinked",
  "down",
];
const RESULTS: readonly PostResult[] = [
  "sent",
  "unknown",
  "not-on-air",
  "rejected",
  "closed",
  "unlinked",
  "wait",
];

/** 差し替えられるもの (単体テストで偽物を渡す) */
export interface OfficialDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}

export class OfficialWriter {
  state: OfficialState = "connecting";
  private asked: { channel: string; at: number } | null = null;
  private stopped = false;

  constructor(
    /** `/api/jikkyo/niconico/session` と `…/comments` (前段の接頭辞を付けたもの) */
    private readonly urls: { session: string; comments: string },
    /** いま書く局 (実況のチャンネル)。無ければ null */
    private readonly channel: () => string | null,
    private readonly deps: OfficialDeps = {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
    },
  ) {}

  /**
   * 欄が 0.25 秒おきに呼ぶ。局が替わった・`HEARTBEAT` が過ぎたときだけ、サーバに接続を保つよう頼む
   */
  tick(): void {
    const channel = this.channel();
    if (this.stopped || channel === null) return;
    const now = this.deps.now();
    if (
      this.asked !== null &&
      this.asked.channel === channel &&
      now - this.asked.at < HEARTBEAT
    )
      return;
    if (this.asked?.channel !== channel) this.state = "connecting";
    this.asked = { channel, at: now };
    void this.ask(channel);
  }

  /** 欄を閉じた。もう頼まない (サーバは呼ばれなくなった接続を閉じる) */
  stop(): void {
    this.stopped = true;
  }

  private async ask(channel: string): Promise<void> {
    let state: OfficialState = "down";
    try {
      const res = await this.request("session", { channel });
      const got = ((await res.json()) as { state?: unknown }).state;
      if (STATES.includes(got as OfficialState)) state = got as OfficialState;
    } catch {
      // サーバに届かない。書けない扱い (次の頼みでまた見る)
    }
    if (this.stopped || this.channel() !== channel) return;
    this.state = state;
    // 繋いでいる途中なら、少し待って見直す (30 秒待たせない)
    if (state === "connecting" && this.asked !== null)
      this.asked.at = this.deps.now() - HEARTBEAT + 1_000;
  }

  /** 書き込む (確かめるのは呼ぶ側。`post.ts`) */
  async post(text: string, style: PostStyle): Promise<PostResult> {
    const channel = this.channel();
    if (channel === null) return "closed";
    try {
      const res = await this.request("comments", { channel, text, style });
      if (!res.ok) return "rejected";
      const result = ((await res.json()) as { result?: unknown }).result;
      if (result === "unlinked") this.state = "unlinked";
      return RESULTS.includes(result as PostResult)
        ? (result as PostResult)
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  private request(
    name: "session" | "comments",
    body: unknown,
  ): Promise<Response> {
    return this.deps.fetch(this.urls[name], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}
