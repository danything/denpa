import { describe, expect, test } from 'bun:test';
import { flatLines, type Groupable, groupBySeries, groupLines, storedGrouped } from './grouping';

function row(key: string, group: string, at: number): Groupable {
    return { key, at, group, groupName: `${group}の名前` };
}

/** 一覧の並び (サーバは新しい順で返す) */
const rows = [
    row('rec-6', 'アニメ', 600),
    row('rec-5', 'ドラマ', 500),
    row('missed-1', 'ニュース', 450),
    row('rec-4', 'アニメ', 400),
    row('rec-3', 'ニュース', 300),
    row('rec-2', 'アニメ', 200),
    row('rec-1', '単発', 100),
];

describe('番組ごとにまとめる', () => {
    test('番組どうしはいちばん新しい回が新しい順、1本だけの番組はまとめずに混ぜる', () => {
        const entries = groupBySeries(rows);
        expect(entries.map((e) => (e.kind === 'group' ? e.group.key : e.item.key))).toEqual([
            'group-アニメ',
            'rec-5',
            'group-ニュース',
            'rec-1',
        ]);
    });

    test('番組の中は放送順 (古い回が先)', () => {
        const [anime] = groupBySeries(rows);
        if (anime?.kind !== 'group') throw new Error('まとまっていない');
        expect(anime.group.items.map((i) => i.key)).toEqual(['rec-2', 'rec-4', 'rec-6']);
        expect(anime.group.newest.key).toBe('rec-6');
        expect(anime.group.name).toBe('アニメの名前');
    });

    test('録り逃しも同じ番組に入る', () => {
        const news = groupBySeries(rows)[2];
        if (news?.kind !== 'group') throw new Error('まとまっていない');
        expect(news.group.items.map((i) => i.key)).toEqual(['rec-3', 'missed-1']);
    });

    test('渡す順に左右されない', () => {
        const shuffled = [...rows].reverse();
        expect(groupBySeries(shuffled)).toEqual(groupBySeries(rows));
    });

    test('空なら空', () => {
        expect(groupBySeries([])).toEqual([]);
    });
});

describe('描く行に開く', () => {
    test('閉じている番組は見出しだけ', () => {
        const lines = groupLines(groupBySeries(rows), () => false);
        expect(lines.map((l) => l.key)).toEqual(['group-アニメ', 'rec-5', 'group-ニュース', 'rec-1']);
        expect(lines.filter((l) => l.kind === 'head').every((l) => l.kind === 'head' && !l.open)).toBe(true);
    });

    test('開いた番組は見出しのすぐ下に放送順で続く', () => {
        const lines = groupLines(groupBySeries(rows), (group) => group === 'アニメ');
        expect(lines.map((l) => l.key)).toEqual([
            'group-アニメ',
            'rec-2',
            'rec-4',
            'rec-6',
            'rec-5',
            'group-ニュース',
            'rec-1',
        ]);
        expect(lines[0]).toMatchObject({ kind: 'head', open: true });
        expect(lines[1]).toMatchObject({ kind: 'row', nested: true });
        // 1本だけの番組は中の行ではない
        expect(lines[4]).toMatchObject({ kind: 'row', nested: false });
    });

    test('まとめないときは渡した順のまま', () => {
        expect(flatLines(rows).map((l) => l.key)).toEqual(rows.map((r) => r.key));
        expect(flatLines(rows).every((l) => l.kind === 'row' && !l.nested)).toBe(true);
    });
});

test('覚えていた値。既定はまとめない', () => {
    expect(storedGrouped(undefined)).toBe(false);
    expect(storedGrouped('0')).toBe(false);
    expect(storedGrouped('1')).toBe(true);
});
