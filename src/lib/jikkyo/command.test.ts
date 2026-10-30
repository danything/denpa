import { describe, expect, test } from "bun:test";

import {
  DEFAULT_POST_STYLE,
  postStyle,
  readMail,
  readPostStyle,
} from "./command";

/*
 * コメントのコマンド (色・位置・大きさ)
 */

describe("readMail", () => {
  test("色・位置・大きさを読む。184 などほかのコマンドは無視する", () => {
    expect(readMail("184 red ue big")).toEqual({
      color: "#ff0000",
      place: "ue",
      size: "big",
    });
    expect(readMail("shita small")).toEqual({ place: "shita", size: "small" });
  });

  test("既定 (白・流れる・中) と、読めないものは持たない", () => {
    expect(readMail("184 white naka medium")).toEqual({});
    expect(readMail("184 docomo invisible")).toEqual({});
    expect(readMail("")).toEqual({});
    expect(readMail(undefined)).toEqual({});
    expect(readMail(42)).toEqual({});
    // 名前に見えても色の表に無いもの (Object の持ち物の名前) は読まない
    expect(readMail("constructor toString")).toEqual({});
  });

  test("プレミアム会員の色の名前と 16 進の色も読む。大文字でもよい", () => {
    expect(readMail("niconicowhite").color).toBe("#cccc99");
    expect(readMail("MarineBlue").color).toBe("#3399ff");
    expect(readMail("#1A2b3C").color).toBe("#1a2b3c");
    // 16 進でも白なら替えない。桁の違うものは読まない
    expect(readMail("#FFFFFF")).toEqual({});
    expect(readMail("#fff")).toEqual({});
  });

  test("同じ種類が 2 つあれば後ろのもの", () => {
    expect(readMail("red blue ue shita")).toEqual({
      color: "#0000ff",
      place: "shita",
    });
    expect(readMail("ue naka")).toEqual({});
  });
});

describe("書き込むときの色・位置・大きさ", () => {
  test("覚えていたものを読み、読めないところは既定に戻す", () => {
    expect(readPostStyle(null)).toEqual(DEFAULT_POST_STYLE);
    expect(readPostStyle("壊れた")).toEqual(DEFAULT_POST_STYLE);
    expect(
      readPostStyle(
        JSON.stringify({ color: "cyan", position: "ue", size: "huge" }),
      ),
    ).toEqual({ color: "cyan", position: "ue", size: "medium" });
    // 選べない色 (プレミアム会員の色) は既定に
    expect(readPostStyle(JSON.stringify({ color: "purple" })).color).toBe(
      "white",
    );
  });

  test("自分で流すときの流し方は、送ったコマンドを読んだものと同じ", () => {
    expect(postStyle({ color: "red", position: "shita", size: "big" })).toEqual(
      { color: "#ff0000", place: "shita", size: "big" },
    );
    expect(postStyle(DEFAULT_POST_STYLE)).toEqual({});
  });
});
