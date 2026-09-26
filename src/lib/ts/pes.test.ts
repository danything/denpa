import { describe, expect, test } from 'bun:test';
import { AdtsSplitter, PesDemuxer, parsePes, unwrap, WRAP } from './pes';
import { packetize, patSection, programMap } from './synth';
import { AUDIO_TICKS, FRAME_TICKS, mpeg2Frame, packetizePes, pes, silentAac } from './synth-av';

/**
 * 生で送る道の受け口。**ffmpeg がやっていた「TS を PES に戻す」を自前でやる**ので、
 * 組み立てた放送 (`synth-av.ts`) を食わせて、映像の1枚・音声の1コマが時刻ごと
 * そのまま戻ってくるかを見る。
 */

const VIDEO = 0x100;
const AUDIO: [number, number] = [0x110, 0x111];

function head(): Uint8Array {
    return Uint8Array.from([
        ...packetize(0x0000, patSection([[1024, 0x1f0]])),
        ...packetize(
            0x1f0,
            programMap(1024, VIDEO, [
                [0x02, VIDEO],
                [0x0f, AUDIO[0]],
                [0x0f, AUDIO[1]],
            ]),
        ),
    ]);
}

describe('PesDemuxer', () => {
    test('映像の1枚と時刻が戻る。**長さ 0 の PES は次の頭で出てくる**', () => {
        const demuxer = new PesDemuxer();
        const frames = [0, 1, 2].map((n) => mpeg2Frame(n));
        let counter = 0;
        const parts: number[] = [...head()];
        frames.forEach((frame, n) => {
            const out = packetizePes(VIDEO, pes(0xe0, 90_000 + n * FRAME_TICKS, frame), counter, 80_000);
            counter = out.counter;
            parts.push(...out.packets);
        });
        const { pes: found, changed } = demuxer.feed(Uint8Array.from(parts));
        expect(changed).toBe(true);
        expect(demuxer.streams).toEqual({ video: VIDEO, audio: AUDIO });
        // 3枚目は次の頭が来るまで終わりが分からない
        expect(found.map((p) => p.pts)).toEqual([90_000, 90_000 + FRAME_TICKS]);
        expect(found[0]!.data).toEqual(frames[0]!);
        expect(found[1]!.kind).toBe('video');
    });

    test('音声は選んだ1本だけ組み立てる。長さが書いてあるので揃った時点で出る', () => {
        const demuxer = new PesDemuxer();
        demuxer.feed(head());
        const frame = silentAac();
        const two = Uint8Array.from([...frame, ...frame]);
        const first = packetizePes(AUDIO[0], pes(0xc0, 5000, two), 0).packets;
        const second = packetizePes(AUDIO[1], pes(0xc0, 7000, two), 0).packets;
        const got = demuxer.feed(Uint8Array.from([...first, ...second])).pes;
        expect(got.map((p) => [p.pid, p.pts])).toEqual([[AUDIO[0], 5000]]);

        demuxer.selectAudio(1);
        const again = demuxer.feed(Uint8Array.from([...first, ...second])).pes;
        expect(again.map((p) => [p.pid, p.pts])).toEqual([[AUDIO[1], 7000]]);
    });

    test('無い番号の音声を頼まれたら先頭に落とす (番組が変わって減ったとき)', () => {
        const demuxer = new PesDemuxer();
        demuxer.audioIndex = 5;
        demuxer.feed(head());
        expect(demuxer.audioPid).toBe(AUDIO[0]);
    });
});

describe('parsePes', () => {
    test('PTS と DTS を読む。DTS が無ければ PTS と同じ', () => {
        const parsed = parsePes(pes(0xe0, 2 ** 32 + 12345, Uint8Array.from([1, 2, 3])));
        expect(parsed?.pts).toBe(2 ** 32 + 12345);
        expect(parsed?.dts).toBe(2 ** 32 + 12345);
        expect([...(parsed?.data ?? [])]).toEqual([1, 2, 3]);
    });

    test('頭が壊れていれば null', () => {
        expect(parsePes(Uint8Array.from([0, 0, 2, 0xe0, 0, 0, 0x80, 0x80, 5]))).toBeNull();
    });
});

describe('AdtsSplitter', () => {
    test('コマごとに割り、続くコマには1コマぶんずつ時刻を足す', () => {
        const splitter = new AdtsSplitter();
        const frame = silentAac();
        const out = splitter.feed(Uint8Array.from([...frame, ...frame, ...frame]), 1000);
        expect(out.map((f) => f.pts)).toEqual([1000, 1000 + AUDIO_TICKS, 1000 + 2 * AUDIO_TICKS]);
        expect(out[0]).toMatchObject({ sampleRate: 48000, channels: 2, duration: AUDIO_TICKS });
    });

    test('PES をまたいだコマは、前の続きの時刻で出る', () => {
        const splitter = new AdtsSplitter();
        const frame = silentAac();
        const joined = Uint8Array.from([...frame, ...frame]);
        const cut = frame.length + 3;
        expect(splitter.feed(joined.subarray(0, cut), 1000).map((f) => f.pts)).toEqual([1000]);
        // 次の PES の時刻は、余りから始まるコマには使わない
        expect(splitter.feed(joined.subarray(cut), 99_999).map((f) => f.pts)).toEqual([1000 + AUDIO_TICKS]);
    });
});

describe('unwrap', () => {
    test('一周をまたいでも手元の物差しの近くに置く', () => {
        expect(unwrap(100, WRAP + 50)).toBe(WRAP + 100);
        expect(unwrap(WRAP - 100, WRAP + 50)).toBe(WRAP - 100);
        expect(unwrap(500, 400)).toBe(500);
    });
});
