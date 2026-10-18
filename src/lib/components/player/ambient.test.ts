import { describe, expect, test } from 'bun:test';
import {
    blurPixels,
    boxRadius,
    falloff,
    glowLayout,
    glowPixels,
    headerTone,
    luminance,
    mixRgb,
    plan,
    reach,
    region,
    type Situation,
    storedAmbient,
    strips,
    vivid,
} from './ambient';

const base: Situation = {
    on: true,
    wide: true,
    fullscreen: false,
    hidden: false,
    reduced: false,
    playing: true,
    lit: true,
};

describe('アンビエントモード', () => {
    test('既定はオン。切ったことのある端末だけオフ', () => {
        expect(storedAmbient(null)).toBe(true);
        expect(storedAmbient('1')).toBe(true);
        expect(storedAmbient('0')).toBe(false);
    });

    test('再生している間は写し続ける', () => {
        expect(plan(base)).toBe('watch');
        expect(plan({ ...base, lit: false })).toBe('watch');
    });

    test('オフにした・光が見えない置き方なら消す', () => {
        expect(plan({ ...base, on: false })).toBe('off');
        expect(plan({ ...base, wide: false })).toBe('off');
    });

    test('止めている間は写さず、光は残す。まだ光が無ければ1枚だけ写す', () => {
        expect(plan({ ...base, playing: false })).toBe('hold');
        expect(plan({ ...base, playing: false, lit: false })).toBe('watch');
    });

    test('裏に回った・全画面なら写さない', () => {
        expect(plan({ ...base, hidden: true })).toBe('hold');
        expect(plan({ ...base, fullscreen: true })).toBe('hold');
        expect(plan({ ...base, hidden: true, lit: false })).toBe('hold');
    });

    test('動かさない設定では1枚写したら止める', () => {
        expect(plan({ ...base, reduced: true, lit: false })).toBe('watch');
        expect(plan({ ...base, reduced: true })).toBe('hold');
    });

    test('光の届く幅は上下左右で同じで、枠の幅の 8% を 64〜128px に収める', () => {
        expect(reach(500)).toBe(64);
        expect(reach(1000)).toBe(80);
        expect(reach(2000)).toBe(128);
    });

    test('濃さは縁で 1、届く幅で 0。その間は薄くなる一方', () => {
        expect(falloff(0)).toBe(1);
        expect(falloff(1)).toBe(0);
        expect(falloff(0.5)).toBeCloseTo(0.354, 2);
        let before = 1;
        for (let t = 0.05; t < 1; t += 0.05) {
            expect(falloff(t)).toBeLessThan(before);
            before = falloff(t);
        }
    });

    test('帯は枠に重ならず、範囲を埋める', () => {
        const area = { left: 0, top: 50, right: 1000, bottom: 700 };
        const stage = { left: 24, top: 80, right: 900, bottom: 573 };
        expect(strips(area, stage)).toEqual([
            { left: 0, top: 50, right: 1000, bottom: 80 },
            { left: 0, top: 573, right: 1000, bottom: 700 },
            { left: 0, top: 80, right: 24, bottom: 573 },
            { left: 900, top: 80, right: 1000, bottom: 573 },
        ]);
        // 範囲の端が枠の端と同じなら、その帯は無い
        expect(strips({ ...area, left: 24, top: 80 }, stage)).toHaveLength(2);
    });

    test('箱は枠を広げたもので、はみ出してよい範囲で切る', () => {
        const stage = { left: 100, top: 80, right: 900, bottom: 530 };
        // 広げる幅は上下左右とも 64px
        expect(region(stage, { left: 0, top: 0, right: 2000, bottom: 2000 })).toEqual({
            left: 36,
            top: 16,
            right: 964,
            bottom: 594,
        });
        // 右に列がある (920px から)。列の上には出さない
        expect(region(stage, { left: 24, top: 56, right: 920, bottom: 700 })).toEqual({
            left: 36,
            top: 56,
            right: 920,
            bottom: 594,
        });
    });

    test('範囲が枠より狭くても、箱の幅と高さは負にならない', () => {
        const box = region(
            { left: 100, top: 100, right: 500, bottom: 325 },
            { left: 600, top: 0, right: 550, bottom: 50 },
        );
        expect(box.right).toBeGreaterThanOrEqual(box.left);
        expect(box.bottom).toBeGreaterThanOrEqual(box.top);
    });
});

