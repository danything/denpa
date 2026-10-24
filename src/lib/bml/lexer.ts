/**
 * スクリプトの字句。BML の ECMAScript (STD-B24 第二編 付属2 5章) が読めればよい。
 *
 * - 数は整数だけ (10 進と 16 進)。小数は運用されないが、来たら整数に切り捨てる
 * - 正規表現のリテラルは無い (`/` はいつも割り算)
 * - `<!--` と行頭の `-->` は 1 行の注釈として読み飛ばす (古い書き方の名残)
 */

type TokenType = "name" | "number" | "string" | "punct" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  /** 数のときの値 */
  number: number;
  /** 前に改行があったか (自動の `;` に使う) */
  newline: boolean;
  line: number;
}

export class ScriptSyntaxError extends Error {}

/** 区切りの記号。長いものから試す */
const PUNCTUATORS = (
  ">>>= === !== >>> <<= >>= <= >= == != && || ++ -- += -= *= /= %= &= |= ^= " +
  "<< >> { } ( ) [ ] ; , < > + - * / % & | ^ ! ~ ? : = ."
).split(" ");

/** `\` に続く 1 字の書き方 */
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function isIdentStart(c: string): boolean {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    c === "_" ||
    c === "$" ||
    c > "\u007f"
  );
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isSpace(c: string): boolean {
  return (
    c === " " ||
    c === "\t" ||
    c === "\v" ||
    c === "\f" ||
    c === " " ||
    c === "　" ||
    c === "﻿"
  );
}

/** 字句に分ける。誤りは `ScriptSyntaxError` */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  let line = 1;
  let newline = true;
  let lineStart = true;
  const fail = (message: string): never => {
    throw new ScriptSyntaxError(`${line} 行目: ${message}`);
  };
  const push = (type: TokenType, value: string, number = 0): void => {
    tokens.push({ type, value, number, newline, line });
    newline = false;
    lineStart = false;
  };

  while (at < source.length) {
    const c = source[at]!;
    if (c === "\n" || c === "\r" || c === " " || c === " ") {
      if (c === "\n" || source[at + 1] !== "\n") line++;
      at++;
      newline = true;
      lineStart = true;
      continue;
    }
    if (isSpace(c)) {
      at++;
      continue;
    }
    // 1 行の注釈 (// と <!-- と、行頭の -->)
    if (
      source.startsWith("//", at) ||
      source.startsWith("<!--", at) ||
      (lineStart && source.startsWith("-->", at))
    ) {
      while (at < source.length && source[at] !== "\n" && source[at] !== "\r")
        at++;
      continue;
    }
    if (source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      if (end === -1) fail("注釈が閉じていません");
      for (let i = at; i < end; i++) {
        if (source[i] === "\n") {
          line++;
          newline = true;
        }
      }
      at = end + 2;
      continue;
    }
    if (isIdentStart(c)) {
      const from = at;
      while (
        at < source.length &&
        (isIdentStart(source[at]!) || isDigit(source[at]!))
      )
        at++;
      push("name", source.slice(from, at));
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(source[at + 1] ?? ""))) {
      const from = at;
      let value: number;
      if (c === "0" && (source[at + 1] === "x" || source[at + 1] === "X")) {
        at += 2;
        while (at < source.length && /[0-9a-fA-F]/.test(source[at]!)) at++;
        value = Number.parseInt(source.slice(from + 2, at), 16);
      } else {
        while (at < source.length && /[0-9.eE]/.test(source[at]!)) {
          if (
            (source[at] === "e" || source[at] === "E") &&
            /[+-]/.test(source[at + 1] ?? "")
          )
            at++;
          at++;
        }
        value = Number(source.slice(from, at));
      }
      if (Number.isNaN(value))
        fail(`数が読めません: ${source.slice(from, at)}`);
      push("number", source.slice(from, at), value);
      continue;
    }
    if (c === '"' || c === "'") {
      at++;
      let out = "";
      for (;;) {
        if (at >= source.length) fail("文字列が閉じていません");
        const d = source[at++]!;
        if (d === c) break;
        if (d === "\n" || d === "\r") fail("文字列の中で改行しています");
        if (d !== "\\") {
          out += d;
          continue;
        }
        const e = source[at++] ?? "";
        const escaped = ESCAPES[e];
        if (escaped !== undefined) {
          out += escaped;
          continue;
        }
        switch (e) {
          case "x":
          case "u": {
            const size = e === "x" ? 2 : 4;
            const hex = source.slice(at, at + size);
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== size)
              fail("\\x / \\u の後が読めません");
            out += String.fromCharCode(Number.parseInt(hex, 16));
            at += size;
            break;
          }
          case "\r":
            if (source[at] === "\n") at++;
            line++;
            break;
          case "\n":
            line++;
            break;
          default:
            out += e;
        }
      }
      push("string", out);
      continue;
    }
    const punct = PUNCTUATORS.find((p) => source.startsWith(p, at));
    if (punct === undefined) fail(`読めない字: ${c}`);
    at += punct!.length;
    push("punct", punct!);
  }
  push("eof", "");
  return tokens;
}
