import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkvFromClip } from '../../../tests/fake/mkv-clip';
import { opusHead } from './fmp4';
import {
    asFmp4Track,
    cueBefore,
    elementSize,
    MkvDemuxer,
    opusDops,
    readCues,
    readMkvHead,
} from './mkv-media';

/**
 * 作り置きの fMP4 (本物の ffmpeg が書いた AV1 + Opus・H.264 + AAC) から組んだ Matroska で確かめる
 * (`tests/fake/mkv-clip.ts`。端末に保存した録画と同じ並び)
 */
const av1 = mkvFromClip(
    new Uint8Array(readFileSync(new URL('../../../tests/fake/live-av1.mp4', import.meta.url))),
    10,
);
const h264 = mkvFromClip(
    new Uint8Array(readFileSync(new URL('../../../tests/fake/live-h264.mp4', import.meta.url))),
    6,
    '副音声',
);

describe('readMkvHead', () => {
    test('頭から軌道の形・尺・Cues の在りか・最初の Cluster を読む', () => {
        const head = readMkvHead(av1);
        expect(head).not.toBeNull();
        if (head === null) return;
        expect(head.duration).toBeCloseTo(10, 3);
        expect(head.scale).toBe(1_000_000);
        const [video, audio] = head.tracks;
        expect(video?.kind).toBe('video');
        expect(video?.codec).toMatch(/^av01\.0\.\d\dM\.08$/);
        expect(video?.width).toBe(320);
        expect(audio?.codec).toBe('opus');
        expect(audio?.name).toBe('主音声');
        expect(audio?.language).toBe('jpn');
        expect(head.firstCluster).toBeGreaterThan(head.segment);
        expect(head.cues).not.toBeNull();
    });

    test('H.264 + AAC も読む', () => {
        const head = readMkvHead(h264);
        expect(head?.tracks[0]?.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
        expect(head?.tracks[1]?.codec).toBe('mp4a.40.2');
        expect(head?.tracks[1]?.name).toBe('副音声');
    });

    test('最初の Cluster まで届いていなければ null (もっと読んで渡し直す)', () => {
        expect(readMkvHead(av1.subarray(0, 100))).toBeNull();
    });
});

describe('Cues', () => {
    test('映像の軌道の位置を、時刻の順に読む。飛ぶ先の手前の Cluster を引く', () => {
        const head = readMkvHead(av1)!;
        const at = head.cues!;
        const length = elementSize(av1.subarray(at, at + 16))!;
        const cues = readCues(av1.subarray(at, at + length), head.scale, 1);
        expect(cues.length).toBeGreaterThan(5);
        expect(cues[0]!.time).toBe(0);
        expect(cueBefore(cues, 4.5)!.time).toBeLessThanOrEqual(4.5);
        expect(cueBefore(cues, 4.5)!.time).toBeGreaterThan(3);
        // 引いた位置は Cluster の頭
        const cluster = av1.subarray(head.segment + cueBefore(cues, 4.5)!.position);
        expect(Array.from(cluster.subarray(0, 4))).toEqual([0x1f, 0x43, 0xb6, 0x75]);
    });
});

describe('MkvDemuxer', () => {
    test('軌道の形とコマを取り出す。細切れに届いても同じ', () => {
        const whole = new MkvDemuxer().feed(av1);
        const demuxer = new MkvDemuxer();
        let tracks = null;
        const blocks = [];
        for (let at = 0; at < av1.length; at += 997) {
            const out = demuxer.feed(av1.subarray(at, at + 997));
            tracks ??= out.tracks;
            blocks.push(...out.blocks);
        }
        expect(tracks?.length).toBe(2);
        expect(blocks.length).toBe(whole.blocks.length);
        expect(blocks.map((b) => b.at)).toEqual(whole.blocks.map((b) => b.at));
        const video = blocks.filter((b) => b.track === 1);
        expect(video[0]?.key).toBe(true);
        expect(video.some((b) => !b.key)).toBe(true);
        // 10 秒ぶん (30 コマ/秒)
        expect(video.length).toBeGreaterThan(280);
        expect(blocks.filter((b) => b.track === 2).length).toBeGreaterThan(100);
    });

    test('頭に飛び先の Cluster からを繋いでも読める (飛ぶとき)', () => {
        const head = readMkvHead(av1)!;
        const at = head.cues!;
        const cues = readCues(av1.subarray(at, at + elementSize(av1.subarray(at, at + 16))!), head.scale, 1);
        const cue = cueBefore(cues, 6)!;
        const joined = new Uint8Array([
            ...av1.subarray(0, head.firstCluster),
            ...av1.subarray(head.segment + cue.position),
        ]);
        const { tracks, blocks } = new MkvDemuxer().feed(joined);
        expect(tracks?.length).toBe(2);
        expect(blocks[0]!.at).toBe(Math.round(cue.time * 1000));
        expect(blocks.find((b) => b.track === 1)?.key).toBe(true);
    });
});

describe('解く側へ渡す形', () => {
    test('OpusHead を dOps に直す (opusHead の逆)', () => {
        const head = readMkvHead(av1)!;
        const opus = head.tracks[1]!;
        const dOps = opusDops(opus.config)!;
        expect(Array.from(opusHead(dOps)!)).toEqual(Array.from(opus.config));
        const track = asFmp4Track(opus, head.scale);
        expect(track?.timescale).toBe(1000);
        expect(track?.codec).toBe('opus');
    });
});
