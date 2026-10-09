import { describe, expect, test } from 'bun:test';
import { parseLogoFrames } from '../server/cm-jls';
import type { Rect } from './logo-area';
import {
    addFrame,
    coherence,
    cropOrientation,
    decodeModel,
    emptyOrientation,
    encodeModel,
    findArea,
    formatLogoFrames,
    framer,
    type LogoModel,
    level,
    logoSpans,
    makeTemplate,
    mergeModel,
    score,
} from './logo-detect';

/**
 * 自前のロゴ判定 (`logo-detect.ts`)。
 *
 * 実物は使わず、**中身が毎コマ変わる絵に、半透明の白い字を重ねた**ものを作って試す。
 * 確かめたいのは「後ろがのっぺりしていなくても覚えられるか」「明るい場面で溶けて
 * 見えないのを、消えたと読まないか」。実素材での突き合わせは `docs/encode.md`「ロゴを自分で拾う」。
 */

const W = 480;
const H = 270;
/** ロゴの置き場 (右上) */
const LOGO: Rect = { x: 410, y: 16, width: 44, height: 18 };

function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

/** ロゴの形。「エ」と「口」を並べた太さ 3 の線 */
function inLogo(x: number, y: number): boolean {
    const lx = x - LOGO.x;
    const ly = y - LOGO.y;
    if (lx < 0 || ly < 0 || lx >= LOGO.width || ly >= LOGO.height) return false;
    const box = (x0: number, y0: number, x1: number, y1: number) =>
        lx >= x0 && lx < x1 && ly >= y0 && ly < y1;
    // エ
    if (box(0, 0, 18, 3) || box(0, 15, 18, 18) || box(7, 0, 10, 18)) return true;
    // 口
    return box(24, 0, 44, 3) || box(24, 15, 44, 18) || box(24, 0, 27, 18) || box(41, 0, 44, 18);
}

/**
 * 1コマ。中身はなだらかな波 (本物の絵は隣どうしが似ている) に細かい揺らぎを足したもの。
 * `base` を渡すと、中身をその明るさに寄せる (明るい場面)
 */
function frame(rand: () => number, logo: boolean, base?: number): Uint8Array {
    const data = new Uint8Array(W * H);
    const waves = Array.from({ length: 3 }, () => ({
        fx: (rand() - 0.5) * 0.15,
        fy: (rand() - 0.5) * 0.15,
        phase: rand() * Math.PI * 2,
        amp: base === undefined ? 30 + rand() * 30 : 2,
    }));
    // 中身は暗め〜中ほど。明るい後ろで白いロゴが溶けるのは別に試す (下の「後ろが白いと」)
    const center = base ?? 40 + rand() * 80;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let value = center + (rand() - 0.5) * 6;
            for (const w of waves) value += w.amp * Math.sin(w.fx * x + w.fy * y + w.phase);
            // 半透明の白: 画素 = (1-α)×中身 + α×255
            if (logo && inLogo(x, y)) value = value * 0.7 + 255 * 0.3;
            data[y * W + x] = Math.max(0, Math.min(255, Math.round(value)));
        }
    }
    return data;
}

/** 上下の帯 (高さ H/5) で向きを足し合わせる。`server/logo-own.ts` の覚え方と同じ */
function learn(frames: Uint8Array[]) {
    const band = Math.round(H / 5) & ~1;
    const top = emptyOrientation(W, band);
    const bottom = emptyOrientation(W, band);
    for (const data of frames) {
        addFrame(top, data, 0, W);
        addFrame(bottom, data, (H - band) * W, W);
    }
    return { top, bottom, band };
}

const rand = random(7);
/** 番組 (ロゴあり) 70 コマと CM (なし) 30 コマ */
const SAMPLES = [
    ...Array.from({ length: 70 }, () => frame(rand, true)),
    ...Array.from({ length: 30 }, () => frame(rand, false)),
];
const BANDS = learn(SAMPLES);

/** 覚えたもの。在り処は割り出したものを使う */
function model(): LogoModel {
    const rect = findArea(BANDS, W, H);
    if (rect === null) throw new Error('在り処が割り出せない');
    return { frameWidth: W, frameHeight: H, rect, orientation: cropOrientation(BANDS.top, rect) };
}

