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
 * ただし中央値の輪郭だけでは、ロゴより強く残るもの (黒帯の縁、滲み残り、出し続ける
 * テロップ) に負けます。そこで**各コマの線の向きが中央値と揃っている割合**を掛け
 * (`steadyEdges`)、ロゴより大きいかたまりは張り合わせず、隣り合うかたまりは括り、
 * 外接枠を中の縁で締めます。実機の 16 本で、前は出せなかった テレ東・BS日テレ・
 * TOKYO MX1・BS-TBS (黒帯) を出せるようになり、出した枠で logoframe が覚えました
 * (`docs/encode.md`「ロゴの在り処はこちらで割り出す」)。
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
 * 選んだかたまりが、上位 1% の縁のうちどれだけを持っているか (ロゴより大きいかたまりの
 * ぶんは数えない)。**届かなければ言い切らない** (その隅は飛ばす。どこも駄目なら `null` で logoframe に任せる)。
 *
 * 外すのは、ロゴと張り合う「動かない縁」が同じ隅にあるときです — 背景の窓枠
 * (MX1)、番組が出し続けるテロップ、動かないセット。中央値にロゴと並んで残るので、
 * **いちばん大きいかたまりが強い縁を独り占めしていません**。当たるときは
 * ロゴがほぼ全部を持っていきます。
 *
 * 実測 (4局9本から散らした 60 コマの組と、続いたコマの窓で 108 回):
 * 当たり 89 回の多くは 0.6 以上、**外れ 19 回は全部 0.46 以下**。0.5 で切ると
 * 外れは 19 → 1 (本番と同じ散らし方では 10 → 0)、当たりは 78 回残りました。
 * `null` なら次の録画でまた割り出すので、**外れた枠を覚えるより安い**。
 * 比 (EDGE_RATIO) では分けられませんでした — ロゴの無い隅でも 4〜6 倍は出ます
 *
 * **向きの揃い方を掛けてからは 0.65。** ロゴのある 15 本 (BS 6局・地上波 6局) は
 * 0.73〜1.00 に上がり、ロゴの無い隅は 0.31 以下のまま。BSテレ東 (番組がずっと出している
 * テロップの帯の飾りがロゴと繋がる) は 0.55 で、ロゴと飾りをまとめた枠になるので出さない
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
 * 枠に足す余白。**文字ぴったりでは覚えられません。**
 *
 * 実測: 文字は 75×30 で、`1310,35,120,55` と `1290,20,140,80` はどちらも
 * 合致 99.9% を出しましたが、広げすぎた `1240,10,190,100` は**合致 0%**
 * でした (有効画素が薄まる)。まわりの背景も見て決めているので、
 * 少し空けるが空けすぎない。
 *
 * **0.3 から 0.15 に詰めた。** 実機の BS日テレ で、0.3 の `1247,47,144,56` は
 * logoframe が `Insufficient full-strength logo frames` で降り、0.15 の
 * `1260,47,118,56` で覚えた。BS-TBS も 0.3 (220 幅) は降り、0.15 (172 幅) で覚えた
 */
const PAD_RATIO = 0.15;
const PAD_MIN = 12;

/** 枠を締めるとき、上下左右それぞれから切り捨ててよい強い縁の割合 */
const TRIM = 0.025;

/** 同じロゴとして括る隣のかたまり: 離れ (画素) と、選んだかたまりに対する縁の多さ */
const MERGE_GAP = 16;
const MERGE_SHARE = 0.1;

/**
 * 真ん中の値。**渡された配列をその場で並べ替えます** (画素ごとに呼ぶので、
 * 写しを作るとそのぶんだけ確保と回収が増える)
 */
