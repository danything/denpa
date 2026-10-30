/**
 * **コメントのコマンド** (`mail` の色・位置・大きさ)。読むのは流すとき (`comments.ts`)、書くのは書き込むとき (`nx.ts`)。
 *
 * - `mail` は空白で区切ったコマンドの並び (`184 red ue big` など)。色・位置・大きさのほかと、読めないものは無視する。
 *   同じ種類が 2 つあれば後ろのものを使う
 * - 色はニコニコの色の名前と、16 進の色 (`#rrggbb`)。値はニコニコのコマンドの色 (プレミアム会員の色も含む)。
 *   白は字の色を替えない (映像の上のいつもの白)
 * - 位置は `ue` (上に止める)・`shita` (下に止める)・`naka` (流れる。既定)。大きさは `big`・`small`・`medium` (既定)
 */

/** 書き込むときに選べる色 (KonomiTV の書き込みの欄と同じ 8 色)。名前はニコニコのコマンド */
export const POST_COLORS = [
  "white",
  "red",
  "pink",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
] as const;
export type PostColor = (typeof POST_COLORS)[number];

/** 色の名前 → 色 */
export const COLOR_VALUES: Readonly<Record<string, string>> = {
  white: "#ffffff",
  red: "#ff0000",
  pink: "#ff8080",
  orange: "#ffc000",
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  blue: "#0000ff",
  purple: "#c000ff",
  black: "#000000",
  white2: "#cccc99",
  niconicowhite: "#cccc99",
  red2: "#cc0033",
  truered: "#cc0033",
  pink2: "#ff33cc",
  orange2: "#ff6600",
  passionorange: "#ff6600",
  yellow2: "#999900",
  madyellow: "#999900",
  green2: "#00cc66",
  elementalgreen: "#00cc66",
  cyan2: "#00cccc",
  blue2: "#3399ff",
  marineblue: "#3399ff",
  purple2: "#6633cc",
  nobleviolet: "#6633cc",
  black2: "#666666",
};

export const POSITIONS = ["ue", "naka", "shita"] as const;
export type Position = (typeof POSITIONS)[number];
export const SIZES = ["big", "medium", "small"] as const;
export type Size = (typeof SIZES)[number];

/** 流し方。既定 (白・流れる・中) のものは持たない */
export interface Style {
  /** 字の色 (`#rrggbb`)。白なら無い */
  color?: string;
  /** 上か下に止める。流れるなら無い */
  place?: "ue" | "shita";
  /** 大きさ。中なら無い */
  size?: "big" | "small";
}

/** `mail` を読む。既定のままなら空 */
export function readMail(mail: unknown): Style {
  const style: Style = {};
  if (typeof mail !== "string") return style;
  for (const command of mail.trim().split(/\s+/)) {
    const name = command.toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(name)) style.color = name;
    else if (Object.hasOwn(COLOR_VALUES, name))
      style.color = COLOR_VALUES[name]!;
    else if (name === "ue" || name === "shita") style.place = name;
    else if (name === "naka") delete style.place;
    else if (name === "big" || name === "small") style.size = name;
    else if (name === "medium") delete style.size;
  }
  if (style.color === COLOR_VALUES["white"]) delete style.color;
  return style;
}

/** 書き込むときに選んだもの (端末ごとに覚える。`JikkyoCompose`) */
export interface PostStyle {
  color: PostColor;
  position: Position;
  size: Size;
}

export const DEFAULT_POST_STYLE: PostStyle = {
  color: "white",
  position: "naka",
  size: "medium",
};

/** 覚えていたものを読む。読めないところは既定に戻す */
export function readPostStyle(raw: string | null): PostStyle {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (parsed !== null && typeof parsed === "object")
      value = parsed as Record<string, unknown>;
  } catch {
    // 既定に戻す
  }
  const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T =>
    list.includes(v as T) ? (v as T) : d;
  return {
    color: pick(POST_COLORS, value["color"], DEFAULT_POST_STYLE.color),
    position: pick(POSITIONS, value["position"], DEFAULT_POST_STYLE.position),
    size: pick(SIZES, value["size"], DEFAULT_POST_STYLE.size),
  };
}

/** 書き込むものの流し方 (送れたらすぐ自分で流すときに使う) */
export function postStyle(post: PostStyle): Style {
  return readMail(`${post.color} ${post.position} ${post.size}`);
}
