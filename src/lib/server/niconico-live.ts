/**
 * **公式のニコニコ実況に書き込み、コメントを受ける** (ニコニコと連携しているとき。連携そのものは `niconico.ts`)。
 *
 * - **視聴の WebSocket は denpa のサーバが張る。** トークンも接続先の URL (それ自体が資格情報) も端末に出さない。
 *   端末が何台あっても、1 つの局に繋ぐのは 1 本。書き込みと受信で同じ接続を使う
 * - 接続先は denpa-hub の `/niconico/live/watch` から受け取る (局の ID とユーザー ID を渡し、アクセストークンを付ける)。
 *   ニコニコ固有の値は hub が持つ。hub が 401 を返したら 1 回だけトークンを更新してやり直す
 * - やり取りは NX-Jikkyo と同じ形式で、`startWatching` (映像はリクエストしない)・`ping` に `pong`・`seat` の間隔で `keepSeat`・
 *   `postComment` (いつも 184) に `postCommentResult` か `error`・`disconnect`・`reconnect` を使う。最初の返事が来たら書ける。
 *   書き込みの `vpos` の基準 (`vposBaseTime`) は、どの返事に載っていても読む (読めなければ繋いだ時刻)
 * - **コメントは `messageServer` の view から受ける** (`niconico-view.ts`)。局ごとに直近 `RING` のぶんを通し番号を付けて持ち、
 *   端末は `feed` で前回の番号より後を受け取る (ロングポーリング)。受けたコメントは家の端末にだけ渡す
 * - **繋ぐのは、書き込みの欄が開いているか、ライブの画面がその局のコメントを受けている間だけ。** 欄は 30 秒おきに `touch` を、
 *   ライブの画面は続けて `feed` を呼ぶ。`IDLE` の間どちらも呼ばれなければ閉じる。
 *   同じアカウントで開ける接続の数には上限がある (数は公開されていない) ので、同時に開くのは `MAX_SESSIONS` まで。
 *   超えたら、聴かれていない (`feed` が待っていない・`HOLD` の間返していない) もののうち、いちばん長く呼ばれていないものを閉じる。
 *   全部聴かれていれば新しい局は開かない
 * - 書き込みは 1 件ずつ、世帯 (アカウント) で `POST_GAP` 空ける。5 秒返事が無ければ「分からない」
 * - 切れたとき: `END_PROGRAM` (4:00 の替わり目) は次に呼ばれたらすぐ繋ぎ直す。`reconnect` は言われた秒数待ってから、
 *   URL の `audience_token` を替えて繋ぎ直す。追い出された・接続が多すぎるときは `LONG_RETRY`、ほかは `RETRY_AFTER` 待つ
 *
 * 接続先の URL とトークンは記録に書かない
 */
import { type PostStyle, readMail } from "../jikkyo/command";
import type { Comment } from "../jikkyo/comments";
import { POST_GAP, type PostResult, REPLY_WAIT, vpos } from "../jikkyo/post";
import { config, userAgent } from "./config";
import { accessToken, HUB_TIMEOUT, linkState, renew } from "./niconico";
import type { OfficialChat } from "./niconico-messages";
import { allowedHttp, allowedUrl, ViewReader } from "./niconico-view";

/** 呼ばれなくなってから閉じるまで (ms)。欄は 30 秒おきに呼ぶ */
export const IDLE = 2 * 60_000;
/** 同時に開く接続の上限。世帯で別々の局を観ることは多くないうえ、同じアカウントの接続の数には上限がある */
export const MAX_SESSIONS = 2;
/** 書き込みが来たとき、繋がるのを待つ上限 (ms) */
export const CONNECT_WAIT = 10_000;
/** 繋げなかったあと、次に試すまで (ms)。呼ばれるたびに hub を呼ばない */
export const RETRY_AFTER = 30_000;
/** 追い出された (同じアカウントでほかの所が観ている)・接続が多すぎると言われたあと、次に試すまで (ms) */
export const LONG_RETRY = 5 * 60_000;
/** `feed` が新しいものを待つ上限 (ms) */
export const LONG_POLL = 20_000;
/** 最初のコメントが来てから、まとめて返すまで (ms)。混む局で 1 秒に何度も呼ばせない */
export const BATCH = 400;
/** 最後の `feed` の返事からこの間は「聴かれている」(ms)。上限で閉じない */
export const HOLD = 10_000;
/** 局ごとに持つコメントの長さ (受けた時刻で。ms) */
export const RING = 2 * 60_000;

