/**
 * **公式のニコニコ実況に書く・受ける (端末の側)。** ニコニコと連携している世帯で、書き込みの欄 (`JikkyoCompose`) と
 * ライブの画面のコメント (`feed.svelte.ts`) が使う。
 * 端末はトークンも接続先も持たず、denpa のサーバにリクエストする (`/api/jikkyo/niconico/…`。繋ぐのはサーバ。`server/niconico-live.ts`)。
 *
 * - 欄が開いている間、`HEARTBEAT` おきと局が替わったときに `session` を呼んで接続を保ち、状態を受け取る
 * - 書き込みは `comments` に送り、結果 (`PostResult`) を受け取る
 * - コメントは `feed` から受ける (`OfficialReader`)
 */
import type { PostStyle } from "./command";
import type { Comment } from "./comments";
import { Echoes, type PostResult } from "./post";

/** 接続を保つために呼ぶ間隔 (ms)。サーバは 2 分呼ばれなければ閉じる */
export const HEARTBEAT = 30_000;

/** サーバが言う接続の状態 (`server/niconico-live.ts` の `LiveState`) */
type OfficialState = "connecting" | "ready" | "unlinked" | "down";

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
interface OfficialDeps {
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
   * 欄が 0.25 秒おきに呼ぶ。局が替わった・`HEARTBEAT` が過ぎたときだけ、サーバに接続を保つようリクエストする
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

  /** 欄を閉じた。もうリクエストしない (サーバは呼ばれなくなった接続を閉じる) */
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
      // サーバに届かない。書けない扱い (次のリクエストでまた見る)
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

/** 受けられなかった (サーバに届かない・断られた) あと、次に呼ぶまで (ms) */
export const FEED_RETRY = 10_000;
/** すぐ返ってきた (状態が変わった) 返事のあと、次に呼ぶまで (ms)。続けてすぐ返ってきても詰めて呼ばない */
export const FEED_GAP = 1_000;

/** サーバが渡すコメント (`server/niconico-live.ts` の `FeedComment`) */
type FeedComment = Comment & { own?: true };

interface ReaderEvents {
  /** コメントが来た (境より前のもの・自分の書き込みの戻りは来ない) */
  comments: (comments: Comment[]) => void;
  /** 境が変わった (null なら公式を受けていない) */
  boundary: (at: number | null) => void;
}

/** 差し替えられるもの (単体テストで偽物を渡す) */
interface ReaderDeps extends OfficialDeps {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

/**
 * **公式のニコニコ実況のコメントを受ける (端末の側)。** ニコニコと連携している世帯のライブの画面で、局ごとに 1 つ (`feed.svelte.ts`)。
 * サーバの `feed` (`/api/jikkyo/niconico/feed`) を続けて呼ぶ (ロングポーリング。サーバは新しいものが来るまで返事を待つ)。
 *
 * - **境 (`boundary`) より後は公式、前は NX-Jikkyo が取り込んだもの** を流す。境は max(サーバが受け続けている始まり, 最初の返事の時刻)。
 *   サーバが受けられていなければ境は無く、NX-Jikkyo の取り込みを全部流す (`nx.ts`)
 * - サーバが返す番号 (`seq`) の続きをリクエストする。サーバを起こし直した (`epoch` が違う) ら最初から
 * - 世帯のアカウントが書いたもの (`own`) のうち、この端末が送ってから 60 秒以内の同じ本文は 1 回だけ捨てる (送れたときにもう流している)
 * - 受けられなければ境を無くし、`FEED_RETRY` 後にまた呼ぶ
 */
export class OfficialReader {
  boundary: number | null = null;
  private after: number | null = null;
  private epoch: string | null = null;
  /** 最初の返事の時刻 (サーバの時計) */
  private first: number | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  private timer: unknown = null;
  private readonly echoes = new Echoes();

  constructor(
    /** `/api/jikkyo/niconico/feed` (前段の接頭辞を付けたもの) */
    private readonly url: string,
    private readonly channel: string,
    private readonly events: ReaderEvents,
    private readonly deps: ReaderDeps = {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    },
  ) {}

  start(): void {
    void this.loop();
  }

  /** 止める。待っているリクエストも止める (サーバが「聴かれている」と数え続けないように) */
  stop(): void {
    this.stopped = true;
    this.abort.abort();
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
  }

  /** 公式に書いた。戻ってきた同じ本文を 1 回だけ捨てる */
  expectEcho(text: string): void {
    this.echoes.expect(text, this.deps.now());
  }

  /** 送れなかった。覚えたものを 1 つ忘れる */
  forgetEcho(text: string): void {
    this.echoes.forget(text);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = this.deps.setTimeout(() => {
        this.timer = null;
        resolve();
      }, ms);
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const started = this.deps.now();
      let got: number | null = null;
      try {
        const res = await this.deps.fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: this.channel,
            ...(this.after === null ? {} : { after: this.after }),
            ...(this.epoch === null ? {} : { epoch: this.epoch }),
          }),
          signal: this.abort.signal,
        });
        if (res.ok) got = this.apply(await res.json());
      } catch {
        // 届かない・止めた
      }
      if (this.stopped) return;
      if (got === null) {
        this.setBoundary(null);
        await this.sleep(FEED_RETRY);
      } else if (got === 0 && this.deps.now() - started < FEED_GAP)
        await this.sleep(FEED_GAP);
    }
  }

  /** 返事を読む。読めた数を返す (形式が違えば null) */
  private apply(reply: unknown): number | null {
    // 止めたあとに読み終えた返事は捨てる (局を替えたあとに、前の局のコメントを流さない)
    if (this.stopped) return null;
    if (reply === null || typeof reply !== "object") return null;
    const r = reply as Record<string, unknown>;
    const { epoch, seq, now, since, comments } = r;
    if (
      typeof epoch !== "string" ||
      typeof seq !== "number" ||
      typeof now !== "number" ||
      !Array.isArray(comments)
    )
      return null;
    if (epoch !== this.epoch || this.first === null) {
      this.epoch = epoch;
      this.first = now;
    }
    this.after = seq;
    const boundary =
      typeof since === "number" ? Math.max(since, this.first) : null;
    this.setBoundary(boundary);
    if (boundary === null) return 0;
    const out: Comment[] = [];
    for (const item of comments as FeedComment[]) {
      if (
        item === null ||
        typeof item !== "object" ||
        typeof item.at !== "number" ||
        typeof item.text !== "string" ||
        item.at < boundary
      )
        continue;
      if (item.own === true && this.echoes.take(item.text, this.deps.now()))
        continue;
      out.push(
        item.style !== undefined
          ? { at: item.at, text: item.text, style: item.style }
          : { at: item.at, text: item.text },
      );
    }
    if (out.length > 0) this.events.comments(out);
    return out.length;
  }

  private setBoundary(at: number | null): void {
    if (at === this.boundary) return;
    this.boundary = at;
    this.events.boundary(at);
  }
}
