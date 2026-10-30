import { resolve } from "$app/paths";

import type { Notice } from "#lib/components/Toasts.svelte";

import type { PlayerControls } from "./controls.svelte";
import {
  clipParams,
  type ClipWhere,
  composeFrame,
  type Frame,
  pngOf,
  saveOnDevice,
  uploadBlob,
} from "./snapshot";

/** 押したあとボタンをチェックの形にしておく長さ (ms) */
const SAVED_MS = 1500;

/**
 * 切り抜きの3点セット (撮る・結果を持つ・トーストに出す)。**3画面 (ライブ・追っかけ・観る画面) で同じ形。**
 *
 * 押すと、いまの1コマを字幕ごと写して**サーバへ送る** (`POST /api/clips`。サーバが AVIF にして置き、
 * 「切り抜き」の画面に並ぶ)。知らせ方は控えめに: ボタンが一瞬チェックになり、トーストに「保存しました」の1行。
 * PC ではクリップボードにもコピーする (そのまま貼りたいとき用)。
 *
 * **送れなかったとき (オフラインで観ている・サーバが断った) だけ、端末に保存する** (指の端末は共有シート、
 * PC は PNG を落とす。`snapshot.saveOnDevice`)
 */
export function snapshotter(controls: PlayerControls) {
  let shot = $state<Notice | null>(null);
  /** 送れた直後か (ボタンをチェックの形にする) */
  let saved = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 撮っている最中か。**続けて押しても1枚ずつ** — 共有シートが開いている間に
   * もう一度押すと、2枚目の共有が「もう開いている」で断られて落ちてくる
   */
  let busy = false;

  /**
   * **PC ではクリップボードにもコピーする。** 置けるのは https か localhost で押した直後だけなので、
   * 送る前に始める (中身は後から渡せる)。断られても黙る
   */
  function copy(canvas: HTMLCanvasElement): Promise<boolean> {
    if (
      window.matchMedia("(pointer: coarse)").matches ||
      typeof ClipboardItem === "undefined" ||
      navigator.clipboard?.write === undefined
    )
      return Promise.resolve(false);
    const png = pngOf(canvas).then(
      (blob) => blob ?? Promise.reject(new Error("PNG にできませんでした")),
    );
    return navigator.clipboard
      .write([new ClipboardItem({ "image/png": png })])
      .then(
        () => true,
        () => false,
      );
  }

  /** サーバへ送る。置けたら true。オフライン・断られた・届かないは false */
  async function upload(
    canvas: HTMLCanvasElement,
    where: ClipWhere,
    captions: string,
  ): Promise<boolean> {
    if (!navigator.onLine) return false;
    const blob = await uploadBlob(canvas);
    if (blob === null) return false;
    try {
      const res = await fetch(
        `${resolve("api/clips")}?${clipParams(where, captions)}`,
        {
          method: "POST",
          headers: { "content-type": blob.type },
          body: blob,
        },
      );
      return res.status === 201;
    } catch {
      return false;
    }
  }

  return {
    /** トーストへ混ぜるぶん。撮っていなければ空 */
    get notices(): Notice[] {
      return shot === null ? [] : [shot];
    },
    /** 送れた直後か。ボタンを一瞬チェックの形にする */
    get saved(): boolean {
      return saved;
    },
    /** 閉じた (自分で消えた) ら捨てる。持ったままだと、返事が変わったときに蘇る (Toasts) */
    dismiss(key: string): void {
      if (shot?.key === key) shot = null;
    },
    /**
     * いまの1コマを字幕ごと切り抜いて送る。
     * @param frame 写すフレームを取ってくる関数。**撮れると決まってから呼ぶ** (`busy` の後) — canvas で
     *   描いているときは worker から1枚もらう (`raw/engine.ts` の `grab`) ので、先に呼ぶと
     *   弾いた押しのぶんのフレーム (1080 で 8MB) が誰にも閉じられずに残る
     * @param caption 出している字幕の canvas。出していなければ null
     * @param title 番組名 (端末に保存するときのファイル名の頭)
     * @param where どこで撮ったか (サーバが番組を引く)。押した瞬間の位置を読むので関数で
     * @param captions 出している字幕の文字 (探すため)。出していなければ空
     */
    async take(
      frame: () => Frame | null | Promise<Frame | null>,
      caption: HTMLCanvasElement | null,
      title: string,
      where: () => ClipWhere,
      captions: string,
    ): Promise<void> {
      if (busy) return;
      busy = true;
      controls.stir();
      const at = where();
      let got: Frame | null = null;
      try {
        got = await frame();
        const canvas = composeFrame(got, caption);
        // worker から貰ったフレーム (1080 で 8MB) は写し終えたら手放す。GC 任せだと押すたびに溜まる
        if (got?.image instanceof ImageBitmap) got.image.close();
        got = null;
        if (canvas === null) return;
        const key = `shot-${Date.now()}`;
        const copied = copy(canvas);
        if (await upload(canvas, at, captions)) {
          saved = true;
          if (savedTimer !== null) clearTimeout(savedTimer);
          savedTimer = setTimeout(() => (saved = false), SAVED_MS);
          shot = {
            key,
            kind: "success",
            text: (await copied)
              ? "保存しました (クリップボードにもコピー)"
              : "保存しました",
          };
          return;
        }
        const notice = await saveOnDevice(canvas, title, key);
        if (notice !== null) shot = notice;
      } finally {
        busy = false;
        if (got?.image instanceof ImageBitmap) got.image.close();
      }
    },
  };
}
