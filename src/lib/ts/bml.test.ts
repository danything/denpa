import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import type { ResponseMessage } from '$lib/vendor/web-bml/ws_api';
import { BmlDecoder, inflate, moduleFiles, parseBxmlInfo } from './bml';
import type { DiiModuleSpec } from './synth';
import { bxmlDescriptor, ddbSection, diiSection, packetize, patSection, programMap, withCrc } from './synth';

/**
 * データ放送 (ARIB STD-B24 の BML)。
 *
 * PAT → PMT のデータ符号化方式記述子 (0xFD) → DII でモジュールの素性 →
 * DDB でブロック、と辿らないと1つのファイルにならない。運び方は衛星のロゴと
 * 同じ DSM-CC で、[dsmcc.ts](dsmcc.ts) を分け合っている。
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

/**
 * モジュール1つぶんの中身。**放送は multipart/mixed で複数のファイルを詰める。**
 * 本物と同じく、頭に Content-Type、境界で区切って各ファイルに Content-Location
 */
function multipart(files: [location: string, type: string, body: string][]): Uint8Array {
    const boundary = 'denpa';
    let out = `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n`;
    for (const [location, type, body] of files) {
        out += `--${boundary}\r\nContent-Type: ${type}\r\nContent-Location: ${location}\r\n\r\n${body}\r\n`;
    }
    out += `--${boundary}--\r\n`;
    return new TextEncoder().encode(out);
}

/** DII と DDB を並べて、1つのモジュールを配りきる */
function carousel(module: Uint8Array, options: Partial<DiiModuleSpec> = {}): Uint8Array[] {
    const blockSize = 4066;
    const spec = {
        moduleId: 1,
        moduleSize: module.length,
        moduleVersion: 1,
        contentType: 'multipart/mixed',
        ...options,
    };
    const blocks: Uint8Array[] = [];
    for (let at = 0, n = 0; at < module.length; at += blockSize, n++) {
        blocks.push(
            packetize(
                BML_PID,
                ddbSection(
                    DOWNLOAD_ID,
                    spec.moduleId,
                    spec.moduleVersion,
                    n,
                    module.subarray(at, at + blockSize),
                ),
            ),
        );
    }
    return [packetize(BML_PID, diiSection(DOWNLOAD_ID, blockSize, spec)), ...blocks];
}

/** 食わせて、出てきた知らせを全部集める */
function decode(...parts: Uint8Array[]): ResponseMessage[] {
    const out: ResponseMessage[] = [];
    const decoder = new BmlDecoder((message) => out.push(message));
    decoder.feed(stream(...parts));
    return out;
}

const head = [packetize(0x0000, patSection([[SERVICE, PMT_PID]])), packetize(PMT_PID, bmlPmt())];

describe('parseBxmlInfo', () => {
    test('入口の ES は起動のしかたまで持っている', () => {
        const descriptor = bxmlDescriptor();
        // 記述子の頭 (tag/length) と data_component_id を落とした残り
        const info = parseBxmlInfo(Uint8Array.from(descriptor.slice(4)));
        expect(info.entryPointFlag).toBe(true);
        expect(info.entryPointInfo?.autoStartFlag).toBe(true);
        // 0011 = 960x540。データ放送でいちばんよく使われる
        expect(info.entryPointInfo?.documentResolution).toBe(3);
        expect(info.additionalAribCarouselInfo?.dataEventId).toBe(0x0f);
    });

    test('入口でない ES は起動のしかたを持たない', () => {
        const descriptor = bxmlDescriptor({ entryPoint: false });
        const info = parseBxmlInfo(Uint8Array.from(descriptor.slice(4)));
        expect(info.entryPointFlag).toBe(false);
        expect(info.entryPointInfo).toBeUndefined();
        // 伝送方式が 00 なら、入口でなくてもカルーセルの覚え書きは付いてくる
        expect(info.additionalAribCarouselInfo?.dataEventId).toBe(0x0f);
    });
});

