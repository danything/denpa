/**
 * スクリプトの構文。字句 ([lexer.ts](lexer.ts)) から木を作る。
 *
 * 放送が使うのは ES1 の小さな部分集合 (var・関数宣言・if・for・for-in・while・break・
 * continue・return・new・typeof・delete・三項・ビット演算)。安く入る do-while・switch・
 * 配列とオブジェクトのリテラル・`===` も読む。try/catch・with・正規表現・関数式は読まない
 * (来たら構文の誤りとしてその文書のスクリプトを止める)。
 */

import { ScriptSyntaxError, type Token, tokenize } from "./lexer";

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "this" }
  | { kind: "name"; name: string }
  | { kind: "array"; items: Expr[] }
  | { kind: "object"; props: [string, Expr][] }
  | { kind: "member"; object: Expr; name: string }
  | { kind: "index"; object: Expr; index: Expr }
  | { kind: "call"; callee: Expr; args: Expr[] }
  | { kind: "new"; callee: Expr; args: Expr[] }
  | { kind: "unary"; op: string; arg: Expr }
  | { kind: "update"; op: "++" | "--"; prefix: boolean; arg: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "logical"; op: "&&" | "||"; left: Expr; right: Expr }
  | { kind: "cond"; test: Expr; then: Expr; else: Expr }
  | { kind: "assign"; op: string; target: Expr; value: Expr }
  | { kind: "seq"; items: Expr[] };

export type Stmt =
  | { kind: "var"; decls: [string, Expr | null][] }
  | { kind: "func"; func: FunctionNode }
  | { kind: "expr"; expr: Expr }
  | { kind: "block"; body: Stmt[] }
  | { kind: "if"; test: Expr; then: Stmt; else: Stmt | null }
  | {
      kind: "for";
      init: Stmt | null;
      test: Expr | null;
      update: Expr | null;
      body: Stmt;
    }
  | { kind: "forin"; target: Expr; declare: boolean; object: Expr; body: Stmt }
  | { kind: "while"; test: Expr; body: Stmt }
  | { kind: "do"; body: Stmt; test: Expr }
  | { kind: "switch"; disc: Expr; cases: { test: Expr | null; body: Stmt[] }[] }
  | { kind: "break" }
  | { kind: "continue" }
  | { kind: "return"; value: Expr | null }
  | { kind: "empty" };

export interface FunctionNode {
  name: string;
  params: string[];
  body: Stmt[];
}

const ASSIGN_OPS = new Set([
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
]);

/** 二項演算の強さ (大きいほど先に結ぶ) */
const BINARY: Record<string, number> = {
  "|": 1,
  "^": 2,
  "&": 3,
  "==": 4,
  "!=": 4,
  "===": 4,
  "!==": 4,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  instanceof: 5,
  in: 5,
  "<<": 6,
  ">>": 6,
  ">>>": 6,
  "+": 7,
  "-": 7,
  "*": 8,
  "/": 8,
  "%": 8,
};

const RESERVED = new Set([
  "var",
  "function",
  "if",
  "else",
  "for",
  "in",
  "while",
  "do",
  "break",
  "continue",
  "return",
  "new",
  "delete",
  "typeof",
  "void",
  "this",
  "null",
  "true",
  "false",
  "switch",
  "case",
  "default",
  "instanceof",
]);

class Parser {
  private at = 0;
  /** for の頭の中では `in` を二項演算として読まない */
  private noIn = false;

  constructor(private readonly tokens: Token[]) {}

  private get peek(): Token {
    return this.tokens[this.at]!;
  }

  private next(): Token {
    const token = this.tokens[this.at]!;
    if (token.type !== "eof") this.at++;
    return token;
  }

  private fail(message: string): never {
    throw new ScriptSyntaxError(
      `${this.peek.line} 行目: ${message} (${this.peek.value || "終わり"})`,
    );
  }

  private is(value: string): boolean {
    const token = this.peek;
    return (
      (token.type === "punct" || token.type === "name") && token.value === value
    );
  }

  private eat(value: string): boolean {
    if (!this.is(value)) return false;
    this.next();
    return true;
  }

