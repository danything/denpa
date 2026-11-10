import { describe, expect, test } from "bun:test";

import { Feed, type FeedPage } from "./feed";

/** 取得を手で終わらせられる偽のサーバ。`before` ごとに 1 ページ (2 件) を返す */
function server() {
  const waiting: { before: number; done: (page: FeedPage<number>) => void }[] =
    [];
  const fetchPage = (before: number) =>
    new Promise<FeedPage<number> | null>((done) =>
      waiting.push({ before, done }),
    );
  /** いちばん古い取得を終わらせる */
  const answer = async () => {
    const one = waiting.shift();
    if (one === undefined) throw new Error("取得していない");
    one.done({
      items: [one.before - 1, one.before - 2],
      next: one.before - 2 > 0 ? one.before - 2 : null,
    });
    // 結果を受けた続き (足す・次を取る) を進める
    await new Promise((settle) => setTimeout(settle, 0));
  };
  return { fetchPage, waiting, answer };
}

describe("下端で続きを足す一覧 (`Feed`)", () => {
  test("取得している間は重ねて取得しない", async () => {
    const s = server();
    const feed = new Feed(10, s.fetchPage);
    void feed.loadMore();
    void feed.loadMore();
    expect(s.waiting).toHaveLength(1);
    await s.answer();
    expect(feed.items).toEqual([9, 8]);
    expect(feed.next).toBe(8);
    expect(feed.loading).toBe(false);
  });

  test("取得の途中で条件を変えても、そのあと続きを取得できる", async () => {
    const s = server();
    const feed = new Feed(10, s.fetchPage);
    void feed.loadMore();
    // 条件を変えた (読み進めたぶんは取り直さない)
    void feed.reset(20);
    expect(feed.loading).toBe(false);
    void feed.loadMore();
    expect(s.waiting.map((w) => w.before)).toEqual([10, 20]);
    // 古い取得の結果は足さない
    await s.answer();
    expect(feed.items).toEqual([]);
    await s.answer();
    expect(feed.items).toEqual([19, 18]);
    expect(feed.loading).toBe(false);
  });

  test("取り直している間に古い取得が終わっても、同じページを 2 回足さない", async () => {
    const s = server();
    const feed = new Feed(10, s.fetchPage);
    void feed.loadMore();
    await s.answer();
    void feed.loadMore();
    // 中身だけ変わった (同じ条件)。読み進めていた 4 件まで取り直す
    void feed.reset(10, 4);
    expect(s.waiting.map((w) => w.before)).toEqual([8, 10]);
    // 古い取得が終わっても、取り直しの間は下端で重ねて取得しない
    await s.answer();
    expect(feed.loading).toBe(true);
    void feed.loadMore();
    expect(s.waiting.map((w) => w.before)).toEqual([10]);
    await s.answer();
    await s.answer();
    expect(feed.items).toEqual([9, 8, 7, 6]);
    expect(feed.loading).toBe(false);
  });

  test("終わりまで来たら取得しない", async () => {
    const s = server();
    const feed = new Feed<number>(null, s.fetchPage);
    await feed.loadMore();
    expect(s.waiting).toHaveLength(0);
  });

  test("足したら知らせる", async () => {
    const s = server();
    let changed = 0;
    const feed = new Feed(10, s.fetchPage, () => changed++);
    void feed.loadMore();
    await s.answer();
    expect(changed).toBe(1);
    void feed.reset(10);
    expect(changed).toBe(2);
  });
});
