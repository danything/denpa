/**
 * **ライブの実況のコメントを、局ごとに 1 本で hub から受けて、家の端末に配る。**
 *
 * - hub の `GET /jikkyo/channels/{ch}/live` (SSE) を局ごとに 1 本だけ受ける。端末が何台あっても 1 本
 * - 受けたものに通し番号 (`seq`) を付けて、直近 15 分・1000 件を控える。端末は `POST /api/jikkyo/feed` で
 *   前に受けた番号を渡し、続きを受ける (ロングポーリング。新しいものが来るか 20 秒たつまで返事を待つ)。
 *   SSE にしないのは、HTTP/1.1 の 6 本の上限・眠ったスマホの半分開きの接続・よそのサイトからの GET を避けるため (公式の受信と同じ)
 * - `epoch` はこのプロセスを作るたびに替わる。端末は替わったら番号を捨てて控えの全部を受け直す
 * - 切れたら 1 秒 → 2 秒 → … 60 秒で頭打ちで繋ぎ直す。繋ぎ直すときは hub の通し番号と `epoch` を渡して続きを受ける
 * - 端末に呼ばれなくなって 30 秒たったら、hub への購読を閉じて控えも捨てる。世帯の設定で実況をオフにしたら全部閉じる (`closeAll`)
 * - hub が局を知らない (`unknown_channel`) と言ったら、その局は 10 分のあいだ繋ぎ直さない
 *
 * コメントの形は hub と同じ (denpa-hub の docs/jikkyo.md の「コメントの形」)。トークンは記録に書かない
 */
import { randomBytes } from "node:crypto";

import { blocks } from "./agent-events";
import { hubFetch } from "./jikkyo-hub";

/** 配るコメント (hub と同じ形) */
export interface LiveComment {
  at: number;
  text: string;
  mail?: string;
  /** `hub`・`nx`・`nicolive` (知らない値もそのまま渡す) */
  src: string;
  id?: string;
}

/** 端末への返事 */
export interface FeedResult {
  epoch: string;
  seq: number;
  /** hub に繋がっているか */
  hub: "up" | "down";
  /** hub が NX-Jikkyo に繋がっているか */
  nx: "up" | "down";
  comments: LiveComment[];
}

/** 控えに持つ長さと件数 */
export const KEEP = 15 * 60_000;
export const KEEP_COUNT = 1000;
/** 新しいものが無いとき、返事を待つ長さ (ms) */
export const LONG_POLL = 20_000;
/** 呼ばれなくなってから hub への購読を閉じるまで (ms) */
export const IDLE = 30_000;
/** 知らない局を繋ぎ直さない長さ (ms) */
export const UNKNOWN_WAIT = 10 * 60_000;
/** 局を開いたときに、hub に繋がるのを待つ上限 (ms) */
export const CONNECT_WAIT = 3_000;
const RETRY_MIN = 1_000;
const RETRY_MAX = 60_000;

/** 差し替えられるもの (単体テストで偽物を渡す) */
export interface LiveDeps {
  /** hub の購読を開く (`/jikkyo/channels/{ch}/live?…`) */
  open: (path: string, signal: AbortSignal) => Promise<Response>;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const real: LiveDeps = {
  open: (path, signal) =>
    hubFetch(path, { headers: { Accept: "text/event-stream" }, signal }),
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** コメントの形を確かめる。違えば null (hub のバージョンが変わっても読めたものだけ使う) */
function readComment(raw: unknown): LiveComment | null {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c["at"] !== "number" || typeof c["text"] !== "string") return null;
  const out: LiveComment = {
    at: c["at"],
    text: c["text"],
    src: typeof c["src"] === "string" ? c["src"] : "nx",
  };
  if (typeof c["mail"] === "string") out.mail = c["mail"];
  if (typeof c["id"] === "string") out.id = c["id"];
  return out;
}

class Channel {
  private readonly ring: { seq: number; comment: LiveComment }[] = [];
  private readonly keys = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private readonly stop = new AbortController();
  hub: "up" | "down" = "down";
  nx: "up" | "down" = "up";
  lastPolled: number;
  /** hub の続きを受けるための番号と印 */
  private hubAfter: string | null = null;
  private hubEpoch: string | null = null;
  /** hub が局を知らないと言った時刻 */
  unknownAt: number | null = null;

