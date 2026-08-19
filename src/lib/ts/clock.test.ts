import { describe, expect, test } from 'bun:test';
import { BroadcastClock, broadcastTime, parseStart, readPcr } from './clock';
import { packetize, patSection, pcrPacket, programMap, stream, tdtPacket } from './synth';

const PID_PAT = 0x0000;
const PID_PMT = 0x1000;
const PID_PCR = 0x0100;

/** 1局に絞った TS のつもり。PAT → PMT → PCR → TDT の順で流す */
function feed(clock: BroadcastClock, pcr: number, unixMs: number): void {
    clock.feed(
        stream(
            packetize(PID_PAT, patSection([[1, PID_PMT]])),
            packetize(PID_PMT, programMap(1, PID_PCR, [[0x02, PID_PCR]])),
            pcrPacket(PID_PCR, pcr),
            tdtPacket(unixMs),
        ),
    );
}

describe('PCR を読む', () => {
    test('適応フィールドの基準部を秒にする', () => {
        expect(readPcr(pcrPacket(PID_PCR, 1234.5))).toBeCloseTo(1234.5, 4);
    });

    test('PCR の入っていないパケットは NaN', () => {
        // 中身だけのパケット (適応フィールドなし)
        expect(Number.isNaN(readPcr(packetize(PID_PCR, patSection([[1, PID_PMT]]))))).toBe(true);
        expect(Number.isNaN(readPcr(new Uint8Array(4)))).toBe(true);
    });
});

describe('放送の実時刻と PCR を組にする', () => {
    /** TDT は秒単位。**組にするのは「TDT が来た瞬間の PCR」** */
    test('TDT が来た瞬間の PCR と組にする', () => {
        const clock = new BroadcastClock();
        expect(clock.anchor).toBeNull();
        const at = Math.floor(Date.UTC(2026, 7, 19, 3, 0, 0) / 1000) * 1000;
        feed(clock, 1000, at);
        expect(clock.anchor).toEqual({ pcr: 1000, unixMs: at });
        expect(clock.now).toBeCloseTo(1000, 4);
    });

    /**
     * **一周したら組み直す。** 足し込む作りにすると、選局直後の飛びまで
     * 拾って時刻が何時間もずれる
     */
    test('PCR が巻き戻ったら組を捨てる', () => {
        const clock = new BroadcastClock();
        const at = Math.floor(Date.UTC(2026, 7, 19, 3, 0, 0) / 1000) * 1000;
        feed(clock, 5000, at);
        expect(clock.anchor).not.toBeNull();
        clock.feed(pcrPacket(PID_PCR, 10));
        expect(clock.anchor).toBeNull();
    });
});

describe('焼いたものの時刻を放送の実時刻に直す', () => {
    const anchor = { pcr: 72575.5, unixMs: 1_787_000_000_000 };

    /** ffmpeg は入口の時刻を 0 に寄せるので、寄せたぶんを足し戻す */
    test('寄せたぶんを足し戻して引き算する', () => {
        // 焼いたものの 0 秒 = 入口の 72575.147 秒。組の 0.353 秒前にあたる
        expect(broadcastTime(anchor, 72575.147, 0)).toBe(anchor.unixMs - 353);
        expect(broadcastTime(anchor, 72575.147, 10)).toBe(anchor.unixMs + 9647);
    });

    test('寄せたぶんが分からなければ言わない', () => {
        expect(broadcastTime(anchor, Number.NaN, 0)).toBeNull();
    });
});

describe('ffmpeg の start: を読む', () => {
    test('入口の見出しから拾う', () => {
        expect(parseStart('  Duration: N/A, start: 72575.147089, bitrate: N/A')).toBeCloseTo(72575.147089, 6);
        expect(parseStart('  Duration: N/A, start: -0.100000, bitrate: N/A')).toBeCloseTo(-0.1, 6);
    });

    test('関係のない行は NaN', () => {
        expect(Number.isNaN(parseStart('Stream #0:0[0x111]: Video: mpeg2video'))).toBe(true);
    });
});
