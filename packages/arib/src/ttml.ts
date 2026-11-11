/**
 * 4K の放送 (MMT/TLV) の字幕 (ARIB STD-B62 の TTML) を、字幕の文字の配置 (`caption-text.ts`) にする。
 * TS の字幕の `b24caption.ts` に当たり、受け側は TS の字幕と同じように描くだけで済む。
 *
 * 字幕の文書は MPU 1 つに 1 つ来る (`mmt-media.ts` の `CaptionUnit`)。文書の中の時刻 (begin・end・dur) は、
 * MPU の最初の提示時刻からのずれとして読む (推定。字幕のパケットは実機の録りにまだ来ていない)。
 *
 * 読むのは文字・位置 (region の origin・extent、textAlign・displayAlign)・大きさ (fontSize・lineHeight)・
 * 色 (color・backgroundColor・textOutline)・太字・斜体・下線・ルビ。画像を参照する字幕 (PNG) と
 * 縦書き・アニメーション (set) は読まない
 */

import {
  CAPTION_TEXT_VERSION,
  type CaptionPage,
  type CaptionRun,
} from "./caption-text.js";
import { CLOCK } from "./mmt-media.js";

/** XML の要素。名前と属性は名前空間の接頭辞を外したもの (`tts:color` → `color`) */
interface XmlElement {
  name: string;
  attributes: Record<string, string | undefined>;
  children: XmlNode[];
}

type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string | undefined> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    const code = name as string;
    if (code.startsWith("#x") || code.startsWith("#X"))
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#"))
      return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code] ?? whole;
  });
}

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

/** 字幕の文書を読むだけの小さな XML の読み取り。壊れていれば null */
function parseXml(text: string): XmlElement | null {
  const root: XmlElement = { name: "", attributes: {}, children: [] };
  const stack = [root];
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const match of text.matchAll(token)) {
    const top = stack.at(-1)!;
    const [, cdata, close, open, attributes, selfClosing, chars] = match;
    if (cdata !== undefined) top.children.push(cdata);
    else if (chars !== undefined) top.children.push(unescape(chars));
    else if (close !== undefined) {
      if (stack.length < 2 || top.name !== localName(close)) return null;
      stack.pop();
    } else if (open !== undefined) {
      const element: XmlElement = {
        name: localName(open),
        attributes: {},
        children: [],
      };
      for (const [, key = "", , a, b] of (attributes ?? "").matchAll(
        /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g,
      ))
        element.attributes[localName(key)] = unescape(a ?? b ?? "");
      top.children.push(element);
      if (selfClosing !== "/") stack.push(element);
    }
  }
  const tt = root.children.find((c) => typeof c !== "string");
  return stack.length === 1 && tt?.name === "tt" ? tt : null;
}

function* elements(node: XmlElement, name: string): Generator<XmlElement> {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.name === name) yield child;
    yield* elements(child, name);
  }
}

/** 時刻の書き方 (`00:00:01.500`・`00:00:01:15`・`1.5s`・`1500ms`・`90f`) を秒に。読めなければ null */
function seconds(value: string | undefined, frameRate: number): number | null {
  if (value === undefined) return null;
  const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/.exec(
    value.trim(),
  );
  if (clock !== null) {
    const [, h = "0", m = "0", s = "0", f] = clock;
    return (
      Number(h) * 3600 +
      Number(m) * 60 +
      Number(s) +
      (f === undefined ? 0 : Number(f) / frameRate)
    );
  }
  const offset = /^(\d+(?:\.\d+)?)(h|m|s|ms|f)$/.exec(value.trim());
  if (offset === null) return null;
  const [, count = "0", unit] = offset;
  const scale = {
    h: 3600,
    m: 60,
    s: 1,
    ms: 0.001,
    f: 1 / frameRate,
  }[unit as "h" | "m" | "s" | "ms" | "f"];
  return Number(count) * scale;
}

/** 名前で書く色 (TTML の名前の色) */
const NAMED: Record<string, string | undefined> = {
  transparent: "#00000000",
  black: "#000000ff",
  silver: "#c0c0c0ff",
  gray: "#808080ff",
  white: "#ffffffff",
  maroon: "#800000ff",
  red: "#ff0000ff",
  purple: "#800080ff",
  fuchsia: "#ff00ffff",
  magenta: "#ff00ffff",
  green: "#008000ff",
  lime: "#00ff00ff",
  olive: "#808000ff",
  yellow: "#ffff00ff",
  navy: "#000080ff",
  blue: "#0000ffff",
  teal: "#008080ff",
  aqua: "#00ffffff",
  cyan: "#00ffffff",
};

const hex2 = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");

