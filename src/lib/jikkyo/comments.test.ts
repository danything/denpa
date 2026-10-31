import { describe, expect, test } from "bun:test";

import { CommentStore, KEEP_SPAN, readPackets, toComment } from "./comments";

/*
 * 実況のコメントを本文と時刻と流し方だけにする・控え。見本は自分で作った偽のコメント
 */

const T = Date.UTC(2026, 9, 28, 12, 0, 0);

describe("toComment", () => {
  test("WebSocket の数でも、過去ログの文字列でも読む。date_usec はミリ秒に切り捨てる", () => {
    expect(
      toComment({ date: T / 1000, date_usec: 123_999, content: "わこつ" }),
    ).toEqual({ at: T + 123, text: "わこつ" });
    expect(
      toComment({ date: String(T / 1000), date_usec: "5000", content: "888" }),
    ).toEqual({ at: T + 5, text: "888" });
  });

  test("本文と時刻 (と流し方) だけを持つ。利用者の ID などは残さない", () => {
    const comment = toComment({
      date: T / 1000,
      content: "テスト",
      user_id: "1234567",
      mail: "184",
      premium: 1,
      no: 10,
    });
    expect(comment).toEqual({ at: T, text: "テスト" });
    expect(Object.keys(comment ?? {})).toEqual(["at", "text"]);
  });

  test("mail の色・位置・大きさは流し方として持つ (WebSocket と過去ログのどちらでも)", () => {
    expect(
      toComment({ date: T / 1000, content: "赤", mail: "184 red ue big" }),
    ).toEqual({
      at: T,
      text: "赤",
      style: { color: "#ff0000", place: "ue", size: "big" },
    });
    expect(
      readPackets([
        { chat: { date: String(T / 1000), content: "下", mail: "shita" } },
      ]).comments,
    ).toEqual([{ at: T, text: "下", style: { place: "shita" } }]);
  });

  test("本文が空・運営のコメントは流さない (null)", () => {
    expect(toComment({ date: T / 1000, content: "  " })).toBeNull();
    expect(toComment({ date: T / 1000, content: "/nicoad {}" })).toBeNull();
  });

  test("形式がずれていれば undefined", () => {
    expect(toComment({ content: "時刻が無い" })).toBeUndefined();
    expect(toComment({ date: "x", content: "a" })).toBeUndefined();
    expect(toComment({ date: T / 1000, content: 5 })).toBeUndefined();
    expect(toComment(null)).toBeUndefined();
  });

  test("過去ログの packet は chat の行だけ読み、ずれた行を数える", () => {
    const { comments, odd } = readPackets([
      { chat: { date: String(T / 1000), content: "a" } },
      { thread: {} },
      { chat: { content: "b" } },
    ]);
    expect(comments).toEqual([{ at: T, text: "a" }]);
    expect(odd).toBe(1);
  });
});

describe("CommentStore", () => {
  test("時刻の順に並べ、同じ時刻・同じ本文は 1 つにする", () => {
    const store = new CommentStore();
    store.add([
      { at: T + 2000, text: "b" },
      { at: T, text: "a" },
    ]);
    const added = store.add([
      { at: T, text: "a" },
      { at: T + 1000, text: "c" },
    ]);
    expect(added).toEqual([{ at: T + 1000, text: "c" }]);
    expect(store.between(T - 1, T + 2000).map((c) => c.text)).toEqual([
      "a",
      "c",
      "b",
    ]);
    // 前は含まず、後ろは含む
    expect(store.between(T, T + 1000).map((c) => c.text)).toEqual(["c"]);
  });

  test("埋めた区間をつなぎ、まだ埋めていないところを返す", () => {
    const store = new CommentStore();
    store.add([], [0, 10]);
    store.add([], [20, 30]);
    expect(store.missing(5, 25)).toEqual([[10, 20]]);
    store.add([], [10, 20]);
    expect(store.missing(0, 40)).toEqual([[30, 40]]);
  });

  test("前後あわせて 2 時間を超えたら、いまから遠いほうを捨てる", () => {
    const store = new CommentStore();
    const hour = 60 * 60_000;
    store.add(
      [0, 1, 2, 3].map((h) => ({ at: T + h * hour, text: String(h) })),
      [T, T + 3 * hour],
    );
    store.trim(T + 3 * hour);
    expect(store.between(T - 1, T + 4 * hour).map((c) => c.text)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(store.missing(T, T + 3 * hour)).toEqual([
      [T, T + 3 * hour - KEEP_SPAN],
    ]);
    // 捨てたものは、また来れば足せる
    expect(store.add([{ at: T, text: "0" }])).toHaveLength(1);
  });
});
