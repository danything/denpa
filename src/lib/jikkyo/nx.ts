/**
 * **NX-Jikkyo の WebSocket に繋ぐ** (端末から直接。denpa のサーバは通らない)。
 *
 * 1. 視聴の WS (`watchUrl`) に繋ぎ、`startWatching` を送る。`room` でコメントの WS の URL と
 *    スレッドを受け取る (URL はこちらで組まない。変わっても追える)。`seat` の間隔で `keepSeat`、`ping` には `pong` を返す
 * 2. コメントの WS に旧ニコ生と同じ形式の `thread` を送る (`res_from: -100`。局を替えた直後でもすぐ流せる)。
 *    返事の `thread` のあと、直近のぶんと新しい `chat` が 1 件ずつ来る
 * 3. 切れたら 1 秒 → 2 秒 → … 60 秒で頭打ちで繋ぎ直す。5 回続けて失敗したら「いまは読めない」にし、
 *    60 秒おきに試し続ける。スレッドは毎日 4:00 に替わり、サーバが閉じる (`disconnect` か、コード 1000)。
 *    そのときは視聴の WS から繋ぎ直して新しいスレッドを受け取る (替わり目の数秒は抜けることがある)
 *
 * 4. 書き込み (`post`) は視聴の WS に `postComment` を送り、返事 (`postCommentResult` か `error`) を待つ。1 件ずつで、
 *    5 秒返事が無ければ「分からない」。`room` の `yourPostKey` を `thread` の `threadkey` に渡しておくと、自分の書き込みは
 *    コメントの WS から `yourpost: 1` で戻ってくる。送れたものは画面がすぐ流すので、戻ってきたものは 1 回だけ捨てる (`Echoes`)
 */
import type { PostStyle } from "./command";
import { type Comment, toComment } from "./comments";
import { NX_JIKKYO_WS, watchUrl } from "./endpoints";
import { Echoes, type PostResult, REPLY_WAIT, vpos } from "./post";

/** 続けて何回失敗したら「いまは読めない」にするか */
const FAILURES_TO_DOWN = 5;
/** 繋ぎ直しの間隔の頭打ち (ms) */
const MAX_BACKOFF = 60_000;
/** 遡るときの件数の上限 (NX-Jikkyo の DB の読み出しは重いので、1 回だけ・1000 件まで) */
const BACKFILL_LIMIT = 1000;

/**
 * `room` が言うコメントの WS の URL から、NX-Jikkyo の中のパスだけを取る。**NX-Jikkyo の外を指していたら null** —
 * 返事の言うまま別のホストへ繋がない (CSP でも止まるが、こちらでも確かめる)。URL はこの定数のオリジンに付け直して使う
 */
export function commentPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.origin === NX_JIKKYO_WS ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

interface NxEvents {
  /** コメントが来た (形式のずれたもの・流さないものは来ない) */
  comments: (comments: Comment[]) => void;
  /** 読めているか。最初は読めている扱い。5 回続けて失敗したら false、戻れば true */
  state: (ok: boolean) => void;
  /** 形式のずれた返事を受けた (呼ぶ側が 1 回だけ警告する) */
  odd: (what: string) => void;
}

/** 差し替えられるもの (単体テストで偽物を渡す) */
export interface NxDeps {
  open: (url: string) => WebSocket;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  now: () => number;
}

