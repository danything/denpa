import { describe, expect, test } from "bun:test";

import {
  caughtUp,
  ECHO_SPAN,
  Echoes,
  graphemes,
  MAX_LENGTH,
  POST_GAP,
  refusal,
  Spacing,
  vpos,
} from "./post";

/*
 * NX-Jikkyo へ書き込むときの決まり。本文は自分で作った見本
 */

describe("長さ", () => {
  test("書記素で数える。絵文字・国旗・結合した絵文字・濁点の結合も 1 文字", () => {
    expect(graphemes("わこつ")).toBe(3);
    expect(graphemes("👍🏽")).toBe(1);
    expect(graphemes("🇯🇵")).toBe(1);
    expect(graphemes("👨‍👩‍👧")).toBe(1);
    expect(graphemes(`か${String.fromCodePoint(0x3099)}`)).toBe(1);
  });

  test(`${MAX_LENGTH} 文字までは送れ、超えたら断る (絵文字でも同じ数)`, () => {
    expect(refusal("あ".repeat(MAX_LENGTH))).toBeNull();
    expect(refusal("👨‍👩‍👧".repeat(MAX_LENGTH))).toBeNull();
    expect(refusal("あ".repeat(MAX_LENGTH + 1))).toBe(
      `${MAX_LENGTH} 文字までです`,
    );
    // 前後の空白は数えない
    expect(refusal(`  ${"あ".repeat(MAX_LENGTH)}  `)).toBeNull();
  });
});

describe("断る中身", () => {
  test("空・空白だけは送れない (言うことは無い)", () => {
    expect(refusal("")).toBe("");
    expect(refusal(` ${String.fromCodePoint(0x3000)} `)).toBe("");
  });

  test("改行・制御文字は断る。絵文字を組む ZWJ は通す", () => {
    expect(refusal("一行目\n二行目")).toBe("改行や制御文字は送れません");
    expect(refusal("タブ\tあり")).toBe("改行や制御文字は送れません");
    expect(refusal("ベル\u0007")).toBe("改行や制御文字は送れません");
    expect(refusal(`段落${String.fromCodePoint(0x2029)}`)).toBe(
      "改行や制御文字は送れません",
    );
    expect(refusal("👨‍👩‍👧")).toBeNull();
  });

  test("「/」と英小文字で始まるもの (運営のコメントの形) は断る。ほかの「/」は通す", () => {
    expect(refusal("/nicoad")).toBe("「/」と英小文字で始まるものは送れません");
    expect(refusal("  /gift")).toBe("「/」と英小文字で始まるものは送れません");
    expect(refusal("/ABC")).toBeNull();
    expect(refusal("1/2")).toBeNull();
  });
});

describe("Spacing", () => {
  test("送ってから 3 秒は送れない", () => {
    const spacing = new Spacing();
    expect(spacing.left(0)).toBe(0);
    spacing.mark(1_000);
    expect(spacing.left(1_000)).toBe(POST_GAP);
    expect(spacing.left(3_999)).toBe(1);
    expect(spacing.left(1_000 + POST_GAP)).toBe(0);
  });
});

describe("caughtUp", () => {
  test("止めていない・放送から 30 秒以内なら書ける", () => {
    expect(caughtUp(1.5, false)).toBe(true);
    expect(caughtUp(30, false)).toBe(true);
    expect(caughtUp(30.1, false)).toBe(false);
    // 止めている・遅れが分からない
    expect(caughtUp(1.5, true)).toBe(false);
    expect(caughtUp(null, false)).toBe(false);
  });
});

describe("vpos", () => {
  test("スレッドの頭から 1/100 秒 (四捨五入)", () => {
    expect(vpos(1_000_000 + 12_345, 1_000_000)).toBe(1235);
  });
});

describe("Echoes", () => {
  test("送ってから 60 秒の間に戻ってきた、本文が同じものを 1 回だけ捨てる", () => {
    const echoes = new Echoes();
    echoes.expect("草", 0);
    expect(echoes.take("ほかの本文", 10)).toBe(false);
    expect(echoes.take("草", 10)).toBe(true);
    // 2 回目は捨てない (ほかの人の同じ書き込み)
    expect(echoes.take("草", 20)).toBe(false);
  });

  test("60 秒を過ぎたら捨てない。送れなかったものは忘れる", () => {
    const echoes = new Echoes();
    echoes.expect("遅い", 0);
    expect(echoes.take("遅い", ECHO_SPAN + 1)).toBe(false);
    echoes.expect("失敗", 0);
    echoes.forget("失敗");
    expect(echoes.take("失敗", 1)).toBe(false);
  });

  test("同じ本文を 2 回送ったら 2 回まで捨てる", () => {
    const echoes = new Echoes();
    echoes.expect("888", 0);
    echoes.expect("888", 3_000);
    expect(echoes.take("888", 3_100)).toBe(true);
    expect(echoes.take("888", 3_200)).toBe(true);
    expect(echoes.take("888", 3_300)).toBe(false);
  });
});
