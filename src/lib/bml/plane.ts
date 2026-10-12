/**
 * 文字図形の面の大きさと縦横比。エンジンを読み込まずに画面 (DataBroadcast) からも使うので分けてある
 */

import type { Rect } from './render';

/**
 * 文字図形の面 (body の resolution と display-aspect-ratio。STD-B24 第二編 5.4.13.1)。
 * `aspect` は面を映す縦横比で、960x540 はいつも 16:9、720x480 は 16:9 か 4:3
 * (第二編 表6-3・付属1 の document_resolution)
 */
export interface Plane {
    width: number;
    height: number;
    aspect: '16:9' | '4:3';
}

/**
 * 面を、縦横 `box` の枠のどこへ映すか (枠の中の座標)。16:9 の面は枠いっぱいに伸ばし (映像と同じ)、
 * 4:3 の面は高さを合わせて左右の真ん中に置く (16:9 の画面に 4:3 を映す受信機と同じ)
 */
export function planeArea(box: { width: number; height: number }, plane: { aspect?: Plane['aspect'] }): Rect {
    if (plane.aspect !== '4:3' || box.height === 0)
        return { left: 0, top: 0, width: box.width, height: box.height };
    const width = Math.min(box.width, (box.height * 4) / 3);
    const height = width === box.width ? (box.width * 3) / 4 : box.height;
    return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}
