import { CORNERS, pickArea, type Rect, regionOf } from './logo-area';

/**
 * **局ロゴを自分で覚えて、どのコマに出ているかを当てる。** 以前は logoframe に任せていた。
 *
 * logoframe はロゴを「色と濃さ (α)」で覚えていました。濃さを測るには**ロゴの後ろが
 * のっぺりしたコマ**が要り、BSテレ東 のように後ろが明るいセットばかりの局では
 * `initial logo estimate contains too few active pixels` で降りていました (`docs/encode.md`)。
 *
 * こちらが覚えるのは**線の向き**だけです。ロゴは後ろが何であれ毎コマ同じ所に同じ向きの
 * 縁を出し、中身の縁の向きはコマごとにばらばら。画素ごとに勾配の向きを足し合わせると、
 * ロゴの縁だけ長さが残ります (`coherence`)。濃さも色も測らないので、後ろがのっぺり
 * している必要がありません。
 *
 * - **向きは角を倍にして足す。** 明るいロゴが暗い所にも明るい所にも乗るので、
 *   勾配の符号は場面で反転する。倍角なら θ と θ+π が同じ向きになる
 * - **足し合わせたまま持つ** (`Orientation`)。録画をまたいで足せるので、局ごとに
 *   育てられる。番組が出し続けるテロップは別の番組で薄まる
 * - **当てるときは、覚えた縁の向きが何割そろうか**を見る (`score`)。後ろの柄が
 *   たまたま揃うぶんは、同じ型を斜めにずらした所で測って差し引く
 *
 * DOM もファイルも触らない純粋な計算。コマを抜くのは `server/logo-own.ts`。
 */

/**
 * 画素ごとの「線の向き」の和。**角を倍にした単位ベクトル**を足したもの。
 * `count` で割った長さが向きの揃い方 (0〜1)
 */
export interface Orientation {
    width: number;
    height: number;
    /** 足したコマの数 (縁の無かった画素も、そのコマは数える) */
    count: number;
    sx: Float32Array;
    sy: Float32Array;
}

/** 局ごとに覚えるもの。録画をまたいで足していく */
export interface LogoModel {
    /** 覚えたときのコマの大きさ。違う大きさの録画には当てない */
    frameWidth: number;
    frameHeight: number;
    /** ロゴを含む枠 (コマの座標)。`orientation` はこの大きさ */
    rect: Rect;
    orientation: Orientation;
}

/** これより弱い勾配は向きを数えない (のっぺりした所の揺らぎと、MPEG のブロックの縁) */
const GRADIENT_FLOOR = 16;

export function emptyOrientation(width: number, height: number): Orientation {
    return {
        width,
        height,
        count: 0,
        sx: new Float32Array(width * height),
        sy: new Float32Array(width * height),
    };
}

/**
 * 1コマぶん足す。`src[offset + y * stride + x]` が `o` の (x, y)。
 * 外周 1 画素は Sobel が掛けられないので足さない
 */
export function addFrame(o: Orientation, src: Uint8Array, offset: number, stride: number): void {
    const { width: w, height: h, sx, sy } = o;
    const floor = GRADIENT_FLOOR * GRADIENT_FLOOR;
    for (let y = 1; y < h - 1; y++) {
        const up = offset + (y - 1) * stride;
        const mid = up + stride;
        const down = mid + stride;
        for (let x = 1; x < w - 1; x++) {
            const a = src[up + x - 1]!;
            const c = src[up + x + 1]!;
            const g = src[down + x - 1]!;
            const j = src[down + x + 1]!;
            const gx = c + 2 * src[mid + x + 1]! + j - a - 2 * src[mid + x - 1]! - g;
            const gy = g + 2 * src[down + x]! + j - a - 2 * src[up + x]! - c;
            const m = gx * gx + gy * gy;
            if (m < floor) continue;
            const at = y * w + x;
            sx[at]! += (gx * gx - gy * gy) / m;
            sy[at]! += (2 * gx * gy) / m;
        }
    }
    o.count++;
}

/** 向きの揃い方 (0〜1)。ロゴの縁は「ロゴが出ていたコマの割合」に近く、中身は 0 に近い */
export function coherence(o: Orientation): Float32Array {
    const out = new Float32Array(o.width * o.height);
    if (o.count === 0) return out;
    for (let at = 0; at < out.length; at++) out[at] = Math.hypot(o.sx[at]!, o.sy[at]!) / o.count;
    return out;
}