  private expect(value: string): void {
    if (!this.eat(value)) this.fail(`${value} がありません`);
  }

  private name(): string {
    const token = this.peek;
    if (token.type !== "name" || RESERVED.has(token.value))
      this.fail("名前がありません");
    this.next();
    return token.value;
  }

  /** 文の終わりの `;`。無くても改行・`}`・終わりの前なら補う */
  private semicolon(): void {
    if (this.eat(";")) return;
    if (this.is("}") || this.peek.type === "eof" || this.peek.newline) return;
    this.fail("; がありません");
  }

  program(): Stmt[] {
    const body: Stmt[] = [];
    while (this.peek.type !== "eof") body.push(this.statement());
    return body;
  }

  /** `{` の後ろから `}` までの文 */
  private block(): Stmt[] {
    const body: Stmt[] = [];
    while (!this.eat("}")) {
      if (this.peek.type === "eof") this.fail("} がありません");
      body.push(this.statement());
    }
    return body;
  }

  /** `(式)` */
  private paren(): Expr {
    this.expect("(");
    const expr = this.expression();
    this.expect(")");
    return expr;
  }

  /** 括弧の中は `in` を二項演算として読む (for の頭の中でも) */
  private inside<T>(read: () => T): T {
    const noIn = this.noIn;
    this.noIn = false;
    const value = read();
    this.noIn = noIn;
    return value;
  }

  private statement(): Stmt {
    const token = this.peek;
    if (token.type === "punct") {
      if (token.value === "{") {
        this.next();
        return { kind: "block", body: this.block() };
      }
      if (token.value === ";") {
        this.next();
        return { kind: "empty" };
      }
    }
    if (token.type === "name") {
      switch (token.value) {
        case "var": {
          this.next();
          const stmt = this.varDecls();
          this.semicolon();
          return stmt;
        }
        case "function":
          return { kind: "func", func: this.functionDecl() };
        case "if": {
          this.next();
          const test = this.paren();
          const then = this.statement();
          const otherwise = this.eat("else") ? this.statement() : null;
          return { kind: "if", test, then, else: otherwise };
        }
        case "while": {
          this.next();
          const test = this.paren();
          return { kind: "while", test, body: this.statement() };
        }
        case "do": {
          this.next();
          const body = this.statement();
          this.expect("while");
          const test = this.paren();
          this.eat(";");
          return { kind: "do", body, test };
        }
        case "for":
          return this.forStatement();
        case "switch":
          return this.switchStatement();
        case "break":
        case "continue": {
          this.next();
          this.semicolon();
          return { kind: token.value };
        }
        case "return": {
          this.next();
          let value: Expr | null = null;
          if (
            !this.is(";") &&
            !this.is("}") &&
            this.peek.type !== "eof" &&
            !this.peek.newline
          ) {
            value = this.expression();
          }
          this.semicolon();
          return { kind: "return", value };
        }
      }
    }
    const expr = this.expression();
    this.semicolon();
    return { kind: "expr", expr };
  }

  private varDecls(): Stmt & { kind: "var" } {
    const decls: [string, Expr | null][] = [];
    do {
      const name = this.name();
      decls.push([name, this.eat("=") ? this.assignment() : null]);
    } while (this.eat(","));
    return { kind: "var", decls };
  }

  private functionDecl(): FunctionNode {
    this.expect("function");
    const name = this.name();
    this.expect("(");
    const params: string[] = [];
    if (!this.is(")")) {
      do params.push(this.name());
      while (this.eat(","));
    }
    this.expect(")");
    this.expect("{");
    return { name, params, body: this.block() };
  }

