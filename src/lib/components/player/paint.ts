/**
 * 字幕を映像の上に重ねる。**ライブと観る画面で同じもの。**
 *
 * どちらも「映像の画素そのままの大きさの canvas を敷いて、放送が言う座標に
 * 絵を置き、CSS で伸ばす」という同じやり方をしています。**位置合わせは
 * ブラウザ任せ** (`object-contain`) で、こちらは放送の座標をそのまま使う —
 * **左右の位置がそのまま出る**のはこのためです。
 *
 * ## 絵の作り方だけが違う
 *
 * | | どこから来るか | なぜ |
 * | --- | --- | --- |
 * | ライブ | ffmpeg が組んだ PNG | **画素をこちらへ流さずに済む。** 生の RGBA は30秒で406MB・1.94秒、PNG なら 1.76MB・1.05秒 ([stream.md](../../../../docs/stream.md) §5.2) |
 * | 観る画面 | 焼いたものに入っている PGS | **既にそこに在る。** 抜くのは実測 0.1〜1秒で、ブラウザ側で解く ([pgs.ts](../../pgs.ts)) |
 *
 * ffmpeg に PGS の符号器が無いので、ライブを PGS に揃えるには**生の画素を
 * 流し直す**ことになります (上の 406MB)。逆に観る画面を PNG に揃えるには、
 * 観るたびに焼き直すことになる。**format は出どころで決まる**ので、
 * 揃えられるのは「置き方」のほうだけでした。
 */

/** 重ねる1枚。置く場所は**映像の画素**で数える */
export interface Overlay {
    /** 画面のどこに置くか */
    x: number;
    y: number;
    /** 元の映像の大きさ。canvas をこの大きさにする */
    videoWidth: number;
    videoHeight: number;
    /** 絵そのもの */
    source: CanvasImageSource | ImageData;
}

/** 何も出さない。**消し忘れると次の字幕まで残る** */
export function clearOverlay(canvas: HTMLCanvasElement | null): void {
    const ctx = canvas?.getContext('2d');
    if (ctx === null || ctx === undefined || canvas === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * 1枚を置く。**canvas の大きさは映像に合わせる** (見た目の大きさではない)。
 *
 * 見た目に合わせて敷くと、全画面にした瞬間に字幕だけ引き伸ばされて粗くなる。
 * 映像の画素で敷いておけば、伸ばすのはブラウザの仕事になる
 */
export function drawOverlay(canvas: HTMLCanvasElement | null, overlay: Overlay | null): void {
    if (canvas === null) return;
    if (overlay === null) {
        clearOverlay(canvas);
        return;
    }
    if (canvas.width !== overlay.videoWidth || canvas.height !== overlay.videoHeight) {
        canvas.width = overlay.videoWidth;
        canvas.height = overlay.videoHeight;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (overlay.source instanceof ImageData) {
        // **`putImageData` は重ねずに置き換える。** 透明なところも上書きされるが、
        // 直前に全部消しているので同じこと
        ctx.putImageData(overlay.source, overlay.x, overlay.y);
        return;
    }
    ctx.drawImage(overlay.source, overlay.x, overlay.y);
}

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
