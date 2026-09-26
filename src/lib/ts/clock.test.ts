import { describe, expect, test } from 'bun:test';
import { BroadcastClock, parseStart, readPcr } from './clock';
import { PID_PAT } from './psi';
import { packetize, patSection, pcrPacket, programMap, stream } from './synth';

const PID_PMT = 0x1000;
const PID_PCR = 0x0100;

/** 1局に絞った TS のつもり。PAT → PMT → PCR の順で流す */
function tune(clock: BroadcastClock, pcr: number, receivedAt: number): void {
    clock.feed(
        stream(
            packetize(PID_PAT, patSection([[1, PID_PMT]])),
            packetize(PID_PMT, programMap(1, PID_PCR, [[0x02, PID_PCR]])),
            pcrPacket(PID_PCR, pcr),
        ),
        receivedAt,
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

describe('PCR と受け取った時刻を組にする', () => {
    const at = Date.UTC(2026, 8, 26, 1, 0, 0);

    /** **TDT を待たない。** PCR が1つ着けば組になる */
    test('着いた PCR と受け取った時刻を組にする', () => {
        const clock = new BroadcastClock();
        expect(clock.anchor).toBeNull();
        tune(clock, 1000, at);
        expect(clock.anchor).toEqual({ pcr: 1000, unixMs: at });
        expect(clock.now).toBeCloseTo(1000, 4);
    });

    /** 遅れて読んだ組を採ると、そのぶん「放送から」が小さく出る */
    test('いちばん遅れずに着いた組を採る', () => {
        const clock = new BroadcastClock();
        tune(clock, 1000, at);
        // 0.3秒詰まってから読んだ。**採り直さない**
        clock.feed(pcrPacket(PID_PCR, 1001), at + 1300);
        expect(clock.anchor).toEqual({ pcr: 1000, unixMs: at });
        // 最初の組より 0.05秒 早く着いた。こちらが勝つ
        clock.feed(pcrPacket(PID_PCR, 1002), at + 1950);
        expect(clock.anchor).toEqual({ pcr: 1002, unixMs: at + 1950 });
    });

    /** 1つの塊はどれも同じ時刻で受け取る。**塊の最後の PCR** が選ばれる */
    test('塊の中では最後の PCR が選ばれる', () => {
        const clock = new BroadcastClock();
        tune(clock, 1000, at);
        clock.feed(stream(pcrPacket(PID_PCR, 1004.9), pcrPacket(PID_PCR, 1005)), at + 4990);
        expect(clock.anchor).toEqual({ pcr: 1005, unixMs: at + 4990 });
    });

    /** PCR とサーバの時計は別の水晶。**古い組を永久には持たない** */
    test('30秒ごとに選び直す (1つ前の区切りまでは比べる)', () => {
        const clock = new BroadcastClock();
        tune(clock, 1000, at);
        // 次の区切り。まだ前の組のほうが早い
        clock.feed(pcrPacket(PID_PCR, 1031), at + 31_010);
        expect(clock.anchor).toEqual({ pcr: 1000, unixMs: at });
        // もう1つ先の区切り。最初の組は捨てられ、遅れて見える組しか残らない
        clock.feed(pcrPacket(PID_PCR, 1062), at + 62_030);
        expect(clock.anchor).toEqual({ pcr: 1031, unixMs: at + 31_010 });
    });

    /**
     * **一周したら組み直す。** 足し込む作りにすると、選局直後の飛びまで
     * 拾って時刻が何時間もずれる
     */
    test('PCR が巻き戻ったら組み直す', () => {
        const clock = new BroadcastClock();
        tune(clock, 5000, at);
        clock.feed(pcrPacket(PID_PCR, 10), at + 100);
        expect(clock.anchor).toEqual({ pcr: 10, unixMs: at + 100 });
    });

    /** PMT が言う PCR の ES だけを見る。ほかの ES の PCR は拾わない */
    test('PCR を運ぶ ES だけを見る', () => {
        const clock = new BroadcastClock();
        tune(clock, 1000, at);
        clock.feed(pcrPacket(0x0200, 2000), at + 10);
        expect(clock.anchor).toEqual({ pcr: 1000, unixMs: at });
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