/** 一部を切り出す (`rect` は `o` の中の座標) */
export function cropOrientation(o: Orientation, rect: Rect): Orientation {
    const out = emptyOrientation(rect.width, rect.height);
    out.count = o.count;
    for (let y = 0; y < rect.height; y++) {
        const from = (rect.y + y) * o.width + rect.x;
        out.sx.set(o.sx.subarray(from, from + rect.width), y * rect.width);
        out.sy.set(o.sy.subarray(from, from + rect.width), y * rect.width);
    }
    return out;
}

/** 揃い方の「縁がある」下限。中身だけの所は実測で上位 1% でも 0.07 */
const AREA_FLOOR = 0.15;

/**
 * 隅の帯から、ロゴの在り処を割り出す。
 *
 * `bands` は上と下の帯 (幅はコマと同じ、高さはどちらも同じ)。かたまりの選び方は
 * `logo-area.pickArea` で、強さに揃い方を使う
 */
export function findArea(
    bands: { top: Orientation; bottom: Orientation },
    frameWidth: number,
    frameHeight: number,
): Rect | null {
    for (const corner of CORNERS) {
        const region = regionOf(corner, frameWidth, frameHeight);
        const top = corner.startsWith('top');
        const band = top ? bands.top : bands.bottom;
        const y = top ? region.y : region.y - (frameHeight - band.height);
        if (y < 0 || y + region.height > band.height) continue;
        const strength = coherence(cropOrientation(band, { ...region, y }));
        const rect = pickArea(strength, region, frameWidth, frameHeight, AREA_FLOOR);
        if (rect !== null) return rect;
    }
    return null;
}

/**
 * 覚えたものに、この録画のぶんを足す。
 *
 * **古いぶんは薄めていく** (`MAX_COUNT` を超えたら比で縮める)。局がロゴを替えたとき
 * (特番の飾りつき・周年のロゴ) に、いつまでも前のロゴが残らないように
 */
const MAX_COUNT = 6000;

export function mergeModel(base: LogoModel, add: Orientation): LogoModel {
    const o = base.orientation;
    if (add.width !== o.width || add.height !== o.height) return base;
    const total = o.count + add.count;
    const keep = total > MAX_COUNT ? Math.max(0, MAX_COUNT - add.count) / Math.max(1, o.count) : 1;
    const out = emptyOrientation(o.width, o.height);
    for (let at = 0; at < out.sx.length; at++) {
        out.sx[at] = o.sx[at]! * keep + add.sx[at]!;
        out.sy[at] = o.sy[at]! * keep + add.sy[at]!;
    }
    out.count = Math.round(o.count * keep) + add.count;
    return { ...base, orientation: out };
}

/** ロゴの縁として型に入れる揃い方: いちばん揃う所 (上位 2%) の半分、かつこれ以上 */
const TEMPLATE_FLOOR = 0.15;
const TEMPLATE_PEAK = 0.02;
/** 型の画素がこれより少なければ、覚えたとは言わない */
const TEMPLATE_MIN = 40;
/** 後ろの柄を測るためにずらす幅。文字の太さより大きく */
const SHIFT = 6;

/** 当てるための型。`crop` を切り出したコマに対して `points` の画素を見る */
export interface Template {
    /** 切り出す枠 (コマの座標)。ずらして測るぶんの余白を含む */
    crop: Rect;
    /** 見る画素 (`crop` の中の添字) と、そこでの向き (倍角の単位ベクトル) */
    points: Int32Array;
    ux: Float32Array;
    uy: Float32Array;
}