describe('moduleFiles', () => {
    test('multipart を1ファイルずつに解く', () => {
        const files = moduleFiles(
            multipart([
                ['/startup.bml', 'text/X-arib-bml', '<bml/>'],
                ['/logo.png', 'image/png', 'PNG'],
            ]),
            'multipart/mixed',
        );
        expect(files.map((file) => file.contentLocation)).toEqual(['/startup.bml', '/logo.png']);
        expect(Buffer.from(files[0].dataBase64, 'base64').toString()).toBe('<bml/>');
        expect(files[1].contentType.type).toBe('image');
    });

    /** 中身が1つのモジュールは包まれていない。置き場所は BML 側が知っている */
    test('multipart でなければ丸ごと1ファイル', () => {
        const files = moduleFiles(new TextEncoder().encode('PNG'), 'image/png');
        expect(files).toHaveLength(1);
        expect(files[0].contentLocation).toBeNull();
        expect(files[0].contentType.subtype).toBe('png');
    });
});

describe('inflate', () => {
    test('縮んでいなければそのまま', () => {
        const data = new TextEncoder().encode('abc');
        expect(inflate(data, null)).toBe(data);
    });

    test('zlib なら伸ばす', () => {
        const original = new TextEncoder().encode('a'.repeat(1000));
        const squeezed = new Uint8Array(deflateSync(original));
        expect(inflate(squeezed, { type: 0 })).toEqual(original);
    });

    /** 知らない縮め方は諦める。**壊れたものを配るより出さないほうがいい** */
    test('知らない縮め方は null', () => {
        expect(inflate(new Uint8Array(4), { type: 9 })).toBeNull();
    });

    test('伸ばせなければ null。転んでも投げない', () => {
        expect(inflate(Uint8Array.from([1, 2, 3, 4]), { type: 0 })).toBeNull();
    });
});

