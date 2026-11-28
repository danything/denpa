/**
 * **流すコメントを、いまの放送時刻に合わせて出す** (ライブ・追っかけ・観る画面で同じ 1 つ)。
 *
 * 画面は放送時刻 `W` (いま映しているコマの放送時刻。ライブは `clock` の通知、録画は `ts_head` と再生位置から) を
 * 渡して `take` を呼び、返ってきたものを流す (`JikkyoLayer`)。出し方は `cursor.ts`。
 * コメントの出どころと控えはここが持つ。ライブは denpa のサーバの `/api/jikkyo/feed` (`live.ts`)、録画は `/api/jikkyo/kakolog` (`kakolog.ts`)。
 * どちらもサーバが denpa-hub から受けたもので、端末は外へ繋がない。どこから埋めるかは docs/watch.md の「実況のコメント」
 */
import { resolve } from "$app/paths";

import { type PostStyle, postStyle } from "./command";
import type { Comment } from "./comments";
import { Cursor, type Take } from "./cursor";
import { fetchKakolog, KAKOLOG_LAG } from "./kakolog";
import { FORCE_SPAN, LIST_SPAN } from "./list";
import { type LiveComment, LiveReader } from "./live";
import { compileNg } from "./ng";
import type { OfficialWriter } from "./official";
import { ECHO_SPAN, Echoes, type PostResult } from "./post";

/** 過去ログが読めなかったとき、もう一度試すまで */
const KAKOLOG_RETRY = 60_000;
/** 過去ログにまだ入りきっていないところを取り足す間隔 (過去ログは 5 分おきに集めている) */
const KAKOLOG_REFRESH = 5 * 60_000;
/** 書き込みの結果としてサーバが返すもの */
const HUB_RESULTS: readonly PostResult[] = [
  "sent",
  "unknown",
  "rejected",
  "closed",
  "wait",
];

/** 形式のずれは端末ごとに 1 回だけ言う (denpa のサーバや denpa-hub のバージョンが変わったときに気付けるように) */
let warned = false;
function warnShape(what: string): void {
  if (warned) return;
  warned = true;
  console.warn(
    `[jikkyo] ${what}。denpa のサーバか denpa-hub のバージョンが違うかもしれません (読めたぶんだけ流します)`,
  );
}

export class JikkyoFeed {
  /** 読めないか。読めなくなったら ⚙ の行に「(いまは読めません)」を添える (通知は出さない) */
  down = $state(false);

  /** NG ワードを含むか (世帯の設定)。控えには残し、出すときに外す (語を変えたらすぐ効く。取り直さない) */
  private ng: (text: string) => boolean = () => false;
  /** コメントごとに NG かを控える。一覧は 0.25 秒ごとに同じものを読み直すので、そのたびに字をそろえ直さない */
  private ngSeen = new WeakMap<Comment, boolean>();
  private readonly cursor = new Cursor();
  private live: LiveReader | null = null;
  private channel: string | null = null;
  private active = false;
  /** 書き込みの返事を待っている */
  private posting = false;
  /** 公式に書いたもの。NX-Jikkyo が取り込んで流してくる (`src: "nicolive"`) が、自分の印が付かないので本文で 1 回だけ捨てる */
  private readonly officialEchoes = new Echoes();
  /** 書いて送れた独自コメントの `id` → 捨てる期限。購読から戻ってきたら 1 回だけ捨てる (もう流している) */
  private readonly expected = new Map<string, number>();
  /** 購読から受けた独自コメント (`id` →)。書いた返事より先に戻ってきたら、そのコメントに自分の印を付ける */
  private readonly seen = new Map<
    string,
    { comment: Comment; until: number }
  >();
  /** 読めなくなっている出どころ (`hub`・`kakolog`) */
  private readonly failing = new Set<string>();
  private kakologTimer: ReturnType<typeof setTimeout> | null = null;
  /** 過去ログの取得の回。止めたら進め、前の回の返事を捨てる */
  private kakologRun = 0;