/** 欄と画面に返す接続の状態 */
export type LiveState =
  /** 繋いでいる途中 */
  | "connecting"
  /** 書ける */
  | "ready"
  /** 連携していない・切れた */
  | "unlinked"
  /** 繋げない (番組が無い・hub やニコニコが断った・届かない・上限)。しばらく後にまた試す */
  | "down";

/** 端末に渡すコメント。`own` は世帯のアカウントが書いたもの */
export type FeedComment = Comment & { own?: true };

/** `feed` の返事 */
export interface FeedReply {
  /** サーバを起こすたびに変わる。違えば端末は番号を捨てる */
  epoch: string;
  state: LiveState;
  /** 受信が途切れずに続いている始まり (unix ms。サーバの時計)。受けられていなければ null */
  since: number | null;
  /** サーバの時刻 (unix ms) */
  now: number;
  /** 最後の番号。次はこれを `after` に渡す */
  seq: number;
  comments: FeedComment[];
}

/** hub から接続先を受け取った結果 */
export type WatchResult = { url: string } | { error: string; status: number };

/** 差し替えられるもの (単体テストで偽物を渡す) */
export interface LiveDeps {
  /** hub の `/niconico/live/watch` */
  watch: (token: string, channel: string, user: string) => Promise<WatchResult>;
  open: (url: string) => WebSocket;
  /** メッセージサーバを読む */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  token: () => Promise<string | null>;
  renew: () => Promise<string | null>;
  user: () => string | null;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

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
      "User-Agent": userAgent(),
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

/** 繋いでよい接続先か。`wss:` だけ (テストの偽物だけは `ws:` も。`niconico-view.allowedUrl`) */
export function allowedSocket(url: string): boolean {
  return allowedUrl(url, "wss:", "ws:");
}

/** `reconnect` で受けたトークンに替えた URL。URL に `audience_token` が無ければ null (hub から受け取り直す) */
export function reconnectUrl(url: string, token: unknown): string | null {
  if (typeof token !== "string" || token === "") return null;
  try {
    const target = new URL(url);
    if (!target.searchParams.has("audience_token")) return null;
    target.searchParams.set("audience_token", token);
    return target.toString();
  } catch {
    return null;
  }
}

/** 受けたコメントを端末に渡す形に。流さないもの (空・運営の命令) は null。決まりは `comments.ts` の `toComment` と同じ */
export function toFeedComment(chat: OfficialChat): FeedComment | null {
  const text = chat.text.trim();
  if (text === "" || /^\/[a-z]/.test(text)) return null;
  const style = readMail(chat.mail);
  const comment: FeedComment =
    Object.keys(style).length > 0
      ? { at: chat.at, text, style }
      : { at: chat.at, text };
  if (chat.own) comment.own = true;
  return comment;
}

const server: LiveDeps = {
  watch: hubWatch,
  // Bun の WebSocket はヘッダーを付けられる。ニコニコはツールの名前が分かる User-Agent を求めている
  open: (url) =>
    new WebSocket(url, {
      headers: { "User-Agent": userAgent() },
    } as unknown as string[]),
  fetch: (url, init) => fetch(url, init),
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

/** 接続が外へ知らせること */
interface SessionEvents {
  log: (message: string) => void;
  /** 閉じた */
  end: (session: Session) => void;
  /** コメントが来た */
  chats: (chats: OfficialChat[]) => void;
  /** 状態 (`state`・`since`) が変わった */
  changed: () => void;
}

/** 1 つの局への接続 */
class Session {
  state: LiveState = "connecting";
  touched: number;
  /** `down` になったあと、次に試してよい時刻 (0 なら待たない) */
  retryAt = 0;
  /** 受信が途切れずに続いている始まり (受けられていなければ null) */
  since: number | null = null;
  private ws: WebSocket | null = null;
  /** いまの視聴の WS の URL (`reconnect` で替える) */
  private url: string | null = null;
  private keep: unknown = null;
  private idle: unknown = null;
  /** `reconnect` で繋ぎ直すまでの目覚まし */
  private again: unknown = null;
  private reader: ViewReader | null = null;
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
    private readonly events: SessionEvents,
  ) {
    this.touched = deps.now();
    this.base = deps.now();
  }

  /** 欄・画面が呼んだ・書き込みが来た。閉じるまでの時間を延ばす */
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
      // hub に届かないのは連携が切れたのとは別 (`niconico.accessToken`)。最初の取得と同じく down にする
      token = await this.deps.renew().catch(() => {
        this.fail("トークンを更新できません (denpa-hub に届きません)");
        return undefined;
      });
      if (token === undefined || this.closed) return;
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
    if (this.closed) return;
    this.url = url;
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
      // disconnect も reconnect も無しに閉じられた。閉じられ続けて hub を呼び続けないよう、しばらく待つ
      this.fail(`${this.channel} の視聴の接続が切れました`);
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
      case "messageServer":
        this.receive(body["viewUri"], body["hashedUserId"]);
        break;
      case "postCommentResult":
        this.settlePost("sent");
        break;
      case "error":
        this.settlePost(
          body["message"] === "NOT_ON_AIR" ? "not-on-air" : "rejected",
        );
        break;
      case "reconnect": {
        const url = reconnectUrl(this.url ?? "", body["audienceToken"]);
        // URL を替えられなければ、閉じて次に呼ばれたときに接続先から取り直す
        if (url === null) return this.close();
        const wait = Number(body["waitTimeSec"]);
        // 視聴の WS だけを替える。受信 (view) はそのまま続ける
        this.dropSocket();
        this.settle("connecting");
        this.again = this.deps.setTimeout(
          () => {
            this.again = null;
            this.connect(url);
          },
          Number.isFinite(wait) && wait > 0 ? wait * 1000 : 0,
        );
        break;
      }
      case "disconnect": {
        const reason = String(body["reason"] ?? "");
        // 番組の終わり (4:00 の替わり目)。閉じて、次に呼ばれたときに接続先から取り直す
        if (reason === "END_PROGRAM") return this.close();
        // 同じアカウントでほかの所が観ている・接続が多すぎる。すぐ繋ぎ直すと追い出し合う
        const long =
          reason === "TAKEOVER" ||
          reason === "TOO_MANY_CONNECTIONS" ||
          reason === "TOO_MANY_WATCHINGS";
        this.fail(
          `${this.channel} の視聴の接続が切られました (${reason || "理由なし"})`,
          long ? LONG_RETRY : RETRY_AFTER,
        );
        break;
      }
    }
  }

  /** コメントを受け始める。view が替わったときだけ読み直す */
  private receive(view: unknown, hashed: unknown): void {
    if (typeof view !== "string" || !allowedHttp(view)) {
      this.events.log("messageServer の view が https: ではありません");
      return;
    }
    if (this.reader?.view === view) return;
    this.reader?.stop();
    this.setSince(null);
    const reader = new ViewReader(
      view,
      typeof hashed === "string" ? hashed : null,
      this.deps,
      {
        chats: (chats) => {
          if (reader === this.reader) this.events.chats(chats);
        },
        receiving: (ok) => {
          if (reader !== this.reader) return;
          this.setSince(ok ? (this.since ?? this.deps.now()) : null);
        },
        fatal: (reason) => {
          if (reader === this.reader) this.fail(`${this.channel} の ${reason}`);
        },
      },
    );
    this.reader = reader;
    reader.start();
  }

  private setSince(since: number | null): void {
    if (since === this.since) return;
    this.since = since;
    this.events.changed();
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

  /** 状態を決めて、待っているものを起こす */
  private settle(state: LiveState): void {
    const changed = state !== this.state;
    this.state = state;
    for (const wake of this.waiters.splice(0)) wake();
    if (changed) this.events.changed();
  }

  /** 繋げない。`wait` の間は試し直さない */
  private fail(reason: string, wait = RETRY_AFTER): void {
    if (this.closed) return;
    this.events.log(reason);
    this.retryAt = this.deps.now() + wait;
    this.settle("down");
    this.close();
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

  /** 視聴の WS だけを閉じる (受信は止めない) */
  private dropSocket(): void {
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

  /** 閉じる (使われなくなった・番組が替わった・連携を外した・繋げなかった・上限) */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of [this.idle, this.again])
      if (timer !== null) this.deps.clearTimeout(timer);
    this.idle = null;
    this.again = null;
    this.dropSocket();
    this.reader?.stop();
    this.reader = null;
    this.since = null;
    // 使われなくなった・番組が替わったときは、次に呼ばれたらすぐ繋ぎ直す (待つのは繋げなかったときだけ。`retryAt`)
    if (this.state === "connecting" || this.state === "ready") {
      this.state = "down";
      for (const wake of this.waiters.splice(0)) wake();
    }
    this.events.changed();
    this.events.end(this);
  }

  get ended(): boolean {
    return this.closed;
  }
}

