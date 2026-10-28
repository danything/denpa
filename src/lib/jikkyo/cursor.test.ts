import { describe, expect, test } from "bun:test";

import { Cursor } from "./cursor";

/*
 * 控えから、いまの放送時刻までに書かれたものを出す
 */

const T = Date.UTC(2026, 9, 28, 12, 0, 0);
const at = (ms: number, text = String(ms)) => ({ at: T + ms, text });
const texts = (take: { comments: { text: string }[] }) =>
  take.comments.map((c) => c.text);

describe("Cursor", () => {
  test("前の W から今の W までに書かれたものを出す。最初の 1 回は出さない", () => {
    const cursor = new Cursor();
    cursor.receive([at(500), at(1500), at(2500)]);
    expect(cursor.take(T + 1000)).toEqual({ comments: [], jumped: false });
    expect(texts(cursor.take(T + 2000))).toEqual(["1500"]);
    expect(texts(cursor.take(T + 3000))).toEqual(["2500"]);
  });

  test("W が戻った・大きく飛んだら、飛んだ先から出し直す (飛んだぶんはまとめて出さない)", () => {
    const cursor = new Cursor();
    cursor.receive([at(500), at(30_500), at(31_500)]);
    cursor.take(T);
    expect(cursor.take(T + 30_000)).toEqual({ comments: [], jumped: true });
    expect(texts(cursor.take(T + 32_000))).toEqual(["30500", "31500"]);
    expect(cursor.take(T).jumped).toBe(true);
    expect(texts(cursor.take(T + 1000))).toEqual(["500"]);
  });

  test("時計の合わせ直しで少し戻っただけなら飛んだことにせず、W も戻さない", () => {
    const cursor = new Cursor();
    cursor.receive([at(1500), at(2500)]);
    cursor.take(T + 2000);
    expect(cursor.take(T + 1800)).toEqual({ comments: [], jumped: false });
    // 戻った所から出し直さない (1500 は 2 度出さない)
    expect(texts(cursor.take(T + 3000))).toEqual(["2500"]);
  });

  test("遅れて届いたものは、10 秒以内なら次に出す。それより古いものは出さない", () => {
    const cursor = new Cursor();
    cursor.take(T + 20_000);
    cursor.receive([at(15_000, "遅れた"), at(5_000, "古い")]);
    expect(texts(cursor.take(T + 20_100))).toEqual(["遅れた"]);
  });

  test("オフにしていた間に進んだぶんは出さない", () => {
    const cursor = new Cursor();
    cursor.receive([at(1500), at(2500)]);
    cursor.take(T + 1000);
    cursor.pause();
    expect(cursor.take(T + 2000).comments).toEqual([]);
    expect(texts(cursor.take(T + 3000))).toEqual(["2500"]);
  });
});