export function makeTemplate(model: LogoModel): Template | null {
    const { rect, frameWidth, frameHeight } = model;
    const r = coherence(model.orientation);
    const sorted = Array.from(r).sort((a, b) => b - a);
    const peak = sorted[Math.floor(sorted.length * TEMPLATE_PEAK)] ?? 0;
    const limit = Math.max(TEMPLATE_FLOOR, peak / 2);

    const margin = SHIFT + 1;
    const x0 = Math.max(0, rect.x - margin);
    const y0 = Math.max(0, rect.y - margin);
    const crop = {
        x: x0,
        y: y0,
        width: Math.min(frameWidth, rect.x + rect.width + margin) - x0,
        height: Math.min(frameHeight, rect.y + rect.height + margin) - y0,
    };
    const points: number[] = [];
    const ux: number[] = [];
    const uy: number[] = [];
    const { sx, sy, width } = model.orientation;
    for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
            const at = y * width + x;
            if (r[at]! < limit) continue;
            // ずらした所も Sobel が掛けられる所だけ
            const cx = rect.x + x - crop.x;
            const cy = rect.y + y - crop.y;
            if (
                cx - SHIFT < 1 ||
                cy - SHIFT < 1 ||
                cx + SHIFT >= crop.width - 1 ||
                cy + SHIFT >= crop.height - 1
            )
                continue;
            const len = Math.hypot(sx[at]!, sy[at]!);
            points.push(cy * crop.width + cx);
            ux.push(sx[at]! / len);
            uy.push(sy[at]! / len);
        }
    }
    if (points.length < TEMPLATE_MIN) return null;
    return { crop, points: Int32Array.from(points), ux: Float32Array.from(ux), uy: Float32Array.from(uy) };
}

/** 向きが揃っているとみなす、倍角での cos。元の角で ±26° (|cos| ≥ 0.9) */
const MATCH_COS2 = 2 * 0.9 * 0.9 - 1;

/** 型を `dx, dy` ずらして、向きの合う画素の割合を数える */
function agree(t: Template, data: Uint8Array, dx: number, dy: number): number {
    const w = t.crop.width;
    const shift = dy * w + dx;
    const floor = GRADIENT_FLOOR * GRADIENT_FLOOR;
    let hit = 0;
    for (let i = 0; i < t.points.length; i++) {
        const at = t.points[i]! + shift;
        const up = at - w;
        const down = at + w;
        const a = data[up - 1]!;
        const c = data[up + 1]!;
        const g = data[down - 1]!;
        const j = data[down + 1]!;
        const gx = c + 2 * data[at + 1]! + j - a - 2 * data[at - 1]! - g;
        const gy = g + 2 * data[down]! + j - a - 2 * data[up]! - c;
        const m = gx * gx + gy * gy;
        if (m < floor) continue;
        // 倍角の cos = (ux·(gx²-gy²) + uy·2gxgy) / m
        if (t.ux[i]! * (gx * gx - gy * gy) + t.uy[i]! * 2 * gx * gy >= MATCH_COS2 * m) hit++;
    }
    return hit / t.points.length;
}

/**
 * そのコマにロゴが出ているか (おおむね 0〜1)。`data` は `t.crop` を切り出したグレースケール。
 *
 * **型の位置で揃う割合から、斜めにずらした4箇所で揃う割合を引く。** 後ろが細かい柄
 * (文字・格子) だと、ロゴが無くてもたまたま揃う画素が出る。同じ柄はずらしても揃うが、
 * ロゴはずらすと外れるので、差がロゴのぶんになる
 */
export function score(t: Template, data: Uint8Array): number {
    const on = agree(t, data, 0, 0);
    let off = 0;
    for (const [dx, dy] of [
        [SHIFT, SHIFT],
        [-SHIFT, SHIFT],
        [SHIFT, -SHIFT],
        [-SHIFT, -SHIFT],
    ] as const)
        off += agree(t, data, dx, dy);
    return on - off / 4;
}

/** 型の画素の平均の明るさ (0〜255)。ロゴが溶けて見えない明るさを外すのに使う (`byLevel`) */
export function level(t: Template, data: Uint8Array): number {
    let sum = 0;
    for (const at of t.points) sum += data[at]!;
    return Math.round(sum / t.points.length);
}

/**
 * 後ろの肌理。切り出した枠の、横に隣り合う画素の差の平均 (0〜255)。
 * 細かい柄の上ではロゴが埋もれるので、明るさと並べて見る (`byCell`)
 */
export function texture(t: Template, data: Uint8Array): number {
    const { width, height } = t.crop;
    let sum = 0;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 1; x < width; x++) sum += Math.abs(data[row + x]! - data[row + x - 1]!);
    }
    return Math.min(255, Math.round(sum / (height * (width - 1))));
}

/** ロゴが出ていた区間。コマ番号で、終わりも含む */
export interface Span {
    start: number;
    end: number;
}

/**
 * 出ている/いないを決める境目。**上がるときと下がるときで分ける** (ヒステリシス)。
 * 境目近くを行き来するコマで区間が細切れにならないように
 */
