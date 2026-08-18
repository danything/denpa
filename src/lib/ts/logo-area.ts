/**
 * **ロゴの在り処を、録れた絵そのものから割り出す。** DOM もファイルも触らない。
 *
 * logoframe も自分で位置を探しますが、**画面全体から「恒常的な縁」を拾う**ので、
 * テレ東の実素材では家具の縁 (`1004,216`) を掴んで
 * `The initial logo estimate contains too few active pixels` で降りていました。
 * 半透明の細い白文字より強い縁は、画面のどこかに必ずあります。
 *
 * こちらが勝てるのは、logoframe に渡していない前提を1つ使えるからです —
 * **透かしは隅にしか出ません。** 画面全体を探す必要がない。
 *
 * ## 探し方: コマをまたいだ中央値に、輪郭が残る
 *
 * 番組のあちこちからコマを集めて**画素ごとの中央値**を取ると、中身は場面ごとに
 * 変わるので滲んで消え、**毎コマ同じ所に重なっているロゴだけが輪郭を保ちます**。
 * その中央値画像に Sobel をかけ、**いちばん強い縁 1% のかたまり**を取れば、
 * それがロゴです (実測でロゴがはっきり読める絵が残ります)。
 *
 * **「動かなさ」では駄目でした。** 半透明の重ねは `画素 = (1-α)×中身 + α×ロゴ色`
 * なので振れ幅が縮む — という筋で MAD を測りましたが、実素材ではロゴの所が
 * `46.4`、隅全体の中央値が `60.5` と**差が小さすぎて**分けられません
 * (テレ東は α が小さい)。CM の間はロゴが消えるぶんも効きません。
 * 中央値に残る輪郭のほうが、薄いロゴでもはっきり出ます。
 *
 * 出すのは `-logo-area` に渡す4数字だけです。**当てるのは位置で、ロゴそのものの
 * 判定は logoframe に任せます** — 位置さえ渡せば合致 99.9% が出るので、
 * あちらを置き換える理由がありません。
 */

/** コマ1枚の明るさ。幅×高さぶんの 8bit グレースケール */
export interface Frame {
    width: number;
    height: number;
    data: Uint8Array;
}

/** 見つけた枠。そのまま `-logo-area x,y,w,h` になる */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 探す隅。**右上から見ます** — 国内の地上波はほぼここ。
 * 決め打ちにしないのは、確かめられたのが手元の局だけだからです
 */
const CORNERS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const;

/** 隅として見る範囲。横は 1/3、縦は 1/5 まで */
const REGION_W = 1 / 3;
const REGION_H = 1 / 5;

/** これだけコマが無いと中央値が当てにならない */
const MIN_FRAMES = 16;

/**
 * 縁として拾う強さ。隅の中での上位いくら。
 *
 * 実測 (テレ東・152コマ): 上位 1% で `1315,42,88,55` と目視どおり。
 * **2% まで緩めると中身の滲み**を掴みました (`987,0,150,106`)
 */
const EDGE_TOP = 0.01;

/**
 * 「そもそも縁があるか」の境目。上位 1% が、隅の中央値の何倍あるか。
 *
 * ロゴを出していない局・時間帯でも上位 1% は必ず取れてしまうので、
 * **強さそのもの**で門を作る。実測ではロゴありで 4.6 倍 (36.1 / 7.8)
 */
const EDGE_RATIO = 3;

/** 隅がのっぺりしている (ロゴも中身も無い) ときに拾わないための下限 */
const EDGE_FLOOR = 2;

/**
 * 縁を太らせる幅。**文字の画数どうしを繋ぐため。**
 *
 * 繋がないと「テ」「レ」「東」が別のかたまりになり、いちばん大きい1画だけの
 * 枠になります
 */
const DILATE = 4;

/**
 * ロゴとして受け取る大きさ。画面に対する比。
 *
 * テレ東の実測は 1440 幅で 75×30 (5.2% × 2.8%) でここに収まります
 */
