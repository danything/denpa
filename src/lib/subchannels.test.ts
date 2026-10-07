import { describe, expect, test } from 'bun:test';
import {
    type Airing,
    cellsOf,
    columnsOf,
    hasSubchannels,
    mainOf,
    type Station,
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
        expect(hasSubchannels(main)).toBe(true);
    });

    test('衛星は束ねない (WOWOW の 191〜193 はそれぞれが本チャンネル)', () => {
        const prime = station(10, 191, 4, 'BS');
        const live = station(11, 192, 4, 'BS');
        const main = mainOf([prime, live]);
        expect(main.get(live.id)).toBe(live.id);
        expect(hasSubchannels(main)).toBe(false);
    });

    test('既定はサブを出さない。出すときは本チャンネルのすぐ右に寄せる', () => {
        // 別の地域の局が間に挟まっていても寄せる
        const other = station(9, 1040, 32000);
        const services = [TX, other, TX2, NHK, NHK2];
        const main = mainOf(services);
        expect(columnsOf(services, main, false).map((s) => s.id)).toEqual([TX.id, other.id, NHK.id]);
        expect(columnsOf(services, main, true).map((s) => s.id)).toEqual([
            TX.id,
            TX2.id,
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
    const services = [TX, TX2, TX3];
    const main = mainOf(services);
    const columns = columnsOf(services, main, true);

    test('相乗り中は本チャンネルのマスがサブの列まで伸びる', () => {
        const programs = [
            program(TX.id, 4, 5, 'ニュース'),
            // 名前の無い枠
            program(TX2.id, 4, 5, ''),
            // 本チャンネルと同じ番組を載せてくる EIT
            program(TX3.id, 4, 5, 'ニュース'),
        ];
        expect(shape(cellsOf(columns, programs, main))).toEqual([[TX.id, 0, 3, 4, 5]]);
    });

    test('サブの番組が無くても相乗りとみなす', () => {
        expect(shape(cellsOf(columns, [program(TX.id, 4, 6)], main))).toEqual([[TX.id, 0, 3, 4, 6]]);
    });

    test('分割放送の間だけサブに自分のマスを立てる', () => {
        const programs = [program(TX.id, 4, 5, 'ニュース'), program(TX2.id, 4, 5, '野球')];
        expect(shape(cellsOf(columns, programs, main))).toEqual([
            [TX.id, 0, 1, 4, 5],
            [TX2.id, 1, 1, 4, 5],
            // テレ東3 は相乗りのまま。本チャンネルとは隣り合っていないので別のマスになる
            [TX.id, 2, 1, 4, 5],
        ]);
    });

    test('分割放送が番組の途中で始まって途中で終わる', () => {
        const programs = [
            program(TX.id, 4, 8, '特番'),
            program(TX3.id, 5, 6, '野球'),
            // 分割放送の後ろは相乗りに戻る
            program(TX3.id, 6, 8, ''),
        ];
        expect(shape(cellsOf(columns, programs, main))).toEqual([
            [TX.id, 0, 3, 4, 5],
            [TX.id, 0, 2, 5, 6],
            [TX3.id, 2, 1, 5, 6],
            [TX.id, 0, 3, 6, 8],
        ]);
    });

    test('分割放送が続けて並んでいるだけなら本チャンネルのマスは切らない', () => {
        const programs = [
            program(TX.id, 4, 8, '特番'),
            program(TX2.id, 4, 6, '野球'),
            program(TX2.id, 6, 8, '延長'),
        ];
        expect(shape(cellsOf(columns, programs, main))).toEqual([
            [TX.id, 0, 1, 4, 8],
            [TX2.id, 1, 1, 4, 6],
            [TX.id, 2, 1, 4, 8],
            [TX2.id, 1, 1, 6, 8],
        ]);
    });

    test('分割放送が本チャンネルの番組をまたぐ', () => {
        const programs = [
            program(TX.id, 4, 5, 'A'),
            program(TX.id, 5, 6, 'B'),
            program(TX2.id, 4.5, 5.5, '野球'),
            program(TX3.id, 4.5, 5.5, '相撲'),
        ];
        expect(shape(cellsOf(columns, programs, main))).toEqual([
            [TX.id, 0, 3, 4, 4.5],
            [TX.id, 0, 1, 4.5, 5],
            [TX2.id, 1, 1, 4.5, 5.5],
            [TX3.id, 2, 1, 4.5, 5.5],
            [TX.id, 0, 1, 5, 5.5],
            [TX.id, 0, 3, 5.5, 6],
        ]);
    });

    test('マスの鍵は重ならない', () => {
        const programs = [program(TX.id, 4, 8), program(TX2.id, 5, 6, '野球')];
        const keys = cellsOf(columns, programs, main).map((c) => c.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    test('サブを出さないときは、サブの番組を置かない', () => {
        const hidden = columnsOf(services, main, false);
        const programs = [program(TX.id, 4, 5), program(TX2.id, 4, 5, '野球')];
        expect(shape(cellsOf(hidden, programs, main))).toEqual([[TX.id, 0, 1, 4, 5]]);
    });
});
