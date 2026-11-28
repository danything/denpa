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
export interface LiveDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const browser: LiveDeps = {
  fetch: (url, init) => fetch(url, init),
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
      try {
        this.abort = new AbortController();
        const res = await this.deps.fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: this.channel,
            ...(this.seq === null ? {} : { after: this.seq }),
            ...(this.epoch === null ? {} : { epoch: this.epoch }),
          }),
          signal: this.abort.signal,
        });
        if (res.ok) {
          this.take((await res.json()) as unknown);
          ok = true;
        }
      } catch {
        // 届かない
      }
      if (this.stopped) return;
      if (ok) {
        this.failures = 0;
        continue;
      }
      this.failures++;
      if (this.failures >= FAILURES_TO_DOWN) this.setState(false, this.nx);
      await new Promise<void>((resolve) => {
        this.timer = this.deps.setTimeout(() => {
          this.timer = null;
          resolve();
        }, RETRY);
      });
    }
  }

  private take(body: unknown): void {
    if (body === null || typeof body !== "object") {
      this.events.odd("実況の返事の形式が違います");
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b["epoch"] === "string") this.epoch = b["epoch"];
    if (typeof b["seq"] === "number") this.seq = b["seq"];
    this.ready = true;
    this.setState(b["hub"] !== "down", b["nx"] !== "down");
    if (!Array.isArray(b["comments"])) return;
    const comments: LiveComment[] = [];
    let odd = false;
    for (const raw of b["comments"] as unknown[]) {
      const comment = readLiveComment(raw);
      if (comment === undefined) odd = true;
      else if (comment !== null) comments.push(comment);
    }
    if (odd) this.events.odd("実況のコメントの形式が一部違います");
    if (comments.length > 0) this.events.comments(comments);
  }

  private setState(hub: boolean, nx: boolean): void {
    if (hub === this.hub && nx === this.nx) return;
    this.hub = hub;
    this.nx = nx;
    this.events.state(hub, nx);
  }
}
