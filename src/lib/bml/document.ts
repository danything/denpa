/**
 * BML の文書の中身 (要素の木)。XML の木 ([xml.ts](xml.ts)) から作り、スクリプト
 * ([dom.ts](dom.ts)) と描く側 ([render.ts](render.ts)) が同じものを見る。
 *
 * **放送が使う 18 の要素だけを持つ** (bml・head・title・meta・script・style・link・body・
 * div・p・span・a・br・object・bevent・beitem・input・img)。ほかの要素は中身ごと無視する。
 * 属性は持つが、ページの DOM には写さない (on* はここで読むだけ)。
 */

import { type Declaration, matches, parseDeclarations, type Rule } from "./css";
import {
  type Cascade,
  compute,
  type Computed,
  type Declarations,
  expand,
  type State,
} from "./style";
import { decodeEntities, type XmlElement, type XmlNode } from "./xml";

/** 持つ要素 */
const KNOWN = new Set([
  "bml",
  "head",
  "title",
  "meta",
  "script",
  "style",
  "link",
  "body",
  "div",
  "p",
  "span",
  "a",
  "br",
  "object",
  "bevent",
  "beitem",
  "input",
  "img",
]);

/** 字を持つ要素。中身が空でも文字を 1 つ持たせる (`build`) */
const HOLDS_TEXT = new Set(["p", "span", "a"]);

const STATES: readonly State[] = ["normal", "focus", "active"];

/** 要素の数の上限 (規格は 512。余裕を持たせて、暴走だけ止める) */
const MAX_ELEMENTS = 4096;

export class BmlText {
  readonly kind = "text";
  parent: BmlElement | null = null;
  constructor(
    public data: string,
    readonly cdata: boolean,
  ) {}
}

export type BmlNode = BmlElement | BmlText;

export class BmlElement implements Cascade {
  readonly kind = "element";
  parent: BmlElement | null = null;
  children: BmlNode[] = [];
  readonly rules: Record<State, Declaration[]> = {
    normal: [],
    focus: [],
    active: [],
  };
  readonly inline: Record<State, Declarations> = {
    normal: new Map(),
    focus: new Map(),
    active: new Map(),
  };
  state: State = "normal";
  /** beitem の覚え書き (前に起きたこと) */
  memo: Record<string, unknown> = {};
  /** 決めた見た目 (`generation` が変わるまで使い回す) */
  private computed: Computed | null = null;
  private computedAt = -1;

  constructor(
    readonly document: BmlDocument,
    readonly tag: string,
    readonly attrs: Map<string, string>,
  ) {
    const style = attrs.get("style");
    if (style !== undefined) {
      for (const [property, value] of parseDeclarations(style)) {
        for (const [name, v] of expand(property, value))
          this.inline.normal.set(name, v);
      }
    }
  }

  get id(): string {
    return this.attrs.get("id") ?? "";
  }

  get classes(): string[] {
    return (this.attrs.get("class") ?? "")
      .split(/\s+/)
      .filter((name) => name !== "");
  }

  attr(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttr(name: string, value: string | null): void {
    if (value === null) this.attrs.delete(name);
    else this.attrs.set(name, value);
    this.document.touch();
  }

  /** 今の状態の決めた見た目 */
  style(): Computed {
    if (
      this.computedAt !== this.document.generation ||
      this.computed === null
    ) {
      this.computed = compute(this, this.parent?.style() ?? null);
      this.computedAt = this.document.generation;
    }
    return this.computed;
  }

  /** 状態を指定した決めた見た目 (`focusStyle` などの読み出し) */
  styleIn(state: State): Computed {
    return state === this.state
      ? this.style()
      : compute(this, this.parent?.style() ?? null, state);
  }

  setState(state: State): void {
    if (this.state === state) return;
    this.state = state;
    this.document.touch();
  }

  /** 子孫を文書の順にたどる */
  *descendants(): Generator<BmlElement> {
    for (const child of this.children) {
      if (child.kind !== "element") continue;
      yield child;
      yield* child.descendants();
    }
  }

  /** 中の文字 (title など) */
  get text(): string {
    return this.children
      .map((child) => (child.kind === "text" ? child.data : child.text))
      .join("");
  }
}

/** 文書 1 つ */
export class BmlDocument {
  /** 見た目に関わるものが変わるたびに増える。描く側はこれを見て描き直す */
  generation = 0;
  readonly root: BmlElement;
  private count = 0;
  private readonly byId = new Map<string, BmlElement>();

  constructor(xml: XmlElement) {
    this.root = this.build(xml, null) ?? new BmlElement(this, "bml", new Map());
    for (const element of this.root.descendants()) {
      if (element.id !== "" && !this.byId.has(element.id))
        this.byId.set(element.id, element);
    }
  }

  touch(): void {
    this.generation++;
  }

  get body(): BmlElement | null {
    for (const element of this.root.descendants())
      if (element.tag === "body") return element;
    return null;
  }

