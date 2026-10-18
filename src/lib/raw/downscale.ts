/**
 * **コマを小さく縮める** (アンビエントモードの 32x18。`messages.ts` の `grab` の `size`・`glance-worker.ts`)。
 * worker の中で動く。
 *
 * `createImageBitmap` の縮小 (`resizeWidth`) に任せると、1920 から 32 へ一度に縮めるので、どこまで
 * 平均されるかがブラウザと経路しだいになる — GPU の上で mipmap を作らずに縮めると、32x18 の1画素が
 * 元の数画素だけを拾い、放送の雑音や字幕の縁で写すたびに色が変わる (止まった場面でもちらつく)。
 * そこで **半分ずつ縮める**: 2D の canvas に縦横ちょうど半分で描くと、1画素は元の 2x2 のちょうど平均になる
 * (どのブラウザでも、GPU でも)。128 画素幅まで縮めてから、最後は自分で面積で平均する (`boxAverage`)
 */
import type { GrabSize } from './messages';

/** 半分ずつ縮めていく大きさの並び。**幅が `limit` 以下になるまで** (元が既に小さければ空) */
export function halvingSteps(width: number, height: number, limit: number): [number, number][] {
    const steps: [number, number][] = [];
    let w = width;
    let h = height;
    while (w > limit) {
        w = Math.max(1, Math.round(w / 2));
        h = Math.max(1, Math.round(h / 2));
        steps.push([w, h]);
    }
    return steps;
}

/**
 * RGBA を、面積の割合で平均して `outWidth`x`outHeight` に縮める。**元の画素は全部、重なった割合だけ数える** —
 * 点で拾わないので、細かい雑音は平均されて消える
 */
export function boxAverage(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    outWidth: number,
    outHeight: number,
): Uint8ClampedArray<ArrayBuffer> {
    const out = new Uint8ClampedArray(outWidth * outHeight * 4);
    const sx = width / outWidth;
    const sy = height / outHeight;
    for (let oy = 0; oy < outHeight; oy++) {
        const y0 = oy * sy;
        const y1 = y0 + sy;
        for (let ox = 0; ox < outWidth; ox++) {
            const x0 = ox * sx;
            const x1 = x0 + sx;
            const sum = [0, 0, 0, 0];
            let area = 0;
            for (let y = Math.floor(y0); y < Math.min(height, Math.ceil(y1)); y++) {
                const wy = Math.min(y + 1, y1) - Math.max(y, y0);
                for (let x = Math.floor(x0); x < Math.min(width, Math.ceil(x1)); x++) {
                    const weight = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
                    const i = (y * width + x) * 4;
                    for (let c = 0; c < 4; c++) sum[c]! += data[i + c]! * weight;
                    area += weight;
                }
            }
            const o = (oy * outWidth + ox) * 4;
            for (let c = 0; c < 4; c++) out[o + c] = sum[c]! / Math.max(area, 1e-9);
        }
    }
    return out;
}

/** 半分ずつ縮めるのをやめる幅。ここから先は `boxAverage` (128x72 で 9000 画素ほど) */
const HALVING_LIMIT = 128;

/**
 * `source` (`width`x`height`) を `size` に縮める。**描いたのと同じ回のうちに呼ぶこと** — WebGL の面は
 * 回をまたぐと消えている (`worker.ts` の `toPip` と同じ)。最初の1回の `drawImage` までは同期で進む
 */
export async function downscale(
    source: CanvasImageSource,
    width: number,
    height: number,
    size: GrabSize,
): Promise<ImageBitmap | null> {
    let current: CanvasImageSource = source;
    let w = width;
    let h = height;
    for (const [sw, sh] of halvingSteps(width, height, HALVING_LIMIT)) {
        const canvas = new OffscreenCanvas(sw, sh);
        const context = canvas.getContext('2d');
        if (context === null) return null;
        context.imageSmoothingEnabled = true;
        // ちょうど半分なら、線形で拾う1画素が元の 2x2 の真ん中に来て、4画素のちょうど平均になる
        // (奇数の大きさを丸めた回だけは少しずれるが、最後に面積で平均するので残らない)
        context.imageSmoothingQuality = 'low';
        context.drawImage(current, 0, 0, sw, sh);
        current = canvas;
        w = sw;
        h = sh;
    }
    const last = new OffscreenCanvas(w, h);
    const context = last.getContext('2d', { willReadFrequently: true });
    if (context === null) return null;
    context.drawImage(current, 0, 0, w, h);
    const pixels = boxAverage(context.getImageData(0, 0, w, h).data, w, h, size.width, size.height);
    return createImageBitmap(new ImageData(pixels, size.width, size.height));
}
