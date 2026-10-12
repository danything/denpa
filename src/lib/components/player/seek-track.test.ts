import { describe, expect, test } from 'bun:test';
import { CM_COLOR, trackAt, trackLayers } from './seek-track';

describe('シークバーの溝の位置', () => {
    test('つまみの往復ぶんを引いて置く', () => {
        expect(trackAt(0.5)).toBe('calc(0.5rem + 0.5 * (100% - 1rem))');
    });

    test('両端は溝の端まで', () => {
        expect(trackAt(0)).toBe('0%');
        expect(trackAt(-1)).toBe('0%');
        expect(trackAt(Number.NaN)).toBe('0%');
        expect(trackAt(1)).toBe('100%');
    });
});

describe('シークバーの溝の塗り', () => {
    test('CM の区間を琥珀で、その外は透かして塗る', () => {
        const spans = [
            { start: 0, end: 10 },
            { start: 50, end: 60 },
        ];
        const { cm, ticks } = trackLayers(spans, [], 0, 100);
        expect(ticks).toBe('none');
        const at = (ratio: number) => `calc(0.5rem + ${ratio} * (100% - 1rem))`;
        const stops = [
            'transparent 0%',
            `${CM_COLOR} 0%`,
            `${CM_COLOR} ${at(0.1)}`,
            `transparent ${at(0.1)}`,
            `transparent ${at(0.5)}`,
            `${CM_COLOR} ${at(0.5)}`,
            `${CM_COLOR} ${at(0.6)}`,
            `transparent ${at(0.6)}`,
        ];
        expect(cm).toBe(`linear-gradient(to right, ${stops.join(', ')})`);
    });

    test('末尾の CM は溝の右端まで', () => {
        const { cm } = trackLayers([{ start: 90, end: 100 }], [], 0, 100);
        expect(cm).toContain(`${CM_COLOR} 100%`);
    });

    test('目盛りは 1px の線', () => {
        const { cm, ticks } = trackLayers([], [25], 0, 100);
        expect(cm).toBe('none');
        expect(ticks).toContain('calc(calc(0.5rem + 0.25 * (100% - 1rem)) + 1px)');
    });

    test('幅の無いバー・外れた区間は塗らない', () => {
        expect(trackLayers([{ start: 0, end: 10 }], [5], 0, 0)).toEqual({ cm: 'none', ticks: 'none' });
        expect(trackLayers([{ start: 200, end: 210 }], [0, 100], 0, 100)).toEqual({
            cm: 'none',
            ticks: 'none',
        });
    });
});
