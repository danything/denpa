import { describe, expect, test } from 'bun:test';
import type { ResponseMessage } from '$lib/vendor/web-bml/server/ws_api';
import {
    captureDataBroadcast,
    feedFor,
    type PlacedMessage,
    playbackMsAt,
    replayAt,
    toPlaybackTimeline,
} from './data-timeline';
import { bxmlDescriptor, ddbSection, diiSection, packetize, patSection, programMap } from './synth';

/*
 * 録画のデータ放送。**ライブ (carousel.ts) と違って時間変化を持つ。**
 *
 * エンコードのついでに元TSを解いて、配られた変化を実時刻つきで並べ (captureDataBroadcast)、
 * 再生位置に当たる時刻までを積み直して画面を作る (replayAt)。ここはその中核。
 */

const SERVICE = 1024;
const PMT_PID = 0x1f0;
const VIDEO_PID = 0x0111;
const BML_PID = 0x0800;
const DOWNLOAD_ID = 0xf0000001;
const COMPONENT_TAG = 0x40;

function stream(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/** BML の ES が1本だけ載った PMT */
function bmlPmt(): Uint8Array {
    return programMap(SERVICE, VIDEO_PID, [
        [0x02, VIDEO_PID, [0x52, 0x01, 0x00]],
        [0x0d, BML_PID, [0x52, 0x01, COMPONENT_TAG, ...bxmlDescriptor()]],
    ]);
}

/** モジュール1つぶんの multipart */
function multipart(body: string): Uint8Array {
    const boundary = 'denpa';
    const out =
        `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n` +
        `--${boundary}\r\nContent-Type: text/X-arib-bml\r\nContent-Location: /startup.bml\r\n\r\n${body}\r\n` +
        `--${boundary}--\r\n`;
    return new TextEncoder().encode(out);
}

/** DII と DDB を並べて、1つのモジュールを配りきる。版ごとに回 (transaction) を変える */
function carousel(module: Uint8Array, version: number): Uint8Array[] {
    const spec = {
        moduleId: 1,
        moduleSize: module.length,
        moduleVersion: version,
        contentType: 'multipart/mixed',
    };
    return [
        packetize(BML_PID, diiSection(DOWNLOAD_ID, 4066, spec, version)),
        packetize(BML_PID, ddbSection(DOWNLOAD_ID, 1, version, 0, module)),
    ];
}

/** 放送の実時刻 (TDT)。unix ms を JST の MJD + BCD 時分秒にする */
function tdt(unixMs: number): Uint8Array {
    const jst = unixMs + 9 * 3600 * 1000;
    const days = Math.floor(jst / 86400000) + 40587;
    const ofDay = jst % 86400000;
    const bcd = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;
    const section = Uint8Array.from([
        0x70,
        0x70,
        0x05,
        (days >> 8) & 0xff,
        days & 0xff,
        bcd(Math.floor(ofDay / 3600000)),
        bcd(Math.floor((ofDay % 3600000) / 60000)),
        bcd(Math.floor((ofDay % 60000) / 1000)),
    ]);
    return packetize(0x0014, section);
}

const head = [packetize(0x0000, patSection([[SERVICE, PMT_PID]])), packetize(PMT_PID, bmlPmt())];

function bmlBody(message: ResponseMessage): string | null {
    if (message.type !== 'moduleDownloaded') return null;
    return Buffer.from(message.files[0].dataBase64, 'base64').toString();
}

const T1 = Date.UTC(2026, 7, 9, 12, 0, 0);
const T2 = Date.UTC(2026, 7, 9, 12, 5, 0);

describe('captureDataBroadcast', () => {
    test('配られたモジュールに、そのとき見えていた放送時刻が付く', () => {
        const timeline = captureDataBroadcast([
            stream(...head, tdt(T1), ...carousel(multipart('<bml>1</bml>'), 1)),
        ]);
        const done = timeline.filter((item) => item.message.type === 'moduleDownloaded');
        expect(done).toHaveLength(1);
        expect(done[0].at).toBe(T1);
        expect(bmlBody(done[0].message)).toContain('<bml>1</bml>');
    });

    test('時計を見る前に配られたものは at = null', () => {
        // TDT より前にモジュールが揃う。**準備として常に含めたい**ので時刻は付けない
        const timeline = captureDataBroadcast([
            stream(...head, ...carousel(multipart('<bml/>'), 1), tdt(T1)),
        ]);
        const done = timeline.find((item) => item.message.type === 'moduleDownloaded');
        expect(done?.at).toBeNull();
    });

    test('同じ版は配り直さない = ログにも1つだけ', () => {
        const module = multipart('<bml/>');
        const timeline = captureDataBroadcast([
            stream(...head, tdt(T1), ...carousel(module, 1), ...carousel(module, 1)),
        ]);
        expect(timeline.filter((item) => item.message.type === 'moduleDownloaded')).toHaveLength(1);
    });
});

describe('replayAt', () => {
    // 版1を T1 に、版2を T2 に配る。**途中で中身が差し替わる録画**
    const timeline = captureDataBroadcast([
        stream(
            ...head,
            tdt(T1),
            ...carousel(multipart('<bml>ver1</bml>'), 1),
            tdt(T2),
            ...carousel(multipart('<bml>ver2</bml>'), 2),
        ),
    ]);

    function shownBml(at: number): string | null {
        const module = replayAt(timeline, at).find((m) => m.type === 'moduleDownloaded');
        return module ? bmlBody(module) : null;
    }

    test('差し替え前の位置では、古いほうの画面が出る', () => {
        expect(shownBml(T1 + 60_000)).toContain('ver1');
    });

    test('差し替え後の位置では、新しいほうの画面が出る', () => {
        expect(shownBml(T2 + 60_000)).toContain('ver2');
    });

    test('差し替えのちょうど時刻では、新しいほうまで含む', () => {
        expect(shownBml(T2)).toContain('ver2');
    });

    test('pmt が先に来る = 置き場所が決まってからモジュールを出す', () => {
        const out = replayAt(timeline, T2);
        const pmtAt = out.findIndex((m) => m.type === 'pmt');
        const moduleAt = out.findIndex((m) => m.type === 'moduleDownloaded');
        expect(pmtAt).toBeGreaterThanOrEqual(0);
        expect(pmtAt).toBeLessThan(moduleAt);
    });
});

describe('playbackMsAt', () => {
    test('切っていない録画は、基準からの経過そのまま', () => {
        expect(playbackMsAt(60_000, 0, null)).toBe(60_000);
    });

    test('基準より前は 0 に寄せる', () => {
        expect(playbackMsAt(-5_000, 0, null)).toBe(0);
    });

    // 0〜60秒 と 120〜180秒 を残す (60〜120秒の CM を切った録画)
    const keep = [
        { start: 0, end: 60 },
        { start: 120, end: 180 },
    ];

    test('CM を切った録画は、残した尺だけ積む', () => {
        // ts 150秒 = 2つ目の残り区間の途中。残ったのは 60 + (150-120) = 90秒
        expect(playbackMsAt(150_000, 0, keep)).toBe(90_000);
        // 両区間とも通り過ぎた ts 200秒 = 60 + 60 = 120秒
        expect(playbackMsAt(200_000, 0, keep)).toBe(120_000);
    });

    test('CM の穴に落ちた時刻は、その手前の残り終わりに寄る', () => {
        // ts 90秒 = 切った 60〜120秒の中。手前に残ったのは 60秒ぶんだけ
        expect(playbackMsAt(90_000, 0, keep)).toBe(60_000);
    });
});

describe('toPlaybackTimeline', () => {
    test('頭の準備 (at=null) は 0、あとは再生位置に写る', () => {
        const placed = toPlaybackTimeline(
            [
                { at: null, message: { type: 'pmt', components: [] } as ResponseMessage },
                { at: 30_000, message: { type: 'pmt', components: [] } as ResponseMessage },
            ],
            0,
            null,
        );
        expect(placed.map((p) => p.at)).toEqual([0, 30_000]);
    });
});

describe('feedFor', () => {
    const mod = (version: number): ResponseMessage =>
        ({
            type: 'moduleDownloaded',
            componentId: 1,
            moduleId: 1,
            version,
            dataEventId: 0,
            files: [],
        }) as ResponseMessage;
    const tl: PlacedMessage[] = [
        { at: 0, message: { type: 'pmt', components: [] } as ResponseMessage },
        { at: 10_000, message: mod(1) },
        { at: 60_000, message: mod(2) },
    ];

    test('頭から進む = そこまでの変化を順に流す', () => {
        expect(feedFor(tl, -1, 5_000)).toEqual({ reset: false, messages: [tl[0].message] });
        expect(feedFor(tl, -1, 20_000)).toEqual({ reset: false, messages: [tl[0].message, tl[1].message] });
    });

    test('進んだぶんだけ足す (器はそのまま)', () => {
        expect(feedFor(tl, 20_000, 70_000)).toEqual({ reset: false, messages: [tl[2].message] });
    });

    test('戻ったら作り直して積み直す', () => {
        const feed = feedFor(tl, 70_000, 5_000);
        expect(feed.reset).toBe(true);
        // 5秒の時点では版1 (10秒) はまだ来ていない。pmt だけ
        expect(feed.messages.some((m) => m.type === 'moduleDownloaded')).toBe(false);
        expect(feed.messages.some((m) => m.type === 'pmt')).toBe(true);
    });
});
