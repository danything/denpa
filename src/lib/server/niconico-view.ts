/**
 * **公式のニコニコ実況のコメントを受ける** (メッセージサーバ。`niconico-live.ts` の接続ごとに 1 つ)。
 *
 * - 視聴の WebSocket の `messageServer` が言う view から始める。`at=now` で次の時刻 (`next`) を受け、その時刻の view で
 *   セグメントの URI を受ける。セグメントは待たずに読み始め (先読み)、view は `next` が来たら次へ進む
 * - 読んだセグメントの URI は覚えて 2 度読まない。コメントはメッセージの ID で重なりを除く (投稿時刻が直近 `ID_SPAN` のもの)
 * - **止まったものを見分ける。** view は `STALL` の間バイトが届かなければ失敗にする。セグメントは区間の終わりから `STALL` 過ぎたら止める
 * - view の失敗 (503・届かない・途中で切れた・止まった) は、1 秒・2 秒…30 秒で頭打ちのバックオフで `at=now` から取り直す。
 *   失敗したらすぐ「受けられていない」にする (`receiving(false)`)。読めたら戻す
 * - view の 403・404 はこの view では直らない。`fatal` を呼び、接続ごと受け取り直してもらう
 * - セグメントの失敗は 1 秒・2 秒で 3 回まで試し直す。それでも読めなければ捨てて、受けられていないことにする
 * - `stop` で読んでいるものを全部止める
 *
 * URL は記録に書かない (資格情報が入っていることがある)
 */
import { userAgent } from "./config";
import {
  Delimited,
  type OfficialChat,
  readEntry,
  readMessage,
} from "./niconico-messages";

/** これだけバイトが届かなければ止まったとみなす (ms)。セグメントは 16 秒ほどの区間なので、それより少し長く */
export const STALL = 30_000;
/** view の取り直しの間隔の頭打ち (ms) */
export const VIEW_BACKOFF_MAX = 30_000;
/** セグメントを試す回数 */
export const SEGMENT_TRIES = 3;
/** 重なりを除くために ID を持つ長さ (投稿時刻で。ms) */
export const ID_SPAN = 3 * 60_000;
/** 古い ID を捨てる間隔 (ms) */
const PRUNE_EVERY = 10_000;

/** 差し替えられるもの (単体テストで偽物を渡す) */
export interface ViewDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export interface ViewEvents {
  /** コメントが来た (重なりを除いたもの) */
  chats: (chats: OfficialChat[]) => void;
  /** 受けられているか */
  receiving: (ok: boolean) => void;
  /** この view では直らない (403・404) */
  fatal: (reason: string) => void;
}

