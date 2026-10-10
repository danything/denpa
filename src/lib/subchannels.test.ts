import { describe, expect, test } from 'bun:test';
import {
    type Airing,
    cellsOf,
    columnsOf,
    mainOf,
    type Station,
    splitOf,
    storedSubchannels,
} from './subchannels';

const HOUR = 60 * 60 * 1000;

function station(id: number, serviceId: number, channel: string, type = 'GR'): Station {
    return { id, service_id: serviceId, channel, type };
}

// テレ東 (1072〜1074) と NHK総合 (1024・1025)。並びは SERVICE_ORDER のとおり
const TX = station(1, 1072, 'T23');
const TX2 = station(2, 1073, 'T23');
const TX3 = station(3, 1074, 'T23');
const NHK = station(4, 1024, 'T27');
const NHK2 = station(5, 1025, 'T27');

let nextId = 100;
function program(serviceId: number, from: number, to: number, name = '番組'): Airing {
    return { id: nextId++, service_id: serviceId, start_at: from * HOUR, end_at: to * HOUR, name };
}

/** 画面と同じ手順で組む */
function layout(programs: Airing[], subs = true, services = [TX, TX2, TX3]) {
    const main = mainOf(services);
    const split = splitOf(programs, main);
    const columns = columnsOf(services, main, subs ? split : null);
    return { columns: columns.map((s) => s.id), cells: cellsOf(columns, programs, main, split) };
}

/** 見比べやすい形にする: [局, 列, 幅, 開始時, 終了時] */
function shape(cells: ReturnType<typeof cellsOf>) {
    return cells.map((c) => [c.program.service_id, c.column, c.span, c.start_at / HOUR, c.end_at / HOUR]);
}

