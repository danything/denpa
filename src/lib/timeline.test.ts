import { describe, expect, test } from 'bun:test';
import {
    catchUp,
    countFilters,
    dayName,
    dayStart,
    lineIndex,
    passes,
    sections,
    type TimelineItem,
    type TimelineLine,
    type Traits,
    timelineLines,
    type Zone,
} from './timeline';

const H = 3_600_000;
/** 2026-10-18 12:00 (端末の時刻帯) */
const NOW = new Date(2026, 9, 18, 12, 0).getTime();

function item(key: string, zone: Zone, at: number, group = key): TimelineItem {
    return { key, zone, at, group, groupName: `${group}の名前` };
}

const keys = (lines: TimelineLine<TimelineItem>[]) => lines.map((line) => line.key);

describe('側ごとの並び', () => {
    const items = [
        item('rec-1', 'past', NOW - 3 * H),
        item('res-2', 'future', NOW + 5 * H),
        item('res-now', 'now', NOW - H),
        item('res-1', 'future', NOW + H),
        item('rec-2', 'past', NOW - 2 * H),
        item('missed-1', 'past', NOW - 26 * H),
    ];

    test('予約は遠い先が上、録画は新しい順。どちらも「いま」に近いものが線の側に来る', () => {
        const parts = sections(items);
        expect(parts.future.map((i) => i.key)).toEqual(['res-2', 'res-1']);
        expect(parts.now.map((i) => i.key)).toEqual(['res-now']);
        expect(parts.past.map((i) => i.key)).toEqual(['rec-2', 'rec-1', 'missed-1']);
    });

    test('日付の見出しを挟み、「いま」の線の下に録画中を置く', () => {
        const { above, below } = timelineLines(sections(items), { grouped: false, isOpen: () => false });
        const today = dayStart(NOW);
        const yesterday = dayStart(NOW - 26 * H);
        expect(keys(above)).toEqual([`day-future-${today}`, 'res-2', 'res-1', 'now', 'res-now']);
        expect(keys(below)).toEqual([
            `day-past-${today}`,
            'rec-2',
            'rec-1',
            `day-past-${yesterday}`,
            'missed-1',
        ]);
    });

    test('何も無くても「いま」の線は残す', () => {
        const { above, below } = timelineLines(sections([]), { grouped: false, isOpen: () => false });
        expect(keys(above)).toEqual(['now']);
        expect(below).toEqual([]);
    });
});

describe('まとめて表示', () => {
    const items = [
        item('res-a2', 'future', NOW + 30 * H, 'アニメ'),
        item('res-a1', 'future', NOW + 2 * H, 'アニメ'),
        item('res-d1', 'future', NOW + 10 * H, 'ドラマ'),
        item('res-d2', 'future', NOW + 20 * H, 'ドラマ'),
        item('res-x', 'future', NOW + 5 * H, '単発'),
        item('rec-a1', 'past', NOW - 20 * H, 'アニメ'),
        item('rec-a2', 'past', NOW - 2 * H, 'アニメ'),
        item('rec-n', 'past', NOW - 5 * H, 'ニュース'),
    ];

    test('同じ番組でも、予約と録画で側ごとに別の見出しを立てる', () => {
        const { above, below } = timelineLines(sections(items), { grouped: true, isOpen: () => false });
        expect(keys(above)).toEqual([
            'side-future',
            'future-group-ドラマ',
            'res-x',
            'future-group-アニメ',
            'now',
        ]);
        expect(keys(below)).toEqual(['side-past', 'past-group-アニメ', 'rec-n']);
    });

    test('予約の番組は次の回の位置に置く (いちばん早い予約が線のすぐ上)', () => {
        const { above } = timelineLines(sections(items), { grouped: true, isOpen: () => false });
        const heads = above.filter((line) => line.kind === 'head');
        // アニメの次の回 (2時間後) はドラマの次の回 (10時間後) より早いので、線の側 (下) に来る
        expect(heads.map((line) => line.key)).toEqual(['future-group-ドラマ', 'future-group-アニメ']);
    });

    test('開くのは側ごと。中身は放送順', () => {
        const { above, below } = timelineLines(sections(items), {
            grouped: true,
            isOpen: (zone, group) => zone === 'future' && group === 'アニメ',
        });
        expect(keys(above)).toEqual([
            'side-future',
            'future-group-ドラマ',
            'res-x',
            'future-group-アニメ',
            'res-a1',
            'res-a2',
            'now',
        ]);
        expect(keys(below)).toEqual(['side-past', 'past-group-アニメ', 'rec-n']);
    });
});