  constructor(
    /** ライブのコメントを受けるか (ライブと追っかけ) */
    private readonly receives: boolean,
  ) {}

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
    if (!active || !this.receives || channel === null) return;
    // NX-Jikkyo が読めなくても、hub の独自コメントは流れて書けるので「読めない」にはしない (hub に届かないときだけ)
    this.live = new LiveReader(channel, resolve("api/jikkyo/feed"), {
      comments: (comments) => this.receiveLive(comments),
      state: (hub) => this.mark("hub", hub),
      odd: warnShape,
    });
    this.live.start();
  }

  /**
   * 過去ログから `from` から `to()` までを取る。録画は開いたときに 1 回 (`every` を省く)、録画中の追っかけは
   * `every` ごとに新しいところを取り足す。取ったところは控えが覚えているので、同じ区間を 2 度訊かない。
   * **10 分より新しいところは、取っても「埋めた」ことにしない** (過去ログにまだ入りきっていない。そこはライブの購読の直近 15 分が埋める)。
   * 録り終えてすぐ開いた録画は、そこが埋まるまで `KAKOLOG_REFRESH` ごとに取り足す。読めなければ (hub が取りきれなかったときも)
   * 「いまは読めない」にして、60 秒後にもう一度試す
   */
  kakolog(from: number, to: () => number, every?: number): void {
    this.stopKakolog();
    const channel = this.channel;
    if (!this.active || channel === null) return;
    const run = ++this.kakologRun;
    const step = async (): Promise<void> => {
      let ok = true;
      const now = Date.now();
      const end = Math.min(to(), now);
      // ここより新しいところは、まだ過去ログに入りきっていない
      const settled = now - KAKOLOG_LAG;
      for (const [start, stop] of this.cursor.store.missing(from, end)) {
        try {
          const got = await fetchKakolog(
            resolve("api/jikkyo/kakolog"),
            channel,
            start,
            stop,
          );
          if (run !== this.kakologRun) return;
          if (got.odd > 0) warnShape("過去ログの返事の形式が一部違います");
          // hub が過去ログ API から取りきれなかったら、取れた分だけ流し、埋めたことにはしない
          this.cursor.receive(
            got.comments,
            got.complete ? [start, Math.min(stop, settled)] : undefined,
          );
          if (!got.complete) ok = false;
        } catch {
          ok = false;
          break;
        }
      }
      if (run !== this.kakologRun) return;
      this.mark("kakolog", ok);
      const wait = !ok
        ? KAKOLOG_RETRY
        : (every ?? (end > settled ? KAKOLOG_REFRESH : undefined));
      if (wait !== undefined)
        this.kakologTimer = setTimeout(() => void step(), wait);
    };
    void step();
  }

  /** 書き込めるか (denpa のサーバを通して hub に繋がっていて、前の書き込みの返事を待っていない) */
  get writable(): boolean {
    return this.live?.writable === true && !this.posting;
  }

  /** いま流している実況のチャンネル (流していなければ null)。公式に書くときの書き先 (`official.ts`) */
  get current(): string | null {
    return this.active ? this.channel : null;
  }

  /**
   * 書き込む (確かめるのは呼ぶ側。`post.ts`)。`official` を渡したら公式のニコニコ実況へ (denpa のサーバ経由)、無ければ denpa-hub へ
   * (denpa のサーバ経由。hub が NX-Jikkyo にも書く)。送れたら、いまの放送時刻 `w` に置いてすぐ流す。
   * hub から戻ってきた同じものは `id` で 1 回だけ捨てる。公式に書いたものは NX-Jikkyo が取り込んで流してくる (`src: "nicolive"`) が、
   * 自分の印が付かないので本文で見分ける。`w` は返事を受けたときに読み、読めなければ送ったときの値に置く
   */
  async post(
    text: string,
    style: PostStyle,
    w: () => number | null,
    official?: OfficialWriter,
  ): Promise<PostResult> {
    const live = this.live;
    // live が無いのは、流していないときと録画だけ (どちらも書けない)
    if (live === null || this.posting) return "closed";
    const before = w();
    let result: PostResult;
    let id: string | undefined;
    this.posting = true;
    try {
      if (official === undefined)
        ({ result, id } = await this.postHub(text, style));
      else {
        this.officialEchoes.expect(text, Date.now());
        result = await official.post(text, style);
        if (result !== "sent") this.officialEchoes.forget(text);
      }
    } finally {
      this.posting = false;
    }
    const at = w() ?? before;
    if (result !== "sent" || live !== this.live) return result;
    // 購読から先に戻ってきていたら、それに印を付けるだけ (2 度流さない)
    const back = id === undefined ? undefined : this.seen.get(id);
    if (back !== undefined) {
      back.comment.mine = true;
      return result;
    }
    if (at === null) return result;
    if (id !== undefined) this.expected.set(id, Date.now() + ECHO_SPAN);
    const own = postStyle(style);
    this.cursor.receive([
      Object.keys(own).length > 0
        ? { at, text, style: own, mine: true }
        : { at, text, mine: true },
    ]);
    return result;
  }

  private async postHub(
    text: string,
    style: PostStyle,
  ): Promise<{ result: PostResult; id?: string }> {
    const channel = this.channel;
    if (channel === null) return { result: "closed" };
    try {
      const res = await fetch(resolve("api/jikkyo/comments"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, text, style }),
      });
      if (!res.ok) return { result: "rejected" };
      const body = (await res.json()) as { result?: unknown; id?: unknown };
      const result = HUB_RESULTS.includes(body.result as PostResult)
        ? (body.result as PostResult)
        : "unknown";
      return typeof body.id === "string" ? { result, id: body.id } : { result };
    } catch {
      return { result: "unknown" };
    }
  }

  /**
   * 購読から受けたものを控えに入れる。自分が書いて送れた独自コメントの戻りと、公式に書いたものを NX-Jikkyo が取り込んだ戻りは捨てる
   * (公式のコメントを自分で受けている間の `nicolive` の扱いを足すなら、ここで分ける)
   */
  private receiveLive(comments: LiveComment[]): void {
    const now = Date.now();
    for (const [id, until] of this.expected)
      if (until < now) this.expected.delete(id);
    for (const [id, entry] of this.seen)
      if (entry.until < now) this.seen.delete(id);
    const keep: LiveComment[] = [];
    for (const comment of comments) {
      if (
        comment.src === "nicolive" &&
        this.officialEchoes.take(comment.text, now)
      )
        continue;
      if (comment.id !== undefined) {
        if (this.expected.delete(comment.id)) continue;
        this.seen.set(comment.id, { comment, until: now + ECHO_SPAN });
      }
      keep.push(comment);
    }
    if (keep.length > 0) this.cursor.receive(keep);
  }

  /** 出どころが読めるか。どれかが読めなければ `down` */
  private mark(source: string, ok: boolean): void {
    if (ok) this.failing.delete(source);
    else this.failing.add(source);
    this.down = this.failing.size > 0;
  }

  /** 重ねるのを止めた (データ放送を出した・オフにした)。戻ったときに、止めていた間のぶんをまとめて流さない */
  pause(): void {
    this.cursor.pause();
  }

  /** NG ワードを替えた。次に出すものから効く */
  setNg(words: readonly string[]): void {
    this.ng = compileNg(words);
    this.ngSeen = new WeakMap();
  }

  /**
   * いまの放送時刻 `w` までに書かれたもののうち、まだ流していないもの。流していないときは何も返さない。
   * 録画は枠の外から流し始めるぶん、`ahead` ms 先まで出す (`cursor.ts`)。NG ワードを含むものは外す (自分の書き込みも)
   */
  take(w: number, ahead = 0): Take {
    if (!this.active) return { comments: [], jumped: false };
    const take = this.cursor.take(w, ahead);
    const comments = take.comments.filter((c) => !this.isNg(c));
    return { comments, jumped: take.jumped };
  }

  /**
   * コメントの一覧に並べるもの。いまの放送時刻 `w` までの `LIST_SPAN` に書かれたもののうち、新しいほうから `limit` 件
   * (時刻の順)。`take` と違って何も消費しないので、何度読んでもよい。NG ワードを含むものは外す
   */
  recent(w: number, limit: number): Comment[] {
    if (!this.active) return [];
    return this.cursor.store.latest(
      w - LIST_SPAN,
      w,
      limit,
      (c) => !this.isNg(c),
    );
  }

  /**
   * コメントの一覧の「この先」(録画だけ)。いまの放送時刻 `w` より後、`until` までに書かれたもののうち、古いほうから `limit` 件。
   * `recent` と同じく何も消費せず、NG ワードを含むものは外す
   */
  ahead(w: number, until: number, limit: number): Comment[] {
    if (!this.active || until <= w) return [];
    return this.cursor.store.earliest(w, until, limit, (c) => !this.isNg(c));
  }

  private isNg(comment: Comment): boolean {
    let hit = this.ngSeen.get(comment);
    if (hit === undefined) {
      hit = this.ng(comment.text);
      this.ngSeen.set(comment, hit);
    }
    return hit;
  }

  /** 勢い。いまの放送時刻 `w` までの 1 分に書かれたものの数 (NG ワードのものも数える) */
  force(w: number): number {
    if (!this.active) return 0;
    return this.cursor.store.count(w - FORCE_SPAN, w);
  }

  /** 画面を閉じた。繋いでいるものを閉じる */
  close(): void {
    this.active = false;
    this.stopSources();
  }

  private stopKakolog(): void {
    this.kakologRun++;
    if (this.kakologTimer !== null) clearTimeout(this.kakologTimer);
    this.kakologTimer = null;
  }

  private stopSources(): void {
    this.live?.stop();
    this.live = null;
    this.expected.clear();
    this.seen.clear();
    this.stopKakolog();
    this.failing.clear();
    this.down = false;
  }
}
