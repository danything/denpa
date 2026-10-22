/**
 * BML の文書 (XML) を木にする。**DOMParser は使わない。**
 *
 * - XML として 1 か所でも崩れていると、DOMParser は文書ごと `parsererror` にする。放送の
 *   文書は受信機向けに作られていて、閉じ忘れや `&` をそのまま書いたものがあっても受信機は読む。
 *   こちらも寛容に読む (閉じていない要素は親が閉じるときに閉じる、知らない実体参照はそのまま)
 * - 単体テスト (bun) に DOM が無くても動く
 *
 * 名前は小文字にそろえる。`bml:` などの前置きは落とす (C プロファイルの名残)。
 */

export interface XmlText {
  kind: "text";
  text: string;
  /** CDATA か (空白の扱いが違う) */
  cdata: boolean;
  /**
   * 実体参照を開く前の字 (CDATA でないものだけ)。空白を詰めるのはこちらで見る — `&#x20;` のように
   * 参照で書いた空白は、詰める対象の「制御符号」ではない
   */
  raw?: string;
}

export interface XmlElement {
  kind: "element";
  name: string;
  attrs: Map<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | XmlText;

/** 中身を持たない要素 */
/** 入れ子の深さの上限。放送の文書は 10 段にも満たない */
const MAX_DEPTH = 64;

const VOID = new Set(["br", "meta", "link", "img", "input"]);

const ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** 実体参照を開く。知らないものはそのまま残す */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number(body.slice(1));
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[body] ?? whole;
    },
  );
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

/** 文書を読んで、いちばん外の要素 (bml) を返す。要素が無ければ null */
export function parseXml(source: string): XmlElement | null {
  const root: XmlElement = {
    kind: "element",
    name: "#root",
    attrs: new Map(),
    children: [],
  };
  const open: XmlElement[] = [root];
  let at = 0;
  const text = (value: string, cdata: boolean): void => {
    // 空の CDATA も文字として残す (`<p id="x"><![CDATA[]]></p>` に後からスクリプトが字を入れる)
    if (value === "" && !cdata) return;
    open
      .at(-1)!
      .children.push(
        cdata
          ? { kind: "text", text: value, cdata }
          : { kind: "text", text: decodeEntities(value), cdata, raw: value },
      );
  };

  while (at < source.length) {
    const lt = source.indexOf("<", at);
    if (lt === -1) {
      text(source.slice(at), false);
      break;
    }
    text(source.slice(at, lt), false);
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      at = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      text(source.slice(lt + 9, end === -1 ? source.length : end), true);
      at = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2);
      at = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("<!", lt)) {
      // DOCTYPE。内部サブセット ([...]) を持つこともある
      let depth = 0;
      let i = lt + 2;
      for (; i < source.length; i++) {
        const c = source[i];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      at = i + 1;
      continue;
    }
    if (source[lt + 1] === "/") {
      const end = source.indexOf(">", lt + 2);
      const name = localName(
        source.slice(lt + 2, end === -1 ? source.length : end).trim(),
      );
      at = end === -1 ? source.length : end + 1;
      // 対応する開きまで閉じる。無ければ無視する
      const index = open.findLastIndex((element) => element.name === name);
      if (index > 0) open.length = index;
      continue;
    }
    // 開きタグ
    let i = lt + 1;
    const nameStart = i;
    while (i < source.length && !/[\s/>]/.test(source[i]!)) i++;
    const name = localName(source.slice(nameStart, i));
    if (name === "") {
      text("<", false);
      at = lt + 1;
      continue;
    }
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      while (i < source.length && /\s/.test(source[i]!)) i++;
      if (i >= source.length) break;
      if (source[i] === ">") {
        i++;
        break;
      }
      if (source.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      const attrStart = i;
      while (i < source.length && !/[\s=/>]/.test(source[i]!)) i++;
      const attr = localName(source.slice(attrStart, i));
      while (i < source.length && /\s/.test(source[i]!)) i++;
      let value = attr;
      if (source[i] === "=") {
        i++;
        while (i < source.length && /\s/.test(source[i]!)) i++;
        const quote = source[i];
        if (quote === '"' || quote === "'") {
          const end = source.indexOf(quote, i + 1);
          value = source.slice(i + 1, end === -1 ? source.length : end);
          i = end === -1 ? source.length : end + 1;
        } else {
          const valueStart = i;
          while (i < source.length && !/[\s>]/.test(source[i]!)) i++;
          value = source.slice(valueStart, i);
          // `<x a=b/>` の / は値ではなく、自分で閉じる印
          if (value.endsWith("/") && source[i] === ">") {
            value = value.slice(0, -1);
            selfClosing = true;
          }
        }
      }
      if (attr === "") {
        i++;
        continue;
      }
      if (!attrs.has(attr)) attrs.set(attr, decodeEntities(value));
    }
    at = i;
    const element: XmlElement = { kind: "element", name, attrs, children: [] };
    open.at(-1)!.children.push(element);
    // 中身を持たない要素 (閉じずに書かれても、後ろを飲み込まない)
    if (selfClosing || VOID.has(name)) continue;
    // script と style の中身は文字のまま (中の < をタグと見ない)
    if (name === "script" || name === "style") {
      const closer = new RegExp(`</${name}`, "ig");
      closer.lastIndex = at;
      const end = closer.exec(source)?.index ?? source.length;
      const body = source.slice(at, end);
      if (body.includes("<![CDATA[")) {
        // CDATA が幾つあってもつなぐ。外の注釈 (<!-- -->) は捨て、外の字は実体参照を開く
        const text = body
          .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
          .map((part) =>
            part.startsWith("<![CDATA[")
              ? part.slice(9, -3)
              : decodeEntities(part.replace(/<!--[\s\S]*?-->/g, "")),
          )
          .join("");
        element.children.push({ kind: "text", text, cdata: true });
      } else if (body !== "") {
        element.children.push({
          kind: "text",
          text: decodeEntities(body),
          cdata: false,
        });
      }
      const gt = source.indexOf(">", end);
      at = gt === -1 ? source.length : gt + 1;
      continue;
    }
    // 入れ子の深さに上限 (閉じない要素が延々と続く文書で、読む側・描く側の呼び出しが溢れない)
    if (open.length < MAX_DEPTH) open.push(element);
  }
  return (
    root.children.find(
      (child): child is XmlElement => child.kind === "element",
    ) ?? null
  );
}
