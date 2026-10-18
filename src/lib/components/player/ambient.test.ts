import { describe, expect, test } from 'bun:test';
import {
    blur,
    blurPixels,
    boxRadius,
    glowLayout,
    plan,
    reach,
    region,
    type Situation,
    storedAmbient,
    strips,
} from './ambient';

const base: Situation = {
    on: true,
    wide: true,
    dark: true,
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

    test('オフにした・明るいテーマ・光が見えない置き方なら消す', () => {
        expect(plan({ ...base, on: false })).toBe('off');
        expect(plan({ ...base, dark: false })).toBe('off');
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

    test('ぼかしは枠の幅に合わせ、上下限で止める。届く幅は引き伸ばしとぼかしのぶん', () => {
        expect(blur(200)).toBe(24);
        expect(blur(1000)).toBe(40);
        expect(blur(2000)).toBe(56);
        // 800px: 引き伸ばしで 32px、ぼかし (32px) の2倍で 64px
        expect(reach(800)).toBe(96);
        expect(reach(1600)).toBe(64 + 112);
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
        // 広げる幅は 96px
        expect(region(stage, { left: 0, top: 0, right: 2000, bottom: 2000 })).toEqual({
            left: 4,
            top: 0,
            right: 996,
            bottom: 626,
        });
        // 右に列がある (920px から)。列の上には出さない
        expect(region(stage, { left: 24, top: 56, right: 920, bottom: 700 })).toEqual({
            left: 24,
            top: 56,
            right: 920,
            bottom: 626,
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
    test('枠の幅を 64 画素にして、範囲ぶんの大きさを取る。コマは枠を少し大きくした所に描く', () => {
        const stage = { left: 100, top: 100, right: 740, bottom: 460 };
        const area = { left: 0, top: 60, right: 900, bottom: 600 };
        const layout = glowLayout(area, stage);
        // 640px の枠が 64 画素 (1画素 10px)
        expect(layout.width).toBe(90);
        expect(layout.height).toBe(54);
        expect(layout.w).toBeCloseTo(64 * 1.08);
        expect(layout.h).toBeCloseTo(36 * 1.08);
        // 真ん中は枠の真ん中 (42, 22)
        expect(layout.x + layout.w / 2).toBeCloseTo(42);
        expect(layout.y + layout.h / 2).toBeCloseTo(22);
        // ぼかし 26px は 2.6 画素
        expect(layout.radius).toBe(boxRadius(2.6));
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
