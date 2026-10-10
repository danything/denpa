import { describe, expect, test } from 'bun:test';
import { scanArgs, scanLine } from './cm-scan';

/**
 * CM 検出の材料を1回の復号で取るところ (`cm-scan.ts`)。ffmpeg は動かさず、
 * 渡す引数と、標準エラーの読み方だけを見る
 */
describe('標準エラーの1行を読む', () => {
    test('scdet はコマごとの切れ目と時刻', () => {
        expect(
            scanLine('[Parsed_scdet_0 @ 0x72dc0c002840] lavfi.scd.score: 12.760, lavfi.scd.time: 277.511'),
        ).toEqual({ cut: 12.76, time: 277.511 });
    });

    test('silencedetect は始まりと終わり。始まりが負なら 0', () => {
        expect(scanLine('[silencedetect @ 0x1] silence_start: -0.02')).toEqual({ silenceStart: 0 });
        expect(scanLine('[silencedetect @ 0x1] silence_end: 300.2 | silence_duration: 0.4')).toEqual({
            silenceEnd: 300.2,
        });
    });

    test('読んだ所 (-progress) は秒で', () => {
        expect(scanLine('out_time_us=12500000')).toEqual({ progress: 12.5 });
        expect(scanLine('out_time_us=N/A')).toBeNull();
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
        expect(args).toContain('scdet=threshold=0,crop=10:10:0:0,format=gray');
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