/** 局ごとに持つもの (受けたコメントと、`feed` で待っているもの)。サーバが動いている間は作り直さない */
interface Channel {
  seq: number;
  ring: { seq: number; got: number; comment: FeedComment }[];
  /** 待っている `feed`。`true` はすぐ返す (状態が変わった)、`false` はまとめて返す (コメントが来た) */
  waiters: Set<(now: boolean) => void>;
  /** 待っている `feed` の数 */
  waiting: number;
  /** 最後に `feed` に返した時刻 */
  replied: number;
}

/** 公式の実況への接続をまとめるもの (サーバに 1 つ。下の `niconicoLive`) */
export class NiconicoLive {
  private readonly sessions = new Map<string, Session>();
  /** 繋げなかった局と、次に試してよい時刻 */
  private readonly down = new Map<string, number>();
  private readonly channels = new Map<string, Channel>();
  /** 最後に書いた時刻 (世帯で 1 つのアカウントなので、局をまたいで数える) */
  private lastPost = Number.NEGATIVE_INFINITY;
  /** 最後に記録に残した理由。同じものは繰り返さない */
  private lastReason: string | null = null;
  /** サーバを起こすたびに変わる (`feed` の番号が続いているか) */
  readonly epoch = crypto.randomUUID();

  constructor(private readonly deps: LiveDeps = server) {}

