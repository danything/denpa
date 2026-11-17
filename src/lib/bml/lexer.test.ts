import { describe, expect, test } from "bun:test";

import { tokenize } from "./lexer";

/** `name` の字句が何行目にあるか */
const lineOf = (source: string, name: string): number | undefined =>
  tokenize(source).find((token) => token.value === name)?.line;

describe("行の数え方", () => {
  for (const [what, end] of [
    ["LF", "\n"],
    ["CR LF", "\r\n"],
    ["CR だけ", "\r"],
    ["LS", "\u2028"],
    ["PS", "\u2029"],
  ] as const) {
    test(`${what} の改行は、注釈の中でも外でも 1 行に数える`, () => {
      const source = ["a;", "/* x", "y */ b;", "c;"].join(end);
      expect(lineOf(source, "a")).toBe(1);
      expect(lineOf(source, "b")).toBe(3);
      expect(lineOf(source, "c")).toBe(4);
    });
  }

  test("改行を含む注釈のあとの字句は、行の始まりとして扱う", () => {
    const token = tokenize("a /*\r*/ b").find((t) => t.value === "b");
    expect(token?.newline).toBe(true);
  });
});
