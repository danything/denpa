import { describe, expect, test } from 'bun:test';
import { MkvSplitter } from './mkv';

/**
 * 本物の ffmpeg が流したもので確かめる。**手で組んだものでは足りない。**
 *
 * ここに入れてあるのは、実機の ffmpeg に
 * `-f matroska pipe:1` で吐かせた 4 コマ (16x16 の PNG、25コマ/秒)。
 * **パイプへ流させた**ものなので、Segment の大きさが「不明」で書かれている —
 * ファイルに書かせたものとは形が違い、本番で来るのはこちら。
 *
 * ffprobe が読んだ時刻は 0 / 0.04 / 0.08 / 0.12 秒
 */
const TINY =
    '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' +
    'TkSuQmCC';

const bytes = () => new Uint8Array(Buffer.from(TINY, 'base64'));

describe('MkvSplitter', () => {
    test('コマと時刻を取り出す', () => {
        const frames = new MkvSplitter().feed(bytes());
        expect(frames.map((f) => f.at)).toEqual([0, 40, 80, 120]);
        // 中身は PNG そのまま。受け側はこれをそのまま絵にする
        for (const frame of frames) {
            expect([...frame.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        }
    });

    test('どこで切れても同じものが出る', () => {
        const raw = bytes();
        for (const step of [1, 7, 200, 1024]) {
            const splitter = new MkvSplitter();
            const out = [];
            for (let at = 0; at < raw.length; at += step) {
                out.push(...splitter.feed(raw.subarray(at, at + step)));
            }
            expect(
                out.map((f) => f.at),
                `刻み ${step}`,
            ).toEqual([0, 40, 80, 120]);
            expect(
                out.map((f) => f.data.length),
                `刻み ${step}`,
            ).toEqual(new MkvSplitter().feed(raw).map((f) => f.data.length));
        }
    });

    test('途中で切れたら、そこまでを出して続きを待つ', () => {
        const raw = bytes();
        const splitter = new MkvSplitter();
        // 2コマ目の途中まで
        const half = splitter.feed(raw.subarray(0, 800));
        expect(half.map((f) => f.at)).toEqual([0]);
        // 残りを渡せば揃う
        expect(splitter.feed(raw.subarray(800)).map((f) => f.at)).toEqual([40, 80, 120]);
    });

    test('知らない要素は大きさぶん飛ばす', () => {
        /*
         * **全部を知らなくていい**のがこの読み方の要。実機の流れには
         * CRC-32 (0xBF) や SeekHead が混ざっていて、その通りに動いている
         */
        const raw = bytes();
        const junk = new Uint8Array([0xbf, 0x84, 1, 2, 3, 4]);
        const mixed = new Uint8Array(junk.length + raw.length);
        mixed.set(junk);
        mixed.set(raw, junk.length);
        expect(new MkvSplitter().feed(mixed).map((f) => f.at)).toEqual([0, 40, 80, 120]);
    });
});
