import { describe, expect, test } from 'bun:test';
import { AitReader, APPLICATION_TYPE_HTML5, aitPidsFromPmt, CONTROL, parseAit } from './ait';
import { aitSection, aitSignallingDescriptor, packetize, patSection, programMap } from './synth';

/*
 * **Hybridcast の在り処だけを読む。**
 *
 * データ放送と違って、アプリの中身は電波に乗っていない。乗っているのは
 * 「どこにあるか」だけなので、ここで確かめるのは**住所を正しく組み立てられるか**。
 * denpa はアプリを動かさない ([docs/stream.md](../../../docs/stream.md#58-hybridcast))。
 */

describe('AIT の在り処', () => {
    test('PMT の印が付いた ES の PID を拾う', () => {
        const pmt = programMap(1024, 0x0100, [
            [0x02, 0x0100], // 映像
            [0x0f, 0x0110], // 音声
            [0x0d, 0x0200, aitSignallingDescriptor()], // AIT
        ]);
        expect(aitPidsFromPmt(pmt)).toEqual([0x0200]);
    });

    test('印の無い局では拾わない', () => {
        // **データ放送のカルーセルと同じ stream_type (0x0D) でも、印が無ければ AIT ではない**
        const pmt = programMap(1024, 0x0100, [
            [0x02, 0x0100],
            [0x0d, 0x0300], // データ放送のカルーセル
        ]);
        expect(aitPidsFromPmt(pmt)).toEqual([]);
    });
});

describe('AIT の中身', () => {
    test('URL は頭と道を繋いだもの', () => {
        const ait = parseAit(
            aitSection([
                {
                    organisationId: 0x0000_7fe0,
                    applicationId: 0x0001,
                    name: 'NHK ONE',
                    base: 'https://example.jp/hc/',
                    path: 'index.html',
                },
            ]),
        );
        expect(ait?.applicationType).toBe(APPLICATION_TYPE_HTML5);
        expect(ait?.applications).toEqual([
            {
                organisationId: 0x0000_7fe0,
                applicationId: 0x0001,
                controlCode: CONTROL.autostart,
                name: 'NHK ONE',
                url: 'https://example.jp/hc/index.html',
            },
        ]);
    });

    test('道が無ければ頭だけ', () => {
        const ait = parseAit(
            aitSection([{ organisationId: 1, applicationId: 2, base: 'https://example.jp/app' }]),
        );
        expect(ait?.applications[0].url).toBe('https://example.jp/app');
        // 名前は放送が入れていないことがある。空でも捨てない
        expect(ait?.applications[0].name).toBe('');
    });

    test('起動のしかたはそのまま持つ', () => {
        const ait = parseAit(
            aitSection([
                { organisationId: 1, applicationId: 2, controlCode: CONTROL.present, base: 'https://a/' },
            ]),
        );
        expect(ait?.applications[0].controlCode).toBe(CONTROL.present);
    });

    /*
     * **URL の無いものは出さない。**
     *
     * 放送のカルーセルで運ぶアプリ (protocol_id = 1) は、Hybridcast ではなく
     * データ放送と同じ道のもの。在ることだけ言われても、こちらには行き先が無い
     */
    test('行き先の無いものは出さない', () => {
        const ait = parseAit(aitSection([{ organisationId: 1, applicationId: 2 }]));
        expect(ait?.applications).toEqual([]);
    });

    test('AIT でないセクションは null', () => {
        expect(parseAit(patSection([[1024, 0x1fc8]]))).toBeNull();
    });
});

describe('TS から見つける', () => {
    /** PAT → PMT → AIT の順に流す。**実際の放送もこの順でしか辿れない** */
    function stream(app: { base: string; path?: string; name?: string }): Uint8Array {
        const pat = packetize(0x0000, patSection([[1024, 0x1fc8]]));
        const pmt = packetize(
            0x1fc8,
            programMap(1024, 0x0100, [
                [0x02, 0x0100],
                [0x0d, 0x0200, aitSignallingDescriptor()],
            ]),
        );
        const ait = packetize(0x0200, aitSection([{ organisationId: 0x7fe0, applicationId: 1, ...app }]));
        return Uint8Array.from([...pat, ...pmt, ...ait]);
    }

    test('PAT から辿って AIT まで届く', () => {
        const reader = new AitReader(1024);
        const found = reader.feed(stream({ base: 'https://example.jp/', path: 'x.html', name: 'テスト' }));
        expect(found).toHaveLength(1);
        expect(found[0].applications[0].url).toBe('https://example.jp/x.html');
        expect(found[0].applications[0].name).toBe('テスト');
    });

    test('AIT が先に来ても、PMT を読むまでは拾わない', () => {
        // **印を知らない PID は読まない。** 拾ってしまうと他局の表まで混ざる
        const reader = new AitReader(1024);
        const ait = packetize(
            0x0200,
            aitSection([{ organisationId: 1, applicationId: 1, base: 'https://a/' }]),
        );
        expect(reader.feed(ait)).toEqual([]);
    });

    test('印の無い局では永久に何も返さない', () => {
        const reader = new AitReader(1024);
        const pat = packetize(0x0000, patSection([[1024, 0x1fc8]]));
        const pmt = packetize(0x1fc8, programMap(1024, 0x0100, [[0x02, 0x0100]]));
        const ait = packetize(
            0x0200,
            aitSection([{ organisationId: 1, applicationId: 1, base: 'https://a/' }]),
        );
        expect(reader.feed(Uint8Array.from([...pat, ...pmt, ...ait]))).toEqual([]);
    });
});