const MIN_W = 0.02;
const MAX_W = 0.15;
const MIN_H = 0.015;
const MAX_H = 0.1;

/**
 * 枠に足す余白。**文字ぴったりでは覚えられません。**
 *
 * 実測: 文字は 75×30 で、`1310,35,120,55` と `1290,20,140,80` はどちらも
 * 合致 99.9% を出しましたが、広げすぎた `1240,10,190,100` は**合致 0%**
 * でした (有効画素が薄まる)。まわりの背景も見て決めているので、
 * 少し空けるが空けすぎない
 */
const PAD_RATIO = 0.3;
const PAD_MIN = 12;

/**
 * 真ん中の値。**渡された配列をその場で並べ替えます** (画素ごとに呼ぶので、
 * 写しを作るとそのぶんだけ確保と回収が増える)
 */
function median(values: number[]): number {
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const half = values.length >> 1;
    return values.length % 2 === 0 ? (values[half - 1] + values[half]) / 2 : values[half];
}

/** 隅の範囲。`width`/`height` はコマの大きさ */
function regionOf(corner: (typeof CORNERS)[number], width: number, height: number): Rect {
    const w = Math.round(width * REGION_W);
    const h = Math.round(height * REGION_H);
    return {
        x: corner === 'top-right' || corner === 'bottom-right' ? width - w : 0,
        y: corner === 'top-left' || corner === 'top-right' ? 0 : height - h,
        width: w,
        height: h,
    };
}

/** コマをまたいだ画素ごとの中央値。**中身が滲んで消え、ロゴだけ残る** */
function medianImage(frames: Frame[], region: Rect, width: number): Float32Array {
    const out = new Float32Array(region.width * region.height);
    const scratch = new Array<number>(frames.length);
    for (let y = 0; y < region.height; y++) {
        for (let x = 0; x < region.width; x++) {
            const at = (region.y + y) * width + region.x + x;
            for (let n = 0; n < frames.length; n++) scratch[n] = frames[n].data[at];
            out[y * region.width + x] = median(scratch);
        }
    }
    return out;
}

/** 中央値画像の勾配 (Sobel)。輪郭の強さ */
function edges(image: Float32Array, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const at = (xx: number, yy: number) => image[yy * w + xx];
            const gx =
                -at(x - 1, y - 1) -
                2 * at(x - 1, y) -
                at(x - 1, y + 1) +
                at(x + 1, y - 1) +
                2 * at(x + 1, y) +
                at(x + 1, y + 1);
            const gy =
                -at(x - 1, y - 1) -
                2 * at(x, y - 1) -
                at(x + 1, y - 1) +
                at(x - 1, y + 1) +
                2 * at(x, y + 1) +
                at(x + 1, y + 1);
            out[y * w + x] = Math.hypot(gx, gy);
        }
    }
    return out;
}

/** 印を太らせて、近いものどうしを繋ぐ */
function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (mask[y * w + x] === 0) continue;
            for (let dy = -radius; dy <= radius; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -radius; dx <= radius; dx++) {
                    const xx = x + dx;
                    if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
                }
            }
        }
    }
    return out;
}

/**
 * 繋がっているかたまりのうち、いちばん大きいものの外接枠。
 *
 * かたまりで見るのは、**ロゴは一箇所にまとまっている**ため。散らばった縁を
 * 1つの枠に括ると、枠が隅いっぱいに広がります
 */
function largestBlob(mask: Uint8Array, w: number, h: number): Rect | null {
    const seen = new Uint8Array(mask.length);
    let best: Rect | null = null;
    let bestCount = 0;
    const stack: number[] = [];
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] === 0 || seen[start] === 1) continue;
        stack.push(start);
        seen[start] = 1;
        let count = 0;
        let minX = w;
        let maxX = -1;
        let minY = h;
        let maxY = -1;
        while (stack.length > 0) {
            const at = stack.pop() as number;
            const x = at % w;
            const y = (at / w) | 0;
            count++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            // 上下左右だけ。斜めまで繋ぐと、隣の縁と橋が架かる
            for (const next of [
                x > 0 ? at - 1 : -1,
                x < w - 1 ? at + 1 : -1,
                y > 0 ? at - w : -1,
                y < h - 1 ? at + w : -1,
            ]) {
                if (next < 0 || seen[next] === 1 || mask[next] === 0) continue;
                seen[next] = 1;
                stack.push(next);
            }
        }
        if (count > bestCount) {
            bestCount = count;
            best = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
        }
    }
    return best;
}

