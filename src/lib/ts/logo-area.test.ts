import { describe, expect, test } from 'bun:test';
import { areaText, type Frame, findLogoArea } from './logo-area';

/**
 * ロゴの在り処を絵から割り出すところ (`findLogoArea`)。
 *
 * 実物は使わず、**中身が毎コマ変わる絵に半透明の四角を重ねた**ものを作って試す。
 * 確かめたいのは「濃さではなく、コマをまたいで同じ所に残る輪郭で見つけられるか」
 * なので、ロゴは**まわりより暗い**場合も混ぜてある (濃さで探していると落ちる)。
 *
 * 実素材での当たりは `docs/encode.md`「ロゴの在り処はこちらで割り出す」に。
 */

const W = 320;
const H = 240;

/** その乱数列。試験のたびに同じ絵が出るように自前で回す */
function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

/**
 * 番組の絵をこしらえる。
 *
 * @param logo 重ねる四角。`null` なら重ねない (CM のコマ)
 * @param alpha 重ねの濃さ。0.5 なら振れ幅が半分になる
 */
function make(count: number, logo: Rect | null, alpha: number, logoValue = 255, seed = 1): Frame[] {
    const rand = random(seed);
    const frames: Frame[] = [];
    for (let n = 0; n < count; n++) {
        const data = new Uint8Array(W * H);
        // 中身は毎コマまったく違う (場面が変わる番組のつもり)
        for (let at = 0; at < data.length; at++) data[at] = Math.floor(rand() * 256);
        if (logo !== null) {
            for (let y = logo.y; y < logo.y + logo.height; y++) {
                for (let x = logo.x; x < logo.x + logo.width; x++) {
                    const at = y * W + x;
                    data[at] = Math.round(data[at] * (1 - alpha) + logoValue * alpha);
                }
            }
        }
        frames.push({ width: W, height: H, data });
    }
    return frames;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 見つけた枠が、本物を囲めているか (余白ぶん外側に広がるのは想定どおり) */
function covers(found: Rect, truth: Rect): boolean {
    return (
        found.x <= truth.x &&
        found.y <= truth.y &&
        found.x + found.width >= truth.x + truth.width &&
        found.y + found.height >= truth.y + truth.height
    );
}

describe('ロゴの在り処', () => {
    /** 国内の地上波はほぼここ。テレ東の実測も右上 */
    test('右上の半透明ロゴを見つける', () => {
        const truth = { x: 260, y: 12, width: 40, height: 16 };
        const found = findLogoArea(make(40, truth, 0.6));
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /**
     * **濃さでは探していないこと。** ロゴがまわりより暗くても、
     * 振れ幅は同じように縮むので見つかる
     */
    test('暗いロゴでも見つける', () => {
        const truth = { x: 262, y: 20, width: 36, height: 14 };
        const found = findLogoArea(make(40, truth, 0.6, 0));
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /** 右上以外に出る局もありうるので、四隅を見る */
    test('左上でも見つける', () => {
        const truth = { x: 16, y: 14, width: 38, height: 15 };
        const found = findLogoArea(make(40, truth, 0.6));
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /**
     * **CM ではロゴが消えます。** 消えているコマが混ざっても、
     * 出ているコマのほうが多ければ振れ幅は縮んだままになる
     */
    test('CM のコマが混ざっても見つける', () => {
        const truth = { x: 258, y: 16, width: 42, height: 18 };
        const withLogo = make(30, truth, 0.7);
        const cm = make(10, null, 0, 255, 99);
        const found = findLogoArea([...withLogo, ...cm]);
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /** ロゴを出さない局・出していない時間帯では、黙って諦める */
    test('ロゴが無ければ null', () => {
        expect(findLogoArea(make(40, null, 0))).toBeNull();
    });

    /**
     * **隅がまるごと静止していても拾わない。** 黒帯や固定の背景を
     * 「ロゴ」と言い出すと、そのまま覚えさせてしまう
     */
    test('隅がまるごと静止していても拾わない', () => {
        const frames = make(40, null, 0);
        // 右上の隅ぜんぶを真っ黒に固定する
        for (const frame of frames) {
            for (let y = 0; y < 48; y++) for (let x = 213; x < W; x++) frame.data[y * W + x] = 0;
        }
        expect(findLogoArea(frames)).toBeNull();
    });

    /** コマが少なすぎると振れ幅が当てにならない */
    test('コマが少なければ諦める', () => {
        expect(findLogoArea(make(8, { x: 260, y: 12, width: 40, height: 16 }, 0.6))).toBeNull();
    });

    /** 枠からはみ出すと logoframe が降りる (outside the video) */
    test('枠はコマの中に収まる', () => {
        const truth = { x: 300, y: 4, width: 18, height: 12 };
        const found = findLogoArea(make(40, truth, 0.7)) as Rect;
        expect(found).not.toBeNull();
        expect(found.x).toBeGreaterThanOrEqual(0);
        expect(found.y).toBeGreaterThanOrEqual(0);
        expect(found.x + found.width).toBeLessThanOrEqual(W);
        expect(found.y + found.height).toBeLessThanOrEqual(H);
    });

    test('渡す形は x,y,w,h', () => {
        expect(areaText({ x: 1290, y: 20, width: 140, height: 80 })).toBe('1290,20,140,80');
    });
});
