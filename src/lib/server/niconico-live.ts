/**
 * **公式のニコニコ実況に書き込む** (ニコニコと連携しているとき。連携そのものは `niconico.ts`)。
 *
 * - **視聴の WebSocket は denpa のサーバが張る。** トークンも接続先の URL (それ自体が資格情報) も端末に出さない。
 *   端末が何台あっても、1 つの局に繋ぐのは 1 本
 * - 接続先は denpa-hub の `/niconico/live/watch` から受け取る (局の ID とユーザー ID を渡し、アクセストークンを付ける)。
 *   ニコニコ固有の値は hub が持つ。hub が 401 を返したら 1 回だけトークンを更新してやり直す
 * - やり取りは NX-Jikkyo と同じ形 (`nx.ts`): `startWatching` (映像は頼まない)・`ping` に `pong`・`seat` の間隔で `keepSeat`・
 *   `postComment` (いつも 184) に `postCommentResult` か `error`・`disconnect`。最初の返事が来たら書ける。
 *   書き込みの `vpos` の基準 (`vposBaseTime`) は、どの返事に載っていても読む (読めなければ繋いだ時刻)
 * - **繋ぐのは書き込みの欄が開いている間だけ。** 欄は開いている間 30 秒おきに `touch` を呼ぶ。`IDLE` の間呼ばれなければ閉じる。
 *   同じアカウントで開ける接続の数には上限がある (数は公開されていない) ので、同時に開くのは `MAX_SESSIONS` まで
 *   (超えたら、いちばん長く呼ばれていないものを閉じる)
 * - 書き込みは 1 件ずつ、世帯 (アカウント) で `POST_GAP` 空ける。5 秒返事が無ければ「分からない」
 *
 * 接続先の URL とトークンは記録に書かない
 */
import type { PostStyle } from "../jikkyo/command";
import { POST_GAP, type PostResult, REPLY_WAIT, vpos } from "../jikkyo/post";
import { config } from "./config";
import { accessToken, linkState, renew } from "./niconico";

/** 欄が呼ばなくなってから閉じるまで (ms)。欄は 30 秒おきに呼ぶ */
export const IDLE = 2 * 60_000;
/** 同時に開く接続の上限。世帯で別々の局に書くことは多くないうえ、同じアカウントの接続の数には上限がある */
export const MAX_SESSIONS = 2;
/** 書き込みが来たとき、繋がるのを待つ上限 (ms) */
export const CONNECT_WAIT = 10_000;
/** 繋げなかったあと、次に試すまで (ms)。欄が呼ぶたびに hub を呼ばない */
export const RETRY_AFTER = 30_000;
/** hub を待つ上限 (ms)。hub はニコニコを 15 秒で打ち切る */
const HUB_TIMEOUT = 20_000;

/** 欄に返す接続の状態 */
export type LiveState =
  /** 繋いでいる途中 */
  | "connecting"
  /** 書ける */
  | "ready"
  /** 連携していない・切れた */
  | "unlinked"
  /** 繋げない (番組が無い・hub やニコニコが断った・届かない)。`RETRY_AFTER` 後にまた試す */
  | "down";

/** hub から接続先を受け取った結果 */
export type WatchResult = { url: string } | { error: string; status: number };