/** 色を `#rrggbbaa` に。読めなければ null */
function color(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return `${text}ff`;
  if (/^#[0-9a-f]{8}$/.test(text)) return text;
  const rgb = /^rgba?\(([^)]*)\)$/.exec(text);
  if (rgb !== null) {
    const [r = 0, g = 0, b = 0, a = 255] = (rgb[1] ?? "")
      .split(",")
      .map(Number);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`;
  }
  return NAMED[text] ?? null;
}

/** 字幕の面の大きさと、セルの数 (`c` の単位) */
interface Frame {
  width: number;
  height: number;
  columns: number;
  rows: number;
}

/** 長さ 1 つ (`12px`・`50%`・`1.5c`)。% は `whole` に対して。読めなければ null */
function length(value: string, whole: number, cell: number): number | null {
  const match = /^(-?\d+(?:\.\d+)?)(px|%|c|em)$/.exec(value.trim());
  if (match === null) return null;
  const number = Number(match[1]);
  switch (match[2]) {
    case "px":
      return number;
    case "%":
      return (number / 100) * whole;
    default:
      return number * cell;
  }
}

/** 2 つの長さ (`x y`・`幅 高さ`)。1 つしか無ければ両方に使う */
function pair(
  value: string | undefined,
  frame: Frame,
  wholeX = frame.width,
  wholeY = frame.height,
): [number, number] | null {
  if (value === undefined) return null;
  const parts = value.trim().split(/\s+/);
  const x = length(parts[0] ?? "", wholeX, frame.width / frame.columns);
  const y = length(
    parts[1] ?? parts[0] ?? "",
    wholeY,
    frame.height / frame.rows,
  );
  return x === null || y === null ? null : [x, y];
}

type Style = Record<string, string | undefined>;

/** 文書の中で使う決まりごと */
interface Context {
  frame: Frame;
  frameRate: number;
  styles: Map<string, Style>;
  regions: Map<string, XmlElement>;
}

/** `style` で参照した名前の付いた style を、参照の順に重ねる (style がさらに参照するものも先に) */
function referenced(
  ids: string | undefined,
  context: Context,
  seen = new Set<string>(),
): Style {
  let out: Style = {};
  for (const id of (ids ?? "").split(/\s+/)) {
    const style = context.styles.get(id);
    if (style === undefined || seen.has(id)) continue;
    seen.add(id);
    out = { ...out, ...referenced(style["style"], context, seen), ...style };
  }
  return out;
}

/** 要素の見た目。親から受け継いだものに、参照した style と要素の属性を重ねる */
function styleOf(
  element: XmlElement,
  inherited: Style,
  context: Context,
): Style {
  return {
    ...inherited,
    ...referenced(element.attributes["style"], context),
    ...element.attributes,
  };
}

/** 1 字ぶんの見た目 */
interface Glyph {
  char: string;
  style: Style;
  /** ルビ (この字の並びの上に置く文字)。並びの最初の字にだけ付ける */
  ruby?: { text: string; count: number };
}

/** p の中身を行に分ける。xml:space が default なら、空白の並びを 1 つにして行の端を落とす */
function lines(p: XmlElement, style: Style, context: Context): Glyph[][] {
  const out: Glyph[][] = [[]];
  const walk = (node: XmlNode, inherited: Style) => {
    if (typeof node === "string") {
      const preserve = inherited["space"] === "preserve";
      const text = preserve ? node : node.replace(/\s+/g, " ");
      for (const char of text) out.at(-1)!.push({ char, style: inherited });
      return;
    }
    if (node.name === "br") {
      out.push([]);
      return;
    }
    if (node.name !== "span") return;
    const own = styleOf(node, inherited, context);
    // ルビの入れ物: 親字 (base) の並びと、ルビ (text) を組にする
    if (own["ruby"] === "container") {
      const parts = node.children.filter(
        (c): c is XmlElement => typeof c !== "string",
      );
      const find = (kind: string): XmlElement | undefined =>
        parts.find((c) => styleOf(c, own, context)["ruby"] === kind) ??
        parts
          .filter(
            (c) => styleOf(c, own, context)["ruby"] === `${kind}Container`,
          )
          .flatMap((c) =>
            c.children.filter((x): x is XmlElement => typeof x !== "string"),
          )[0];
      const base = find("base");
      const ruby = find("text");
      const before = out.at(-1)!.length;
      if (base !== undefined) walk(base, own);
      const added = out.at(-1)!.length - before;
      const first = out.at(-1)![before];
      if (ruby !== undefined && first !== undefined && added > 0)
        first.ruby = { text: textOf(ruby).trim(), count: added };
      return;
    }
    for (const child of node.children) walk(child, own);
  };
  for (const child of p.children) walk(child, style);
  return out.map((line) =>
    style["space"] === "preserve" ? line : trimLine(line),
  );
}

function textOf(node: XmlNode): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

function trimLine(line: Glyph[]): Glyph[] {
  let start = 0;
  let end = line.length;
  while (start < end && line[start]!.char === " ") start++;
  while (end > start && line[end - 1]!.char === " ") end--;
  return line.slice(start, end);
}

/** 半角の字 (ASCII・半角カナ)。区画の幅を半分にする */
function narrow(char: string): boolean {
  const code = char.codePointAt(0)!;
  return code < 0x7f || (code >= 0xff61 && code <= 0xff9f);
}

/** 見た目から、字の大きさ (縦) と横の縮め方 */
function fontSize(style: Style, frame: Frame): [number, number] {
  const cell = frame.height / frame.rows;
  const parts = (style["fontSize"] ?? "1c").trim().split(/\s+/);
  const height = length(parts[1] ?? parts[0] ?? "", cell, cell) ?? cell;
  const width =
    parts[1] === undefined
      ? height
      : (length(parts[0] ?? "", cell, cell) ?? height);
  return [height, height > 0 ? width / height : 1];
}

function lineHeight(style: Style, size: number, frame: Frame): number {
  const value = style["lineHeight"];
  if (value === undefined || value === "normal") return size * 1.2;
  return length(value, size, frame.height / frame.rows) ?? size * 1.2;
}

/** 1 行を区画に並べた run にする。`x`・`y` は行の左上 */
function lineRuns(
  line: Glyph[],
  x: number,
  y: number,
  height: number,
  frame: Frame,
): CaptionRun[] {
  const runs: CaptionRun[] = [];
  const rubies: CaptionRun[] = [];
  let at = x;
  line.forEach((glyph, i) => {
    const [size, scaleX] = fontSize(glyph.style, frame);
    const w = glyphWidth(glyph.char, glyph.style, frame);
    const run = runOf(glyph.style, glyph.char, at, y, w, height, size, scaleX);
    const last = runs.at(-1);
    if (
      last !== undefined &&
      sameLook(last, run) &&
      Math.abs(last.x + last.w * [...last.text].length - at) < 1e-6
    )
      last.text += glyph.char;
    else runs.push(run);
    if (glyph.ruby !== undefined) {
      // 親字の並びの幅の真ん中に、半分の大きさで、行の上へはみ出して置く
      const baseWidth = line
        .slice(i, i + glyph.ruby.count)
        .reduce((sum, g) => sum + glyphWidth(g.char, g.style, frame), 0);
      const rubySize = size / 2;
      const chars = [...glyph.ruby.text];
      const widths = chars.map(
        (c) => rubySize * scaleX * (narrow(c) ? 0.5 : 1),
      );
      let rx = at + (baseWidth - widths.reduce((a, b) => a + b, 0)) / 2;
      chars.forEach((char, k) => {
        const rw = widths[k]!;
        const ruby = runOf(
          glyph.style,
          char,
          rx,
          y - rubySize,
          rw,
          rubySize,
          rubySize,
          scaleX,
        );
        ruby.ruby = true;
        ruby.bg = "#00000000";
        rubies.push(ruby);
        rx += rw;
      });
    }
    at += w;
  });
  return [...runs, ...rubies];
}

/** 1 字の区画の幅 */
function glyphWidth(char: string, style: Style, frame: Frame): number {
  const [size, scaleX] = fontSize(style, frame);
  return size * scaleX * (narrow(char) ? 0.5 : 1);
}

function runOf(
  style: Style,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  size: number,
  scaleX: number,
): CaptionRun {
  const run: CaptionRun = {
    x,
    y,
    w,
    h,
    fx: 0,
    fy: (h - size) / 2,
    size,
    scaleX,
    text,
    fg: color(style["color"]) ?? "#ffffffff",
    bg: color(style["backgroundColor"]) ?? "#00000000",
  };
  const outline = style["textOutline"]?.trim().split(/\s+/) ?? ["none"];
  if (outline[0] !== "none") run.stroke = color(outline[0]) ?? run.fg;
  if (style["fontWeight"] === "bold") run.bold = true;
  if (style["fontStyle"] === "italic" || style["fontStyle"] === "oblique")
    run.italic = true;
  if (style["textDecoration"]?.includes("underline") === true)
    run.underline = true;
  return run;
}

function sameLook(a: CaptionRun, b: CaptionRun): boolean {
  return (
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.size === b.size &&
    a.scaleX === b.scaleX &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.stroke === b.stroke &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.ruby === undefined &&
    b.ruby === undefined
  );
}

/** 出す段落 1 つ。時刻は文書の始まりからの秒 */
interface Paragraph {
  begin: number;
  end: number;
  runs: CaptionRun[];
}

/** p を、region の中に置いた run にする */
function layout(p: XmlElement, style: Style, context: Context): CaptionRun[] {
  const { frame } = context;
  const region = context.regions.get(style["region"] ?? "");
  const regionStyle = region === undefined ? {} : styleOf(region, {}, context);
  const merged = { ...regionStyle, ...style };
  const [x, y] = pair(regionStyle["origin"], frame) ?? [0, 0];
  const [width, height] = pair(regionStyle["extent"], frame) ?? [
    frame.width - x,
    frame.height - y,
  ];
  const rows = lines(p, merged, context).filter((line) => line.length > 0);
  const heights = rows.map((line) =>
    Math.max(
      ...line.map((g) =>
        lineHeight(g.style, fontSize(g.style, frame)[0], frame),
      ),
    ),
  );
  const total = heights.reduce((sum, h) => sum + h, 0);
  const align = merged["displayAlign"];
  let top =
    y +
    (align === "after"
      ? height - total
      : align === "center"
        ? (height - total) / 2
        : 0);
  const runs: CaptionRun[] = [];
  rows.forEach((line, i) => {
    const lineWidth = line.reduce(
      (sum, g) => sum + glyphWidth(g.char, g.style, frame),
      0,
    );
    const textAlign = merged["textAlign"];
    const left =
      x +
      (textAlign === "center"
        ? (width - lineWidth) / 2
        : textAlign === "right" || textAlign === "end"
          ? width - lineWidth
          : 0);
    runs.push(...lineRuns(line, left, top, heights[i]!, frame));
    top += heights[i]!;
  });
  return runs;
}

/** 字幕 1 枚と、出す時刻 (90 kHz) */
export interface TimedCaptionPage {
  at: number;
  page: CaptionPage;
}

/**
 * TTML の文書を、出す時刻ごとの字幕の文字の配置にする。`start` は文書の時刻の始まり (MPU の最初の提示時刻、90 kHz)。
 *
 * 段落 (p) の出る・消える時刻ごとに 1 枚を作る (`CaptionPage` は前の 1 枚を丸ごと置き換えるので、
 * その時刻に出ている段落を全部並べる)。最初の 1 枚は `start` で、何も出ていなければ空 (前の文書の字幕を消す)。
 * 読めない文書は空の並びを返す
 */
export function ttmlPages(document: string, start: number): TimedCaptionPage[] {
  const tt = parseXml(document);
  if (tt === null) return [];
  const [columns = 32, rows = 15] = (tt.attributes["cellResolution"] ?? "32 15")
    .split(/\s+/)
    .map(Number);
  const [width = 1920, height = 1080] =
    /^\s*(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s*$/
      .exec(tt.attributes["extent"] ?? "")
      ?.slice(1)
      .map(Number) ?? [1920, 1080];
  const context: Context = {
    frame: { width, height, columns, rows },
    frameRate: Number(tt.attributes["frameRate"] ?? 30) || 30,
    styles: new Map(),
    regions: new Map(),
  };
  for (const style of elements(tt, "style")) {
    const id = style.attributes["id"];
    if (id !== undefined) context.styles.set(id, style.attributes);
  }
  for (const region of elements(tt, "region")) {
    const id = region.attributes["id"];
    if (id !== undefined) context.regions.set(id, region);
  }

  const paragraphs: Paragraph[] = [];
  /** 時刻は親の始まりからのずれ (par)。end も dur も無ければ親の終わりまで */
  const walk = (
    node: XmlElement,
    inherited: Style,
    begin: number,
    end: number,
  ) => {
    const style = styleOf(node, inherited, context);
    const own = seconds(node.attributes["begin"], context.frameRate);
    const from = begin + (own ?? 0);
    const until = seconds(node.attributes["end"], context.frameRate);
    const dur = seconds(node.attributes["dur"], context.frameRate);
    const to = Math.min(
      end,
      until !== null ? begin + until : Infinity,
      dur !== null ? from + dur : Infinity,
    );
    if (node.name === "p") {
      paragraphs.push({
        begin: from,
        end: to,
        runs: layout(node, style, context),
      });
      return;
    }
    for (const child of node.children)
      if (typeof child !== "string") walk(child, style, from, to);
  };
  const body = [...elements(tt, "body")][0];
  if (body !== undefined) walk(body, {}, 0, Infinity);

  const times = [
    ...new Set([0, ...paragraphs.flatMap((p) => [p.begin, p.end])]),
  ]
    .filter((t) => Number.isFinite(t) && t >= 0)
    .sort((a, b) => a - b);
  return times.map((t) => ({
    at: start + Math.round(t * CLOCK),
    page: {
      v: CAPTION_TEXT_VERSION,
      plane: [width, height],
      duration: null,
      runs: paragraphs
        .filter((p) => p.begin <= t && t < p.end)
        .flatMap((p) => p.runs),
    },
  }));
}
