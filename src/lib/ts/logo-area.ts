/**
 * **隅の「縁の強さ」から、ロゴの在り処を選ぶ。** DOM もファイルも触らない。
 *
 * 強さの測り方は呼ぶ側 (`logo-detect.findArea`。線の向きが毎コマ揃う割合) が決め、
 * ここはかたまりの選び方だけを持つ。**透かしは隅にしか出ない**ので、画面全体は探さない。
 *
 * - 上位 1% の縁を太らせて繋ぎ、かたまりにする (文字の画数どうしを繋ぐ)
 * - ロゴより大きいかたまり (テロップの帯・黒帯の縁) は張り合わせない
 * - すぐ隣のかたまりは同じロゴとして括る (図形と文字が離れているロゴ)
 * - 選んだかたまりが強い縁の大半を持っていなければ言い切らない (`EDGE_SHARE`)
 * - 外接枠を中の縁で締め、少しだけ余白を足す
 *
 * 経緯と実測は `docs/encode.md`「在り処の割り出し」。
 */

/** 見つけた枠 (コマの座標) */
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
export const CORNERS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const;
export type Corner = (typeof CORNERS)[number];

/** 隅として見る範囲。横は 1/3、縦は 1/5 まで */
const REGION_W = 1 / 3;
const REGION_H = 1 / 5;

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

/**
 * 選んだかたまりが、上位 1% の縁のうちどれだけを持っているか (ロゴより大きいかたまりの
 * ぶんは数えない)。**届かなければ言い切らない** (その隅は飛ばす。どこも駄目なら `null` で、
 * その録画は覚えずに無音検出へ落ちる)。
 *
 * 外すのは、ロゴと張り合う「動かない縁」が同じ隅にあるときです — 背景の窓枠
 * (MX1)、番組が出し続けるテロップ、動かないセット。**いちばん大きいかたまりが
 * 強い縁を独り占めしていません**。当たるときはロゴがほぼ全部を持っていきます。
 * `null` なら次の録画でまた割り出すので、**外れた枠を覚えるより安い**。
 * 比 (EDGE_RATIO) では分けられませんでした — ロゴの無い隅でも 4〜6 倍は出ます
 */
const EDGE_SHARE = 0.65;

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
 * 枠に足す余白。少し空けるが空けすぎない (締めたぶんの縁の端を取りこぼさない /
 * ロゴではない縁を型に入れない)。
 *
 * 0.15 は logoframe に枠を渡していた頃に実機で詰めた値 (0.3 では BS日テレ・BS-TBS で
 * 覚えられなかった)。自前の型は枠の中の縁だけで作るので、その値のまま使っている
 */
const PAD_RATIO = 0.15;
const PAD_MIN = 12;

/** 枠を締めるとき、上下左右それぞれから切り捨ててよい強い縁の割合 */
const TRIM = 0.025;

/** 同じロゴとして括る隣のかたまり: 離れ (画素) と、選んだかたまりに対する縁の多さ */
const MERGE_GAP = 16;
const MERGE_SHARE = 0.1;

/** 隅の範囲。`width`/`height` はコマの大きさ */
export function regionOf(corner: Corner, width: number, height: number): Rect {
    const w = Math.round(width * REGION_W);
    const h = Math.round(height * REGION_H);
    return {
        x: corner === 'top-right' || corner === 'bottom-right' ? width - w : 0,
        y: corner === 'top-left' || corner === 'top-right' ? 0 : height - h,
        width: w,
        height: h,
    };
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
 * 繋がっているかたまり**全部**の外接枠と、そこに入った太らせる前の縁の数 (`strong`)。
 *
 * かたまりで見るのは、**ロゴは一箇所にまとまっている**ため。散らばった縁を
 * 1つの枠に括ると、枠が隅いっぱいに広がります
 */
function blobs(mask: Uint8Array, strong: Uint8Array, w: number, h: number): { rect: Rect; strong: number }[] {
    const seen = new Uint8Array(mask.length);
    const found: { rect: Rect; strong: number }[] = [];
    const stack: number[] = [];
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] === 0 || seen[start] === 1) continue;
        stack.push(start);
        seen[start] = 1;
        let own = 0;
        let minX = w;
        let maxX = -1;
        let minY = h;
        let maxY = -1;
        while (stack.length > 0) {
            const at = stack.pop() as number;
            const x = at % w;
            const y = (at / w) | 0;
            own += strong[at]!;
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
        found.push({
            rect: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
            strong: own,
        });
    }
    return found;
}

/**
 * かたまりの枠を、**中の強い縁の 95% が収まるところまで**締める (上下左右から 2.5% ずつ)。
 *
 * 太らせて繋いだかたまりには、ロゴの縁に触れた滲み残りがぶら下がる。外接枠のままだと
 * 実機の BS日テレ で 100×66 (ロゴは 85×30 ほど) になり、余白を足した 160×106 では
 * 当てても合致しなかった (logoframe に渡していた頃。108×54 なら 88%)
 */