/** 型の枠を切り出す */
function crop(data: Uint8Array, r: Rect): Uint8Array {
    const out = new Uint8Array(r.width * r.height);
    for (let y = 0; y < r.height; y++)
        out.set(data.subarray((r.y + y) * W + r.x, (r.y + y) * W + r.x + r.width), y * r.width);
    return out;
}

describe('覚える', () => {
    test('後ろが毎コマ違っても、線の向きが揃う所としてロゴが残る', () => {
        const r = coherence(BANDS.top);
        // ロゴの縁 (「エ」の上の横棒の下端) と、ロゴの無い所
        const edge = (LOGO.y + 3) * W + LOGO.x + 4;
        const away = 30 * W + 100;
        // ロゴが出ているのは 7 割のコマ
        expect(r[edge]!).toBeGreaterThan(0.5);
        expect(r[away]!).toBeLessThan(0.2);
    });

    test('在り処を割り出す (余白込みでロゴを囲む)', () => {
        const rect = findArea(BANDS, W, H);
        expect(rect).not.toBeNull();
        if (rect === null) return;
        expect(rect.x).toBeLessThanOrEqual(LOGO.x);
        expect(rect.y).toBeLessThanOrEqual(LOGO.y);
        expect(rect.x + rect.width).toBeGreaterThanOrEqual(LOGO.x + LOGO.width);
        expect(rect.y + rect.height).toBeGreaterThanOrEqual(LOGO.y + LOGO.height);
        expect(rect.width).toBeLessThan(LOGO.width * 2);
    });

    test('ロゴが無ければ割り出さない', () => {
        const blank = learn(Array.from({ length: 40 }, () => frame(rand, false)));
        expect(findArea(blank, W, H)).toBeNull();
    });

    test('型はロゴの縁の画素だけで作る', () => {
        const t = makeTemplate(model());
        expect(t).not.toBeNull();
        if (t === null) return;
        for (const at of t.points) {
            const x = t.crop.x + (at % t.crop.width);
            const y = t.crop.y + Math.floor(at / t.crop.width);
            // 縁は字の内側か、外側に 1 画素
            let near = false;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) near ||= inLogo(x + dx, y + dy);
            expect(near).toBe(true);
        }
    });
});

describe('当てる', () => {
    const t = makeTemplate(model());
    if (t === null) throw new Error('型が作れない');

    test('出ているコマは高く、出ていないコマは 0 近く', () => {
        const fresh = random(99);
        for (let n = 0; n < 5; n++) {
            expect(score(t, crop(frame(fresh, true), t.crop))).toBeGreaterThan(0.3);
            expect(Math.abs(score(t, crop(frame(fresh, false), t.crop)))).toBeLessThan(0.1);
        }
    });

    test('後ろが白いと溶けて見えない (明るさでわかる)', () => {
        const white = crop(frame(random(5), true, 250), t.crop);
        expect(score(t, white)).toBeLessThan(0.12);
        expect(level(t, white)).toBeGreaterThan(240);
    });
});