const ON = 0.25;
const OFF = 0.12;
/** 1コマごとの点を、前後これだけのコマの中央値でならす (奇数)。白いフラッシュ1枚で切れないように */
const SMOOTH = 9;
/**
 * 「消えた」と言うには、前後この秒数のどこにもロゴが見えないこと。
 *
 * **見えないことと、無いことは違う。** 半透明の白いロゴは明るい場面で後ろに溶けて
 * 点が 0 近くまで落ちる (実機のテレ東で、本編の中に 10 秒ほどの谷がいくつもある)。
 * それでも少し暗い所が横切るたびに点は戻るので、窓の中の上位 `PEAK_RANK` 番目で見る。
 * CM の間はどのコマも 0.1 に届かない
 */
const PEAK_WINDOW = 1;
const PEAK_RANK = 3;
/** これより短い「消えた」は消えていない (秒) */
const MIN_GAP = 1;
/** これより短い「出た」は出ていない (秒)。CM の中の似た絵 */
const MIN_SPAN = 2;

/** 前後 `SMOOTH` コマの中央値 */
function smooth(scores: Float32Array): Float32Array {
    const half = SMOOTH >> 1;
    const out = new Float32Array(scores.length);
    const window: number[] = [];
    for (let i = 0; i < scores.length; i++) {
        window.length = 0;
        for (let k = Math.max(0, i - half); k <= Math.min(scores.length - 1, i + half); k++)
            window.push(scores[k]!);
        window.sort((a, b) => a - b);
        out[i] = window[window.length >> 1]!;
    }
    return out;
}

/**
 * 前後 `half` コマの中で `rank` 番目に高い点。判断できるコマ (`known`) だけ数え、
 * 窓の 1/3 に満たなければ NaN (判断しない)。明るい場面に入る手前の数コマだけで
 * 「消えた」と言わないように
 */
function peak(scores: Float32Array, known: Uint8Array, half: number, rank: number): Float32Array {
    const out = new Float32Array(scores.length);
    const top = new Float32Array(rank);
    for (let i = 0; i < scores.length; i++) {
        top.fill(-Infinity);
        let seen = 0;
        for (let k = Math.max(0, i - half); k <= Math.min(scores.length - 1, i + half); k++) {
            if (known[k] === 0) continue;
            seen++;
            const v = scores[k]!;
            if (v <= top[rank - 1]!) continue;
            // 降順に差し込む
            let at = rank - 1;
            while (at > 0 && top[at - 1]! < v) {
                top[at] = top[at - 1]!;
                at--;
            }
            top[at] = v;
        }
        out[i] = seen < Math.max(rank, (2 * half + 1) / 3) ? Number.NaN : top[rank - 1]!;
    }
    return out;
}

/** コマごとに測るもの。`score`・`level`・`texture` を並べたもの */
export interface Readings {
    scores: Float32Array;
    levels: Uint8Array;
    textures: Uint8Array;
}

/**
 * 「見えない = 無い」と言える後ろか。**明るさ × 肌理** の段ごとに決める。
 *
 * **見えないことと、無いことは違う。** 半透明の白いロゴは、後ろが白っぽいと溶けて
 * 点が 0 まで落ちる (実機のテレ東: 型の画素の明るさが 208 を超えると、ロゴの出ている
 * コマでも点の 9 割が 0.16 未満)。細かい柄 (金網・木の葉) の上でも埋もれる。
 * そこを「消えた」と読むと、本編が明るい場面・柄の場面のたびに切れる。
 *
 * 決め方は2回。どちらも局ごとに決め打ちせず、その録画の絵から決まる。
 *
 * 1. 明るさの段ごとに点の上位 5% を見て、ON に届かない段は判断しない (前後 2 秒にロゴが
 *    はっきり見えたコマだけで数える。CM にしか出ない後ろを「見えない」と取り違えないように)。
 *    (番組の大半にロゴが出ているので、見える段なら上位 5% は ON を超える)。
 *    白いロゴなら明るい段が、黒い縁取りのロゴなら暗い段が外れる
 * 2. 1 で出した区間の中 (= ロゴが出ているはずのコマ) で、明るさ × 肌理の段ごとに
 *    「点が OFF を割った割合」を数え、`MISS_MAX` を超える段は判断しない。
 *    実機のテレ東では、明るさ 176〜207 で肌理のある所が 1〜2 割、208 以上は半分以上割っていた
 *
 * 判断しないコマは、直前の判断を持ち越す (`logoSpans`)
 */
