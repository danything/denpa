import { describe, expect, test } from "bun:test";

import { parseGenres, parseTimes } from "./migrate";

/**
 * EPGStation のジャンル指定の読み取り。
 *
 * ここを取りこぼすと、引き継いだルールのジャンル欄に名前の引けない値が並ぶ。
 * denpa 側は文字列で `"7"`(大分類だけ)と `"7-0"`(中分類まで)を持つ。
 */
describe("ジャンルの引き継ぎ", () => {
  test("中分類まであれば大分類と繋ぐ", () => {
    expect(parseGenres('[{"genre":7,"subGenre":0}]')).toEqual(["7-0"]);
  });

  test("大分類だけなら大分類だけ", () => {
    // EPGStation で「アニメ全部」を選んだとき subGenre は入ってこない
    expect(parseGenres('[{"genre":7}]')).toEqual(["7"]);
  });

  test("数値の配列でも読める", () => {
    expect(parseGenres("[7,6]")).toEqual(["7", "6"]);
  });

  test("引ける形式にならないものは落とす", () => {
    // 残すと画面のジャンル欄に名前の引けない値が並ぶ
    expect(parseGenres('[null,{"subGenre":1},{"genre":"7"},7]')).toEqual(["7"]);
  });

  test("壊れていても空で返す", () => {
    expect(parseGenres("{壊れている")).toEqual([]);
    expect(parseGenres(null)).toEqual([]);
    expect(parseGenres("")).toEqual([]);
    expect(parseGenres('"文字列"')).toEqual([]);
  });
});

/**
 * EPGStation の時間帯と曜日 (`rule.times`)。`start` / `range` は時、`week` は日曜 0x01〜土曜 0x40 のビット。
 * 向こうは番組の始まる「時」が `start`〜`start + range - 1` なら当てる
 */
describe("時間帯と曜日の引き継ぎ", () => {
  const anytime = { time_from: null, time_to: null, weekdays: null };

  test("時刻は分に、曜日はビットから", () => {
    // 金曜 (0x20) の 19 時から 2 時間
    expect(parseTimes('[{"start":19,"range":2,"week":32}]')).toEqual({
      time_from: 19 * 60,
      time_to: 21 * 60,
      weekdays: [5],
    });
  });

  test("日をまたぐ時間帯は終わりが小さくなる", () => {
    // 土日 (0x41) の 23 時から 3 時間 = 23:00〜02:00
    expect(parseTimes('[{"start":23,"range":3,"week":65}]')).toEqual({
      time_from: 23 * 60,
      time_to: 2 * 60,
      weekdays: [0, 6],
    });
  });

  test("毎日・時刻なしはいつでも。空や壊れたものも", () => {
    expect(parseTimes('[{"week":127}]')).toEqual(anytime);
    expect(parseTimes(null)).toEqual(anytime);
    expect(parseTimes("")).toEqual(anytime);
    expect(parseTimes("{")).toEqual(anytime);
    // 曜日が 0 の行は向こうも飛ばす
    expect(parseTimes('[{"start":1,"range":1,"week":0}]')).toEqual(anytime);
  });

  test("曜日だけで絞る", () => {
    // 月〜金
    expect(parseTimes('[{"week":62}]')).toEqual({
      time_from: null,
      time_to: null,
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  test("時刻の同じ行は曜日を足す。時刻の違う行があれば写せない", () => {
    expect(
      parseTimes(
        '[{"start":19,"range":1,"week":2},{"start":19,"range":1,"week":4}]',
      ),
    ).toEqual({ time_from: 19 * 60, time_to: 20 * 60, weekdays: [1, 2] });
    expect(
      parseTimes(
        '[{"start":19,"range":1,"week":2},{"start":21,"range":1,"week":2}]',
      ),
    ).toBeNull();
  });
});