function trim(mask: Uint8Array, w: number, rect: Rect): Rect {
    const cols = new Array<number>(rect.width).fill(0);
    const rows = new Array<number>(rect.height).fill(0);
    let total = 0;
    for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
            if (mask[(rect.y + y) * w + rect.x + x] === 0) continue;
            cols[x]!++;
            rows[y]!++;
            total++;
        }
    }
    const span = (counts: number[]): [number, number] => {
        const cut = total * TRIM;
        let from = 0;
        for (let sum = 0; from < counts.length - 1 && sum + counts[from]! <= cut; from++)
            sum += counts[from]!;
        let to = counts.length - 1;
        for (let sum = 0; to > from && sum + counts[to]! <= cut; to--) sum += counts[to]!;
        return [from, to];
    };
    const [x0, x1] = span(cols);
    const [y0, y1] = span(rows);
    return { x: rect.x + x0, y: rect.y + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** 2つの枠の離れ (重なっていれば 0) */
function gap(a: Rect, b: Rect): number {
    const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
    const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
    return Math.max(dx, dy);
}

function union(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
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
        // コマからはみ出すと切り出せない
        width: Math.min(width - x, rect.width + px * 2),
        height: Math.min(height - y, rect.height + py * 2),
    };
}

/**
 * 隅の「縁の強さ」から、ロゴのかたまりを選んで枠にする。言い切れなければ `null`。
 *
 * 強さの測り方は呼ぶ側が決める (`logo-detect.findArea` では線の
 * 向きの揃い方そのもの)。`floor` はその尺度での「縁がある」下限。
 * 返す枠はコマの座標で、余白を足してある
 */
export function pickArea(
    strength: Float32Array,
    region: Rect,
    width: number,
    height: number,
    floor: number,
): Rect | null {
    const sorted = Array.from(strength).sort((a, b) => a - b);
    const middle = sorted[Math.floor(sorted.length * 0.5)]!;
    const limit = sorted[Math.floor(sorted.length * (1 - EDGE_TOP))]!;
    // ロゴを出していない隅では、上位 1% も中央値とたいして変わらない
    if (limit < floor || limit < middle * EDGE_RATIO) return null;

    const mask = new Uint8Array(strength.length);
    for (let at = 0; at < strength.length; at++) mask[at] = strength[at]! >= limit ? 1 : 0;

    /*
     * **太らせたぶんを戻す。** 外接枠は「縁を繋ぐために広げた幅」と
     * 「Sobel が縁の外側にも出す1画素」のぶんだけ大きくなっているので、
     * そのまま大きさを見ると本物より太って見え、余白もそのぶん過剰になる
     */
    const found = blobs(
        dilate(mask, region.width, region.height, DILATE),
        mask,
        region.width,
        region.height,
    ).map((blob) => ({ ...blob, rect: deflate(blob.rect, DILATE + 1) }));
    /*
     * **ロゴより大きいかたまりは、ロゴと張り合わない。** いちばん大きいかたまりだけを
     * 見ていた頃は、BSテレ東 でテロップの帯の下の線 (343×9) を選んで大きさで弾き、
     * 隣にあるロゴを見ずに諦めていた。帯・黒帯の縁は画面の幅ほどあるので、ここで除ける
     */
    const tooBig = (r: Rect) => r.width > width * MAX_W || r.height > height * MAX_H;
    const fits = (r: Rect) => !tooBig(r) && r.width >= width * MIN_W && r.height >= height * MIN_H;
    let rivals = 0;
    let best: { rect: Rect; strong: number } | null = null;
    for (const blob of found) {
        if (tooBig(blob.rect)) continue;
        rivals += blob.strong;
        if (fits(blob.rect) && (best === null || blob.strong > best.strong)) best = blob;
    }
    if (best === null) return null;

    /*
     * **すぐ隣のかたまりは同じロゴとして括る。** テレビ朝日 のロゴは図形と文字が
     * 縦に離れていて、文字だけの枠では覚えられなかった (両方入れると覚える)
     */
    let rect = best.rect;
    let strong = best.strong;
    for (const blob of found) {
        if (blob === best || tooBig(blob.rect) || blob.strong < best.strong * MERGE_SHARE) continue;
        if (gap(rect, blob.rect) > MERGE_GAP) continue;
        const merged = union(rect, blob.rect);
        if (!fits(merged)) continue;
        rect = merged;
        strong += blob.strong;
    }
    // 強い縁が隅のあちこちに散っている。ロゴと言い切れない (EDGE_SHARE)
    if (strong < rivals * EDGE_SHARE) return null;

    const core = trim(mask, region.width, rect);
    return padded({ ...core, x: core.x + region.x, y: core.y + region.y }, width, height);
}
