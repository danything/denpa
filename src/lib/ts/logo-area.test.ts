import { describe, expect, test } from 'bun:test';
import type { Rect } from './logo-area';
import { addFrame, emptyOrientation, findArea } from './logo-detect';

/**
 * ロゴの在り処の選び方 (`logo-area.pickArea`)。強さは自前のロゴ判定と同じ
 * 「線の向きが毎コマ揃う割合」で測る (`logo-detect.findArea`)。
 *
 * 実物は使わず、**中身が毎コマ変わる絵に半透明の四角を重ねた**ものを作って試す。
 * ロゴは**まわりより暗い**場合も混ぜてある (濃さで探していると落ちる)。
 *
 * 実素材での当たりは `docs/encode.md`「在り処の割り出し」に。
 */

const W = 960;
const H = 720;
/** 上下の帯の高さ。`server/logo-own.ts` と同じく縦の 1/5 */
const BAND = Math.round(H / 5) & ~1;

/** 番組のコマ1枚 (8bit グレースケール) */
interface Frame {
    data: Uint8Array;
}

/** 上下の帯で向きを足し合わせて割り出す。`server/logo-own.ts` の覚え方と同じ */
function find(frames: Frame[]): Rect | null {
    const top = emptyOrientation(W, BAND);
    const bottom = emptyOrientation(W, BAND);
    for (const { data } of frames) {
        addFrame(top, data, 0, W);
        addFrame(bottom, data, (H - BAND) * W, W);
    }
    return findArea({ top, bottom }, W, H);
}

/** sin の表引き。コマを何十枚も作るので Math.sin では遅い */
const SIN = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((i / 4096) * Math.PI * 2));
const sin = (a: number) => SIN[Math.floor((a / (Math.PI * 2)) * 4096) & 4095]!;

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
        /*
         * 中身は毎コマまったく違う (場面が変わる番組のつもり)。**なだらかな絵にする** —
         * 本物の絵は隣どうしの画素が似ている。画素ごとの乱数だと、どのコマでも
         * 至る所に強い縁が立ち、ロゴの縁の向きが揃うこと (`logo-detect.coherence`) が見えない
         */
        const waves = Array.from({ length: 3 }, () => ({
            fx: (rand() - 0.5) * 0.1,
            fy: (rand() - 0.5) * 0.1,
            phase: rand() * Math.PI * 2,
            amp: 30 + rand() * 30,
        }));
        for (let y = 0; y < H; y++) {
            // 見るのは上下の帯だけ (`find`)。間は描かない — 全面を描いていた頃は1件 8 秒かかり、CI で時間切れになっていた
            if (y >= BAND && y < H - BAND) continue;
            for (let x = 0; x < W; x++) {
                let value = 128 + (rand() - 0.5) * 16;
                for (const w of waves) value += w.amp * sin(w.fx * x + w.fy * y + w.phase);
                data[y * W + x] = Math.max(0, Math.min(255, Math.round(value)));
            }
        }
        if (logo !== null) paint(data, logo, alpha, logoValue);
        frames.push({ data });
    }
    return frames;
}

/**
 * 四角を重ねる。**中は縦縞** (幅 3 の線を 3 おき) — 本物のロゴは文字なので、
 * 外枠だけでなく中にも縁がぎっしり詰まっている
 */
function paint(data: Uint8Array, rect: Rect, alpha: number, value: number, striped = true): void {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
        for (let x = rect.x; x < rect.x + rect.width; x++) {
            if (striped && Math.floor((x - rect.x) / 3) % 2 === 1) continue;
            const at = y * W + x;
            data[at] = Math.round(data[at]! * (1 - alpha) + value * alpha);
        }
    }
}

