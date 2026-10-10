/**
 * 字幕を映像の上に重ねるときの置き場所。**3画面 (ライブ・追っかけ・観る画面) で同じもの。**
 *
 * 描くのは [caption-draw.ts](caption-draw.ts)。ここは「映像の絵が枠のどこに出ているか」だけを出す (`fitRect`)。
 */

/** 枠の中で中身がどこに出るか (画素) */
export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * 中身を枠に収めたときの位置と大きさ (`object-fit: contain` と同じ計算)。
 * 映像の絵が出ている場所を出し、字幕の canvas の箱をそこへ重ねる。
 * 箱の中の画素の大きさは `CaptionPainter` が面の縦横比 × DPR で決める
 */
export function fitRect(
    boxWidth: number,
    boxHeight: number,
    contentWidth: number,
    contentHeight: number,
): Rect {
    if (boxWidth <= 0 || boxHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
        return { left: 0, top: 0, width: Math.max(0, boxWidth), height: Math.max(0, boxHeight) };
    }
    const scale = Math.min(boxWidth / contentWidth, boxHeight / contentHeight);
    const width = contentWidth * scale;
    const height = contentHeight * scale;
    return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}