  constructor(
    readonly channel: string,
    private readonly owner: JikkyoLive,
    private readonly deps: LiveDeps,
  ) {
    this.lastPolled = deps.now();
    void this.run();
  }

  get waiting(): number {
    return this.waiters.size;
  }

  /** `after` より後のもの。無ければ全部 (1000 件まで) */
  since(after: number | null): LiveComment[] {
    const first = this.ring[0]?.seq ?? Number.POSITIVE_INFINITY;
    const from = after === null || after < first - 1 ? -1 : after;
    return this.ring.filter((e) => e.seq > from).map((e) => e.comment);
  }

  get last(): number {
    return this.ring[this.ring.length - 1]?.seq ?? this.owner.seq;
  }

  /** 新しいものか状態の変化が来るまで待つ (`ms` まで) */
  wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        this.deps.clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = this.deps.setTimeout(done, ms);
      signal?.addEventListener("abort", done);
      this.waiters.add(done);
    });
  }

  private wake(): void {
    for (const done of [...this.waiters]) done();
  }

  close(): void {
    this.stop.abort();
    this.wake();
  }

  private add(list: LiveComment[]): void {
    let added = false;
    for (const comment of list) {
      const key = `${comment.at}\u0000${comment.text}`;
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      this.ring.push({ seq: ++this.owner.seq, comment });
      added = true;
    }
    const before = this.deps.now() - KEEP;
    while (
      this.ring.length > 0 &&
      (this.ring.length > KEEP_COUNT || this.ring[0]!.comment.at < before)
    ) {
      const old = this.ring.shift()!;
      this.keys.delete(`${old.comment.at}\u0000${old.comment.text}`);
    }
    if (added) this.wake();
  }

  private setHub(next: "up" | "down"): void {
    if (this.hub === next) return;
    this.hub = next;
    this.wake();
  }

  private async run(): Promise<void> {
    let retry = RETRY_MIN;
    const signal = this.stop.signal;
    while (!signal.aborted) {
      try {
        const query = new URLSearchParams();
        if (this.hubAfter !== null) query.set("after", this.hubAfter);
        if (this.hubEpoch !== null) query.set("epoch", this.hubEpoch);
        const q = query.toString();
        const res = await this.deps.open(
          `/jikkyo/channels/${this.channel}/live${q === "" ? "" : `?${q}`}`,
          signal,
        );
        if (res.status === 400) {
          const body = (await res.json().catch(() => null)) as {
            error?: unknown;
          } | null;
          if (body?.error === "unknown_channel") {
            this.unknownAt = this.deps.now();
            this.setHub("down");
            this.owner.forget(this);
            return;
          }
        }
        if (!res.ok || res.body === null)
          throw new Error(`hub live -> ${res.status}`);
        retry = RETRY_MIN;
        this.setHub("up");
        for await (const block of blocks(res.body)) this.read(block);
      } catch {
        if (signal.aborted) return;
      }
      this.setHub("down");
      await new Promise<void>((resolve) => {
        const timer = this.deps.setTimeout(resolve, retry);
        signal.addEventListener("abort", () => {
          this.deps.clearTimeout(timer);
          resolve();
        });
      });
      retry = Math.min(retry * 2, RETRY_MAX);
    }
  }

  private read(block: string): void {
    let name = "";
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
    }
    let body: unknown;
    try {
      body = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (name === "state") {
      const state = body as { nx?: unknown; epoch?: unknown };
      if (typeof state.epoch === "string") this.hubEpoch = state.epoch;
      const nx = state.nx === "down" ? "down" : "up";
      if (nx !== this.nx) {
        this.nx = nx;
        this.wake();
      }
    } else if (name === "comments" && Array.isArray(body)) {
      if (id !== null) this.hubAfter = id;
      this.add(
        body.map(readComment).filter((c): c is LiveComment => c !== null),
      );
    }
  }
}