  private log(reason: string): void {
    if (reason === this.lastReason) return;
    this.lastReason = reason;
    console.warn(`[niconico] ${reason}`);
  }

  private channel(name: string): Channel {
    let ch = this.channels.get(name);
    if (ch === undefined) {
      ch = {
        seq: 0,
        ring: [],
        waiters: new Set(),
        waiting: 0,
        replied: Number.NEGATIVE_INFINITY,
      };
      this.channels.set(name, ch);
    }
    return ch;
  }

  /** 聴かれているか (`feed` が待っている・`HOLD` の間に返した) */
  private held(name: string): boolean {
    const ch = this.channels.get(name);
    return (
      ch !== undefined &&
      (ch.waiting > 0 || this.deps.now() - ch.replied < HOLD)
    );
  }

  /**
   * **欄が開いている (30 秒おきに呼ぶ)・画面がコメントを受けている。** 繋いでいなければ繋ぎ始め、いまの状態を返す。
   * 繋げなかった局は決めた時刻まで試し直さない
   */
  touch(channel: string): LiveState {
    const session = this.sessions.get(channel);
    if (session !== undefined && !session.ended) {
      session.touch();
      // 繋がったあとの失敗は、前と同じ理由でも記録に残す (`open` は繋ぎ始めたところで返るので、繋がったかはここで見る)
      if (session.state === "ready") this.lastReason = null;
      return session.state;
    }
    const retryAt = this.down.get(channel);
    if (retryAt !== undefined && this.deps.now() < retryAt) return "down";
    if (this.deps.user() === null) return "unlinked";
    return this.start(channel)?.state ?? "down";
  }