describe('本チャンネルとサブチャンネル', () => {
    test('同じ TS (チャンネル) を束ね、サービスID のいちばん若い局が本チャンネル', () => {
        // 渡す順は問わない
        const main = mainOf([TX3, NHK2, TX, NHK, TX2]);
        expect(main.get(TX.id)).toBe(TX.id);
        expect(main.get(TX2.id)).toBe(TX.id);
        expect(main.get(TX3.id)).toBe(TX.id);
        expect(main.get(NHK2.id)).toBe(NHK.id);
    });

    test('地上波はチャンネルで束ねても、ネットワークID で束ねたのと同じ', () => {
        // 関東の各局 [サービスID, ネットワークID, チャンネル]。地上波は1局1TS で、
        // TS の番号はネットワークID と同じ (ARIB TR-B14 第四編 5.3)
        const kanto: [number, number, string][] = [
            [1024, 32736, 'T27'],
            [1025, 32736, 'T27'],
            [1032, 32737, 'T26'],
            [1033, 32737, 'T26'],
            [1034, 32737, 'T26'],
            [1040, 32738, 'T25'],
            [1048, 32739, 'T22'],
            [1056, 32740, 'T21'],
            [1064, 32741, 'T24'],
            [1072, 32742, 'T23'],
            [1073, 32742, 'T23'],
            [1074, 32742, 'T23'],
            [23608, 32391, 'T16'],
            [23610, 32391, 'T16'],
        ];
        const main = mainOf(kanto.map(([sid, , channel], i) => station(i, sid, channel)));
        // ネットワークID ごとに、サービスID のいちばん若い局
        const byNetwork = kanto.map(([, nid]) => {
            const first = Math.min(...kanto.filter(([, n]) => n === nid).map(([s]) => s));
            return kanto.findIndex(([s]) => s === first);
        });
        expect(kanto.map((_, i) => main.get(i))).toEqual(byNetwork);
    });

    // 実機の BS [サービスID, チャンネル]
    const BS: [number, string][] = [
        [101, 'BS15_0'],
        [102, 'BS15_0'],
        // 2024年3月で終わった枠。局名も「-」で、番組は1つも来ない
        [103, 'BS15_0'],
        [141, 'BS13_3'],
        [142, 'BS13_3'],
        [143, 'BS13_3'],
        [151, 'BS01_3'],
        [152, 'BS01_3'],
        [153, 'BS01_3'],
        [161, 'BS01_1'],
        [162, 'BS01_1'],
        [163, 'BS01_1'],
        [171, 'BS01_2'],
        [172, 'BS01_2'],
        [173, 'BS01_2'],
        [181, 'BS13_1'],
        [182, 'BS13_1'],
        [183, 'BS13_1'],
        // WOWOW のプライム・ライブ・シネマ。同じ会社でも TS が別
        [191, 'BS03_3'],
        [192, 'BS05_3'],
        [193, 'BS05_1'],
        [231, 'BS13_2'],
        [232, 'BS13_2'],
        // J SPORTS 1〜4 も TS が別
        [242, 'BS19_1'],
        [243, 'BS19_2'],
        [244, 'BS19_3'],
        [245, 'BS19_0'],
        // BS10 と BS10プレミアム
        [200, 'BS15_1'],
        [263, 'BS15_2'],
    ];
    const bs = (sid: number) => station(400000 + sid, sid, BS.find(([s]) => s === sid)![1], 'BS');
    const bsMain = mainOf(BS.map(([sid]) => bs(sid)));
    const mainSid = (sid: number) => bsMain.get(400000 + sid)! - 400000;

    test('BS も同じ TS を束ねる (BS朝日1〜3、NHK BS 101〜103 …)', () => {
        expect([101, 102, 103].map(mainSid)).toEqual([101, 101, 101]);
        expect([141, 142, 143].map(mainSid)).toEqual([141, 141, 141]);
        expect([151, 152, 153].map(mainSid)).toEqual([151, 151, 151]);
        expect([161, 162, 163].map(mainSid)).toEqual([161, 161, 161]);
        expect([171, 172, 173].map(mainSid)).toEqual([171, 171, 171]);
        expect([181, 182, 183].map(mainSid)).toEqual([181, 181, 181]);
        expect([231, 232].map(mainSid)).toEqual([231, 231]);
    });

    test('TS が別なら、番号が並んでいても同じ会社でも束ねない (WOWOW、J SPORTS、BS10)', () => {
        for (const sid of [191, 192, 193, 242, 243, 244, 245, 200, 263]) expect(mainSid(sid)).toBe(sid);
        // 名前が違っても分割放送にはならない
        expect(
            splitOf([program(bs(191).id, 4, 5, '映画'), program(bs(192).id, 4, 5, 'ライブ')], bsMain).size,
        ).toBe(0);
    });

    test('番組の来ないサブ (NHK BS の 103) は本チャンネルにまとまって列を立てない', () => {
        const services = [bs(101), bs(102), bs(103)];
        const main = mainOf(services);
        const programs = [program(bs(101).id, 4, 5, 'ニュース'), program(bs(102).id, 4, 5, '')];
        const split = splitOf(programs, main);
        expect(columnsOf(services, main, split).map((s) => s.id)).toEqual([bs(101).id]);
        expect(shape(cellsOf(columnsOf(services, main, split), programs, main, split))).toEqual([
            [bs(101).id, 0, 1, 4, 5],
        ]);
    });

    test('CS と SKY は同じ TS でも束ねない (1つの TS に別々の会社の局が乗る)', () => {
        const a = station(20, 296, 'CS2', 'CS');
        const b = station(21, 298, 'CS2', 'CS');
        const c = station(22, 800, 'SKY1', 'SKY');
        const d = station(23, 801, 'SKY1', 'SKY');
        const main = mainOf([a, b, c, d]);
        expect([a, b, c, d].map((s) => main.get(s.id))).toEqual([a.id, b.id, c.id, d.id]);
    });

    test('種別が違えば、同じ名前のチャンネルでも束ねない', () => {
        const gr = station(30, 1024, 'X1');
        const sat = station(31, 101, 'X1', 'BS');
        const main = mainOf([gr, sat]);
        expect(main.get(sat.id)).toBe(sat.id);
    });

    test('名前の無い枠も、重なる時間の本チャンネルと同じ名前の番組も相乗り', () => {
        const main = mainOf([TX, TX2, TX3]);
        const programs = [
            program(TX.id, 4, 6, 'ニュース'),
            program(TX2.id, 4, 5, ''),
            // 時刻がずれていても、名前が同じなら同じ番組
            program(TX3.id, 4.5, 6.5, 'ニュース'),
        ];
        expect(splitOf(programs, main).size).toBe(0);
    });

    test('名前の幅だけ違っても同じ番組 (英数を全角で送るか半角で送るかは EIT ごとに違いうる)', () => {
        const main = mainOf([TX, TX2]);
        const programs = [program(TX.id, 4, 6, 'ＷＢＳ　２３時'), program(TX2.id, 4, 6, 'WBS 23時')];
        expect(splitOf(programs, main).size).toBe(0);
    });

    test('出すのは分割放送のあるサブだけ。本チャンネルのすぐ右に寄せる', () => {
        // 別の地域の局が間に挟まっていても寄せる
        const other = station(9, 1040, 'T30');
        const services = [TX, other, TX2, TX3, NHK, NHK2];
        const main = mainOf(services);
        const split = splitOf(
            [program(TX.id, 4, 5), program(TX3.id, 4, 5, '野球'), program(NHK2.id, 4, 5, '相撲')],
            main,
        );
        expect(columnsOf(services, main, null).map((s) => s.id)).toEqual([TX.id, other.id, NHK.id]);
        // テレ東2 はずっと相乗りなので列を立てない
        expect(columnsOf(services, main, split).map((s) => s.id)).toEqual([
            TX.id,
            TX3.id,
            other.id,
            NHK.id,
            NHK2.id,
        ]);
    });

    test('既定はサブも出す。cookie が "0" (切った) のときだけ隠す', () => {
        expect(storedSubchannels(undefined)).toBe(true);
        expect(storedSubchannels('1')).toBe(true);
        expect(storedSubchannels('0')).toBe(false);
    });
});

