import { describe, expect, test } from 'bun:test';
import { CLOCK, WRAP } from './pes';
import { PACKET, SYNC } from './psi';
import { lastVideoPts, type ReadAt, seekTs, sinceHead, tsHead } from './seek';
import { AUDIO_TICKS, FRAME_TICKS, packetizePes, pes } from './synth-av';

/** 空のパケット (PID 0x1FFF)。放送の量 (1 秒に数 MB) に近づけて、二分探索に幅を持たせる */
function nullPacket(): Uint8Array {
    const packet = new Uint8Array(PACKET).fill(0xff);
    packet.set([SYNC, 0x1f, 0xff, 0x10]);
    return packet;
}

/**
 * 合成した録画。映像 (29.97 コマ/秒) と音声 (AAC のコマ) の PES に、コマごとに空のパケットを挟む。
 * 音声は映像より `audioLead` 秒早く始まる (放送もそう)
 */
function recording(start: number, seconds: number, audioLead = 0.5, fill = 40): Uint8Array {
    const parts: Uint8Array[] = [];
    const filler = nullPacket();
    let video = 0;
    let audio = 0;
    let at = 0;
    const end = Math.round(seconds * CLOCK);
    const lead = Math.round(audioLead * CLOCK);
    while (at < end) {
        // 音声を映像に追いつくまで出す
        while (audio * AUDIO_TICKS <= at + lead) {
            const out = packetizePes(0x111, pes(0xc0, start + audio * AUDIO_TICKS, new Uint8Array(7)), audio);
            parts.push(out.packets);
            audio++;
        }
        const out = packetizePes(0x100, pes(0xe0, start + lead + at, new Uint8Array(300)), video);
        parts.push(out.packets);
        for (let i = 0; i < fill; i++) parts.push(filler);
        video++;
        at = video * FRAME_TICKS;
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function readerOf(bytes: Uint8Array): ReadAt {
    return async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length));
}

describe('入れ物の始まり (tsHead)', () => {
    test('映像と音声の最初の PTS のうち早いほう (ffmpeg の start_time と同じ)', () => {
        const bytes = recording(900_000, 5, 0.5);
        // 音声が 0.5 秒先に始まる
        expect(tsHead(bytes.subarray(0, 1024 * 1024))).toBe(900_000);
    });

    test('一周の直前から始まっても、またいだ先を頭にしない', () => {
        const start = WRAP - 0.2 * CLOCK;
        const bytes = recording(start, 3, 0.5);
        expect(tsHead(bytes)).toBe(start);
    });

    test('PES が無ければ null', () => {
        expect(tsHead(new Uint8Array(PACKET * 10).fill(0))).toBeNull();
    });
});

describe('頭から数えた秒 (sinceHead)', () => {
    test('一周をまたいでも増え続ける', () => {
        const head = WRAP - 10 * CLOCK;
        expect(sinceHead(head + 5 * CLOCK, head)).toBe(5);
        // 一周して小さな値に戻ったもの
        expect(sinceHead(20 * CLOCK, head)).toBe(30);
    });

    test('頭の少し前 (並べ替え・音声との頭のずれ) は負', () => {
        expect(sinceHead(900_000 - 9_000, 900_000)).toBeCloseTo(-0.1, 6);
        expect(sinceHead(WRAP - 9_000, 0)).toBeCloseTo(-0.1, 6);
    });
});

describe('時刻から位置を引く (seekTs)', () => {
    const start = 1_000_000;
    const bytes = recording(start, 120);
    const head = tsHead(bytes) as number;
    const read = readerOf(bytes);

    test('指定した時刻の手前でいちばん近い映像の PES', async () => {
        for (const target of [7.3, 33, 59.99, 101.5]) {
            const mark = await seekTs(read, bytes.length, head, target);
            expect(mark).not.toBeNull();
            const at = sinceHead(mark!.pts, head);
            expect(at).toBeLessThanOrEqual(target);
            expect(target - at).toBeLessThan(FRAME_TICKS / CLOCK + 1e-9);
            // 返した位置はその PES の頭のパケット
            expect(bytes[mark!.at]).toBe(SYNC);
            expect(bytes[mark!.at + 1]! & 0x40).toBe(0x40);
        }
    });

    test('頭より前なら頭の映像、尻より後ろなら最後の映像', async () => {
        const first = await seekTs(read, bytes.length, head, 0);
        expect(sinceHead(first!.pts, head)).toBeCloseTo(0.5, 3);
        const last = await seekTs(read, bytes.length, head, 10_000);
        expect(last!.pts).toBe(lastVideoPts(bytes)!);
    });

    test('PTS が一周をまたぐ録画でも引ける', async () => {
        // 30 秒で一周する
        const wrapping = recording(WRAP - 30 * CLOCK, 90);
        const wrapHead = tsHead(wrapping) as number;
        const wrapRead = readerOf(wrapping);
        for (const target of [10, 29.5, 31, 75]) {
            const mark = await seekTs(wrapRead, wrapping.length, wrapHead, target);
            const at = sinceHead(mark!.pts, wrapHead);
            expect(at).toBeLessThanOrEqual(target);
            expect(target - at).toBeLessThan(FRAME_TICKS / CLOCK + 1e-9);
        }
        // またいだ後ろは PTS が小さい
        const after = await seekTs(wrapRead, wrapping.length, wrapHead, 75);
        expect(after!.pts).toBeLessThan(60 * CLOCK);
    });

    test('尻の映像の PTS から尺を出せる', () => {
        expect(sinceHead(lastVideoPts(bytes)!, head)).toBeCloseTo(120, 0);
    });
});