function median(values: number[]): number {
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const half = values.length >> 1;
    return values.length % 2 === 0 ? (values[half - 1]! + values[half]!) / 2 : values[half]!;
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

/**
 * コマをまたいだ画素ごとの中央値。**中身が滲んで消え、ロゴだけ残る。**
 * 位置を教える画面にもこのまま出す (薄いロゴでも字が読める。`api/recordings/<id>/logo-still`)
 */
export function medianImage(frames: Frame[], region: Rect, width: number): Float32Array {
    const out = new Float32Array(region.width * region.height);
    const scratch = new Array<number>(frames.length);
    for (let y = 0; y < region.height; y++) {
        for (let x = 0; x < region.width; x++) {
            const at = (region.y + y) * width + region.x + x;
            for (let n = 0; n < frames.length; n++) scratch[n] = frames[n]!.data[at]!;
            out[y * region.width + x] = median(scratch);
        }
    }
    return out;
}

/**
 * Sobel の横と縦。`src[offset + y * stride + x]` を読み、`gx`/`gy` に書く (外周 1 画素は 0)。
 * コマごとに呼ぶので、入れ物は呼ぶ側が使い回す
 */
function sobel(
    src: ArrayLike<number>,
    offset: number,
    stride: number,
    w: number,
    h: number,
    gx: Float32Array,
    gy: Float32Array,
): void {
    for (let y = 1; y < h - 1; y++) {
        const up = offset + (y - 1) * stride;
        const mid = up + stride;
        const down = mid + stride;
        for (let x = 1; x < w - 1; x++) {
            const a = src[up + x - 1]!;
            const b = src[up + x]!;
            const c = src[up + x + 1]!;
            const d = src[mid + x - 1]!;
            const f = src[mid + x + 1]!;
            const g = src[down + x - 1]!;
            const i = src[down + x]!;
            const j = src[down + x + 1]!;
            gx[y * w + x] = c + 2 * f + j - a - 2 * d - g;
            gy[y * w + x] = g + 2 * i + j - a - 2 * b - c;
        }
    }
}

/** 1コマで、これより弱い勾配は向きを数えない (のっぺりした所の揺らぎ) */
const STEADY_FLOOR = 4;
/** 向きが揃っているとみなす cos。ロゴは明るさが逆になっても線の向きは同じなので、符号は見ない */
const STEADY_COS = 0.9;

/**
 * **縁の強さ × 向きの揃い方²。**
 *
 * 中央値の輪郭だけだと、ロゴより強く残るものに負けます。実機では
 * 映画の黒帯の縁 (BS-TBS)、中身の滲み残り (テレ東・BS日テレ・TOKYO MX1。輪郭は
 * あるが弱く、上位 1% を取り切れない)、番組が出し続けるテロップの帯 (BSテレ東)。
 *
 * そこで、**各コマの勾配の向きが中央値の勾配の向きと揃っているコマの割合**を掛けます。
 * ロゴは後ろが何であれ毎コマ同じ所に同じ向きの線を出すので、割合が 1 に近い。
 * 滲み残りは中央値にたまたま残った線なので、各コマの向きはばらばら。
 * テロップや黒帯は出ている間だけ揃うので、出ていない場面のぶん下がる。
 * 二乗するのは、半分しか揃わないもの (場面の半分に出るテロップ) を 1/4 まで沈めるため
 */
function steadyEdges(frames: Frame[], region: Rect, width: number, median: Float32Array): Float32Array {
    const { width: w, height: h } = region;
    const size = w * h;
    const mx = new Float32Array(size);
    const my = new Float32Array(size);
    sobel(median, 0, w, w, h, mx, my);
    const magnitude = new Float32Array(size);
    for (let at = 0; at < size; at++) magnitude[at] = Math.hypot(mx[at]!, my[at]!);

    const count = new Uint16Array(size);
    const fx = new Float32Array(size);
    const fy = new Float32Array(size);
    const floor = STEADY_FLOOR * STEADY_FLOOR;
    const cos = STEADY_COS * STEADY_COS;
    for (const frame of frames) {
        sobel(frame.data, region.y * width + region.x, width, w, h, fx, fy);
        for (let at = 0; at < size; at++) {
            const m = magnitude[at]!;
            if (m === 0) continue;
            const x = fx[at]!;
            const y = fy[at]!;
            const f = x * x + y * y;
            if (f < floor) continue;
            // |cos| >= STEADY_COS を、平方根を取らずに比べる
            const dot = x * mx[at]! + y * my[at]!;
            if (dot * dot >= cos * f * m * m) count[at]!++;
        }
    }
    const out = new Float32Array(size);
    for (let at = 0; at < size; at++) {
        const share = count[at]! / frames.length;
        out[at] = magnitude[at]! * share * share;
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
 * logoframe が覚えても合致 0% だった (108×54 なら 88%)
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
    const first = frames[0];
    if (frames.length < MIN_FRAMES || first === undefined) return null;
    const { width, height } = first;
    if (width <= 0 || height <= 0) return null;
    if (frames.some((frame) => frame.width !== width || frame.height !== height)) return null;

    for (const corner of CORNERS) {
        const region = regionOf(corner, width, height);
        const strength = steadyEdges(frames, region, width, medianImage(frames, region, width));

        const sorted = Array.from(strength).sort((a, b) => a - b);
        const middle = sorted[Math.floor(sorted.length * 0.5)]!;
        const limit = sorted[Math.floor(sorted.length * (1 - EDGE_TOP))]!;
        // ロゴを出していない隅では、上位 1% も中央値とたいして変わらない
        if (limit < EDGE_FLOOR || limit < middle * EDGE_RATIO) continue;

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
        if (best === null) continue;

        /*
         * **すぐ隣のかたまりは同じロゴとして括る。** テレビ朝日 のロゴは図形と文字が
         * 縦に離れていて、文字だけの枠では logoframe が覚えられなかった (両方入れると覚える)
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
        if (strong < rivals * EDGE_SHARE) continue;

        const core = trim(mask, region.width, rect);
        return padded({ ...core, x: core.x + region.x, y: core.y + region.y }, width, height);
    }
    return null;
}

/** `-logo-area` に渡す形。`services.logo_area` に入るのもこの形 */
export function areaText(rect: Rect): string {
    return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}