describe('マスを組む', () => {
    test('ずっと相乗りなら、出す設定でもサブの列は立たない', () => {
        const { columns, cells } = layout([
            program(TX.id, 4, 5, 'ニュース'),
            program(TX2.id, 4, 5, ''),
            program(TX3.id, 4, 5, 'ニュース'),
        ]);
        expect(columns).toEqual([TX.id]);
        expect(shape(cells)).toEqual([[TX.id, 0, 1, 4, 5]]);
    });

    test('相乗り中は本チャンネルのマスがサブの列まで伸びる', () => {
        const { columns, cells } = layout([
            program(TX.id, 4, 5, 'ニュース'),
            program(TX.id, 5, 6, 'ドラマ'),
            program(TX2.id, 5, 6, '野球'),
            // ニュースの間は名前の無い枠、番組が無い
            program(TX2.id, 4, 5, ''),
        ]);
        expect(columns).toEqual([TX.id, TX2.id]);
        expect(shape(cells)).toEqual([
            [TX.id, 0, 2, 4, 5],
            [TX.id, 0, 1, 5, 6],
            [TX2.id, 1, 1, 5, 6],
        ]);
    });

    test('相乗りのサブが本チャンネルと隣り合わないときは別のマスにする', () => {
        const { cells } = layout([
            program(TX.id, 4, 6, '特番'),
            program(TX2.id, 4, 5, '野球'),
            program(TX3.id, 5, 6, '相撲'),
        ]);
        expect(shape(cells)).toEqual([
            [TX.id, 0, 1, 4, 5],
            [TX2.id, 1, 1, 4, 5],
            // テレ東3 は相乗り。間にテレ東2 の野球が挟まる
            [TX.id, 2, 1, 4, 5],
            [TX.id, 0, 2, 5, 6],
            [TX3.id, 2, 1, 5, 6],
        ]);
    });

    test('分割放送が番組の途中で始まって途中で終わる', () => {
        const { columns, cells } = layout([
            program(TX.id, 4, 8, '特番'),
            program(TX3.id, 5, 6, '野球'),
            // 分割放送の後ろは相乗りに戻る
            program(TX3.id, 6, 8, ''),
        ]);
        expect(columns).toEqual([TX.id, TX3.id]);
        expect(shape(cells)).toEqual([
            [TX.id, 0, 2, 4, 5],
            [TX.id, 0, 1, 5, 6],
            [TX3.id, 1, 1, 5, 6],
            [TX.id, 0, 2, 6, 8],
        ]);
    });

    test('分割放送が続けて並んでいるだけなら本チャンネルのマスは切らない', () => {
        const { cells } = layout([
            program(TX.id, 4, 8, '特番'),
            program(TX2.id, 4, 6, '野球'),
            program(TX2.id, 6, 8, '延長'),
        ]);
        expect(shape(cells)).toEqual([
            [TX.id, 0, 1, 4, 8],
            [TX2.id, 1, 1, 4, 6],
            [TX2.id, 1, 1, 6, 8],
        ]);
    });

    test('分割放送が本チャンネルの番組をまたぐ', () => {
        const { cells } = layout([
            program(TX.id, 4, 5, 'A'),
            program(TX.id, 5, 6, 'B'),
            program(TX2.id, 4.5, 5.5, '野球'),
            program(TX3.id, 4.5, 5.5, '相撲'),
        ]);
        expect(shape(cells)).toEqual([
            [TX.id, 0, 3, 4, 4.5],
            [TX.id, 0, 1, 4.5, 5],
            [TX2.id, 1, 1, 4.5, 5.5],
            [TX3.id, 2, 1, 4.5, 5.5],
            [TX.id, 0, 1, 5, 5.5],
            [TX.id, 0, 3, 5.5, 6],
        ]);
    });

    test('長さの無い枠も消さない', () => {
        expect(shape(layout([program(TX.id, 4, 4), program(TX2.id, 4, 5, '野球')]).cells)).toEqual([
            [TX.id, 0, 1, 4, 4],
            [TX2.id, 1, 1, 4, 5],
        ]);
    });

    test('マスの鍵は重ならない', () => {
        const keys = layout([program(TX.id, 4, 8), program(TX2.id, 5, 6, '野球')]).cells.map((c) => c.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    test('サブを出さないときは、サブの番組を置かない', () => {
        const { columns, cells } = layout([program(TX.id, 4, 5), program(TX2.id, 4, 5, '野球')], false);
        expect(columns).toEqual([TX.id]);
        expect(shape(cells)).toEqual([[TX.id, 0, 1, 4, 5]]);
    });
});
