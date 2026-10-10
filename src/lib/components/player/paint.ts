/**
 * 字幕を映像の上に重ねるときの置き場所。**3画面 (ライブ・追っかけ・観る画面) で同じもの。**
 *
 * 描くのは [caption-draw.ts](caption-draw.ts)。ここは「映像の絵が枠のどこに出ているか」だけを出す
 * (字幕の面と映像の縦横比が違うことがあるため。`fitRect`)。
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
 *
 * **字幕の面と映像の縦横比が違うことがある。** 地上波は 1440x1080 の画素が
 * 横長で、焼くときに正方形へ直している (1920x1080) のに、**字幕の面は
 * 放送のまま 1440x1080** で入っている。canvas を `object-contain` で敷くと、
 * 字幕だけ4:3で letterbox されて**横に縮み、位置もずれる** (実機で確認)。
 *
 * プレイヤーは字幕の面を**映像の見えている枠いっぱいに引き伸ばす**ので、
 * こちらもそうする。この計算で映像の絵が出ている場所を出し、canvas を
 * そこへ重ねる。ライブは面も映像も 1920x1080 なので、同じ計算で同じ結果になる
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