  private forStatement(): Stmt {
    this.expect("for");
    this.expect("(");
    let init: Stmt | null = null;
    this.noIn = true;
    if (this.eat("var")) {
      const decls = this.varDecls();
      if (
        decls.decls.length === 1 &&
        decls.decls[0]![1] === null &&
        this.eat("in")
      ) {
        this.noIn = false;
        const object = this.expression();
        this.expect(")");
        const target: Expr = { kind: "name", name: decls.decls[0]![0] };
        return {
          kind: "forin",
          target,
          declare: true,
          object,
          body: this.statement(),
        };
      }
      init = decls;
    } else if (!this.is(";")) {
      const expr = this.expression();
      if (this.eat("in")) {
        this.noIn = false;
        if (!assignable(expr)) this.fail("for-in の左が代入できません");
        const object = this.expression();
        this.expect(")");
        return {
          kind: "forin",
          target: expr,
          declare: false,
          object,
          body: this.statement(),
        };
      }
      init = { kind: "expr", expr };
    }
    this.noIn = false;
    this.expect(";");
    const test = this.is(";") ? null : this.expression();
    this.expect(";");
    const update = this.is(")") ? null : this.expression();
    this.expect(")");
    return { kind: "for", init, test, update, body: this.statement() };
  }

  private switchStatement(): Stmt {
    this.expect("switch");
    const disc = this.paren();
    this.expect("{");
    const cases: { test: Expr | null; body: Stmt[] }[] = [];
    while (!this.eat("}")) {
      let test: Expr | null = null;
      if (this.eat("case")) test = this.expression();
      else if (!this.eat("default")) this.fail("case がありません");
      this.expect(":");
      const body: Stmt[] = [];
      while (!this.is("case") && !this.is("default") && !this.is("}")) {
        if (this.peek.type === "eof") this.fail("} がありません");
        body.push(this.statement());
      }
      cases.push({ test, body });
    }
    return { kind: "switch", disc, cases };
  }

  expression(): Expr {
    const first = this.assignment();
    if (!this.is(",")) return first;
    const items = [first];
    while (this.eat(",")) items.push(this.assignment());
    return { kind: "seq", items };
  }

  private assignment(): Expr {
    const target = this.conditional();
    const token = this.peek;
    if (token.type === "punct" && ASSIGN_OPS.has(token.value)) {
      if (!assignable(target)) this.fail("代入できない左辺");
      this.next();
      return {
        kind: "assign",
        op: token.value,
        target,
        value: this.assignment(),
      };
    }
    return target;
  }

  private conditional(): Expr {
    const test = this.logicalOr();
    if (!this.eat("?")) return test;
    const then = this.inside(() => this.assignment());
    this.expect(":");
    return { kind: "cond", test, then, else: this.assignment() };
  }

  private logicalOr(): Expr {
    let left = this.logicalAnd();
    while (this.eat("||"))
      left = { kind: "logical", op: "||", left, right: this.logicalAnd() };
    return left;
  }

  private logicalAnd(): Expr {
    let left = this.binary(1);
    while (this.eat("&&"))
      left = { kind: "logical", op: "&&", left, right: this.binary(1) };
    return left;
  }

  private binary(level: number): Expr {
    let left = this.unary();
    for (;;) {
      const token = this.peek;
      if (token.type !== "punct" && token.type !== "name") return left;
      const strength = BINARY[token.value];
      if (
        strength === undefined ||
        strength < level ||
        (token.value === "in" && this.noIn)
      )
        return left;
      this.next();
      left = this.climb(left, token.value, strength);
    }
  }

  private climb(left: Expr, op: string, strength: number): Expr {
    let right = this.unary();
    for (;;) {
      const token = this.peek;
      const next =
        token.type === "punct" || token.type === "name"
          ? BINARY[token.value]
          : undefined;
      if (
        next === undefined ||
        next <= strength ||
        (token.value === "in" && this.noIn)
      )
        break;
      this.next();
      right = this.climb(right, token.value, next);
    }
    return { kind: "binary", op, left, right };
  }

  private unary(): Expr {
    const token = this.peek;
    if (
      (token.type === "punct" && ["!", "~", "-", "+"].includes(token.value)) ||
      (token.type === "name" &&
        ["typeof", "delete", "void"].includes(token.value))
    ) {
      this.next();
      return { kind: "unary", op: token.value, arg: this.unary() };
    }
    if (
      token.type === "punct" &&
      (token.value === "++" || token.value === "--")
    ) {
      this.next();
      return {
        kind: "update",
        op: token.value,
        prefix: true,
        arg: this.target(this.unary()),
      };
    }
    const expr = this.postfix();
    const after = this.peek;
    if (
      after.type === "punct" &&
      (after.value === "++" || after.value === "--") &&
      !after.newline
    ) {
      this.next();
      return {
        kind: "update",
        op: after.value,
        prefix: false,
        arg: this.target(expr),
      };
    }
    return expr;
  }

