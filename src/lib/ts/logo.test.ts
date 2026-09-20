import { describe, expect, test } from 'bun:test';
import { LogoCollector, logoTypeOfPng, parseCdt, parseLogoLinks, replacesLogo } from './logo';
import { packetize, withCrc } from './synth';

/** 1x1 の PNG。中身は問わないので、ロゴとして扱えるかだけ見る */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad]);

const be = (value: number) => [(value >> 8) & 0xff, value & 0xff];

/** 開いている物理チャンネルのネットワーク。地上波の CDT には入っていない */
const NETWORK = 0x0004;

/** CDT を組み立てる。data_type=0x01 がロゴ */
function cdtSection(logoId: number, logoType: number, data: Uint8Array, logoVersion = 1): Uint8Array {
    return withCrc([
        0xc8,
        0x00,
        0x00,
        ...be(0x0004), // download_data_id
        0xc1,
        0x00,
        0x00,
        ...be(0x0004), // original_network_id
        0x01, // data_type = ロゴ
        ...be(0xf000), // descriptors_loop_length = 0
        logoType,
        ...be(logoId), // reserved 7 + logo_id 9
        ...be(logoVersion),
        ...be(data.length),
        ...data,
    ]);
}

/** SDT の logo_transmission_descriptor (0xCF) 付き */
function sdtWithLogo(services: [number, number][], transmissionType = 0x01): Uint8Array {
    const body = [0x42, 0x00, 0x00, ...be(0x0408), 0xc1, 0x00, 0x00, ...be(0x0004), 0xff];
    for (const [serviceId, logoId] of services) {
        const descriptor =
            transmissionType === 0x03
                ? [0xcf, 0x03, 0x03, 0x41, 0x42]
                : [0xcf, 0x07, transmissionType, ...be(logoId), ...be(0x0001), ...be(0x0004)];
        body.push(...be(serviceId), 0xfc, ...be(0x8000 | descriptor.length), ...descriptor);
    }
    return withCrc(body);
}

describe('CDT', () => {
    test('ロゴのPNGを取り出す', () => {
        const logo = parseCdt(cdtSection(3, 0x05, PNG));
        expect(logo?.logoId).toBe(3);
        expect(logo?.logoType).toBe(0x05);
        expect(logo?.data).toEqual(PNG);
    });

    test('ロゴ以外のデータは読まない', () => {
        const section = cdtSection(3, 0x05, PNG);
        section[10] = 0x02; // data_type をロゴ以外にする
        expect(parseCdt(section)).toBeNull();
    });

    test('長さが合わないものは捨てる', () => {
        const section = cdtSection(3, 0x05, PNG);
        // data_size を実際より大きくする
        section[section.length - 4 - PNG.length - 1] = 0xff;
        expect(parseCdt(section)).toBeNull();
    });
});

describe('SDT のロゴ対応', () => {
    test('サービスとロゴIDを結ぶ', () => {
        expect(
            parseLogoLinks(
                sdtWithLogo([
                    [1024, 3],
                    [1025, 3],
                    [1032, 7],
                ]),
            ),
        ).toEqual(
            new Map([
                [1024, 3],
                [1025, 3],
                [1032, 7],
            ]),
        );
    });

    test('文字で代用する形式は画像が流れてこないので結ばない', () => {
        expect(parseLogoLinks(sdtWithLogo([[1024, 3]], 0x03)).size).toBe(0);
    });
});

describe('拾い集める', () => {
    test('CDTとSDTが揃って初めて局に配れる', () => {
        const collector = new LogoCollector(NETWORK);
        collector.feed(packetize(0x0029, cdtSection(3, 0x05, PNG)));
        // ロゴだけではどの局のものか分からない
        expect(collector.collected()).toEqual([]);

        collector.feed(
            packetize(
                0x0011,
                sdtWithLogo([
                    [1024, 3],
                    [1025, 3],
                ]),
            ),
        );
        const found = collector.collected();
        expect(found).toHaveLength(1);
        expect(found[0]!.serviceIds.sort()).toEqual([1024, 1025]);
        expect(found[0]!.logo.data).toEqual(PNG);
    });

    test('対応だけあってロゴが来ていなければ配らない', () => {
        const collector = new LogoCollector(NETWORK);
        collector.feed(packetize(0x0011, sdtWithLogo([[1024, 3]])));
        expect(collector.collected()).toEqual([]);
    });

    test('大きいロゴが来たら差し替える', () => {
        const collector = new LogoCollector(NETWORK);
        const small = Uint8Array.from([1, 2, 3]);
        collector.feed(packetize(0x0029, cdtSection(3, 0x02, small)));
        collector.feed(packetize(0x0029, cdtSection(3, 0x05, PNG)));
        collector.feed(packetize(0x0011, sdtWithLogo([[1024, 3]])));
        expect(collector.collected()[0]!.logo.logoType).toBe(0x05);
    });

    test('小さいロゴが後から来ても戻さない', () => {
        const collector = new LogoCollector(NETWORK);
        collector.feed(packetize(0x0029, cdtSection(3, 0x05, PNG)));
        collector.feed(packetize(0x0029, cdtSection(3, 0x02, Uint8Array.from([1, 2, 3]))));
        collector.feed(packetize(0x0011, sdtWithLogo([[1024, 3]])));
        expect(collector.collected()[0]!.logo.logoType).toBe(0x05);
    });

    test('188の切れ目と無関係に届いても読める', () => {
        const collector = new LogoCollector(NETWORK);
        const data = Uint8Array.from([
            ...packetize(0x0029, cdtSection(3, 0x05, PNG)),
            ...packetize(0x0011, sdtWithLogo([[1024, 3]])),
        ]);
        for (let at = 0; at < data.length; at += 77) collector.feed(data.subarray(at, at + 77));
        expect(collector.collected()).toHaveLength(1);
    });
});

/** 署名と IHDR の頭だけの PNG。寸法を読むのに要るのはここまで */
function pngOf(width: number, height: number): Uint8Array {
    const out = new Uint8Array(24);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(out.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return out;
}

describe('ロゴの大きさ', () => {
    test('寸法から logo_type を引く', () => {
        expect(logoTypeOfPng(pngOf(48, 24))).toBe(0x00);
        expect(logoTypeOfPng(pngOf(72, 36))).toBe(0x03);
        expect(logoTypeOfPng(pngOf(64, 36))).toBe(0x05);
    });

    test('規格に無い寸法・PNG でないものは null', () => {
        expect(logoTypeOfPng(pngOf(100, 100))).toBeNull();
        expect(logoTypeOfPng(PNG)).toBeNull();
        expect(logoTypeOfPng(new Uint8Array(24))).toBeNull();
    });

    test('64×36 を持っていたら小さいものへは戻さない', () => {
        expect(replacesLogo(0x05, 0x00)).toBe(false);
        expect(replacesLogo(0x05, 0x03)).toBe(false);
        // 同じ種類は絵が変わったかもしれないので置き換える
        expect(replacesLogo(0x05, 0x05)).toBe(true);
    });

    test('小さいものは大きいもので置き換える', () => {
        expect(replacesLogo(0x00, 0x05)).toBe(true);
        expect(replacesLogo(0x00, 0x03)).toBe(true);
        expect(replacesLogo(0x03, 0x00)).toBe(false);
        // 何を持っているか分からなければ置き換える
        expect(replacesLogo(null, 0x00)).toBe(true);
    });
});
