import { describe, expect, test } from 'bun:test';
import {
    catchUp,
    countFilters,
    dayName,
    dayStart,
    lineIndex,
    mergeRecorded,
    pageStart,
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

    test('どの側も時刻の早い順 (録画は古い順、予約は近い順)。どちらも「いま」に近いものが線の側に来る', () => {
        const parts = sections(items);
        expect(parts.past.map((i) => i.key)).toEqual(['missed-1', 'rec-1', 'rec-2']);
        expect(parts.now.map((i) => i.key)).toEqual(['res-now']);
        expect(parts.future.map((i) => i.key)).toEqual(['res-1', 'res-2']);
    });

    test('日付の見出しはその日の頭に立ち、「いま」の線の下に録画中、その下に予約を置く', () => {
        const { past, now, future } = timelineLines(sections(items), { grouped: false, isOpen: () => false });
        const today = dayStart(NOW);
        const yesterday = dayStart(NOW - 26 * H);
        expect(keys(past)).toEqual([
            `day-past-${yesterday}`,
            'missed-1',
            `day-past-${today}`,
            'rec-1',
            'rec-2',
        ]);
        expect(keys(now)).toEqual(['now', 'res-now']);
        expect(keys(future)).toEqual([`day-future-${today}`, 'res-1', 'res-2']);
    });

    test('何も無くても「いま」の線は残す', () => {
        const { past, now, future } = timelineLines(sections([]), { grouped: false, isOpen: () => false });
        expect(keys(now)).toEqual(['now']);
        expect(past).toEqual([]);
        expect(future).toEqual([]);
    });
});

