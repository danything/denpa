/**
 * **流すコメントを、いまの放送時刻に合わせて出す** (ライブ・追っかけ・観る画面で同じ 1 つ)。
 *
 * 画面は放送時刻 `W` (いま映しているコマの放送時刻。ライブは `clock` の通知、録画は `ts_head` と再生位置から) を
 * 渡して `take` を呼び、返ってきたものを流す (`JikkyoLayer`)。出し方は `cursor.ts`。
 * コメントの出どころ (NX-Jikkyo・過去ログ API) と控えはここが持つ。どこから埋めるかは docs/watch.md の「実況」
 */
import type { Comment, CommentStore } from "./comments";
import { Cursor, type Take } from "./cursor";
import { type NxDeps, NxJikkyo } from "./nx";

/** 形のずれは端末ごとに 1 回だけ言う (NX-Jikkyo や過去ログ API のバージョンが変わったときに気付けるように) */
let warned = false;
export function warnShape(what: string): void {
  if (warned) return;
  warned = true;
  console.warn(
    `[jikkyo] ${what}。実況の取得先のバージョンが変わったかもしれません (読めたぶんだけ流します)`,
  );
}

export class JikkyoFeed {
  /** 読めないか。読めなくなったら ⚙ の行に「(いまは読めません)」を添える (通知は出さない) */
  down = $state(false);

  private readonly cursor = new Cursor();
  private nx: NxJikkyo | null = null;
  private channel: string | null = null;
  private active = false;
  /** 読めなくなっている出どころ (`nx`・`kakolog`) */
  private readonly failing = new Set<string>();

  constructor(
    /** NX-Jikkyo の WebSocket に繋ぐか (ライブと追っかけ) */
    private readonly live: boolean,
    private readonly deps?: NxDeps,
  ) {}

  /** いまのチャンネル (`jk1` など)。null は実況の無い局 */
  get current(): string | null {
    return this.channel;
  }

  /** 流しているか (チャンネルがあり、オンのとき) */
  get running(): boolean {
    return this.active;
  }

  /** 控え (どこを埋めたか・一番古いコメント)。追っかけの取得の決め方に使う */
  get comments(): CommentStore {
    return this.cursor.store;
  }

  /**
   * 局を替えた・オン/オフを替えた。替わったら繋ぎ直す。局が替わったら控えも捨てる。
   * @param channel 実況のチャンネル。実況の無い局・世帯の設定がオフなら null
   * @param on 流すか (端末の設定がオンのとき)
   */
  set(channel: string | null, on: boolean): void {
    const active = on && channel !== null;
    if (channel === this.channel && active === this.active) return;
    if (channel !== this.channel) this.cursor.reset();
    else this.cursor.pause();
    this.channel = channel;
    this.active = active;
    this.stopSources();
    if (!active || !this.live || channel === null) return;
    this.nx = new NxJikkyo(
      channel,
      {
        comments: (comments) => this.cursor.receive(comments),
        state: (ok) => this.mark("nx", ok),
        odd: warnShape,
      },
      this.deps,
    );
    this.nx.start();
  }

  /** NX-Jikkyo で `before` より前を 1 回だけ遡る (追っかけ) */
  backfill(before: number): void {
    this.nx?.backfill(before);
  }

  /** 外から足す (過去ログ API で取ったもの)。`span` はその区間を埋めたことにする */
  add(comments: Comment[], span?: [number, number]): void {
    this.cursor.receive(comments, span);
  }

  /** 出どころが読めるか (過去ログ API は呼ぶ側が取得の結果で言う)。どれかが読めなければ `down` */
  mark(source: string, ok: boolean): void {
    if (ok) this.failing.delete(source);
    else this.failing.add(source);
    this.down = this.failing.size > 0;
  }

  /** 重ねるのを止めた (データ放送を出した・オフにした)。戻ったときに、止めていた間のぶんをまとめて流さない */
  pause(): void {
    this.cursor.pause();
  }

  /** いまの放送時刻 `w` までに書かれたもののうち、まだ流していないもの。流していないときは何も返さない */
  take(w: number): Take {
    if (!this.active) return { comments: [], jumped: false };
    return this.cursor.take(w);
  }

  /** 画面を閉じた。繋いでいるものを閉じる */
  close(): void {
    this.active = false;
    this.stopSources();
  }

  private stopSources(): void {
    this.nx?.close();
    this.nx = null;
    this.failing.clear();
    this.down = false;
  }
}
