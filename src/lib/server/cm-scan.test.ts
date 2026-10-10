import { describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { parseCuts, parseSilences, scanLine, scanOutputs, scanReader } from './cm-scan';

/**
 * CM 検出の材料を1回の復号で取るところ (`cm-scan.ts`)。ffmpeg は動かさず、
 * 渡す引数と、書き出しの読み方だけを見る
 */
const files = { cuts: '/tmp/x.cuts', silences: '/tmp/x.silences' };

describe('書き出しを読む', () => {
    test('切れ目はコマごとの時刻と点 (metadata の1コマ2行)', () => {
        const text = [
            'frame:0    pts:58316   pts_time:0.647956',
            'lavfi.scd.score=0.000',
            'frame:1    pts:61319   pts_time:0.681322',
            'lavfi.scd.score=12.760',
            '',
        ].join('\n');
        expect(parseCuts(text)).toEqual({ times: [0.647956, 0.681322], cuts: [0, 12.76] });
    });

    test('無音は始まりと終わりの印から。始まりが負なら 0、終わりまで続いたものは尺で閉じる', () => {
        const text = [
            'frame:880  pts:901120  pts_time:18.773333',
            'lavfi.silence_start=-0.02',
            'frame:941  pts:963584  pts_time:20.074667',
            'lavfi.silence_end=20.092417',
            'lavfi.silence_duration=1.449896',
            'frame:1377 pts:1410048 pts_time:29.376',
            'lavfi.silence_start=598',
        ].join('\n');
        expect(parseSilences(text, 599.5)).toEqual([
            { start: 0, end: 20.092417 },
            { start: 598, end: 599.5 },
        ]);
        // 尺が分からなければ閉じない
        expect(parseSilences(text, Number.NaN)).toHaveLength(1);
    });

    test('標準エラーからは入れ物の尺だけ', () => {
        expect(scanLine('  Duration: 00:30:00.50, start: 6115.51, bitrate: 15000 kb/s')).toEqual({
            duration: 1800.5,
        });
        expect(scanLine('[scdet@cm @ 0x1] lavfi.scd.score: 100.000, lavfi.scd.time: 1.0')).toBeNull();
        expect(scanLine('[mpeg2video @ 0x1] ac-tex damaged at 12 34')).toBeNull();
    });
});

describe('ffmpeg に渡す出口', () => {
    test('絵は切れ目の点を書き出してからロゴの枠を白黒で切り出し、音は主音声の無音を書き出す', () => {
        const args = scanOutputs(
            { video: true, audio: true, logo: { filter: 'crop=10:10:0:0', size: 100, onFrame: () => {} } },
            files,
        );
        expect(args).toContain(
            'scdet@cm=threshold=100,metadata=mode=print:key=lavfi.scd.score:file=/tmp/x.cuts,crop=10:10:0:0,format=gray',
        );
        // コマを間引かない (時刻とロゴの枠を順番で突き合わせる)
        expect(args.join(' ')).toContain('-fps_mode passthrough');
        expect(args.join(' ')).toContain('-f rawvideo pipe:1');
        expect(args.join(' ')).toContain('-map 0:a:0');
        expect(
            args.some(
                (a) =>
                    a.startsWith('silencedetect=') && a.endsWith('ametadata=mode=print:file=/tmp/x.silences'),
            ),
        ).toBe(true);
    });

    test('音だけなら絵を復号しない', () => {
        const args = scanOutputs({ video: false, audio: true }, files);
        expect(args.some((a) => a.includes('scdet'))).toBe(false);
        expect(args).not.toContain('pipe:1');
    });

    test('ロゴの枠だけ読み直すときは音を読まない', () => {
        const args = scanOutputs(
            { video: true, audio: false, logo: { filter: 'crop=10:10:0:0', size: 100, onFrame: () => {} } },
            files,
        );
        expect(args.some((a) => a.startsWith('silencedetect='))).toBe(false);
    });
});

describe('読み手', () => {
    test('書き出しを読んで片付ける。ロゴの枠は塊の境目に関わらずコマごとに渡す', () => {
        const frames: number[] = [];
        const reader = scanReader({
            video: true,
            audio: true,
            logo: { filter: 'crop=2:2:0:0', size: 4, onFrame: (_f, i) => frames.push(i) },
        });
        const cuts = /file=([^,]+\.cuts)/.exec(reader.outputs.join(' '))![1]!;
        const silences = /file=([^,\s]+\.silences)/.exec(reader.outputs.join(' '))![1]!;
        writeFileSync(
            cuts,
            'frame:0 pts:0 pts_time:0.5\nlavfi.scd.score=1\nframe:1 pts:1 pts_time:0.533\nlavfi.scd.score=30\n',
        );
        writeFileSync(silences, 'frame:1 pts:1 pts_time:1\nlavfi.silence_start=1\n');
        reader.onStdout?.(new Uint8Array(6));
        reader.onStdout?.(new Uint8Array(2));
        expect(reader.line('  Duration: 00:10:00.00, start: 1.400000, bitrate: 15000 kb/s')).toBe(true);
        const found = reader.result(0, '', 599.5);
        expect(found.times).toEqual([0.5, 0.533]);
        expect(found.cuts).toEqual([1, 30]);
        expect(found.silences).toEqual([{ start: 1, end: 599.5 }]);
        expect(found.logoFrames).toBe(2);
        expect(frames).toEqual([0, 1]);
        expect(found.duration).toBe(600);
        expect(existsSync(cuts) || existsSync(silences)).toBe(false);
    });
});
