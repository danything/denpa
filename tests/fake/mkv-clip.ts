/**
 * **作り置きの fMP4 (`live-av1.mp4` / `live-h264.mp4`) から、端末に保存した録画のふりをする Matroska を組む。**
 * 単体試験 (`src/lib/ts/mkv-media.test.ts`) と E2E (`41-watch-compat-local`) が使う。
 *
 * 偽 ffmpeg が焼く録画は中身が無い (0 が並んでいるだけ) ので、互換モードで描くところまで見るには
 * 本物の映像と音の入った mkv が要る。ffmpeg の Matroska と同じ並びにする — SeekHead (Cues の在りか)・
 * Info・Tracks (CodecPrivate)・Cluster (1 秒ごと、鍵のコマで区切る)・Cues。字幕の軌道は入れない。
 *
 * 大きさは全部 8 バイトで書く (先に大きさを決めずに組めて、位置の計算が楽)。Bun にも Node にも依らない
 */

import { opusHead, readFragment, readInit } from '../../src/lib/ts/fmp4';
import { clipFrom, readClip } from './fmp4-clip';

function join(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/** ID はそのままの並び (印込み) */
function id(value: number): Uint8Array {
    const bytes: number[] = [];
    for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    return Uint8Array.from(bytes);
}

/** 大きさは 8 バイトの可変長整数で書く */
function size(value: number): Uint8Array {
    const out = new Uint8Array(8);
    out[0] = 0x01;
    let v = value;
    for (let i = 7; i >= 1; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
    }
    return out;
}

function el(tag: number, ...body: Uint8Array[]): Uint8Array {
    const inner = join(body);
    return join([id(tag), size(inner.length), inner]);
}

/** 符号なし整数 (8 バイトで書く。位置を後から埋めても大きさが変わらない) */
function u(tag: number, value: number): Uint8Array {
    const body = new Uint8Array(8);
    let v = value;
    for (let i = 7; i >= 0; i--) {
        body[i] = v % 256;
        v = Math.floor(v / 256);
    }
    return el(tag, body);
}

function f64(tag: number, value: number): Uint8Array {
    const body = new Uint8Array(8);
    new DataView(body.buffer).setFloat64(0, value);
    return el(tag, body);
}

function str(tag: number, value: string): Uint8Array {
    return el(tag, new TextEncoder().encode(value));
}

interface Frame {
    track: number;
    /** ms */
    at: number;
    key: boolean;
    data: Uint8Array;
}

/**
 * `file` (作り置きの fMP4) を `length` 秒ぶん並べて、Matroska にする。映像は軌道 1、音は軌道 2 (名前は `audioName`)
 */
export function mkvFromClip(file: Uint8Array, length: number, audioName = '主音声'): Uint8Array {
    const clip = readClip(file);
    const data = clipFrom(clip, 0, length);
    const tracks = readInit(data);
    const video = tracks.find((t) => t.kind === 'video');
    const audio = tracks.find((t) => t.kind === 'audio');
    if (video === undefined || audio === undefined) throw new Error('映像と音が要ります');

    const frames: Frame[] = [];
    // 媒体ごとに読む (頭の後ろから moof + mdat が並ぶ)
    const head = clip.head.length;
    for (const sample of readFragment(data.subarray(head), tracks)) {
        const track = tracks.find((t) => t.id === sample.track)!;
        frames.push({
            track: track === video ? 1 : 2,
            at: Math.round((sample.pts * 1000) / track.timescale),
            key: track === video ? sample.key : true,
            data: sample.data,
        });
    }
    frames.sort((a, b) => a.at - b.at || a.track - b.track);

    const opus = audio.codec === 'opus';
    const trackEntries = el(
        0x1654ae6b,
        el(
            0xae,
            u(0xd7, 1),
            u(0x83, 1),
            str(0x86, video.codec.startsWith('av01') ? 'V_AV1' : 'V_MPEG4/ISO/AVC'),
            el(0x63a2, video.config),
            u(0x23e383, Math.round(1e9 / 30)),
            el(0xe0, u(0xb0, video.width), u(0xba, video.height)),
        ),
        el(
            0xae,
            u(0xd7, 2),
            u(0x83, 2),
            str(0x86, opus ? 'A_OPUS' : 'A_AAC'),
            el(0x63a2, opus ? (opusHead(audio.config) ?? new Uint8Array(0)) : audio.config),
            str(0x536e, audioName),
            str(0x22b59c, 'jpn'),
            el(0xe1, f64(0xb5, audio.sampleRate || 48000), u(0x9f, audio.channels || 2)),
        ),
    );
    const info = el(0x1549a966, u(0x2ad7b1, 1_000_000), f64(0x4489, length * 1000));

    // Cluster は 1 秒たって次の映像の鍵のコマが来たら区切る
    const clusters: { at: number; bytes: Uint8Array }[] = [];
    let current: Frame[] = [];
    const flush = () => {
        if (current.length === 0) return;
        const base = current[0]!.at;
        const blocks = current.map((frame) => {
            const block = new Uint8Array(4 + frame.data.length);
            block[0] = 0x80 | frame.track;
            new DataView(block.buffer).setInt16(1, frame.at - base);
            block[3] = frame.key ? 0x80 : 0;
            block.set(frame.data, 4);
            return el(0xa3, block);
        });
        clusters.push({ at: base, bytes: el(0x1f43b675, u(0xe7, base), ...blocks) });
        current = [];
    };
    for (const frame of frames) {
        if (frame.track === 1 && frame.key && current.length > 0 && frame.at - current[0]!.at >= 1000)
            flush();
        current.push(frame);
    }
    flush();

    // 位置は Segment の中身の頭から。SeekHead の大きさは中身で決まらない (8 バイト固定) ので、先に組める
    const seekHead = (cuesAt: number) =>
        el(0x114d9b74, el(0x4dbb, el(0x53ab, id(0x1c53bb6b)), u(0x53ac, cuesAt)));
    const lead = seekHead(0).length + info.length + trackEntries.length;
    let at = lead;
    const positions = clusters.map((cluster) => {
        const here = at;
        at += cluster.bytes.length;
        return here;
    });
    const cues = el(
        0x1c53bb6b,
        ...clusters.map((cluster, i) =>
            el(0xbb, u(0xb3, cluster.at), el(0xb7, u(0xf7, 1), u(0xf1, positions[i]!))),
        ),
    );
    const segment = el(
        0x18538067,
        seekHead(at),
        info,
        trackEntries,
        ...clusters.map((cluster) => cluster.bytes),
        cues,
    );
    const ebml = el(
        0x1a45dfa3,
        u(0x4286, 1),
        u(0x42f7, 1),
        str(0x4282, 'matroska'),
        u(0x4287, 4),
        u(0x4285, 2),
    );
    return join([ebml, segment]);
}