describe('絞り込み', () => {
    const plain: Traits = { unfinished: false, failed: false };
    const items = [
        item('res-1', 'future', NOW + H),
        item('res-now', 'now', NOW - H),
        item('rec-new', 'past', NOW - 2 * H),
        item('rec-old', 'past', NOW - 30 * H),
        item('rec-failed', 'past', NOW - 3 * H),
        item('missed-1', 'past', NOW - 4 * H),
    ];
    const traits = (i: TimelineItem): Traits => ({
        unfinished: i.key === 'rec-new' || i.key === 'rec-old',
        failed: i.key === 'rec-failed' || i.key === 'missed-1',
    });

    test('件数はボタンごとに数える', () => {
        expect(countFilters(items, traits)).toEqual({
            all: 6,
            reservations: 1,
            recording: 1,
            unfinished: 2,
            failed: 2,
            attention: 2,
            conflict: 0,
            cmlogo: 0,
        });
    });

    test('見てほしいことは、競合の予約・失敗・CM の判定ができなかった録画', () => {
        const conflict = { unfinished: false, failed: false, conflict: true };
        const cmlogo = { unfinished: false, failed: false, cmlogo: true };
        expect(passes('attention', items[0]!, conflict)).toBe(true);
        expect(passes('conflict', items[0]!, conflict)).toBe(true);
        // 競合は予約だけ (録れたものに付いていても数えない)
        expect(passes('conflict', items[2]!, conflict)).toBe(false);
        expect(passes('attention', items[2]!, cmlogo)).toBe(true);
        expect(passes('attention', items[4]!, traits(items[4]!))).toBe(true);
        expect(passes('attention', items[2]!, plain)).toBe(false);
    });

    test('予約は線の上、録画中は線の下、未視聴と失敗は録れたものだけ', () => {
        expect(passes('reservations', items[0]!, plain)).toBe(true);
        expect(passes('reservations', items[1]!, plain)).toBe(false);
        expect(passes('recording', items[1]!, plain)).toBe(true);
        // 録画中は観終えていなくても「未視聴」に入れない (まだ録っている)
        expect(passes('unfinished', items[1]!, { unfinished: true, failed: false })).toBe(false);
        expect(passes('failed', items[4]!, traits(items[4]!))).toBe(true);
    });
});

describe('開いたときに映すもの', () => {
    const past = sections([
        item('rec-3', 'past', NOW - H),
        item('rec-2', 'past', NOW - 10 * H),
        item('rec-1', 'past', NOW - 50 * H),
    ]).past;

    test('観終えていない録画のうち、いちばん古いもの', () => {
        expect(catchUp(past, (i) => i.key !== 'rec-1')?.key).toBe('rec-2');
    });

    test('全部観ていれば null (「いま」の線を映す)', () => {
        expect(catchUp(past, () => false)).toBeNull();
    });

    test('閉じた番組の中にあれば、その見出しの位置', () => {
        const grouped = [item('rec-a2', 'past', NOW - H, 'A'), item('rec-a1', 'past', NOW - 9 * H, 'A')];
        const { below } = timelineLines(sections(grouped), { grouped: true, isOpen: () => false });
        expect(lineIndex(below, 'rec-a1')).toBe(1);
        expect(lineIndex(below, 'rec-zz')).toBe(-1);
    });
});

describe('日付の呼び名', () => {
    test('今日・明日・昨日だけ言葉にする', () => {
        expect(dayName(NOW + 11 * H, NOW)).toBe('今日');
        expect(dayName(NOW + 13 * H, NOW)).toBe('明日');
        expect(dayName(NOW - 13 * H, NOW)).toBe('昨日');
        expect(dayName(NOW - 40 * H, NOW)).toBeNull();
    });
});
