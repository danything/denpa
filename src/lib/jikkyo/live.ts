/**
 * **ライブの実況のコメントを denpa のサーバから受ける** (端末の側)。端末は外 (NX-Jikkyo・過去ログ API) へ繋がない。
 * サーバが denpa-hub から局ごとに 1 本で受けたものを、`POST /api/jikkyo/feed` で続きから受ける (`server/jikkyo-live.ts`)。
 *
 * - 前に受けた番号 (`seq`) と印 (`epoch`) を渡す。サーバは続きが来るか 20 秒たつまで返事を待つので、受けたらすぐ次を呼ぶ
 * - 初めての呼び出しは直近 15 分を受ける (録画中の追っかけの、過去ログに入る前の 10 分もここで埋まる)
 * - 届かない・断られたら 10 秒置く。3 回続けて届かなければ「hub に繋がっていない」にする
 * - 受けたコメントは本文・時刻・流し方と、出どころ (`src`) と独自コメントの `id` だけ
 */
import { readMail } from "./command";
import type { Comment } from "./comments";

/** 出どころの付いたコメント。`src` は `hub`・`nx`・`nicolive` (知らない値は `nx` と同じに扱う) */
export interface LiveComment extends Comment {
  src: string;
  /** hub の独自コメントの ID (自分の書き込みが戻ってきたのを見分ける) */
  id?: string;
}

/** 届かなかったあと、次に呼ぶまで (ms) */
export const RETRY = 10_000;
/** すぐ返ってきた (状態が替わった・初めての) 返事のあと、次に呼ぶまで (ms)。続けてすぐ返ってきても詰めて呼ばない */
export const GAP = 1_000;
/** 続けて何回届かなければ「繋がっていない」にするか */
const FAILURES_TO_DOWN = 3;

interface LiveEvents {
  comments: (comments: LiveComment[]) => void;
  /** hub に繋がっているか (書けるか)・hub が NX-Jikkyo に繋がっているか */
  state: (hub: boolean, nx: boolean) => void;
  /** 形式のずれた返事を受けた (呼ぶ側が 1 回だけ警告する) */
  odd: (what: string) => void;
}

/** 差し替えられるもの (単体テストで偽物を渡す) */
/**
 * 同じ呼び出しに載せる公式のコメントの受け手 (連携している世帯のライブ。`official.ts` の `OfficialReader`)。
 * 端末から denpa のサーバへのロングポーリングを 1 本にするため、公式のぶんも同じ `/api/jikkyo/feed` で受ける
 */
export interface OfficialPart {
  body: () => Record<string, unknown>;
  apply: (reply: unknown) => number | null;
  fail: () => void;
}

export interface LiveDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const browser: LiveDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** サーバの返事のコメントを 1 つ読む。読めなければ undefined、流さないものは null */
export function readLiveComment(raw: unknown): LiveComment | null | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c["at"] !== "number" || typeof c["text"] !== "string")
    return undefined;
  const text = c["text"].trim();
  if (text === "" || /^\/[a-z]/.test(text)) return null;
  const style = readMail(c["mail"]);
  const comment: LiveComment = {
    at: c["at"],
    text,
    src: typeof c["src"] === "string" ? c["src"] : "nx",
  };
  if (Object.keys(style).length > 0) comment.style = style;
  if (typeof c["id"] === "string") comment.id = c["id"];
  return comment;
}

export class LiveReader {
  private stopped = false;
  private timer: unknown = null;
  private abort: AbortController | null = null;
  private seq: number | null = null;
  private epoch: string | null = null;
  private failures = 0;
  private hub = true;
  private nx = true;
  /** 一度でも返事を受けたか (受けるまでは書けない) */
  private ready = false;

  constructor(
    private readonly channel: string,
    /** `/api/jikkyo/feed` (前段の接頭辞を付けたもの) */
    private readonly url: string,
    private readonly events: LiveEvents,
    private readonly deps: LiveDeps = browser,
    private readonly official: OfficialPart | null = null,
  ) {}

  start(): void {
    void this.loop();
  }

  /** hub に繋がっていて、書ける */
  get writable(): boolean {
    return this.ready && this.hub;
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let ok = false;
      let got = 0;
      const started = this.deps.now();
      try {
        this.abort = new AbortController();
        const res = await this.deps.fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: this.channel,
            ...(this.seq === null ? {} : { after: this.seq }),
            ...(this.epoch === null ? {} : { epoch: this.epoch }),
            ...(this.official === null
              ? {}
              : { official: this.official.body() }),
          }),
          signal: this.abort.signal,
        });
        if (res.ok) {
          got = this.take((await res.json()) as unknown);
          ok = true;
        }
      } catch {
        // 届かない
      }
      if (this.stopped) return;
      if (ok) {
        this.failures = 0;
        if (got === 0 && this.deps.now() - started < GAP) await this.sleep(GAP);
        continue;
      }
      this.official?.fail();
      this.failures++;
      if (this.failures >= FAILURES_TO_DOWN) this.setState(false, this.nx);
      await this.sleep(RETRY);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = this.deps.setTimeout(() => {
        this.timer = null;
        resolve();
      }, ms);
    });
  }

  /** 返事を読む。受けたコメントの数 (公式のぶんも) を返す */
  private take(body: unknown): number {
    // 止めたあとに読み終えた返事は捨てる (局を替えたあとに、前の局のコメントを流さない)
    if (this.stopped) return 0;
    if (body === null || typeof body !== "object") {
      this.events.odd("実況の返事の形式が違います");
      return 0;
    }
    const b = body as Record<string, unknown>;
    if (typeof b["epoch"] === "string") this.epoch = b["epoch"];
    if (typeof b["seq"] === "number") this.seq = b["seq"];
    this.ready = true;
    this.setState(b["hub"] !== "down", b["nx"] !== "down");
    const official =
      this.official === null ? 0 : (this.official.apply(b["official"]) ?? 0);
    if (!Array.isArray(b["comments"])) return official;
    const comments: LiveComment[] = [];
    let odd = false;
    for (const raw of b["comments"] as unknown[]) {
      const comment = readLiveComment(raw);
      if (comment === undefined) odd = true;
      else if (comment !== null) comments.push(comment);
    }
    if (odd) this.events.odd("実況のコメントの形式が一部違います");
    if (comments.length > 0) this.events.comments(comments);
    return comments.length + official;
  }

  private setState(hub: boolean, nx: boolean): void {
    if (hub === this.hub && nx === this.nx) return;
    this.hub = hub;
    this.nx = nx;
    this.events.state(hub, nx);
  }
}
