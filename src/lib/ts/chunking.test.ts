import { describe, expect, test } from 'bun:test';
import type { ResponseMessage } from 'web-bml/protocol';
import { type Ait, AitReader } from './ait';
import { BmlDecoder } from './bml';
import { BroadcastClock } from './clock';
import { DataBroadcastCapture } from './data-capture';
import { EpgReader } from './eit';
import { type Pes, PesDemuxer } from './pes';
import { PacketStream } from './psi';
import { ServiceFilter } from './service-filter';
import {
    aitSection,
    aitSignallingDescriptor,
    bxmlDescriptor,
    ddbSection,
    diiSection,
    eitSection,
    multipartModule,
    nitSection,
    packetize,
    patSection,
    pcrPacket,
    programMap,
    sdtSection,
    stream,
    tdtPacket,
} from './synth';

/**
 * **塊の切れ目と入れ物の使い回しで、読めるものが変わらないこと。**
 *
 * パケットは届いた塊の上の窓として配っている (写さない。`psi.ts` の `PacketStream`)。
 * 録画のデータ放送は1つの入れ物に読み込み直しながら食わせる (`server/recorded-bml.ts`)
 * ので、窓を持ち続ける読み手が居ると、次の読み込みで中身が化ける。
 * 局を2つ相乗りさせた TS を、丸ごと1回で食わせたときと、半端な大きさに切って
 * 使い回しの入れ物から食わせたときとで、出てくるものを突き合わせる
 */

const ONID = 0x7fe8;
const TSID = 0x7fe8;
const SERVICES = [1024, 1025];
const PMT = [0x1f0, 0x1f1];
const VIDEO = 0x111;
const AUDIO = 0x112;
const BML = 0x800;
const AIT = 0x900;
const DOWNLOAD = 0xf0000001;
const BASE = Date.UTC(2026, 9, 10, 0, 0, 0);

function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

