/**
 * BML の CSS を読む。**ブラウザの CSS には渡さない** — 規則を読んで自分で重ね合わせ
 * ([style.ts](style.ts))、確かめた値だけを要素の style に書く ([render.ts](render.ts))。
 *
 * 放送が使うセレクタは `*`・`要素名`・`.class`・`#id`・`要素名.class` (と規格の `:focus`・
 * `:active`) だけ。子孫セレクタ・@ 規則は運用されないので、来たら読み飛ばす。
 */

interface Selector {
  tag: string | null;
  id: string | null;
  classes: string[];
  pseudo: "focus" | "active" | null;
  /** 詳細度 (id 100・class と擬似クラス 10・要素名 1) */
  specificity: number;
}

/** [特性, 値, !important] */
export type Declaration = [property: string, value: string, important: boolean];

export interface Rule {
  selector: Selector;
  declarations: Declaration[];
  /** 文書の中の順番 (同じ詳細度なら後が勝つ) */
  order: number;
}

const SIMPLE =
  /^(\*|[a-z][a-z0-9-]*)?((?:[.#][a-zA-Z0-9_-]+)*)(?::(focus|active))?$/i;

/** 単純セレクタを読む。使えない書き方 (子孫など) なら null */
function parseSelector(text: string): Selector | null {
  const match = SIMPLE.exec(text.trim());
  if (match === null || text.trim() === "") return null;
  const tag =
    match[1] === undefined || match[1] === "*" ? null : match[1].toLowerCase();
  let id: string | null = null;
  const classes: string[] = [];
  for (const part of match[2]?.match(/[.#][a-zA-Z0-9_-]+/g) ?? []) {
    if (part[0] === "#") id = part.slice(1);
    else classes.push(part.slice(1));
  }
  const pseudo =
    (match[3]?.toLowerCase() as "focus" | "active" | undefined) ?? null;
  const specificity =
    (id === null ? 0 : 100) +
    (classes.length + (pseudo === null ? 0 : 1)) * 10 +
    (tag === null ? 0 : 1);
  return { tag, id, classes, pseudo, specificity };
}

/** `a: b; c: d !important` を読む。名前は小文字に */
export function parseDeclarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of stripComments(text).split(";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    if (value.length > MAX_VALUE) continue;
    let important = false;
    const bang = /!\s*important\s*$/i.exec(value);
    if (bang !== null) {
      important = true;
      value = value.slice(0, bang.index).trim();
    }
    if (property === "" || value === "") continue;
    out.push([property, value, important]);
  }
  return out;
}

/**
 * 値の長さの上限。放送の値は短い (色・数・ファイルの名前)。これより長い値は読まない
 * (読むのは線形だが、描くたびに全要素で読むので重さを抑える)
 */
const MAX_VALUE = 4096;

function stripComments(text: string): string {
  // `<!--`・`-->` は古いブラウザから style の中身を隠す印 (CSS では読み飛ばすだけ)
  return replaceBlocks(text, "/*", "*/", " ")
    .split("<!--")
    .join(" ")
    .split("-->")
    .join(" ");
}

/**
 * `open` から次の `close` までを `by` に置き換える (閉じないものは残す)。正規表現の `[\s\S]*?` は
 * 閉じない `open` が並ぶと 2 乗かかるので、位置で探す
 */
function replaceBlocks(
  text: string,
  open: string,
  close: string,
  by: string,
): string {
  let out = "";
  let at = 0;
  for (;;) {
    const start = text.indexOf(open, at);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    out += text.slice(at, start) + by;
    at = end + close.length;
  }
  return out + text.slice(at);
}

/** スタイルシートを読む。`order` は `start` から振る (文書の中の複数の style の通し番号) */
export function parseStylesheet(text: string, start = 0): Rule[] {
  const rules: Rule[] = [];
  const source = stripComments(text);
  let at = 0;
  let order = start;
  while (at < source.length) {
    const open = source.indexOf("{", at);
    if (open === -1) break;
    // 余った `}` の後ろから読む (前の規則の閉じすぎ)
    const raw = source.slice(at, open);
    const head = raw.slice(raw.lastIndexOf("}") + 1).trim();
    // @ 規則 (@media など) は運用されない。`;` で終わる @ 規則は head に混ざるので落とす
    const selectorText = replaceBlocks(head, "@", ";", "").trim();
    if (selectorText.startsWith("@")) {
      // 括弧の対応を見て終わりを探す (@ 規則の入れ子を読み飛ばす)
      let depth = 1;
      let i = open + 1;
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
      }
      at = i;
      continue;
    }
    // 本体は次の `}` まで。その前に `{` が来たら閉じ忘れ: そこまでの区切り (`;` か改行) で本体を
    // 終え、残りは次の規則として読み直す (壊れた所だけ捨てる。後ろの規則まで道連れにしない)
    const close = source.indexOf("}", open + 1);
    const inner = source.indexOf("{", open + 1);
    let body: string;
    if (inner !== -1 && (close === -1 || inner < close)) {
      const cut = Math.max(
        source.lastIndexOf(";", inner),
        source.lastIndexOf("\n", inner),
      );
      const end = cut > open ? cut + 1 : open + 1;
      body = source.slice(open + 1, end);
      at = end;
    } else {
      const end = close === -1 ? source.length : close;
      body = source.slice(open + 1, end);
      at = end + 1;
    }
    const declarations = parseDeclarations(body);
    for (const part of selectorText.split(",")) {
      const selector = parseSelector(part);
      if (selector !== null)
        rules.push({ selector, declarations, order: order++ });
    }
  }
  return rules;
}

/** 要素に当たるか (状態は `pseudo` で別に見る) */
export function matches(
  selector: Selector,
  tag: string,
  id: string,
  classes: readonly string[],
): boolean {
  if (selector.tag !== null && selector.tag !== tag) return false;
  if (selector.id !== null && selector.id !== id) return false;
  for (const name of selector.classes)
    if (!classes.includes(name)) return false;
  return true;
}

/**
 * `url(...)` の中身。無ければ null。正規表現で一度に読まず、位置で切り出して trim する
 * (`\s*` と `.*?` が隣り合う形は、空白が並ぶと 3 乗かかる)
 */
export function parseUrl(value: string): string | null {
  const text = value.trim();
  if (text.length > MAX_VALUE || !/^url\(/i.test(text) || !text.endsWith(")"))
    return null;
  let inner = text.slice(4, -1).trim();
  const quote = inner[0];
  if (
    (quote === '"' || quote === "'") &&
    inner.length >= 2 &&
    inner.endsWith(quote)
  )
    inner = inner.slice(1, -1);
  // 改行を挟んだものは URL と見ない
  if (/[\n\r]/.test(inner)) return null;
  return inner.replace(/\\(.)/g, "$1");
}