/** 読んでよい URL か。`https:` だけ。テストの偽物 (ループバックのアドレス) だけは `http:` も通す */
export function allowedHttp(url: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol === "https:") return true;
    return (
      target.protocol === "http:" &&
      (target.hostname === "127.0.0.1" || target.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/** 1 回の読み取りの結果 */
type Read = { ok: true; next: number | null } | { ok: false; status: number };

export class ViewReader {
  private stopped = false;
  private readonly aborts = new Set<AbortController>();
  /** 読んだ (読んでいる) セグメントの URI と、その区間の終わり */
  private readonly segments = new Map<string, number>();
  /** 受けたメッセージの ID と投稿時刻 */
  private readonly ids = new Map<string, number>();
  private ok: boolean | null = null;
  /** 最後に古い ID を捨てた時刻 */
  private pruned = Number.NEGATIVE_INFINITY;

  constructor(
    readonly view: string,
    /** `messageServer` の `hashedUserId` */
    private readonly self: string | null,
    private readonly deps: ViewDeps,
    private readonly events: ViewEvents,
  ) {}

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    for (const abort of this.aborts) abort.abort();
    this.aborts.clear();
  }

  private mark(ok: boolean): void {
    if (this.stopped || this.ok === ok) return;
    this.ok = ok;
    this.events.receiving(ok);
  }

  private async run(): Promise<void> {
    let at = "now";
    let failures = 0;
    while (!this.stopped) {
      const read = await this.readView(at);
      if (this.stopped) return;
      if (read.ok && read.next !== null) {
        failures = 0;
        at = String(read.next);
        continue;
      }
      if (!read.ok && (read.status === 403 || read.status === 404)) {
        this.events.fatal(`view を読めません (HTTP ${read.status})`);
        return;
      }
      // 失敗した・次の時刻が来なかった。いまから取り直す
      failures++;
      this.mark(false);
      at = "now";
      await this.sleep(Math.min(VIEW_BACKOFF_MAX, 1_000 * 2 ** (failures - 1)));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.setTimeout(resolve, ms));
  }

  /**
   * `url` を読み、長さ付きの並びを 1 つずつ `each` に渡す。`deadline` (ms。無ければ `STALL` の間バイトが来なければ) で止める。
   * 返すのは HTTP の状態 (届かない・止まった・途中で切れたら 0)
   */
  private async stream(
    url: string,
    each: (message: Uint8Array) => void,
    deadline?: number,
  ): Promise<number> {
    const abort = new AbortController();
    this.aborts.add(abort);
    let timer: unknown = null;
    const arm = (ms: number) => {
      if (timer !== null) this.deps.clearTimeout(timer);
      timer = this.deps.setTimeout(() => abort.abort(), ms);
    };
    arm(deadline ?? STALL);
    try {
      const res = await this.deps.fetch(url, {
        headers: {
          "User-Agent": userAgent(),
          Accept: "application/octet-stream",
        },
        signal: abort.signal,
      });
      if (!res.ok || res.body === null) {
        await res.body?.cancel().catch(() => {});
        return res.status === 200 ? 0 : res.status;
      }
      const reader = res.body.getReader();
      const split = new Delimited();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (deadline === undefined) arm(STALL);
        for (const message of split.push(value)) each(message);
      }
      return 200;
    } catch {
      return 0;
    } finally {
      if (timer !== null) this.deps.clearTimeout(timer);
      this.aborts.delete(abort);
    }
  }

  private async readView(at: string): Promise<Read> {
    const url = new URL(this.view);
    url.searchParams.set("at", at);
    let next: number | null = null;
    const status = await this.stream(url.toString(), (message) => {
      let entry;
      try {
        entry = readEntry(message);
      } catch {
        return;
      }
      if (entry === null) return;
      if ("next" in entry) next = entry.next;
      else this.openSegment(entry.segment, entry.until);
    });
    if (status !== 200) return { ok: false, status };
    return { ok: true, next };
  }

  private openSegment(uri: string, until: number): void {
    if (this.stopped || this.segments.has(uri) || !allowedHttp(uri)) return;
    const now = this.deps.now();
    for (const [known, end] of this.segments)
      if (end < now - ID_SPAN) this.segments.delete(known);
    this.segments.set(uri, until);
    void this.readSegment(uri, until);
  }

  private async readSegment(uri: string, until: number): Promise<void> {
    for (let i = 0; i < SEGMENT_TRIES; i++) {
      const left = Math.max(0, until - this.deps.now()) + STALL;
      const status = await this.stream(
        uri,
        (message) => this.onMessage(message),
        left,
      );
      if (this.stopped || status === 200) return;
      // 区間を十分過ぎた・パスが無い。試し直しても読めない
      if (status === 404 || this.deps.now() > until + STALL) break;
      await this.sleep(1_000 * 2 ** i);
    }
    this.mark(false);
  }

  /** セグメントの 1 メッセージ。届いたら受けられていることにする (コメントの無いセグメントでも、先頭に合図が来る) */
  private onMessage(message: Uint8Array): void {
    this.mark(true);
    let chat: OfficialChat | null;
    try {
      chat = readMessage(message, this.self);
    } catch {
      return;
    }
    if (chat === null || this.ids.has(chat.id)) return;
    const now = this.deps.now();
    this.ids.set(chat.id, chat.at);
    if (now - this.pruned >= PRUNE_EVERY) {
      this.pruned = now;
      for (const [id, at] of this.ids)
        if (at < now - ID_SPAN) this.ids.delete(id);
    }
    this.events.chats([chat]);
  }
}