/** 作った絵に、動かない白い四角をもう1つ重ねる (窓枠やテロップのつもり)。`striped` を外すと塗りつぶし (帯の線) */
function overlay(frames: Frame[], rect: Rect, alpha: number, striped = true): void {
    for (const frame of frames) paint(frame.data, rect, alpha, 255, striped);
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
        const truth = { x: 780, y: 36, width: 40, height: 16 };
        const found = find(make(40, truth, 0.6));
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /**
     * **濃さでは探していないこと。** ロゴがまわりより暗くても、
     * 振れ幅は同じように縮むので見つかる
     */
    test('暗いロゴでも見つける', () => {
        const truth = { x: 786, y: 60, width: 36, height: 14 };
        const found = find(make(40, truth, 0.6, 0));
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /** 右上以外に出る局もありうるので、四隅を見る */
    test('左上でも見つける', () => {
        const truth = { x: 48, y: 42, width: 38, height: 15 };
        const found = find(make(40, truth, 0.6));
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /**
     * **CM ではロゴが消えます。** 消えているコマが混ざっても、
     * 出ているコマのほうが多ければ振れ幅は縮んだままになる
     */
    test('CM のコマが混ざっても見つける', () => {
        const truth = { x: 774, y: 48, width: 42, height: 18 };
        const withLogo = make(30, truth, 0.7);
        const cm = make(10, null, 0, 255, 99);
        const found = find([...withLogo, ...cm]);
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /** ロゴを出さない局・出していない時間帯では、黙って諦める */
    test('ロゴが無ければ null', () => {
        expect(find(make(40, null, 0))).toBeNull();
    });

    /**
     * **隅がまるごと静止していても拾わない。** 黒帯や固定の背景を
     * 「ロゴ」と言い出すと、そのまま覚えさせてしまう
     */
    test('隅がまるごと静止していても拾わない', () => {
        const frames = make(40, null, 0);
        // 右上の隅ぜんぶを真っ黒に固定する
        for (const frame of frames) {
            for (let y = 0; y < 144; y++) for (let x = 640; x < W; x++) frame.data[y * W + x] = 0;
        }
        expect(find(frames)).toBeNull();
    });

    /** 薄い縁が並ぶだけなら (後ろに紛れてたびたび縁が立たない)、ロゴが強い縁を独り占めするので見つかる */
    test('弱い動かない縁が並んでいても見つける', () => {
        const truth = { x: 786, y: 36, width: 40, height: 16 };
        const frames = make(40, truth, 0.6);
        overlay(frames, { x: 648, y: 42, width: 30, height: 14 }, 0.2);
        const found = find(frames);
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
    });

    /**
     * **出ている場面が少ないものは負ける。** 番組の途中だけ出る
     * テロップ・セットの縁は、出ていないコマでは線の向きが揃わない (`logo-detect.coherence`)。
     * ロゴは毎コマ同じ所に同じ向きの線を出す
     */
    test('一部の場面にしか出ない動かない絵には負けない', () => {
        const truth = { x: 786, y: 36, width: 40, height: 16 };
        const frames = make(40, truth, 0.6);
        overlay(frames.slice(0, 24), { x: 648, y: 42, width: 30, height: 14 }, 0.6);
        const found = find(frames);
        expect(found).not.toBeNull();
        expect(covers(found as Rect, truth)).toBe(true);
        expect((found as Rect).x).toBeGreaterThan(648 + 30);
    });

    /** テレビ朝日 のロゴは図形と文字が縦に離れている。片方だけの枠では覚えられなかった */
    test('すぐ隣に離れて並ぶ図形と文字は1つの枠に括る', () => {
        const mark = { x: 810, y: 40, width: 24, height: 12 };
        const text = { x: 802, y: 64, width: 40, height: 12 };
        const frames = make(40, text, 0.6);
        overlay(frames, mark, 0.6);
        const found = find(frames) as Rect;
        expect(found).not.toBeNull();
        expect(covers(found, mark)).toBe(true);
        expect(covers(found, text)).toBe(true);
    });

    /** 枠からはみ出すと切り出せない */
    test('枠はコマの中に収まる', () => {
        const truth = { x: 916, y: 4, width: 40, height: 16 };
        const found = find(make(40, truth, 0.7)) as Rect;
        expect(found).not.toBeNull();
        expect(found.x).toBeGreaterThanOrEqual(0);
        expect(found.y).toBeGreaterThanOrEqual(0);
        expect(found.x + found.width).toBeLessThanOrEqual(W);
        expect(found.y + found.height).toBeLessThanOrEqual(H);
    });
});
