import { describe, expect, test } from 'bun:test';
import {
    calendarDay,
    dayAriaLabel,
    markDays,
    monthGrid,
    monthLabel,
    monthOf,
    moveDay,
    navigableMonths,
    stepMonth,
} from './calendar';
import { dayStart } from './timeline';

const H = 3_600_000;
/** 2026年10月19日 (月) 14:30 */
const NOW = new Date(2026, 9, 19, 14, 30).getTime();
const today = dayStart(NOW);
const day = (m: number, d: number) => new Date(2026, m - 1, d).getTime();

describe('月の升目', () => {
    test('週は日曜からで、月の外は空ける', () => {
        // 2026年10月1日は木曜
        const weeks = monthGrid(monthOf(NOW));
        expect(weeks[0]).toEqual([null, null, null, null, day(10, 1), day(10, 2), day(10, 3)]);
        expect(weeks.flat().filter((cell) => cell !== null)).toHaveLength(31);
        expect(weeks.every((week) => week.length === 7)).toBe(true);
        // 31日は土曜なので、最後の週はちょうど埋まる
        expect(weeks.at(-1)?.at(-1)).toBe(day(10, 31));
    });

    test('升の値は一覧の見出しと同じ 0 時', () => {
        for (const cell of monthGrid(monthOf(NOW)).flat()) {
            if (cell !== null) expect(dayStart(cell)).toBe(cell);
        }
    });

    test('うるう年の2月', () => {
        const feb = monthGrid(2028 * 12 + 1)
            .flat()
            .filter((cell) => cell !== null);
        expect(feb).toHaveLength(29);
    });

    test('月の見出し', () => {
        expect(monthLabel(monthOf(NOW))).toBe('2026年10月');
        expect(monthLabel(2027 * 12)).toBe('2027年1月');
    });
});

describe('日ごとの印', () => {
    test('録れたものはその日、予約と録画中は今日より前に置かない', () => {
        expect(calendarDay({ kind: 'rec', zone: 'past', at: NOW - 30 * H }, today)).toBe(day(10, 18));
        // 0 時をまたいで録っている (昨日始まった) 録画中は今日
        expect(calendarDay({ kind: 'res', zone: 'now', at: NOW - 15 * H }, today)).toBe(today);
        // 始まったのに録画に入っていない予約も今日
        expect(calendarDay({ kind: 'res', zone: 'future', at: NOW - 15 * H }, today)).toBe(today);
        expect(calendarDay({ kind: 'res', zone: 'future', at: NOW + 24 * H }, today)).toBe(day(10, 20));
    });

    test('種類と側ごとに数える', () => {
        const marks = markDays(
            [
                { kind: 'rec', zone: 'past', at: NOW - 2 * H },
                { kind: 'missed', zone: 'past', at: NOW - 3 * H },
                { kind: 'res', zone: 'past', at: NOW - 4 * H },
                { kind: 'res', zone: 'now', at: NOW - H },
                { kind: 'res', zone: 'future', at: NOW + H },
                { kind: 'res', zone: 'future', at: NOW + 2 * H },
                { kind: 'res', zone: 'future', at: NOW + 48 * H },
            ],
            today,
        );
        expect(marks.get(today)).toEqual({ recorded: 1, missed: 1, ended: 1, recording: 1, reserved: 2 });
        expect(marks.get(day(10, 21))).toEqual({
            recorded: 0,
            missed: 0,
            ended: 0,
            recording: 0,
            reserved: 1,
        });
        expect(marks.has(day(10, 20))).toBe(false);
    });

    test('読み上げの名前', () => {
        const marks = markDays(
            [
                { kind: 'res', zone: 'future', at: NOW + H },
                { kind: 'res', zone: 'future', at: NOW + 2 * H },
                { kind: 'res', zone: 'future', at: NOW + 3 * H },
            ],
            today,
        );
        expect(dayAriaLabel(today, marks.get(today), today)).toBe('10月19日 (今日)、予約 3件');
        expect(dayAriaLabel(day(10, 20), undefined, today)).toBe('10月20日、なし');
        expect(
            dayAriaLabel(day(10, 1), { recorded: 2, missed: 1, ended: 0, recording: 0, reserved: 0 }, today),
        ).toBe('10月1日、録画 2件、録り逃し 1件');
    });
});

describe('月の行き来', () => {
    const oct = monthOf(NOW);
    test('行のある月だけを古い順に。今日の月は行が無くても入る', () => {
        const months = navigableMonths([day(7, 3), day(7, 9), new Date(2027, 1, 2).getTime()], [oct]);
        expect(months).toEqual([oct - 3, oct, oct + 4]);
    });

    test('空の月は飛ばし、端の先は無い', () => {
        const months = [oct - 3, oct, oct + 4];
        expect(stepMonth(months, oct, -1)).toBe(oct - 3);
        expect(stepMonth(months, oct, 1)).toBe(oct + 4);
        expect(stepMonth(months, oct - 3, -1)).toBeNull();
        expect(stepMonth(months, oct + 4, 1)).toBeNull();
        // 行き先の無い月にいても、前後の行のある月へ行ける
        expect(stepMonth(months, oct + 1, -1)).toBe(oct);
    });

    test('矢印の鍵で日を動かす', () => {
        expect(moveDay(today, 'ArrowRight')).toBe(day(10, 20));
        expect(moveDay(today, 'ArrowUp')).toBe(day(10, 12));
        expect(moveDay(day(10, 31), 'ArrowDown')).toBe(day(11, 7));
        expect(moveDay(today, 'Enter')).toBeNull();
    });
});
