import type { CaptionPage, CaptionRun } from "@danything/arib/caption-text";

import { CLIP_BYTES_MOST } from "#lib/clips.js";
import type { Notice } from "#lib/components/Toasts.svelte";
import { pad } from "#lib/format.js";

/** 写す1コマ。`<video>` か、canvas で描いているときに worker から貰ったフレーム (`raw/engine.ts` の `grab`) */
export interface Frame {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** いま映している `<video>` の1コマ。まだフレームが来ていなければ null */
export function videoFrame(video: HTMLVideoElement | null): Frame | null {
  if (video === null || video.videoWidth === 0) return null;
  return { image: video, width: video.videoWidth, height: video.videoHeight };
}

/**
 * **canvas で描いているとき (MPEG-2・互換モード) は worker に1枚貰う。** 映像は worker の canvas にあって、
 * `<video>` は空のまま (`raw/engine.ts`)
 */
export async function grabbedFrame(
  bitmap: Promise<ImageBitmap | null>,
): Promise<Frame | null> {
  const image = await bitmap;
  return image === null
    ? null
    : { image, width: image.width, height: image.height };
}

/**
 * ファイル名に使えない字。Windows が断る `\ / : * ? " < > |` と制御文字。
 * 番組名には「／」(全角) や「:」がよく入る — 全角は通るので残し、半角だけ替える
 */
const FORBIDDEN = /[\\/:*?"<>|\p{Cc}]/gu;
/** 名前の上限 (字)。**長い番組名で 255 バイトを超えない**ように (日本語は1字3バイト) */
const NAME_MOST = 60;

/**
 * 切り抜きのファイル名。`番組名_YYYYMMDD-HHMMSS.png` (時刻は撮った瞬間。拡張子は `extension`)。
 *
 * **時刻は秒まで入れる。** 同じ番組を何枚も撮ると名前がぶつかり、ブラウザが「(1)」を
 * 足していくか、共有先 (写真アプリ) で上書きの確認が出る
 */
export function shotName(title: string, at: Date, extension = "png"): string {
  const name =
    title
      .replace(FORBIDDEN, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NAME_MOST)
      // 末尾の点と空白は Windows が黙って落とす
      .replace(/[. ]+$/, "") || "denpa";
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${name}_${day}-${time}.${extension}`;
}

/**
 * **指の端末では共有に渡す。** スマホで `<a download>` に落とすと「ファイル」の奥に
 * 入るだけで、写真には並ばない (iOS)。共有シートなら「画像を保存」で写真へ、そのまま
 * LINE などへも送れる。PC にも共有の API を持つブラウザがある (Chrome・Safari) が、
 * あちらは落とすほうが早いので使わない
 */
function prefersShare(file: File): boolean {
  if (
    typeof navigator.share !== "function" ||
    typeof navigator.canShare !== "function"
  )
    return false;
  if (!window.matchMedia("(pointer: coarse)").matches) return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** 落とす。**URL はすぐには捨てない** — Safari と Firefox は押した直後に捨てると落とし損ねる */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 映像と同じ縦横の空の canvas。作れなければ null */
function blankCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  return ctx === null ? null : { canvas, ctx };
}

/**
 * いまの1コマを1枚の canvas に写し、`layers` (映像と同じ縦横の重ね) を下から順に重ねる。
 * 重ねを渡さなければ映像だけ。まだフレームが来ていなければ null
 */
export function composeFrame(
  frame: Frame | null,
  layers: (HTMLCanvasElement | null)[] = [],
): HTMLCanvasElement | null {
  if (frame === null || frame.width === 0) return null;
  const made = blankCanvas(frame.width, frame.height);
  if (made === null) return null;
  const { canvas, ctx } = made;
  ctx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
  for (const layer of layers)
    if (layer !== null) ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 透けていない画素が1つでもあるか (何も描かれていない重ねは送らない) */
function inked(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  return false;
}

/**
 * **字幕の重ね。** 出している字幕の canvas を映像の縦横に引き伸ばして、透明な canvas に写す
 * (重ねたときに観ていた画面と同じ所へ来る)。出していない・何も描かれていなければ null
 */
export function captionLayer(
  caption: HTMLCanvasElement | null,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  if (caption === null || caption.width <= 1) return null;
  const made = blankCanvas(width, height);
  if (made === null) return null;
  made.ctx.drawImage(caption, 0, 0, width, height);
  return inked(made.ctx, width, height) ? made.canvas : null;
}

/** 画面の上の箱 (CSS px) */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 画面に出ている実況のコメント1件 */
export interface ShownComment {
  text: string;
  /** いま見えている箱 (CSS px。`getBoundingClientRect`。流れている途中の位置) */
  box: Box;
  /** 字の書体 (canvas の `font` の形) と色 */
  font: string;
  color: string;
}

/** 重ねに描くコメント1件。位置は映像の枠の左上からの CSS px */
export interface CommentSpot {
  text: string;
  font: string;
  color: string;
  /** 字の左端と、行の縦の中ほど */
  x: number;
  y: number;
}

/**
 * **コメントの置き場所。** 枠 (`frame`。映像を 16:9 に収めた所) に掛かっているものだけを、枠の左上からの位置にする。
 * 流れて枠の外に出たもの・まだ入ってきていないものは描かない
 */
export function commentSpots(
  frame: Box,
  comments: ShownComment[],
): CommentSpot[] {
  return comments
    .filter(
      ({ box }) =>
        box.width > 0 &&
        box.left < frame.left + frame.width &&
        box.left + box.width > frame.left &&
        box.top < frame.top + frame.height &&
        box.top + box.height > frame.top,
    )
    .map(({ text, font, color, box }) => ({
      text,
      font,
      color,
      x: box.left - frame.left,
      y: box.top - frame.top + box.height / 2,
    }));
}

/** 実況の字の透明度。`JikkyoLayer` の `.comment` と同じ */
const COMMENT_OPACITY = 0.5;
/** 黒い縁の幅 (CSS px)。`JikkyoLayer` の `text-shadow` と同じく斜め4方向にずらして描く */
const OUTLINE = 1;

/** 押した瞬間のコメントの枠 (CSS px) と、そこに掛かっているコメント */
export interface CommentScene {
  area: Box;
  spots: CommentSpot[];
}

/**
 * **いま流れているコメントを読む** (押した瞬間に。コメントは動き続けるので、フレームを待つ前に)。
 * 位置は DOM から読む (`getBoundingClientRect`。CSS の `translateX` で動いている途中の所)。
 * コメントの層はプレイヤーに1つ (`JikkyoLayer`) なので、画面から探す。流していない・枠に1件も無ければ null
 */
export function readComments(): CommentScene | null {
  const frame = document.querySelector<HTMLElement>(
    '[data-testid="jikkyo-layer"] [data-frame]',
  );
  if (frame === null) return null;
  const area = frame.getBoundingClientRect();
  if (area.width <= 0 || area.height <= 0) return null;
  const shown: ShownComment[] = [];
  for (const node of frame.querySelectorAll<HTMLElement>(
    '[data-testid="jikkyo-comment"]',
  )) {
    const style = getComputedStyle(node);
    shown.push({
      text: node.textContent ?? "",
      box: node.getBoundingClientRect(),
      font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
      color: style.color,
    });
  }
  const spots = commentSpots(area, shown);
  return spots.length === 0 ? null : { area, spots };
}

/**
 * **実況のコメントの重ね。** 読んでおいたコメント (`readComments`) を、見えていた位置のまま透明な canvas に描く。
 * 枠の CSS px から映像の画素へ引き伸ばす。字の書体・色・黒い縁・透明度は観ている画面と同じ
 * (この端末で書いたものの下線は描かない)。コメントが無ければ null
 */
export function commentLayer(
  scene: CommentScene | null,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  if (scene === null) return null;
  const { area, spots } = scene;

  // いったん濃いまま描いて、まとめて透かす (1件ずつ透かすと、縁と字が重なった所だけ濃くなる)
  const solid = blankCanvas(width, height);
  const layer = blankCanvas(width, height);
  if (solid === null || layer === null) return null;
  const { ctx } = solid;
  ctx.setTransform(width / area.width, 0, 0, height / area.height, 0, 0);
  ctx.textBaseline = "middle";
  for (const spot of spots) {
    ctx.font = spot.font;
    ctx.fillStyle = "#000";
    for (const [dx, dy] of OUTLINE_SHIFTS)
      ctx.fillText(spot.text, spot.x + dx, spot.y + dy);
    ctx.fillStyle = spot.color;
    ctx.fillText(spot.text, spot.x, spot.y);
  }
  layer.ctx.globalAlpha = COMMENT_OPACITY;
  layer.ctx.drawImage(solid.canvas, 0, 0);
  return layer.canvas;
}

const OUTLINE_SHIFTS = [
  [-OUTLINE, -OUTLINE],
  [OUTLINE, -OUTLINE],
  [-OUTLINE, OUTLINE],
  [OUTLINE, OUTLINE],
] as const;

export function pngOf(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** サーバへ送るときの画質 (WebP・JPEG の 0〜1)。上限に収まるまでこの順に下げる */
const QUALITIES = [0.92, 0.85, 0.75, 0.6];

/**
 * **サーバへ送る映像。** PNG は 1080 で数 MB になり、本文の上限 (`CLIP_BYTES_MOST`) を超えるので、
 * WebP (作れないブラウザ (Safari) では JPEG) にして、`most` バイトに収まるまで画質を下げる。
 * サーバは受けたものを AVIF にし直すので、ここは見た目が崩れない程度でよい。収まらなければ null
 */
export async function uploadBlob(
  canvas: HTMLCanvasElement,
  most = CLIP_BYTES_MOST,
): Promise<Blob | null> {
  let type = "image/webp";
  for (const quality of QUALITIES) {
    let blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, quality),
    );
    // WebP を作れないブラウザは PNG を返してくる
    if (blob !== null && blob.type !== type) {
      type = "image/jpeg";
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, type, quality),
      );
    }
    if (blob === null) return null;
    if (blob.size <= most) return blob;
  }
  return null;
}

/** multipart の区切りと部分の頭のぶん (バイト)。3つの部分で数百バイトなので、多めに */
const FORM_SLACK = 4 * 1024;
/** 重ねを除いて映像に残したい大きさ。これより狭ければ重ねを諦めて1枚にする (画質を下げても入らない) */
const FRAME_LEAST = 64 * 1024;

/** 送る重ね (映像と同じ縦横)。出していなかったものは null */
export interface ClipLayerCanvases {
  captions: HTMLCanvasElement | null;
  comments: HTMLCanvasElement | null;
}

/**
 * 映像に使える大きさ (バイト)。本文の上限から区切りのぶんと重ね (PNG) を引いたもの。
 * 重ねが無い・狭すぎて映像が入らないなら null (重ねたものを1枚で送る)
 */
export function frameRoom(layerBytes: number[]): number | null {
  if (layerBytes.length === 0) return null;
  const room =
    CLIP_BYTES_MOST - FORM_SLACK - layerBytes.reduce((a, b) => a + b, 0);
  return room >= FRAME_LEAST ? room : null;
}

/**
 * **`POST /api/clips` の本文。** 映像 (`frame`) と、出していた重ね (`captions`・`comments`。透明な PNG) を
 * 分けて送る (あとから出し入れできる)。合わせて本文の上限に収まるよう、重ねの残りで映像の画質を下げる。
 *
 * 重ねが大きすぎて映像が入らないときは、**重ねたもの (`composite`) を映像として1枚だけ送る** (出し入れはできないが、
 * 撮ったものは残る)。それも収まらなければ null
 */
export async function clipForm(
  frame: HTMLCanvasElement,
  layers: ClipLayerCanvases,
  composite: HTMLCanvasElement,
): Promise<FormData | null> {
  const form = new FormData();
  const pngs: [string, Blob][] = [];
  for (const name of ["captions", "comments"] as const) {
    const layer = layers[name];
    if (layer === null) continue;
    const png = await pngOf(layer);
    if (png !== null) pngs.push([name, png]);
  }
  const room = frameRoom(pngs.map(([, png]) => png.size));
  const blob = room === null ? null : await uploadBlob(frame, room);
  if (blob !== null) {
    form.append("frame", blob, `frame.${extensionOf(blob)}`);
    for (const [name, png] of pngs) form.append(name, png, `${name}.png`);
    return form;
  }
  const whole = await uploadBlob(composite, CLIP_BYTES_MOST - FORM_SLACK);
  if (whole === null) return null;
  form.append("frame", whole, `frame.${extensionOf(whole)}`);
  return form;
}

function extensionOf(blob: Blob): string {
  return blob.type === "image/jpeg" ? "jpg" : blob.type.replace("image/", "");
}

/**
 * 出している字幕の文字 (探すため)。字の並びを上から行ごとにつなぐ。ルビと外字の代わりの「〓」は落とす
 */
export function captionWords(page: CaptionPage | null): string {
  if (page === null) return "";
  const lines = new Map<number, CaptionRun[]>();
  for (const run of page.runs) {
    if (run.ruby === true || run.drcs !== undefined) continue;
    const line = lines.get(run.y) ?? [];
    line.push(run);
    lines.set(run.y, line);
  }
  return [...lines.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, runs]) =>
      runs
        .sort((a, b) => a.x - b.x)
        .map((run) => run.text)
        .join("")
        .trim(),
    )
    .filter(Boolean)
    .join(" ");
}

/** どこで撮ったか。サーバはこれで番組を引く (`POST /api/clips`) */
export type ClipWhere =
  | {
      place: "watch" | "chase";
      recording: number;
      /** 位置 (秒)。観ているものの物差し */
      at: number;
      /** 観ているもの (`ts` / `encoded` / `alt`)。分からなければ undefined */
      source: string | undefined;
    }
  | {
      place: "live";
      service: number;
      /** 映していたコマの放送時刻 (unix ms)。分からなければ null (サーバが受け取った時刻にする) */
      aired: number | null;
    };

/** `POST /api/clips` の URL の問い合わせ */
export function clipParams(
  where: ClipWhere,
  captions: string,
): URLSearchParams {
  const params = new URLSearchParams({ place: where.place });
  if (where.place === "live") {
    params.set("service", String(where.service));
    if (where.aired !== null)
      params.set("aired", String(Math.round(where.aired)));
  } else {
    params.set("recording", String(where.recording));
    params.set("at", where.at.toFixed(3));
    if (where.source !== undefined) params.set("source", where.source);
  }
  if (captions !== "") params.set("captions", captions);
  return params;
}

/**
 * **端末に保存する** (サーバに置けなかったとき)。PNG にして `keepOnDevice` に渡す。
 * 共有シートを閉じられたら何も残らないので、そう言う。
 *
 * 返り値は通知 (トースト)。サーバに置けなかったことは必ず言う (黙ると、一覧に無い理由が分からない)
 */
export async function saveOnDevice(
  canvas: HTMLCanvasElement,
  title: string,
  key: string,
): Promise<Notice | null> {
  const blob = await pngOf(canvas);
  if (blob === null) return null;
  const kept = await keepOnDevice(blob, shotName(title, new Date()));
  return {
    key,
    kind: "info",
    text:
      kept === "canceled"
        ? "サーバに保存できませんでした"
        : "サーバに保存できなかったので端末に保存しました",
  };
}

/**
 * 画像を端末に渡す。**指の端末は共有シート** (写真へ保存・そのまま送る)、PC はファイルに落とす。
 * 共有を断られたら (押した直後でなくなった・共有できない形式) 落とすほうに倒す。閉じられたら `canceled`
 */
export async function keepOnDevice(
  blob: Blob,
  name: string,
): Promise<"shared" | "downloaded" | "canceled"> {
  const file = new File([blob], name, { type: blob.type });
  if (prefersShare(file)) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (error) {
      // 閉じた (やめた) なら何も残っていない
      if (error instanceof DOMException && error.name === "AbortError")
        return "canceled";
      // それ以外は落とす
    }
  }
  download(blob, name);
  return "downloaded";
}