/** 差し替えられるもの (単体テストで偽物を渡す) */
export interface LiveDeps {
  /** hub の `/niconico/live/watch` */
  watch: (token: string, channel: string, user: string) => Promise<WatchResult>;
  open: (url: string) => WebSocket;
  token: () => Promise<string | null>;
  renew: () => Promise<string | null>;
  user: () => string | null;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const USER_AGENT = () =>
  `denpa/${config.version} (+https://github.com/danything/denpa)`;

async function hubWatch(
  token: string,
  channel: string,
  user: string,
): Promise<WatchResult> {
  const res = await fetch(`${config.hubUrl}/niconico/live/watch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT(),
    },
    body: new URLSearchParams({ channel, user }),
    signal: AbortSignal.timeout(HUB_TIMEOUT),
  });
  const body = (await res.json().catch(() => null)) as {
    url?: unknown;
    error?: unknown;
  } | null;
  if (res.ok && typeof body?.url === "string") return { url: body.url };
  return {
    error: typeof body?.error === "string" ? body.error : `HTTP ${res.status}`,
    status: res.status,
  };
}

/**
 * 繋いでよい接続先か。`wss:` だけ。試験の偽物 (ループバックのアドレス) だけは `ws:` も通す
 */
export function allowedSocket(url: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol === "wss:") return true;
    return (
      target.protocol === "ws:" &&
      (target.hostname === "127.0.0.1" || target.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

const server: LiveDeps = {
  watch: hubWatch,
  // Bun の WebSocket はヘッダーを付けられる。ニコニコはツールの名前が分かる User-Agent を求めている
  open: (url) =>
    new WebSocket(url, {
      headers: { "User-Agent": USER_AGENT() },
    } as unknown as string[]),
  token: accessToken,
  renew,
  user: () => {
    const state = linkState();
    return state.state === "linked" ? state.userId : null;
  },
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** 1 つの局への接続 */
class Session {
  state: LiveState = "connecting";
  touched: number;
  /** `down` になった時刻 (`RETRY_AFTER` の間は試し直さない) */
  downAt = 0;
  private ws: WebSocket | null = null;
  private keep: unknown = null;
  private idle: unknown = null;
  /** 書き込みの `vpos` の基準 (unix ms) */
  private base: number;
  private pending: {
    timer: unknown;
    done: (result: PostResult) => void;
  } | null = null;
  /** 繋がる (書ける・繋げない) のを待っているもの */
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(
    readonly channel: string,
    private readonly deps: LiveDeps,
    private readonly log: (message: string) => void,
    private readonly onEnd: (session: Session) => void,
  ) {
    this.touched = deps.now();
    this.base = deps.now();
  }

  /** 欄が呼んだ・書き込みが来た。閉じるまでの時間を延ばす */
  touch(): void {
    this.touched = this.deps.now();
    if (this.idle !== null) this.deps.clearTimeout(this.idle);
    this.idle = this.deps.setTimeout(() => this.close(), IDLE);
  }

  async open(): Promise<void> {
    this.touch();
    const user = this.deps.user();
    let token =
      user === null
        ? null
        : await this.deps.token().catch(() => {
            this.fail("トークンを更新できません (denpa-hub に届きません)");
            return undefined;
          });
    if (token === undefined || this.closed) return;
    if (token === null || user === null) return this.settle("unlinked");
    let got = await this.watch(token, user);
    if ("error" in got && got.status === 401) {
      // アクセストークンが断られた。1 回だけ更新してやり直す
      token = await this.deps.renew().catch(() => null);
      if (token === null) return this.settle("unlinked");
      got = await this.watch(token, user);
    }
    if (this.closed) return;
    if ("error" in got) {
      if (got.status === 401) return this.settle("unlinked");
      return this.fail(
        `${this.channel} の接続先を受け取れません (${got.error}${got.error === "insufficient_scope" ? "。連携で許可されたスコープが足りません" : ""})`,
      );
    }
    if (!allowedSocket(got.url))
      return this.fail("denpa-hub が wss: でない接続先を返しました");
    this.connect(got.url);
  }

  private async watch(token: string, user: string): Promise<WatchResult> {
    try {
      return await this.deps.watch(token, this.channel, user);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        status: 502,
      };
    }
  }

  private connect(url: string): void {
    const ws = this.deps.open(url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ type: "startWatching", data: { reconnect: false } }),
      );
    };
    ws.onmessage = (event) => this.onMessage(ws, event.data);
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.close();
    };
    ws.onerror = () => {
      // 続く close で閉じる
    };
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    if (ws !== this.ws) return;
    let message: { type?: unknown; data?: Record<string, unknown> };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    const body = message.data ?? {};
    // vpos の基準。どの返事に載っていても読む
    const base = Date.parse(String(body["vposBaseTime"]));
    if (Number.isFinite(base)) this.base = base;
    // 最初の返事が来たら書ける
    if (this.state === "connecting") this.settle("ready");
    switch (message.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "seat": {
        const every = Number(body["keepIntervalSec"]);
        this.startKeep(ws, Number.isFinite(every) && every > 0 ? every : 30);
        break;
      }
      case "postCommentResult":
        this.settlePost("sent");
        break;
      case "error":
        this.settlePost(
          body["message"] === "NOT_ON_AIR" ? "not-on-air" : "rejected",
        );
        break;
      case "disconnect":
        // 番組の終わり (4:00 の替わり目) など。閉じて、次に呼ばれたときに接続先から取り直す
        this.close();
        break;
    }
  }

  private startKeep(ws: WebSocket, seconds: number): void {
    if (this.keep !== null) this.deps.clearTimeout(this.keep);
    const tick = () => {
      if (ws !== this.ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: "keepSeat" }));
      this.keep = this.deps.setTimeout(tick, seconds * 1000);
    };
    this.keep = this.deps.setTimeout(tick, seconds * 1000);
  }

  /** 繋がる (書ける・繋げない・閉じた) のを待つ。`ms` を過ぎたらそのまま返る */
  settled(ms: number): Promise<void> {
    if (this.state !== "connecting") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = this.deps.setTimeout(resolve, ms);
      this.waiters.push(() => {
        this.deps.clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 状態を決めて、待っているものを起こす。`down` は試し直すまで待つ印 (`downAt`) も付ける。閉じたときは付けない (`mark` が false) */
  private settle(state: LiveState, mark = true): void {
    this.state = state;
    if (state === "down" && mark) this.downAt = this.deps.now();
    for (const wake of this.waiters.splice(0)) wake();
  }

  private fail(reason: string): void {
    this.log(reason);
    this.settle("down");
    this.teardown();
  }

  /** 書き込む (`text` は確かめ終えたもの)。いつも 184 */
  post(text: string, style: PostStyle): Promise<PostResult> {
    const ws = this.ws;
    if (this.state !== "ready" || ws === null || this.pending !== null)
      return Promise.resolve("closed");
    return new Promise((resolve) => {
      this.pending = {
        timer: this.deps.setTimeout(
          () => this.settlePost("unknown"),
          REPLY_WAIT,
        ),
        done: resolve,
      };
      ws.send(
        JSON.stringify({
          type: "postComment",
          data: {
            text,
            vpos: vpos(this.deps.now(), this.base),
            isAnonymous: true,
            color: style.color,
            position: style.position,
            size: style.size,
          },
        }),
      );
    });
  }

  private settlePost(result: PostResult): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.deps.clearTimeout(pending.timer);
    pending.done(result);
  }

  private teardown(): void {
    if (this.keep !== null) this.deps.clearTimeout(this.keep);
    this.keep = null;
    // 返事を待っている間に切れた。届いたかは分からない
    this.settlePost("unknown");
    const ws = this.ws;
    this.ws = null;
    if (ws === null) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // 閉じられなくても捨てる
    }
  }

  /** 閉じる (使われなくなった・相手が閉じた・連携を外した・繋げなかった) */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idle !== null) this.deps.clearTimeout(this.idle);
    this.idle = null;
    this.teardown();
    // 使われなくなった・相手が閉じたときは、次に呼ばれたらすぐ繋ぎ直す (試し直すまで待つのは繋げなかったときだけ)
    if (this.state === "connecting" || this.state === "ready")
      this.settle("down", false);
    this.onEnd(this);
  }

  get ended(): boolean {
    return this.closed;
  }
}

/** 公式の実況への接続をまとめるもの (サーバに 1 つ。下の `niconicoLive`) */
export class NiconicoLive {
  private readonly sessions = new Map<string, Session>();
  /** 繋げなかった局と時刻。`RETRY_AFTER` の間は同じ答えを返す */
  private readonly down = new Map<string, number>();
  /** 最後に書いた時刻 (世帯で 1 つのアカウントなので、局をまたいで数える) */
  private lastPost = Number.NEGATIVE_INFINITY;
  /** 最後に記録に残した理由。同じものは繰り返さない */
  private lastReason: string | null = null;

  constructor(private readonly deps: LiveDeps = server) {}

  private log(reason: string): void {
    if (reason === this.lastReason) return;
    this.lastReason = reason;
    console.warn(`[niconico] ${reason}`);
  }

  /**
   * **欄が開いている (30 秒おきに呼ぶ)。** 繋いでいなければ繋ぎ始め、いまの状態を返す。
   * 繋げなかった局は `RETRY_AFTER` の間は試し直さない
   */
  touch(channel: string): LiveState {
    const session = this.sessions.get(channel);
    if (session !== undefined && !session.ended) {
      session.touch();
      return session.state;
    }
    const downAt = this.down.get(channel);
    if (downAt !== undefined && this.deps.now() - downAt < RETRY_AFTER)
      return "down";
    if (this.deps.user() === null) return "unlinked";
    return this.start(channel).state;
  }

  private start(channel: string): Session {
    // 上限を超えるなら、いちばん長く呼ばれていないものを閉じる
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort(
        (a, b) => a.touched - b.touched,
      )[0];
      if (oldest === undefined) break;
      oldest.close();
    }
    this.down.delete(channel);
    const session = new Session(
      channel,
      this.deps,
      (reason) => this.log(reason),
      (ended) => {
        if (this.sessions.get(channel) === ended) this.sessions.delete(channel);
        if (ended.downAt > 0) this.down.set(channel, ended.downAt);
      },
    );
    this.sessions.set(channel, session);
    void session.open().then(() => {
      if (session.state === "ready") this.lastReason = null;
      // 繋げなかった (連携していない・切れた・断られた) ものは閉じる。次に呼ばれたら試し直す
      if (session.state === "unlinked" || session.state === "down")
        session.close();
    });
    return session;
  }

  /** **書き込む。** 繋いでいなければ繋ぎ、`CONNECT_WAIT` まで待つ */
  async post(
    channel: string,
    text: string,
    style: PostStyle,
  ): Promise<PostResult> {
    const now = this.deps.now();
    if (now - this.lastPost < POST_GAP) return "wait";
    const state = this.touch(channel);
    if (state === "unlinked") return "unlinked";
    const session = this.sessions.get(channel);
    if (session === undefined) return "closed";
    await session.settled(CONNECT_WAIT);
    if (session.state === "unlinked") return "unlinked";
    if (session.state !== "ready") return "closed";
    // 繋がるのを待っている間に、ほかの端末が書いたかもしれない。確かめ直す
    const before = this.lastPost;
    if (this.deps.now() - before < POST_GAP) return "wait";
    this.lastPost = this.deps.now();
    const result = await session.post(text, style);
    // 送らなかった (前の書き込みの返事を待っている) なら、間隔は使っていない
    if (result === "closed") this.lastPost = before;
    return result;
  }

  /** 全部閉じる (連携を外した) */
  closeAll(): void {
    for (const session of [...this.sessions.values()]) session.close();
    this.down.clear();
  }
}

/** サーバに 1 つ */
export const niconicoLive = new NiconicoLive();