const browser: NxDeps = {
  open: (url) => new WebSocket(url),
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class NxJikkyo {
  private watch: WebSocket | null = null;
  private comment: WebSocket | null = null;
  private keep: unknown = null;
  private retry: unknown = null;
  private failures = 0;
  private ok = true;
  /** いまの繋ぎでスレッドの返事を受けたか。受ける前にきれいに閉じられたら、失敗に数える (すぐ閉じられ続けて 1 秒おきに繋ぎ続けない) */
  private live = false;
  private closed = false;
  /** いまのスレッド (`room`)。コメントの WS に `thread` を送るのに使う */
  private room: { thread: string; key: string; base: number } | null = null;
  /** 返事を待っている書き込み。1 件ずつ */
  private pending: {
    text: string;
    timer: unknown;
    /** 返事より先に、自分の書き込みが戻ってきた (送れている) */
    echoed: boolean;
    done: (result: PostResult) => void;
  } | null = null;
  private readonly echoes = new Echoes();
  /** 遡る起点の時刻 (unix ms)。コメントの WS が開いたら 1 回だけ送る */
  private backfillBefore: number | null = null;
  private backfilled = false;

  constructor(
    private readonly channel: string,
    private readonly events: NxEvents,
    private readonly deps: NxDeps = browser,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  /** 書き込めるか (視聴の WS が開いていて、スレッドを受け取っている。返事を待っている間は false) */
  get ready(): boolean {
    return (
      this.watch !== null &&
      this.watch.readyState === 1 &&
      this.room !== null &&
      this.pending === null
    );
  }

  /**
   * 書き込む (`text` は確かめ終えたもの。`post.ts` の `refusal`)。いつも 184 (匿名)。色・位置・大きさは選んだもの
   * (NX-Jikkyo のサーバが `mail` に組む)。
   * 繋がっていない・返事を待っている間は `closed`
   */
  post(text: string, style: PostStyle): Promise<PostResult> {
    const ws = this.watch;
    const room = this.room;
    if (!this.ready || ws === null || room === null)
      return Promise.resolve("closed");
    const now = this.deps.now();
    return new Promise((resolve) => {
      this.pending = {
        text,
        echoed: false,
        timer: this.deps.setTimeout(
          () => this.settlePost(this.pending?.echoed ? "sent" : "unknown"),
          REPLY_WAIT,
        ),
        done: resolve,
      };
      this.echoes.expect(text, now);
      ws.send(
        JSON.stringify({
          type: "postComment",
          data: {
            text,
            vpos: vpos(now, room.base),
            isAnonymous: true,
            color: style.color,
            position: style.position,
            size: style.size,
          },
        }),
      );
    });
  }

  /** 書き込みの返事が決まった。送れなかったものは、戻ってきても捨てない */
  private settlePost(result: PostResult): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.deps.clearTimeout(pending.timer);
    if (result !== "sent") this.echoes.forget(pending.text);
    pending.done(result);
  }

  /** 閉じる。もう繋ぎ直さない */
  close(): void {
    this.closed = true;
    this.teardown();
    if (this.retry !== null) this.deps.clearTimeout(this.retry);
    this.retry = null;
  }

  /**
   * `before` より前のコメントを 1 回だけ遡って取る (録画中の追っかけで、過去ログにまだ入っていない 10 分以内のところ)。
   * 2 度目からは何もしない — NX-Jikkyo の DB の読み出しは重いので、何度も遡らない
   */
  backfill(before: number): void {
    if (this.backfilled || this.backfillBefore !== null) return;
    this.backfillBefore = before;
    this.sendBackfill();
  }

  private connect(): void {
    if (this.closed) return;
    this.live = false;
    const ws = this.deps.open(watchUrl(this.channel));
    this.watch = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ type: "startWatching", data: { reconnect: false } }),
      );
    };
    ws.onmessage = (event) => this.onWatch(ws, event.data);
    ws.onclose = (event) => this.onClose(ws, event.code);
    ws.onerror = () => {
      // 続く close で繋ぎ直す
    };
  }

  private onWatch(ws: WebSocket, data: unknown): void {
    if (ws !== this.watch) return;
    let message: { type?: unknown; data?: Record<string, unknown> };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      this.events.odd("視聴の WS の返事を読めません");
      return;
    }
    const body = message.data ?? {};
    switch (message.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "seat": {
        // ニコ生と同じ決まりなので送る (いまの NX-Jikkyo は来なくても切らない)
        const every = Number(body["keepIntervalSec"]);
        this.startKeep(ws, Number.isFinite(every) && every > 0 ? every : 30);
        break;
      }
      case "room": {
        const server = body["messageServer"] as { uri?: unknown } | undefined;
        const uri = server?.uri;
        const thread = body["threadId"];
        if (typeof uri !== "string" || typeof thread !== "string") {
          this.events.odd("room の形式が違います");
          return;
        }
        const path = commentPath(uri);
        if (path === null) {
          this.events.odd(
            "room のコメントの WS が NX-Jikkyo の外を指しています",
          );
          return;
        }
        const key = body["yourPostKey"];
        // 書き込みの vpos の基準。読めなければ受け取った時刻 (vpos はずれるが、流れ方には効かない)
        const base = Date.parse(String(body["vposBaseTime"]));
        this.room = {
          thread,
          key: typeof key === "string" ? key : "",
          base: Number.isFinite(base) ? base : this.deps.now(),
        };
        this.openComment(`${NX_JIKKYO_WS}${path}`);
        break;
      }
      case "postCommentResult":
        this.settlePost("sent");
        break;
      case "error":
        // 書き込みの返事。待っていなければ何もしない
        if (this.pending === null) break;
        this.settlePost(
          body["message"] === "NOT_ON_AIR" ? "not-on-air" : "rejected",
        );
        break;
      case "disconnect":
        // スレッドの終わり (`END_PROGRAM`) など。視聴の WS から繋ぎ直す
        this.teardown();
        this.schedule(this.live);
        break;
    }
  }

  private openComment(uri: string): void {
    this.comment?.close();
    const ws = this.deps.open(uri);
    this.comment = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify([
          { ping: { content: "rs:0" } },
          { ping: { content: "ps:0" } },
          {
            thread: {
              version: "20061206",
              thread: this.room?.thread ?? "",
              threadkey: this.room?.key ?? "",
              res_from: -100,
            },
          },
          { ping: { content: "pf:0" } },
          { ping: { content: "rf:0" } },
        ]),
      );
      this.sendBackfill();
    };
    ws.onmessage = (event) => this.onComment(ws, event.data);
    ws.onclose = (event) => this.onClose(ws, event.code);
    ws.onerror = () => {
      // 続く close で繋ぎ直す
    };
  }

  private sendBackfill(): void {
    const ws = this.comment;
    const before = this.backfillBefore;
    if (ws === null || before === null || ws.readyState !== 1) return;
    this.backfillBefore = null;
    this.backfilled = true;
    // `when` を付けると「その時刻より前の res_from 件」を返して止まる (新しいものの配信はそのまま続く)
    ws.send(
      JSON.stringify([
        {
          thread: {
            version: "20061206",
            thread: this.room?.thread ?? "",
            threadkey: this.room?.key ?? "",
            res_from: -BACKFILL_LIMIT,
            when: Math.floor(before / 1000),
          },
        },
      ]),
    );
  }

  private onComment(ws: WebSocket, data: unknown): void {
    if (ws !== this.comment) return;
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      this.events.odd("コメントの WS の返事を読めません");
      return;
    }
    // 1 回に 1 つのはずだが、並びで来ても読む
    const list = Array.isArray(message) ? message : [message];
    const comments: Comment[] = [];
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      if ("thread" in item) this.settle();
      if (!("chat" in item)) continue;
      const chat = (item as { chat: unknown }).chat;
      const comment = toComment(chat);
      if (comment === undefined) this.events.odd("chat の形式が違います");
      else if (comment !== null && !this.ownEcho(chat, comment.text))
        comments.push(comment);
    }
    if (comments.length > 0) this.events.comments(comments);
  }

  /** 戻ってきた自分の書き込みで、もう流したもの。返事を待っている間なら、送れている印にする */
  private ownEcho(chat: unknown, text: string): boolean {
    if ((chat as { yourpost?: unknown }).yourpost !== 1) return false;
    if (!this.echoes.take(text, this.deps.now())) return false;
    if (this.pending?.text === text) this.pending.echoed = true;
    return true;
  }

  /** 読めるようになった。失敗の数を戻す */
  private settle(): void {
    this.failures = 0;
    this.live = true;
    if (!this.ok) {
      this.ok = true;
      this.events.state(true);
    }
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.watch && ws !== this.comment) return;
    // どちらかが閉じたら両方やり直す (視聴の WS から)
    const clean = code === 1000 && this.live;
    this.teardown();
    this.schedule(clean);
  }

  /**
   * 繋ぎ直しを仕掛ける。`clean` はサーバがきれいに閉じた (4:00 のスレッドの替わり目) ときで、
   * 失敗に数えず 1 秒後に繋ぎ直す
   */
  private schedule(clean: boolean): void {
    if (this.closed || this.retry !== null) return;
    if (!clean) this.failures++;
    if (this.failures >= FAILURES_TO_DOWN && this.ok) {
      this.ok = false;
      this.events.state(false);
    }
    const wait = clean
      ? 1_000
      : Math.min(MAX_BACKOFF, 1_000 * 2 ** Math.max(0, this.failures - 1));
    this.retry = this.deps.setTimeout(() => {
      this.retry = null;
      this.connect();
    }, wait);
  }

  private startKeep(ws: WebSocket, seconds: number): void {
    if (this.keep !== null) this.deps.clearTimeout(this.keep);
    const tick = () => {
      if (ws !== this.watch || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: "keepSeat" }));
      this.keep = this.deps.setTimeout(tick, seconds * 1000);
    };
    this.keep = this.deps.setTimeout(tick, seconds * 1000);
  }

  private teardown(): void {
    if (this.keep !== null) this.deps.clearTimeout(this.keep);
    this.keep = null;
    // 返事を待っている間に切れた。届いたかは分からない (戻ってきていれば送れている)
    this.settlePost(this.pending?.echoed === true ? "sent" : "unknown");
    this.room = null;
    const watch = this.watch;
    const comment = this.comment;
    this.watch = null;
    this.comment = null;
    for (const ws of [watch, comment]) {
      if (ws === null) continue;
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
    // 遡りは繋ぎ直しても取り直さない (1 回だけ)。送る前だったものは次の WS で送る
  }
}
