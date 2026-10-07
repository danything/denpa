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

function station(id: number, serviceId: number, networkId: number, type = 'GR'): Station {
    return { id, service_id: serviceId, network_id: networkId, type };
}

// テレ東 (1072〜1074) と NHK総合 (1024・1025)。並びは SERVICE_ORDER のとおり
const TX = station(1, 1072, 32742);
const TX2 = station(2, 1073, 32742);
const TX3 = station(3, 1074, 32742);
const NHK = station(4, 1024, 32736);
const NHK2 = station(5, 1025, 32736);

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
    test('地上波は同じネットワークID を束ね、サービスID のいちばん若い局が本チャンネル', () => {
        // 渡す順は問わない
        const main = mainOf([TX3, NHK2, TX, NHK, TX2]);
        expect(main.get(TX.id)).toBe(TX.id);
        expect(main.get(TX2.id)).toBe(TX.id);
        expect(main.get(TX3.id)).toBe(TX.id);
        expect(main.get(NHK2.id)).toBe(NHK.id);
    });

    test('衛星は束ねない (WOWOW の 191〜193 はそれぞれが本チャンネル)', () => {
        const prime = station(10, 191, 4, 'BS');
        const live = station(11, 192, 4, 'BS');
        const main = mainOf([prime, live]);
        expect(main.get(live.id)).toBe(live.id);
        // 名前が違っても分割放送にはならない
        expect(splitOf([program(prime.id, 4, 5, '映画'), program(live.id, 4, 5, 'ライブ')], main).size).toBe(
            0,
        );
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

    test('既定はサブを出さない。出すときは分割放送のあるサブだけ、本チャンネルのすぐ右に寄せる', () => {
        // 別の地域の局が間に挟まっていても寄せる
        const other = station(9, 1040, 32000);
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

    test('cookie の覚えは "1" のときだけ出す', () => {
        expect(storedSubchannels(undefined)).toBe(false);
        expect(storedSubchannels('0')).toBe(false);
        expect(storedSubchannels('1')).toBe(true);
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