export class JikkyoLive {
  readonly epoch = randomBytes(8).toString("hex");
  /** 通し番号 (このプロセスの中で 1 つ。局を閉じて開き直しても戻らない) */
  seq = 0;
  private readonly channels = new Map<string, Channel>();
  private readonly unknown = new Map<string, number>();
  private sweeper: unknown = null;

  constructor(private readonly deps: LiveDeps = real) {}

  /**
   * 端末の呼び出し 1 回。`after` は前に受けた最後の番号、`epoch` は前に受けた印。
   * 初めて (`after` が無い・`epoch` が違う) ならすぐ控えの全部を返し、そうでなければ続きが来るか `LONG_POLL` たつまで待つ
   */
  async feed(
    channel: string,
    after: number | null,
    epoch: string | null,
    signal?: AbortSignal,
  ): Promise<FeedResult> {
    const now = this.deps.now();
    const unknownAt = this.unknown.get(channel);
    if (unknownAt !== undefined && now - unknownAt < UNKNOWN_WAIT)
      return this.result(null, null);
    this.unknown.delete(channel);
    let live = this.channels.get(channel);
    if (live === undefined) {
      live = new Channel(channel, this, this.deps);
      this.channels.set(channel, live);
      this.sweep();
      // 繋がるまで少し待つ (すぐ返すと、繋ぐ前の「hub に繋がっていない」を端末が受けてしまう)
      await live.wait(CONNECT_WAIT, signal);
    }
    live.lastPolled = now;
    const resume = epoch === this.epoch ? after : null;
    // 新しいものが無ければ待つ。待っている間に状態だけ替わったときも返す (端末は書けるかを替える)
    if (resume !== null && live.since(resume).length === 0)
      await live.wait(LONG_POLL, signal);
    live.lastPolled = this.deps.now();
    return this.result(live, resume);
  }

  private result(live: Channel | null, after: number | null): FeedResult {
    if (live === null)
      return {
        epoch: this.epoch,
        seq: this.seq,
        hub: "down",
        nx: "up",
        comments: [],
      };
    return {
      epoch: this.epoch,
      seq: live.last,
      hub: live.hub,
      nx: live.nx,
      comments: live.since(after),
    };
  }

  /** hub が局を知らないと言った。しばらく繋ぎ直さない */
  forget(live: Channel): void {
    if (this.channels.get(live.channel) !== live) return;
    this.channels.delete(live.channel);
    this.unknown.set(live.channel, live.unknownAt ?? this.deps.now());
    live.close();
  }

  /** 呼ばれなくなった局を閉じる (10 秒ごと。局が無くなったら止める) */
  private sweep(): void {
    if (this.sweeper !== null) return;
    const tick = () => {
      this.sweeper = null;
      const now = this.deps.now();
      for (const [channel, live] of this.channels)
        if (live.waiting === 0 && now - live.lastPolled > IDLE) {
          this.channels.delete(channel);
          live.close();
        }
      if (this.channels.size > 0)
        this.sweeper = this.deps.setTimeout(tick, 10_000);
    };
    this.sweeper = this.deps.setTimeout(tick, 10_000);
  }

  /** 世帯の設定で実況をオフにした。全部閉じる (控えも捨てる) */
  closeAll(): void {
    for (const live of this.channels.values()) live.close();
    this.channels.clear();
    this.unknown.clear();
  }

  /** 開いている局の数 (テスト用) */
  get size(): number {
    return this.channels.size;
  }
}

/** プロセスに 1 つ */
export const jikkyoLive = new JikkyoLive();
