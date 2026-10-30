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

/** いまの1コマを字幕ごと1枚の canvas に写す。映像の大きさに合わせて字幕を重ねる。まだフレームが来ていなければ null */
export function composeFrame(
  frame: Frame | null,
  caption: HTMLCanvasElement | null,
): HTMLCanvasElement | null {
  if (frame === null || frame.width === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
  if (caption !== null && caption.width > 1) {
    ctx.drawImage(caption, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

export function pngOf(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** サーバへ送るときの画質 (WebP・JPEG の 0〜1)。上限に収まるまでこの順に下げる */
const QUALITIES = [0.92, 0.85, 0.75, 0.6];

/**
 * **サーバへ送る1枚。** PNG は 1080 で数 MB になり、本文の上限 (`CLIP_BYTES_MOST`) を超えるので、
 * WebP (作れないブラウザ (Safari) では JPEG) にして、収まるまで画質を下げる。
 * サーバは受けたものを AVIF にし直すので、ここは見た目が崩れない程度でよい。収まらなければ null
 */
export async function uploadBlob(
  canvas: HTMLCanvasElement,
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
    if (blob.size <= CLIP_BYTES_MOST) return blob;
  }
  return null;
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
 * **端末に保存する** (サーバに置けなかったとき)。前は押すたびにこうしていた。
 *
 * - **指の端末** … 共有シート (`navigator.share`)。断られたら (押した直後でなくなった・
 *   共有できない形式) 落とすほうに倒す。閉じられたら何も残らないので、そう言う
 * - **PC** … PNG を落とす
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
  const name = shotName(title, new Date());
  const saved: Notice = {
    key,
    kind: "info",
    text: "サーバに保存できなかったので端末に保存しました",
  };

  return (await keepOnDevice(blob, name)) === "canceled"
    ? { key, kind: "info", text: "サーバに保存できませんでした" }
    : saved;
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