function byLevel(r: Readings, fps: number): Uint8Array {
    /*
     * **数えるのは、前後 `CONTEXT` 秒のどこかでロゴがはっきり見えたコマだけ。** CM の間のコマまで
     * 数えると、CM にしか出ない後ろは上位 5% も 0 なので「判断できない」になり、CM の頭へ
     * 判断が持ち越される
     */
    const near = new Uint8Array(r.scores.length);
    const reach = Math.round(CONTEXT * fps);
    for (let i = 0; i < r.scores.length; i++) {
        if (r.scores[i]! < ON) continue;
        near.fill(1, Math.max(0, i - reach), Math.min(r.scores.length, i + reach + 1));
    }
    const bins: number[][] = Array.from({ length: 16 }, () => []);
    for (let i = 0; i < r.scores.length; i++) if (near[i] === 1) bins[r.levels[i]! >> 4]!.push(r.scores[i]!);
    const ok = Uint8Array.from(bins, (values) => {
        // 少なすぎる段は確かめようがないので、見えるものとして扱う
        if (values.length < CELL_MIN * fps) return 1;
        values.sort((a, b) => b - a);
        return values[Math.floor(values.length * 0.05)]! >= ON ? 1 : 0;
    });
    return Uint8Array.from(r.levels, (level) => ok[level >> 4]!);
}

/** 肌理の段の境目 (隣り合う画素の差の平均) */
const TEXTURE_STEPS = [1, 2, 4, 8, 16];
const cellOf = (level: number, texture: number) =>
    (level >> 4) * (TEXTURE_STEPS.length + 1) + TEXTURE_STEPS.filter((step) => texture >= step).length;

function byCell(r: Readings, first: Span[], known: Uint8Array, fps: number): Uint8Array {
    const cells = 16 * (TEXTURE_STEPS.length + 1);
    const lit = new Uint32Array(cells);
    const miss = new Uint32Array(cells);
    for (const span of first) {
        for (let i = span.start; i <= span.end; i++) {
            const cell = cellOf(r.levels[i]!, r.textures[i]!);
            lit[cell]!++;
            if (r.scores[i]! < OFF) miss[cell]!++;
        }
    }
    return Uint8Array.from(known, (was, i) => {
        const cell = cellOf(r.levels[i]!, r.textures[i]!);
        // 区間の中にほとんど無い段 (CM にしか出ない後ろ) は、1 の判断のまま
        if (lit[cell]! < CELL_MIN * fps) return was;
        return miss[cell]! <= lit[cell]! * MISS_MAX ? 1 : 0;
    });
}
/** 段を判断するのに要る長さ (秒) */
const CELL_MIN = 2;
/** 明るさの段を数えるとき、ロゴがはっきり見えたコマからどれだけ離れたコマまで入れるか (秒) */
const CONTEXT = 2;
/** ロゴが出ているはずのコマで、これより多く点が割れる後ろは当てにしない */
const MISS_MAX = 0.1;

/**
 * コマごとの測り (`score`・`level`・`texture`) から、ロゴの出ていた区間を出す。
 * 判断できる後ろの決め方は `byLevel`/`byCell`
 */
export function logoSpans(r: Readings, fps: number): Span[] {
    const s = smooth(r.scores);
    const known = flat(r, byLevel(r, fps));
    const first = spansOf(r.scores, s, known, fps);
    return spansOf(r.scores, s, flat(r, byCell(r, first, known, fps)), fps);
}

/**
 * **のっぺりして白くない後ろは、いつでも判断できる。** そこにロゴが乗っていれば必ず縁が立つので、
 * 縁が無ければ無い。段ごとの数え方 (`byLevel`) だと、番組の切れ目の真っ黒 (局がロゴごと消す) が
 * ロゴの近くにしか出ないぶん「見えない段」になり、番組の終わりのロゴが黒い間 15 秒ぶん
 * 持ち越された (実機の BS11)
 */
function flat(r: Readings, known: Uint8Array): Uint8Array {
    for (let i = 0; i < known.length; i++) if (r.textures[i]! < 1 && r.levels[i]! < FLAT_LEVEL) known[i] = 1;
    return known;
}
/** これより明るいのっぺりは白飛び。白いロゴは溶けるので、のっぺりでも判断しない */
const FLAT_LEVEL = 200;