describe('録れたものを線の側から描く頭', () => {
    const items = [
        item('rec-1', 'past', NOW - 50 * H),
        item('rec-2', 'past', NOW - 49 * H),
        item('rec-3', 'past', NOW - 26 * H),
        item('rec-4', 'past', NOW - 3 * H),
        item('rec-5', 'past', NOW - 2 * H),
    ];
    const { past } = timelineLines(sections(items), { grouped: false, isOpen: () => false });

    test('日付の途中に落ちたら、その日の見出しまで戻す', () => {
        // [day, rec-1, rec-2, day, rec-3, day, rec-4, rec-5]。末尾 1 行なら今日の見出しから
        expect(pageStart(past, 1)).toBe(5);
        expect(pageStart(past, 3)).toBe(5);
        expect(pageStart(past, 4)).toBe(3);
        expect(pageStart(past, 6)).toBe(0);
        expect(pageStart(past, 100)).toBe(0);
    });

    test('まとめて表示: 開いた番組の中に落ちたら見出しまで戻し、残りが側の見出しだけなら全部', () => {
        const grouped = timelineLines(
            sections([
                ...items,
                item('rec-a1', 'past', NOW - 40 * H, 'A'),
                item('rec-a2', 'past', NOW - 30 * H, 'A'),
            ]),
            { grouped: true, isOpen: () => true },
        ).past;
        expect(keys(grouped)).toEqual([
            'side-past',
            'rec-1',
            'rec-2',
            'past-group-A',
            'rec-a1',
            'rec-a2',
            'rec-3',
            'rec-4',
            'rec-5',
        ]);
        expect(pageStart(grouped, 3)).toBe(6);
        expect(pageStart(grouped, 4)).toBe(3);
        expect(pageStart(grouped, 8)).toBe(0);
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
        const { past, future } = timelineLines(sections(items), { grouped: true, isOpen: () => false });
        expect(keys(past)).toEqual(['side-past', 'rec-n', 'past-group-アニメ']);
        expect(keys(future)).toEqual(['side-future', 'future-group-アニメ', 'res-x', 'future-group-ドラマ']);
    });

    test('予約の番組は次の回の位置に置く (いちばん早い予約が線のすぐ下)', () => {
        const { future } = timelineLines(sections(items), { grouped: true, isOpen: () => false });
        const heads = future.filter((line) => line.kind === 'head');
        // アニメの次の回 (2時間後) はドラマの次の回 (10時間後) より早いので、線の側 (上) に来る
        expect(heads.map((line) => line.key)).toEqual(['future-group-アニメ', 'future-group-ドラマ']);
    });

    test('開くのは側ごと。中身は放送順', () => {
        const { past, future } = timelineLines(sections(items), {
            grouped: true,
            isOpen: (zone, group) => zone === 'future' && group === 'アニメ',
        });
        expect(keys(future)).toEqual([
            'side-future',
            'future-group-アニメ',
            'res-a1',
            'res-a2',
            'res-x',
            'future-group-ドラマ',
        ]);
        expect(keys(past)).toEqual(['side-past', 'rec-n', 'past-group-アニメ']);
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
        failed: i.key === 'rec-failed',
        missed: i.key === 'missed-1',
    });

    test('件数はボタンごとに数える', () => {
        expect(countFilters(items, traits)).toEqual({
            all: 6,
            reservations: 1,
            recording: 1,
            unfinished: 2,
            conflict: 0,
            failed: 1,
            missed: 1,
            cmlogo: 0,
        });
    });

    test('見てほしいこと: 競合は予約だけ、失敗・録り逃し・CM の判定は録れたものだけ', () => {
        const conflict = { unfinished: false, failed: false, conflict: true };
        const cmlogo = { unfinished: false, failed: false, cmlogo: true };
        expect(passes('conflict', items[0]!, conflict)).toBe(true);
        // 競合は予約だけ (録れたものに付いていても数えない)
        expect(passes('conflict', items[2]!, conflict)).toBe(false);
        expect(passes('cmlogo', items[2]!, cmlogo)).toBe(true);
        expect(passes('cmlogo', items[0]!, cmlogo)).toBe(false);
        expect(passes('missed', items[5]!, traits(items[5]!))).toBe(true);
        expect(passes('failed', items[5]!, traits(items[5]!))).toBe(false);
    });

    test('予約と録画中は線の下、未視聴と失敗は録れたものだけ', () => {
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
        const { past: lines } = timelineLines(sections(grouped), { grouped: true, isOpen: () => false });
        expect(lineIndex(lines, 'rec-a1')).toBe(1);
        expect(lineIndex(lines, 'rec-zz')).toBe(-1);
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

describe('終わった予約と録画をまとめる', () => {
    const res = (id: number, program: number | null, end: number, state = 'done', name = `番組${id}`) => ({
        id,
        program_id: program,
        end_at: end,
        state,
        name,
    });
    const rec = (id: number, reservation: number | null, program: number | null, name = `番組${id}`) => ({
        id,
        reservation_id: reservation,
        program_id: program,
        name,
    });

    test('録画が見つかる終わった予約は出さない (予約の ID でも、予約を持たない録画の番組でも)', () => {
        const { reservations } = mergeRecorded(
            [res(1, 10, NOW - H), res(2, 20, NOW - H), res(3, 30, NOW - H, 'canceled')],
            [rec(100, 1, 10), rec(101, null, 20)],
            NOW,
        );
        // 録画の無い予約 (取消) だけが残る
        expect(reservations.map((r) => r.id)).toEqual([3]);
    });

    test('録画が一覧に無くても (消した録画)、録画のあった予約は出さない', () => {
        const { reservations } = mergeRecorded(
            [{ ...res(1, 10, NOW - H), recorded: true }, res(2, 20, NOW - H, 'canceled')],
            [],
            NOW,
        );
        expect(reservations.map((r) => r.id)).toEqual([2]);
    });

    test('これからの予約と録画中の予約は、録画があっても残す', () => {
        const { reservations } = mergeRecorded(
            [res(1, 10, NOW + H, 'scheduled'), res(2, 20, NOW - H, 'recording')],
            [rec(100, 1, 10), rec(101, 2, 20)],
            NOW,
        );
        expect(reservations.map((r) => r.id)).toEqual([1, 2]);
    });

    test('録画の名前に無い副題は予約の名前から持ってくる', () => {
        const { names } = mergeRecorded(
            [res(1, 10, NOW - H, 'done', '魔法少女 #3「エルマ」'), res(2, 20, NOW - H, 'done', '別の名前')],
            [rec(100, 1, 10, '魔法少女'), rec(101, 2, 20, 'まったく違う')],
            NOW,
        );
        expect(names.get(100)).toBe('魔法少女 #3「エルマ」');
        // 片方がもう片方を含まないときは録画の名前のまま
        expect(names.has(101)).toBe(false);
    });
});