/** 太らせたぶんを削る。潰れないよう最低 1 画素は残す */
function deflate(rect: Rect, by: number): Rect {
    const width = Math.max(1, rect.width - by * 2);
    const height = Math.max(1, rect.height - by * 2);
    return {
        x: rect.x + Math.round((rect.width - width) / 2),
        y: rect.y + Math.round((rect.height - height) / 2),
        width,
        height,
    };
}

/** 余白を足して、コマからはみ出さないところまで戻す */
function padded(rect: Rect, width: number, height: number): Rect {
    const px = Math.max(PAD_MIN, Math.round(rect.width * PAD_RATIO));
    const py = Math.max(PAD_MIN, Math.round(rect.height * PAD_RATIO));
    const x = Math.max(0, rect.x - px);
    const y = Math.max(0, rect.y - py);
    return {
        x,
        y,
        // はみ出すと logoframe が `The specified logo area is outside the video` で降りる
        width: Math.min(width - x, rect.width + px * 2),
        height: Math.min(height - y, rect.height + py * 2),
    };
}

/**
 * ロゴの在り処を割り出す。見つからなければ `null` (今までどおり logoframe に任せる)。
 *
 * コマは**同じ大きさのグレースケール**で、番組のあちこちから散らして渡します。
 * 固まった所だけ渡すと中身が滲みきらず、その場面の輪郭がロゴとして残ります
 * (実素材で、90秒ぶんだけ渡したときに実際に外しました)。
 */
export function findLogoArea(frames: Frame[]): Rect | null {
    if (frames.length < MIN_FRAMES) return null;
    const { width, height } = frames[0];
    if (width <= 0 || height <= 0) return null;
    if (frames.some((frame) => frame.width !== width || frame.height !== height)) return null;

    for (const corner of CORNERS) {
        const region = regionOf(corner, width, height);
        const strength = edges(medianImage(frames, region, width), region.width, region.height);

        const sorted = Array.from(strength).sort((a, b) => a - b);
        const middle = sorted[Math.floor(sorted.length * 0.5)];
        const limit = sorted[Math.floor(sorted.length * (1 - EDGE_TOP))];
        // ロゴを出していない隅では、上位 1% も中央値とたいして変わらない
        if (limit < EDGE_FLOOR || limit < middle * EDGE_RATIO) continue;

        const mask = new Uint8Array(strength.length);
        for (let at = 0; at < strength.length; at++) mask[at] = strength[at] >= limit ? 1 : 0;

        const found = largestBlob(
            dilate(mask, region.width, region.height, DILATE),
            region.width,
            region.height,
        );
        if (found === null) continue;

        /*
         * **太らせたぶんを戻す。** 外接枠は「縁を繋ぐために広げた幅」と
         * 「Sobel が縁の外側にも出す1画素」のぶんだけ大きくなっているので、
         * そのまま大きさを見ると本物より太って見え、余白もそのぶん過剰になる
         */
        const blob = deflate(found, DILATE + 1);
        if (blob.width < width * MIN_W || blob.width > width * MAX_W) continue;
        if (blob.height < height * MIN_H || blob.height > height * MAX_H) continue;

        return padded({ ...blob, x: blob.x + region.x, y: blob.y + region.y }, width, height);
    }
    return null;
}

/** `-logo-area` に渡す形。`services.logo_area` に入るのもこの形 */
export function areaText(rect: Rect): string {
    return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}