function spansOf(scores: Float32Array, s: Float32Array, known: Uint8Array, fps: number): Span[] {
    const half = Math.round(PEAK_WINDOW * fps);
    const q = peak(scores, known, half, PEAK_RANK);
    let runs: [number, number][] = [];
    let on = false;
    let from = 0;
    for (let i = 0; i <= q.length; i++) {
        // 判断できない間 (NaN) は持ち越す
        const next: boolean = i < q.length && (Number.isNaN(q[i]!) ? on : on ? q[i]! >= OFF : q[i]! >= ON);
        if (next && !on) from = i;
        if (!next && on) runs.push([from, i - 1]);
        on = next;
    }
    /*
     * **窓で見たぶん、境目は外へ膨らんでいる** (最大で窓の半分)。ならした点が
     * 両方の境目の真ん中を越える所まで戻す。戻すのは窓の幅まで (判断できない間に
     * 始まった区間を、見えるようになった所まで縮めないように)
     */
    const mid = (ON + OFF) / 2;
    runs = runs.flatMap(([a, b]) => {
        let start = a;
        while (start < Math.min(b, a + 2 * half) && s[start]! < mid) start++;
        let end = b;
        while (end > Math.max(start, b - 2 * half) && s[end]! < mid) end--;
        return s[start]! >= mid || start === a + 2 * half ? [[start, end] as [number, number]] : [];
    });
    // 短い切れ目を埋めてから、短い区間を捨てる
    const gap = Math.round(MIN_GAP * fps);
    const merged: [number, number][] = [];
    for (const run of runs) {
        const last = merged.at(-1);
        if (last !== undefined && run[0] - last[1] - 1 < gap) last[1] = run[1];
        else merged.push([run[0], run[1]]);
    }
    runs = merged.filter(([a, b]) => b - a + 1 >= Math.round(MIN_SPAN * fps));

    return runs.map(([start, end]) => ({ start, end }));
}

/** 覚えたものの書き出し。頭に印と数、あとは向きの和 */
const MAGIC = 'denpa-logo1';
const HEADER = 64;

export function encodeModel(model: LogoModel): Uint8Array {
    const { width, height, count, sx, sy } = model.orientation;
    const bytes = new Uint8Array(HEADER + width * height * 8);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode(MAGIC));
    const head = [model.frameWidth, model.frameHeight, model.rect.x, model.rect.y, width, height, count];
    for (const [i, value] of head.entries()) view.setUint32(16 + i * 4, value, true);
    new Float32Array(bytes.buffer, HEADER, width * height).set(sx);
    new Float32Array(bytes.buffer, HEADER + width * height * 4, width * height).set(sy);
    return bytes;
}

/** 読めなければ `null` (形が違う・切れている) */
export function decodeModel(bytes: Uint8Array): LogoModel | null {
    if (bytes.length < HEADER) return null;
    if (new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const [frameWidth, frameHeight, x, y, width, height, count] = Array.from({ length: 7 }, (_, i) =>
        view.getUint32(16 + i * 4, true),
    ) as [number, number, number, number, number, number, number];
    const size = width * height;
    if (size === 0 || bytes.length < HEADER + size * 8) return null;
    /*
     * Float32Array は4バイト境界から始まる必要があるので写す。**`slice` では写らないことがある** —
     * `readFileSync` の Buffer は `slice` が写しではなく窓を返し、`.buffer` が共有の大きな塊になる
     */
    const body = new Uint8Array(size * 8);
    body.set(bytes.subarray(HEADER, HEADER + size * 8));
    return {
        frameWidth,
        frameHeight,
        rect: { x, y, width, height },
        orientation: {
            width,
            height,
            count,
            sx: new Float32Array(body.buffer, 0, size),
            sy: new Float32Array(body.buffer, size * 4, size),
        },
    };
}

/**
 * 流れてくるバイト列を、1コマずつに区切って渡す。チャンクの境目はコマの境目と揃わない
 */
export function framer(size: number, onFrame: (frame: Uint8Array) => void): (chunk: Uint8Array) => void {
    const frame = new Uint8Array(size);
    let fill = 0;
    return (chunk) => {
        let at = 0;
        while (at < chunk.length) {
            const take = Math.min(size - fill, chunk.length - at);
            frame.set(chunk.subarray(at, at + take), fill);
            fill += take;
            at += take;
            if (fill === size) {
                onFrame(frame);
                fill = 0;
            }
        }
    };
}