describe('BmlDecoder', () => {
    test('PMT を見て、データ放送の ES を見分ける', () => {
        const out = decode(...head);
        const pmt = out.find((message) => message.type === 'pmt');
        expect(pmt).toBeDefined();
        if (pmt?.type !== 'pmt') throw new Error('pmt が出ていない');
        const bml = pmt.components.find((component) => component.componentId === COMPONENT_TAG);
        expect(bml?.pid).toBe(BML_PID);
        expect(bml?.bxmlInfo?.entryPointFlag).toBe(true);
        // 映像の ES には付かない
        expect(pmt.components.find((component) => component.componentId === 0)?.bxmlInfo).toBeUndefined();
    });

    /** 放送は同じ表を何度も送る。そのまま通すと受け側が画面を組み直し続ける */
    test('PMT は変わったときだけ配る', () => {
        const out = decode(...head, packetize(PMT_PID, bmlPmt()), packetize(PMT_PID, bmlPmt()));
        expect(out.filter((message) => message.type === 'pmt')).toHaveLength(1);
    });

    test('カルーセルを組み立ててファイルにする', () => {
        const module = multipart([
            ['/startup.bml', 'text/X-arib-bml', '<bml>これはデータ放送</bml>'],
            ['/40/logo.png', 'image/png', 'PNG'],
        ]);
        const out = decode(...head, ...carousel(module));

        const list = out.find((message) => message.type === 'moduleListUpdated');
        if (list?.type !== 'moduleListUpdated') throw new Error('moduleListUpdated が出ていない');
        expect(list.componentId).toBe(COMPONENT_TAG);
        expect(list.modules).toEqual([{ id: 1, version: 1, size: module.length }]);

        const done = out.find((message) => message.type === 'moduleDownloaded');
        if (done?.type !== 'moduleDownloaded') throw new Error('moduleDownloaded が出ていない');
        expect(done.componentId).toBe(COMPONENT_TAG);
        expect(done.files.map((file) => file.contentLocation)).toEqual(['/startup.bml', '/40/logo.png']);
        expect(Buffer.from(done.files[0].dataBase64, 'base64').toString()).toContain('データ放送');
    });

    /** 大きいモジュールは何ブロックにも割れる。順番は保証されない */
    test('ブロックが揃うまで配らない', () => {
        const module = multipart([['/big.bml', 'text/X-arib-bml', 'x'.repeat(9000)]]);
        const parts = carousel(module);
        // DII と、最後の1ブロックを除いた全部
        const half = decode(...head, ...parts.slice(0, -1));
        expect(half.some((message) => message.type === 'moduleDownloaded')).toBe(false);
        expect(decode(...head, ...parts).some((message) => message.type === 'moduleDownloaded')).toBe(true);
    });

    test('縮めて送られたモジュールを伸ばす', () => {
        const original = multipart([['/startup.bml', 'text/X-arib-bml', `<bml>${'あ'.repeat(500)}</bml>`]]);
        const squeezed = new Uint8Array(deflateSync(original));
        const out = decode(
            ...head,
            ...carousel(squeezed, { compression: { type: 0, originalSize: original.length } }),
        );
        const done = out.find((message) => message.type === 'moduleDownloaded');
        if (done?.type !== 'moduleDownloaded') throw new Error('moduleDownloaded が出ていない');
        expect(Buffer.from(done.files[0].dataBase64, 'base64').toString()).toContain('あああ');
    });

    /*
     * **カルーセルは回り続ける。** 版が上がっていなくても同じモジュールが
     * 何度も揃うので、そのたびに配ると受け側が画面を組み直し続ける
     */
    test('同じ版のモジュールは配り直さない', () => {
        const module = multipart([['/startup.bml', 'text/X-arib-bml', '<bml/>']]);
        const out = decode(...head, ...carousel(module), ...carousel(module));
        expect(out.filter((message) => message.type === 'moduleDownloaded')).toHaveLength(1);
        // 同じ transaction_id なので、モジュールの一覧も配り直さない
        expect(out.filter((message) => message.type === 'moduleListUpdated')).toHaveLength(1);
    });

    /** 版が上がれば中身が変わっている。**配り直さないと古い画面のまま** */
    test('版が上がれば配り直す', () => {
        const first = multipart([['/startup.bml', 'text/X-arib-bml', '<bml>1</bml>']]);
        const second = multipart([['/startup.bml', 'text/X-arib-bml', '<bml>2</bml>']]);
        const out = decode(
            ...head,
            ...carousel(first),
            ...carousel(second, { moduleVersion: 2 }).map((packet, at) =>
                // 版を上げるときは DII も新しい回として送られてくる
                at === 0
                    ? packetize(
                          BML_PID,
                          diiSection(
                              DOWNLOAD_ID,
                              4066,
                              {
                                  moduleId: 1,
                                  moduleSize: second.length,
                                  moduleVersion: 2,
                                  contentType: 'multipart/mixed',
                              },
                              2,
                          ),
                      )
                    : packet,
            ),
        );
        const done = out.filter((message) => message.type === 'moduleDownloaded');
        expect(done).toHaveLength(2);
        expect(done.map((message) => (message.type === 'moduleDownloaded' ? message.version : 0))).toEqual([
            1, 2,
        ]);
    });

    /** TDT。BML の `getCurrentDateTime` はこれを見る */
    test('放送の時刻を配る', () => {
        const at = Date.UTC(2026, 7, 9, 12, 0, 0);
        const jst = at + 9 * 3600 * 1000;
        const days = Math.floor(jst / 86400000) + 40587;
        const bcd = (n: number) => ((n / 10) << 4) | (n % 10);
        const tdt = Uint8Array.from([
            0x70,
            0x70,
            0x05,
            (days >> 8) & 0xff,
            days & 0xff,
            bcd(21),
            bcd(0),
            bcd(0),
        ]);
        const out = decode(...head, packetize(0x0014, tdt));
        const time = out.find((message) => message.type === 'currentTime');
        if (time?.type !== 'currentTime') throw new Error('currentTime が出ていない');
        expect(time.timeUnixMillis).toBe(at);
    });

    /** データ放送の ES が無い局では、何も出さずに黙っている */
    test('データ放送が載っていなければ何も出さない', () => {
        const out = decode(
            packetize(0x0000, patSection([[SERVICE, PMT_PID]])),
            packetize(PMT_PID, programMap(SERVICE, VIDEO_PID, [[0x02, VIDEO_PID, [0x52, 0x01, 0x00]]])),
            ...carousel(multipart([['/startup.bml', 'text/X-arib-bml', '<bml/>']])),
        );
        expect(out.some((message) => message.type === 'moduleDownloaded')).toBe(false);
    });

    /** 壊れたセクションで転ばない。**映像の付け足しが映像を止めてはいけない** */
    test('でたらめを食べても投げない', () => {
        const junk = packetize(BML_PID, withCrc([0x3b, 0x00, 0x00, 0xff, 0xff, 0xc1, 0x00, 0x00, 1, 2, 3]));
        expect(() => decode(...head, junk)).not.toThrow();
    });
});
