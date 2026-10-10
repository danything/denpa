import { describe, expect, test } from 'bun:test';
import { scanArgs, scanLine, scanReader } from './cm-scan';

/**
 * CM 検出の材料を1回の復号で取るところ (`cm-scan.ts`)。ffmpeg は動かさず、
 * 渡す引数と、標準エラーの読み方だけを見る
 */
describe('標準エラーの1行を読む', () => {
    test('scdet はコマごとの切れ目と時刻', () => {
        expect(
            scanLine('[scdet@cm @ 0x72dc0c002840] lavfi.scd.score: 12.760, lavfi.scd.time: 277.511'),
        ).toEqual({ cut: 12.76, time: 277.511 });
    });

    test('キーフレームを置くための scdet (焼く鎖のほう) は材料にしない', () => {
        expect(
            scanLine('[scdet@key @ 0x72dc0c002840] lavfi.scd.score: 12.760, lavfi.scd.time: 277.511'),
        ).toBeNull();
    });

    test('silencedetect は始まりと終わり。始まりが負なら 0', () => {
        expect(scanLine('[silencedetect @ 0x1] silence_start: -0.02')).toEqual({ silenceStart: 0 });
        expect(scanLine('[silencedetect @ 0x1] silence_end: 300.2 | silence_duration: 0.4')).toEqual({
            silenceEnd: 300.2,
        });
    });

    test('入れ物の尺 (Duration:) は秒で。ffprobe が使えないときの代わり', () => {
        expect(scanLine('  Duration: 00:30:00.50, start: 6115.51, bitrate: 15000 kb/s')).toEqual({
            duration: 1800.5,
        });
    });

    test('それ以外 (復号の警告など) は捨てる', () => {
        expect(scanLine('[mpeg2video @ 0x1] ac-tex damaged at 12 34')).toBeNull();
        expect(scanLine('')).toBeNull();
    });
});

describe('ffmpeg に渡す引数', () => {
    test('絵は切れ目を測ってからロゴの枠を白黒で切り出し、音は主音声の無音', () => {
        const args = scanArgs('/in.m2ts', {
            video: true,
            audio: true,
            logo: { filter: 'crop=10:10:0:0', size: 100, onFrame: () => {} },
        });
        expect(args).toContain('scdet@cm=threshold=0,crop=10:10:0:0,format=gray');
        // コマを間引かない (時刻とロゴの枠を順番で突き合わせる)
        expect(args.join(' ')).toContain('-fps_mode passthrough');
        expect(args.join(' ')).toContain('-f rawvideo pipe:1');
        expect(args.join(' ')).toContain('-map 0:a:0');
        expect(args.some((a) => a.startsWith('silencedetect='))).toBe(true);
    });

    test('無音だけなら絵を復号しない', () => {
        const args = scanArgs('/in.m2ts', { video: false, audio: true });
        expect(args.some((a) => a.startsWith('scdet'))).toBe(false);
        expect(args).not.toContain('pipe:1');
    });

    test('ロゴの枠だけ読み直すときは音を読まない', () => {
        const args = scanArgs('/in.m2ts', {
            video: true,
            audio: false,
            logo: { filter: 'crop=10:10:0:0', size: 100, onFrame: () => {} },
        });
        expect(args.some((a) => a.startsWith('silencedetect='))).toBe(false);
    });
});

describe('材料を読む', () => {
    test('切れ目・無音・尺を集め、終わりまで続いた無音は尺で閉じる', () => {
        const reader = scanReader(null);
        for (const line of [
            '  Duration: 00:10:00.00, start: 1.400000, bitrate: 15000 kb/s',
            '[scdet@cm @ 0x1] lavfi.scd.score: 0.000, lavfi.scd.time: 0.5',
            '[scdet@cm @ 0x1] lavfi.scd.score: 30.000, lavfi.scd.time: 0.533',
            '[silencedetect @ 0x1] silence_start: 299.5',
            '[silencedetect @ 0x1] silence_end: 300.5 | silence_duration: 1.0',
            '[silencedetect @ 0x1] silence_start: 598',
        ])
            expect(reader.line(line)).toBe(true);
        // 焼くほうの行は読まない (呼ぶ側が落ちた理由として扱う)
        expect(reader.line('frame=10')).toBe(false);
        const found = reader.result(0, '', 599.5);
        expect(found.times).toEqual([0.5, 0.533]);
        expect(found.cuts).toEqual([0, 30]);
        expect(found.silences).toEqual([
            { start: 299.5, end: 300.5 },
            { start: 598, end: 599.5 },
        ]);
        expect(found.duration).toBe(600);
    });

    test('ロゴの枠は塊の境目に関わらずコマごとに渡す', () => {
        const frames: number[] = [];
        const reader = scanReader({ filter: 'crop=2:2:0:0', size: 4, onFrame: (_f, i) => frames.push(i) });
        reader.onStdout?.(new Uint8Array(6));
        reader.onStdout?.(new Uint8Array(6));
        expect(frames).toEqual([0, 1, 2]);
        expect(reader.result(0, '').logoFrames).toBe(3);
    });
});