  /** 繋ぎ始める。上限で、聴かれていないものを閉じられなければ null */
  private start(channel: string): Session | null {
    while (this.sessions.size >= MAX_SESSIONS) {
      const free = [...this.sessions.values()]
        .filter((s) => !this.held(s.channel))
        .sort((a, b) => a.touched - b.touched)[0];
      if (free === undefined) return null;
      free.close();
    }
    this.down.delete(channel);
    const session = new Session(channel, this.deps, {
      log: (reason) => this.log(reason),
      end: (ended) => {
        if (this.sessions.get(channel) === ended) this.sessions.delete(channel);
        if (ended.retryAt > 0) this.down.set(channel, ended.retryAt);
      },
      chats: (chats) => this.add(channel, chats),
      changed: () => this.wake(channel, true),
    });
    this.sessions.set(channel, session);
    void session.open().then(() => {
      // 連携していない・切れたものは閉じる。次に呼ばれたら試し直す
      if (session.state === "unlinked") session.close();
    });
    return session;
  }

  /** 受けたコメントを局の持ち物に足し、待っている `feed` を起こす */
  private add(name: string, chats: OfficialChat[]): void {
    const ch = this.channel(name);
    const now = this.deps.now();
    let added = false;
    for (const chat of chats) {
      const comment = toFeedComment(chat);
      if (comment === null) continue;
      ch.ring.push({ seq: ++ch.seq, got: now, comment });
      added = true;
    }
    while (ch.ring.length > 0 && ch.ring[0]!.got < now - RING) ch.ring.shift();
    if (added) this.wake(name, false);
  }

  private wake(name: string, now: boolean): void {
    for (const wake of [...(this.channels.get(name)?.waiters ?? [])]) wake(now);
  }

  /** いまの状態 (繋ぎ始めない) */
  private peek(channel: string): LiveState {
    const session = this.sessions.get(channel);
    if (session !== undefined && !session.ended) return session.state;
    if (this.deps.user() === null) return "unlinked";
    return "down";
  }

  /**
   * **コメントを受ける** (ライブの画面が続けて呼ぶ。ロングポーリング)。`after` より後の番号のコメントを返す。
   * 無ければ、コメントが来る (`BATCH` だけまとめる)・状態が変わる・`LONG_POLL` が過ぎる・`signal` が止まるまで待つ。
   * `after` が無い・`epoch` が違う (サーバを起こし直した) ときは、コメントを返さずにいまの番号だけ返す。
   * `after` が持っているものより古ければ、持っているものの先頭から返す
   */
  async feed(
    channel: string,
    after: number | null,
    epoch: string | null,
    signal?: AbortSignal,
  ): Promise<FeedReply> {
    const ch = this.channel(channel);
    this.touch(channel);
    const from = epoch === this.epoch ? after : null;
    if (from !== null && !ch.ring.some((r) => r.seq > from)) {
      ch.waiting++;
      await new Promise<void>((resolve) => {
        let batch: unknown = null;
        const finish = () => {
          ch.waiters.delete(wake);
          signal?.removeEventListener("abort", finish);
          this.deps.clearTimeout(timer);
          if (batch !== null) this.deps.clearTimeout(batch);
          resolve();
        };
        const wake = (now: boolean) => {
          if (now) finish();
          else batch ??= this.deps.setTimeout(finish, BATCH);
        };
        const timer = this.deps.setTimeout(finish, LONG_POLL);
        ch.waiters.add(wake);
        signal?.addEventListener("abort", finish);
        if (signal?.aborted === true) finish();
      });
      ch.waiting--;
    }
    ch.replied = this.deps.now();
    const session = this.sessions.get(channel);
    return {
      epoch: this.epoch,
      state: this.peek(channel),
      since: session !== undefined && !session.ended ? session.since : null,
      now: this.deps.now(),
      seq: ch.seq,
      comments:
        from === null
          ? []
          : ch.ring.filter((r) => r.seq > from).map((r) => r.comment),
    };
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