describe('区間にする', () => {
    const FPS = 30;
    /** 点と明るさを並べる。`[コマ数, 点, 明るさ]` */
    function series(parts: [number, number, number][]) {
        const scores: number[] = [];
        const levels: number[] = [];
        const noise = random(3);
        for (const [count, value, light] of parts) {
            for (let i = 0; i < count; i++) {
                scores.push(value + (noise() - 0.5) * 0.04);
                levels.push(light);
            }
        }
        return { scores: Float32Array.from(scores), levels: Uint8Array.from(levels), textures: new Uint8Array(scores.length) };
    }

    test('出ている区間の境目をコマで返す', () => {
        const readings = series([
            [300, 0.8, 80],
            [450, 0, 80],
            [600, 0.8, 80],
        ]);
        const spans = logoSpans(readings, FPS);
        expect(spans.map((s) => [s.start, s.end])).toEqual([
            [0, 299],
            [750, 1349],
        ]);
    });

    test('白い場面で見えなくなっても、消えたとは読まない', () => {
        const readings = series([
            [600, 0.8, 80],
            // 本編の中の白い場面 (10 秒)。その明るさではロゴが一度も見えない
            [300, 0.02, 245],
            [600, 0.8, 80],
            [450, 0, 80],
            [600, 0.8, 80],
        ]);
        const spans = logoSpans(readings, FPS);
        expect(spans.map((s) => [s.start, s.end])).toEqual([
            [0, 1499],
            [1950, 2549],
        ]);
    });

    test('柄の上でたびたび埋もれる後ろは、長く埋もれても消えたとは読まない', () => {
        const scores: number[] = [];
        const levels: number[] = [];
        const textures: number[] = [];
        const push = (count: number, value: number, rough: number) => {
            for (let i = 0; i < count; i++) {
                scores.push(value);
                levels.push(80);
                textures.push(rough);
            }
        };
        push(600, 0.8, 0);
        // 柄の場面: 3 コマに 1 コマ埋もれる (窓で見れば続いている)
        for (let n = 0; n < 30; n++) {
            push(20, 0.6, 10);
            push(10, 0.02, 10);
        }
        push(300, 0.8, 0);
        // 同じ柄の場面で 5 秒埋もれる
        push(150, 0.02, 10);
        push(300, 0.8, 0);
        // CM (のっぺりした後ろで見えない = 無い)
        push(450, 0, 0);
        push(300, 0.8, 0);
        const spans = logoSpans(
            {
                scores: Float32Array.from(scores),
                levels: Uint8Array.from(levels),
                textures: Uint8Array.from(textures),
            },
            FPS,
        );
        expect(spans.map((s) => [s.start, s.end])).toEqual([
            [0, 2249],
            [2700, 2999],
        ]);
    });

    test('白いフラッシュ数コマや、CM の中のまぎれは拾わない', () => {
        const readings = series([
            [600, 0.8, 80],
            [3, 0, 80],
            [600, 0.8, 80],
            [200, 0, 80],
            [20, 0.5, 80],
            [400, 0, 80],
        ]);
        const spans = logoSpans(readings, FPS);
        expect(spans.map((s) => [s.start, s.end])).toEqual([[0, 1202]]);
    });

    test('logoframe と同じ形で書き、join_logo_scp と同じ読み方で戻る', () => {
        const text = formatLogoFrames(
            [{ start: 236, end: 21927, startLo: 230, startHi: 240, endLo: 21927, endHi: 21927 }],
            1,
        );
        expect(text).toBe('   237 S 0 ALL    231    241\n 21928 E 0 ALL  21928  21928\n');
        expect(parseLogoFrames(text, 30)).toEqual([{ start: 237 / 30, end: 21929 / 30 }]);
    });
});

describe('覚えたものを持つ', () => {
    test('書いて読むと同じものが戻る (Buffer の窓から読んでも)', () => {
        const m = model();
        const bytes = encodeModel(m);
        // readFileSync の Buffer は大きな塊の途中を指していることがある
        const pool = Buffer.alloc(bytes.length + 13);
        pool.set(bytes, 13);
        const back = decodeModel(pool.subarray(13));
        expect(back).not.toBeNull();
        expect(back?.rect).toEqual(m.rect);
        expect(back?.orientation.count).toBe(m.orientation.count);
        expect(Array.from(back?.orientation.sx ?? [])).toEqual(Array.from(m.orientation.sx));
        expect(Array.from(back?.orientation.sy ?? [])).toEqual(Array.from(m.orientation.sy));
    });

    test('形の違うものは読まない', () => {
        expect(decodeModel(new Uint8Array(10))).toBeNull();
        expect(decodeModel(new Uint8Array(100))).toBeNull();
    });

    test('足していくと、古いぶんは薄まる', () => {
        const m = model();
        const add = emptyOrientation(m.rect.width, m.rect.height);
        add.count = 600;
        let grown = m;
        for (let n = 0; n < 20; n++) grown = mergeModel(grown, add);
        // 上限 (6000) で止まり、最初に覚えたぶんは薄まっている
        expect(grown.orientation.count).toBeLessThanOrEqual(6000);
        const at = grown.orientation.sx.findIndex((v) => v !== 0);
        expect(Math.abs(grown.orientation.sx[at]!)).toBeLessThan(Math.abs(m.orientation.sx[at]!));
    });
});

test('流れてくるバイト列を1コマずつに区切る', () => {
    const got: number[][] = [];
    const push = framer(4, (f) => got.push(Array.from(f)));
    push(Uint8Array.from([1, 2, 3]));
    push(Uint8Array.from([4, 5, 6, 7, 8, 9]));
    push(Uint8Array.from([10]));
    expect(got).toEqual([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
    ]);
});