describe('光の canvas', () => {
    test('枠の幅を 96 画素にして、範囲ぶんの大きさを取る', () => {
        const stage = { left: 100, top: 100, right: 740, bottom: 460 };
        const area = { left: 0, top: 60, right: 900, bottom: 600 };
        const layout = glowLayout(area, stage);
        // 640px の枠が 96 画素 (1画素 6.67px)
        expect(layout.width).toBe(135);
        expect(layout.height).toBe(81);
        expect(layout.x).toBeCloseTo(15);
        expect(layout.y).toBeCloseTo(6);
        expect(layout.w).toBeCloseTo(96);
        expect(layout.h).toBeCloseTo(54);
        // 届く幅 64px は 9.6 画素
        expect(layout.reach).toBeCloseTo(9.6);
        expect(layout.radius).toBe(boxRadius(9.6 * 0.2));
    });

    test('光の色はいちばん近い縁の色で、枠から離れるほど薄く、届く幅の外は透明', () => {
        // 2x2 のコマ: 左上 赤・右上 緑・左下 青・右下 黄
        const frame = new Uint8ClampedArray([
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
        ]);
        const at = { width: 40, height: 30, x: 10, y: 10, w: 20, h: 10, reach: 8, radius: 1 };
        const out = glowPixels(frame, 2, 2, at);
        const px = (x: number, y: number) => [...out.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)];
        // 左上の上: 赤
        const [r, g, b, near] = px(11, 8) as [number, number, number, number];
        expect(r).toBeGreaterThan(g + 100);
        expect(r).toBeGreaterThan(b + 100);
        // 右下の右: 黄
        const yellow = px(31, 19);
        expect(yellow[0]).toBeGreaterThan(200);
        expect(yellow[1]).toBeGreaterThan(200);
        expect(yellow[2]).toBeLessThan(60);
        // 離れるほど薄い
        expect(px(11, 5)[3]).toBeLessThan(near);
        // 届く幅の外 (角から 13 画素) は透明
        expect(px(0, 0)[3]).toBe(0);
    });

    test('枠の奥を飛ばしても、縁の外の光は変わらない', () => {
        const frame = new Uint8ClampedArray(2 * 2 * 4).fill(200);
        // 半径 1 なら奥は縁から 5 画素より内側。幅 8 の枠には奥が無く、幅 40 の枠にはある
        const narrow = { width: 30, height: 60, x: 10, y: 10, w: 8, h: 40, reach: 6, radius: 1 };
        const wide = { ...narrow, width: 62, w: 40 };
        const a = glowPixels(frame, 2, 2, narrow);
        const b = glowPixels(frame, 2, 2, wide);
        for (const x of [5, 7, 9]) {
            const at = (30 * 30 + x) * 4;
            const bt = (62 * 30 + x) * 4;
            expect([...b.slice(bt, bt + 4)]).toEqual([...a.slice(at, at + 4)]);
        }
    });

    test('箱の半径は、3回でその強さに近づくもの', () => {
        expect(boxRadius(0.1)).toBe(1);
        expect(boxRadius(2.6)).toBe(2);
        expect(boxRadius(6)).toBe(6);
    });

    test('一色の面は、中ではそのままの色', () => {
        const width = 20;
        const height = 20;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) data.set([200, 100, 50, 255], i * 4);
        blurPixels(data, width, height, 2);
        const center = (10 * width + 10) * 4;
        expect([...data.slice(center, center + 4)]).toEqual([200, 100, 50, 255]);
    });

    test('透明の外へ広がっても、色は黒ずまない (薄くなるだけ)', () => {
        const width = 21;
        const height = 21;
        const data = new Uint8ClampedArray(width * height * 4);
        // 真ん中の 3x3 だけ赤
        for (let y = 9; y <= 11; y++)
            for (let x = 9; x <= 11; x++) data.set([255, 0, 0, 255], (y * width + x) * 4);
        blurPixels(data, width, height, 2);
        const near = (10 * width + 15) * 4;
        expect(data[near + 3]).toBeGreaterThan(0);
        expect(data[near + 3]).toBeLessThan(255);
        expect(data[near]).toBeGreaterThanOrEqual(254);
        expect(data[near + 1]).toBe(0);
        // 遠い角は透明のまま
        expect(data[3]).toBe(0);
    });
});

