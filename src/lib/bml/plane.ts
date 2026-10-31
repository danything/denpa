/**
 * 文字図形の面の大きさと縦横比。エンジンを読み込まずに画面 (DataBroadcast) からも使うので分けてある
 */

import type { Rect } from "./render";

/**
 * 文字図形の面 (body の resolution と display-aspect-ratio。STD-B24 第二編 5.4.13.1)。
 * `aspect` は面を映す縦横比で、960x540 はいつも 16:9、720x480 は 16:9 か 4:3
 * (第二編 表6-3・付属1 の document_resolution)
 */
export interface Plane {
  width: number;
  height: number;
  aspect: "16:9" | "4:3";
}

/**
 * 面を、縦横 `box` の枠のどこへ映すか (枠の中の座標)。放送の縦横比を保って枠内に収め、
 * 上下左右の真ん中に置く。縦長の画面や全画面でも、面を引き伸ばさない
 */
export function planeArea(
  box: { width: number; height: number },
  plane: { aspect?: Plane["aspect"] },
): Rect {
  const ratio = plane.aspect === "4:3" ? 4 / 3 : 16 / 9;
  const width = Math.min(box.width, box.height * ratio);
  const height = width === box.width ? box.width / ratio : box.height;
  return {
    left: (box.width - width) / 2,
    top: (box.height - height) / 2,
    width,
    height,
  };
}
