/**
 * **下端で続きを足していく一覧の続きのぶん** (切り抜きの一覧。`routes/clips/+page.svelte`)。
 * 画面の `$state` は持たず、変わったら `changed` で知らせる (bun のテストで動かすため)。
 *
 * - 続きを取得している間は重ねて取得しない (`loading`)。下端の印は見えている間ずっと鳴る
 * - 読み直したら (`reset`) 世代を進め、`loading` も戻す。**古い世代の取得は、結果を足さず `loading` にも触らない。**
 *   古い取得が `loading` を戻すと、読み直したあとの取り直しと下端の取得が同じページを 2 回足していた。
 *   読み直しで戻さないと、取得の途中で条件を変えたとき `loading` が立ったままになり、続きを取らなくなっていた
 */

/** 1 ページぶん。`next` は次に渡す位置 (無ければ終わり) */
export interface FeedPage<T> {
  items: T[];
  next: number | null;
}

export class Feed<T> {
  /** 足した続き (load が返した最初のページの後ろ) */
  items: T[] = [];
  /** 次に取得する位置。null なら終わり */
  next: number | null;
  #generation = 0;
  #loading = false;

  constructor(
    next: number | null,
    /** `before` より前の 1 ページを取得する。取れなければ null */
    private readonly fetchPage: (before: number) => Promise<FeedPage<T> | null>,
    private readonly changed: () => void = () => {},
  ) {
    this.next = next;
  }

  /** 取得している最中か */
  get loading(): boolean {
    return this.#loading;
  }

  /**
   * 読み直した。足した続きを捨て、最初のページの続きの位置から始め直す。
   * `keep` 件まで読み進めていたなら (条件はそのままで中身だけ変わった)、そこまで取り直す
   */
  reset(next: number | null, keep = 0): Promise<void> {
    this.#generation++;
    this.#loading = false;
    this.items = [];
    this.next = next;
    this.changed();
    if (keep <= 0) return Promise.resolve();
    return this.#guarded(async (mine) => {
      while (this.items.length < keep && (await this.#fetch(mine)));
    });
  }

  /** 下端に来た。取得している最中でなければ 1 ページ足す */
  loadMore(): Promise<void> {
    if (this.#loading) return Promise.resolve();
    return this.#guarded((mine) => this.#fetch(mine));
  }

  async #guarded(run: (mine: number) => Promise<unknown>): Promise<void> {
    const mine = this.#generation;
    this.#loading = true;
    try {
      await run(mine);
    } finally {
      if (mine === this.#generation) this.#loading = false;
    }
  }

  /** 1 ページ取って足す。世代が替わっていたら捨てる。足せたら true */
  async #fetch(mine: number): Promise<boolean> {
    if (this.next === null) return false;
    const page = await this.fetchPage(this.next);
    if (page === null || mine !== this.#generation) return false;
    this.items = [...this.items, ...page.items];
    this.next = page.next;
    this.changed();
    return true;
  }
}