describe('色を濃くする', () => {
    const pixel = (r: number, g: number, b: number) => new Uint8ClampedArray([r, g, b, 255]);

    test('暗いテーマでは彩度と明るさを上げる。灰色は灰色のまま明るくなるだけ', () => {
        const color = pixel(120, 60, 60);
        vivid(color, 'dark');
        expect(color[0]! - color[1]!).toBeGreaterThan(60);
        expect(color[3]).toBe(255);
        const gray = pixel(100, 100, 100);
        vivid(gray, 'dark');
        expect([...gray]).toEqual([125, 125, 125, 255]);
    });

    test('明るいテーマでは、色の薄い所ほど透明にする', () => {
        const gray = pixel(90, 90, 90);
        vivid(gray, 'light');
        expect(gray[3]).toBe(0);
        const red = pixel(200, 40, 40);
        vivid(red, 'light');
        expect(red[3]).toBe(255);
        const pale = pixel(140, 120, 120);
        vivid(pale, 'light');
        expect(pale[3]).toBeGreaterThan(0);
        expect(pale[3]).toBeLessThan(255);
    });
});

describe('見出しに敷く色', () => {
    const hex = (h: string): [number, number, number] =>
        [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    const contrast = (a: [number, number, number], b: [number, number, number]) => {
        const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
        return (x + 0.05) / (y + 0.05);
    };
    const frames = [
        '#ffffff',
        '#000000',
        '#ff0000',
        '#ffff00',
        '#00ffff',
        '#0000ff',
        '#808080',
        '#36c8c0',
        '#0b3550',
    ].map(hex);

    test('暗いテーマでは、どんな映像でも見出しの字 (控えた字・主の色) が 4.5 以上で読める', () => {
        for (const frame of frames) {
            const tone = headerTone(frame, 'dark');
            expect(contrast(tone, hex('#9aa3b5'))).toBeGreaterThanOrEqual(4.5);
            expect(contrast(tone, hex('#e6e8ec'))).toBeGreaterThanOrEqual(4.5);
        }
    });

    test('明るいテーマでも、見出しの字が 4.5 以上で読める', () => {
        for (const frame of frames) {
            const tone = headerTone(frame, 'light');
            expect(contrast(tone, hex('#555e70'))).toBeGreaterThanOrEqual(4.5);
            expect(contrast(tone, hex('#02659a'))).toBeGreaterThanOrEqual(4.5);
        }
    });

    test('混ぜた途中の色 (グラデーション・入れ替えの途中) でも 4.5 以上で読める', () => {
        expect(mixRgb([0, 0, 0], [200, 100, 50], 0.5)).toEqual([100, 50, 25]);
        for (const theme of ['dark', 'light'] as const) {
            for (const a of frames) {
                for (const b of frames) {
                    const mid = mixRgb(headerTone(a, theme), headerTone(b, theme), 0.5);
                    const text = theme === 'dark' ? hex('#9aa3b5') : hex('#02659a');
                    expect(contrast(mid, text)).toBeGreaterThanOrEqual(4.5);
                }
            }
        }
    });

    test('色相は残す (赤は赤みのまま、青は青みのまま)', () => {
        const red = headerTone(hex('#ff0000'), 'light');
        expect(red[0]).toBeGreaterThan(red[1]);
        const blue = headerTone(hex('#0000ff'), 'dark');
        expect(blue[2]).toBeGreaterThan(blue[0]);
    });
});