  getElementById(id: string): BmlElement | null {
    return this.byId.get(id) ?? null;
  }

  /** 名前で探す (文書の順) */
  elements(tag: string): BmlElement[] {
    return [...this.root.descendants()].filter(
      (element) => element.tag === tag,
    );
  }

  /** 文書の規則を当てる。描く前に 1 回 */
  applyRules(rules: Rule[]): void {
    const sorted = [...rules].sort(
      (a, b) =>
        a.selector.specificity - b.selector.specificity || a.order - b.order,
    );
    for (const element of this.root.descendants()) {
      const { tag, id, classes } = element;
      for (const state of STATES) element.rules[state] = [];
      for (const rule of sorted) {
        if (!matches(rule.selector, tag, id, classes)) continue;
        // :focus / :active の状態では、ふつうの規則と一緒に詳細度の順で重ねる
        const pseudo = rule.selector.pseudo;
        if (pseudo !== null) element.rules[pseudo].push(...rule.declarations);
        else
          for (const state of STATES)
            element.rules[state].push(...rule.declarations);
      }
    }
    this.touch();
  }

  private build(xml: XmlElement, parent: BmlElement | null): BmlElement | null {
    if (!KNOWN.has(xml.name) || ++this.count > MAX_ELEMENTS) return null;
    const element = new BmlElement(this, xml.name, xml.attrs);
    element.parent = parent;
    const preserve = xml.name === "script" || xml.name === "style";
    xml.children.forEach((child, i) => {
      if (child.kind === "element") {
        const made = this.build(child, element);
        if (made !== null) element.children.push(made);
        return;
      }
      // 空白は実体参照を開く前の字で詰める (`&#x20;` と書いた空白は残る)
      const text =
        preserve || child.cdata
          ? child.text
          : decodeEntities(collapse(child.raw ?? child.text, xml, i));
      // 空の CDATA は残す (後からスクリプトが字を入れる先)
      if (text === "" && !child.cdata) return;
      const node = new BmlText(text, child.cdata);
      node.parent = element;
      element.children.push(node);
    });
    // 字を持つ要素 (p・span・a) には、空でも文字を 1 つ持たせる。放送のスクリプトは空の p の
    // `firstChild.data` に字を書き込む (日時・局名・ニュースの文)。文字が無いと firstChild が null で、
    // 書いたところでスクリプトが止まり、後に続く組み立て (メニュー・天気の表) まで出なくなる
    if (HOLDS_TEXT.has(element.tag) && element.children.length === 0) {
      const node = new BmlText("", false);
      node.parent = element;
      element.children.push(node);
    }
    return element;
  }
}

/** 制御符号 (空白・改行・タブ) か */
function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/** 2 バイト文字か。U+0100 から上を 2 バイト文字とみなす */
function isWide(c: string | undefined): boolean {
  return c !== undefined && c.charCodeAt(0) >= 0x100;
}

/**
 * 文字の中の制御符号を STD-B24 第二編 付属 2 5.3.2 (表 5-11・表 5-12) のとおりに詰める。
 * - 制御符号だけの文字列は文字にしない。span と span のあいだの空白 1 つもここで消える
 *   (同 5.3.4 も、ノードのあいだに空白と改行だけがあるとき、それを持つノードを作らないと書いている)
 * - 開始タグの直後と終了タグの直前の並びは消す
 * - 2 バイト文字どうしのあいだの並びは消す。それ以外の字のあいだの並びは 0x20 1 つにする
 * - p の中では、span・a の終了タグの直後と、span・a・br の開始タグの直前の並びを 0x20 1 つにする
 *   (br の終了タグの直後は上の「開始タグの直後」と同じく消す)
 *
 * 前から 1 回なめて組み立てる。正規表現で末尾の空白を探すと、空白の後ろに字が続くとき 2 乗かかる
 */
function collapse(text: string, parent: XmlElement, index: number): string {
  let start = 0;
  while (start < text.length && isSpace(text[start])) start++;
  if (start === text.length) return "";
  let end = text.length;
  while (isSpace(text[end - 1])) end--;
  const name = (node: XmlNode | undefined): string =>
    node?.kind === "element" ? node.name : "";
  const prev = name(parent.children[index - 1]);
  const next = name(parent.children[index + 1]);
  const inline = (tag: string): boolean => tag === "span" || tag === "a";
  const inP = parent.name === "p";
  const parts: string[] = [start > 0 && inP && inline(prev) ? " " : ""];
  let from = start;
  for (let i = start; i < end; i++) {
    if (!isSpace(text[i])) continue;
    parts.push(text.slice(from, i));
    const before = text[i - 1];
    while (isSpace(text[i])) i++;
    if (!(isWide(before) && isWide(text[i]))) parts.push(" ");
    from = i;
  }
  parts.push(text.slice(from, end));
  if (end < text.length && inP && (inline(next) || next === "br"))
    parts.push(" ");
  return parts.join("");
}