  private target(expr: Expr): Expr {
    if (!assignable(expr)) this.fail("増減できない式");
    return expr;
  }

  private args(): Expr[] {
    this.expect("(");
    const args: Expr[] = [];
    if (!this.is(")"))
      this.inside(() => {
        do args.push(this.assignment());
        while (this.eat(","));
      });
    this.expect(")");
    return args;
  }

  private postfix(): Expr {
    let expr: Expr;
    if (this.eat("new")) {
      const callee = this.memberOnly(this.primary());
      expr = { kind: "new", callee, args: this.is("(") ? this.args() : [] };
    } else {
      expr = this.primary();
    }
    for (;;) {
      if (this.eat(".")) {
        const token = this.next();
        if (token.type !== "name") this.fail(". の後に名前がありません");
        expr = { kind: "member", object: expr, name: token.value };
      } else if (this.eat("[")) {
        const index = this.inside(() => this.expression());
        this.expect("]");
        expr = { kind: "index", object: expr, index };
      } else if (this.is("(")) {
        expr = { kind: "call", callee: expr, args: this.args() };
      } else {
        return expr;
      }
    }
  }

  /** `new` の後ろは呼び出しの手前まで (`new a.b(1)` の `a.b`) */
  private memberOnly(expr: Expr): Expr {
    for (;;) {
      if (this.eat(".")) {
        const token = this.next();
        if (token.type !== "name") this.fail(". の後に名前がありません");
        expr = { kind: "member", object: expr, name: token.value };
      } else if (this.eat("[")) {
        const index = this.expression();
        this.expect("]");
        expr = { kind: "index", object: expr, index };
      } else {
        return expr;
      }
    }
  }

  private primary(): Expr {
    const token = this.next();
    switch (token.type) {
      case "number":
        return { kind: "num", value: token.number };
      case "string":
        return { kind: "str", value: token.value };
      case "name":
        switch (token.value) {
          case "true":
            return { kind: "bool", value: true };
          case "false":
            return { kind: "bool", value: false };
          case "null":
            return { kind: "null" };
          case "this":
            return { kind: "this" };
          case "function":
            this.at--;
            this.fail("関数式は読みません");
        }
        if (RESERVED.has(token.value)) {
          this.at--;
          this.fail("ここに来られない語");
        }
        return { kind: "name", name: token.value };
      case "punct":
        if (token.value === "(") {
          const expr = this.inside(() => this.expression());
          this.expect(")");
          return expr;
        }
        if (token.value === "[") {
          const items: Expr[] = [];
          while (!this.eat("]")) {
            // 空き (`[1,,2]`) は undefined
            if (this.is(",")) {
              this.next();
              items.push({
                kind: "unary",
                op: "void",
                arg: { kind: "num", value: 0 },
              });
              continue;
            }
            items.push(this.assignment());
            if (!this.is("]")) this.expect(",");
          }
          return { kind: "array", items };
        }
        if (token.value === "{") {
          const props: [string, Expr][] = [];
          while (!this.eat("}")) {
            const key = this.next();
            if (key.type === "eof" || key.type === "punct")
              this.fail("名前がありません");
            this.expect(":");
            props.push([
              key.type === "number" ? String(key.number) : key.value,
              this.assignment(),
            ]);
            if (!this.is("}")) this.expect(",");
          }
          return { kind: "object", props };
        }
    }
    this.at--;
    return this.fail("式がありません");
  }
}

/** 代入・増減できる左辺か */
function assignable(expr: Expr): boolean {
  return (
    expr.kind === "name" || expr.kind === "member" || expr.kind === "index"
  );
}

/** スクリプトを木にする。誤りは `ScriptSyntaxError` */
export function parseScript(source: string): Stmt[] {
  return new Parser(tokenize(source)).program();
}