function broadcast(): Uint8Array {
    const next = random(3);
    const counters = new Map<number, number>();
    const section = (pid: number, body: Uint8Array) => {
        const counter = counters.get(pid) ?? 0;
        const packets = packetize(pid, body, counter);
        counters.set(pid, (counter + packets.length / 188) & 0x0f);
        return packets;
    };
    const es = (pid: number, start: boolean) => {
        const packet = new Uint8Array(188);
        for (let i = 4; i < 188; i++) packet[i] = Math.floor(next() * 256);
        const counter = counters.get(pid) ?? 0;
        counters.set(pid, (counter + 1) & 0x0f);
        packet.set([0x47, (start ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x10 | counter]);
        if (start) packet.set([0, 0, 1, 0xe0, 0, 0], 4);
        return packet;
    };
    const filler = new Uint8Array(188).fill(0xff);
    filler.set([0x47, 0x1f, 0xff, 0x10]);

    const pat = patSection(
        SERVICES.map((id, i) => [id, PMT[i]!]),
        TSID,
    );
    const pmts = SERVICES.map((id, i) =>
        programMap(id, VIDEO, [
            [0x02, VIDEO, [0x52, 0x01, 0x00]],
            [0x0f, AUDIO, [0x52, 0x01, 0x10]],
            [0x0d, BML, [0x52, 0x01, 0x40, ...bxmlDescriptor()]],
            [0x05, AIT + i, [0x52, 0x01, 0x80, ...aitSignallingDescriptor()]],
        ]),
    );
    const ait = aitSection([
        {
            organisationId: 0x17,
            applicationId: 1,
            name: 'アプリ',
            base: 'https://example.com/',
            path: 'a.html',
        },
    ]);
    const module = multipartModule([
        ['/40/0000/startup.bml', 'text/X-arib-bml', `<bml>${'あ'.repeat(6000)}</bml>`],
    ]);
    const carousel = [
        diiSection(DOWNLOAD, 4066, {
            moduleId: 0,
            moduleSize: module.length,
            moduleVersion: 1,
            contentType: 'multipart/mixed',
        }),
    ];
    for (let at = 0, n = 0; at < module.length; at += 4066, n++) {
        carousel.push(ddbSection(DOWNLOAD, 0, 1, n, module.subarray(at, at + 4066)));
    }
    const eits = SERVICES.flatMap((serviceId) =>
        [0, 1, 2].map((segment) =>
            eitSection({
                tableId: 0x50,
                serviceId,
                transportStreamId: TSID,
                originalNetworkId: ONID,
                sectionNumber: segment * 8,
                lastSectionNumber: 0x10,
                events: Array.from({ length: 5 }, (_, k) => ({
                    eventId: segment * 10 + k + 1,
                    startAt: BASE + (segment * 5 + k) * 1800_000,
                    duration: 1800_000,
                    name: `番組${serviceId}-${segment}-${k}`,
                    description: '合成の番組です。'.repeat(4),
                    extended: { 番組内容: 'あらすじ'.repeat(20) },
                    genres: [[k, 0]] as [number, number][],
                })),
            }),
        ),
    );

    const parts: Uint8Array[] = [];
    // 1周だけ。繰り返すと、化けて落ちたセクションを次の周が埋めてしまい、差が見えない
    for (let round = 0; round < 1; round++) {
        parts.push(section(0x0000, pat), ...PMT.map((pid, i) => section(pid, pmts[i]!)));
        parts.push(
            section(
                0x0011,
                sdtSection(
                    TSID,
                    ONID,
                    SERVICES.map((id) => [id, 0x01, `局${id}`]),
                ),
            ),
        );
        parts.push(section(0x0010, nitSection(ONID, 5, [[TSID, ONID, SERVICES.map((id) => [id, 0x01])]])));
        parts.push(tdtPacket(BASE + round * 1000), pcrPacket(VIDEO, round));
        parts.push(...SERVICES.map((_, i) => section(AIT + i, ait)));
        for (const [i, body] of [...carousel, ...eits].entries()) {
            parts.push(section(i < carousel.length ? BML : 0x0012, body));
            for (let k = 0; k < 4; k++) parts.push(es(k === 0 ? AUDIO : VIDEO, k === 1), filler);
        }
    }
    return stream(...parts);
}

const ts = broadcast();

/**
 * 半端な大きさに切り、**1つの入れ物に読み込み直しながら**渡す。
 * 渡し終えたら入れ物を潰す — 窓を持ち続けている読み手が居れば中身が化ける
 */
function reused(data: Uint8Array, seed: number, feed: (chunk: Uint8Array) => void): void {
    const next = random(seed);
    const buffer = new Uint8Array(4000);
    for (let at = 0; at < data.length; ) {
        const size = Math.min(data.length - at, 1 + Math.floor(next() * buffer.length));
        buffer.set(data.subarray(at, at + size));
        feed(buffer.subarray(0, size));
        buffer.fill(0x47);
        at += size;
    }
}

function joined(parts: Uint8Array[]): number[] {
    return parts.flatMap((part) => [...part]);
}

describe('塊の切れ目と入れ物の使い回し', () => {
    test('局を絞った TS はバイト単位で同じ', () => {
        const whole = new ServiceFilter(SERVICES[0]!).filter(ts);
        expect(whole.length).toBeGreaterThan(0);
        for (const seed of [1, 2, 3]) {
            const filter = new ServiceFilter(SERVICES[0]!);
            const parts: Uint8Array[] = [];
            reused(ts, seed, (chunk) => parts.push(filter.filter(chunk)));
            expect(joined(parts)).toEqual([...whole]);
        }
    });

    test('番組表は同じ番組が同じ中身で揃う', () => {
        const whole = new EpgReader(() => BASE);
        whole.feed(ts);
        expect(whole.all().length).toBe(30);
        for (const seed of [4, 5]) {
            const reader = new EpgReader(() => BASE);
            reused(ts, seed, (chunk) => reader.feed(chunk));
            expect(reader.all()).toEqual(whole.all());
        }
    });

    test('録画のデータ放送は同じ変化が同じ順に並ぶ', () => {
        const only = new ServiceFilter(SERVICES[0]!).filter(ts);
        const whole = new DataBroadcastCapture();
        whole.feed(only);
        expect(whole.result().some((item) => item.message.type === 'moduleDownloaded')).toBe(true);
        for (const seed of [6, 7]) {
            const capture = new DataBroadcastCapture();
            reused(only, seed, (chunk) => capture.feed(chunk));
            expect(capture.result()).toEqual(whole.result());
        }
    });

    test('映像の PES は同じ中身で同じ数だけ出る', () => {
        const only = new ServiceFilter(SERVICES[0]!).filter(ts);
        const whole = new PesDemuxer().feed(only).pes;
        expect(whole.length).toBeGreaterThan(10);
        const demuxer = new PesDemuxer();
        const parts: Pes[] = [];
        reused(only, 9, (chunk) => parts.push(...demuxer.feed(chunk).pes));
        expect(parts).toEqual(whole);
    });
});

describe('ライブの切り分けは1回 (`feedPacket`)', () => {
    const only = new ServiceFilter(SERVICES[1]!).filter(ts);

    test('データ放送・時計・Hybridcast は、それぞれが切ったときと同じものを出す', () => {
        const bySelf: ResponseMessage[] = [];
        const shared: ResponseMessage[] = [];
        const selfBml = new BmlDecoder((message) => bySelf.push(message));
        const sharedBml = new BmlDecoder((message) => shared.push(message));
        const selfClock = new BroadcastClock();
        const sharedClock = new BroadcastClock();
        const selfAit = new AitReader(SERVICES[1]!);
        const sharedAit = new AitReader(SERVICES[1]!);
        const selfApps: Ait[] = [];
        const sharedApps: Ait[] = [];
        const packets = new PacketStream();

        reused(only, 8, (chunk) => {
            selfBml.feed(chunk);
            selfClock.feed(chunk, 1000);
            selfApps.push(...selfAit.feed(chunk));
            for (const packet of packets.feed(chunk)) {
                sharedBml.feedPacket(packet);
                sharedClock.feedPacket(packet, 1000);
                sharedAit.feedPacket(packet, sharedApps);
            }
        });

        expect(bySelf.some((message) => message.type === 'moduleDownloaded')).toBe(true);
        expect(shared).toEqual(bySelf);
        expect(selfClock.anchor).not.toBeNull();
        expect(sharedClock.anchor).toEqual(selfClock.anchor);
        expect(selfApps.length).toBeGreaterThan(0);
        expect(sharedApps).toEqual(selfApps);
    });
});
