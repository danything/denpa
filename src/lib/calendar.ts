/**
 * ホームのサイドバーの**月のカレンダー** (`HomeCalendar.svelte`)。画面に触らない所だけを置く (単体テストで見る)。
 *
 * 日は一覧の日付の見出しと同じ物差し (`#lib/timeline.ts` の `dayStart`。端末の時刻帯の 0 時) で数える。
 * 押した日の見出しを `data-day` で探すので、ずれると押しても動かない。
 * 予約・録画中は、一覧と同じく今日より前の日には置かない (始まったのに録画に入っていない予約も今日の見出しの下)
 */

import { dayStart, type Zone } from "./timeline";

/** その日にある行の数。一覧に出ている行 (絞り込みの後) だけ数える */
export interface DayMark {
  /** 録画 */
  recorded: number;
  /** 録り逃し */
  missed: number;
  /** 終わった予約 (「完了した予約も表示」のとき。取消・失敗など、録画の無いもの) */
  ended: number;
  /** 録画中 */
  recording: number;
  /** これからの予約 */
  reserved: number;
}

/** カレンダーに数える行。一覧の行 (`Item`) から種類と時刻と側だけ */
interface CalendarItem {
  kind: "rec" | "missed" | "res";
  zone: Zone;
  at: number;
}

/** 月は `年 * 12 + 月 (0 始まり)` の1つの数で持つ (前後の月は ±1) */
export function monthOf(at: number): number {
  const d = new Date(at);
  return d.getFullYear() * 12 + d.getMonth();
}

/** 月の見出し (「2026年10月」) */
export function monthLabel(month: number): string {
  return `${Math.floor(month / 12)}年${(month % 12) + 1}月`;
}

/** その行が一覧でどの日の見出しの下に入るか。録画中と予約は今日より前に置かない (`timeline.ts` の `byDay`) */
export function calendarDay(item: CalendarItem, today: number): number {
  const day = dayStart(item.at);
  return item.zone === "past" ? day : Math.max(day, today);
}

/** 日ごとの行の数。鍵はその日の 0 時 */
export function markDays(
  items: CalendarItem[],
  today: number,
): Map<number, DayMark> {
  const marks = new Map<number, DayMark>();
  for (const item of items) {
    const day = calendarDay(item, today);
    let mark = marks.get(day);
    if (mark === undefined) {
      mark = { recorded: 0, missed: 0, ended: 0, recording: 0, reserved: 0 };
      marks.set(day, mark);
    }
    if (item.zone === "now") mark.recording += 1;
    else if (item.zone === "future") mark.reserved += 1;
    else if (item.kind === "rec") mark.recorded += 1;
    else if (item.kind === "missed") mark.missed += 1;
    else mark.ended += 1;
  }
  return marks;
}

/**
 * 月の升目。週は日曜から。月の外の升は null (前後の月の日は描かない)。
 * 値はその日の 0 時で、一覧の見出しの `data-day` と同じ
 */
export function monthGrid(month: number): (number | null)[][] {
  const year = Math.floor(month / 12);
  const index = month % 12;
  const lead = new Date(year, index, 1).getDay();
  const days = new Date(year, index + 1, 0).getDate();
  const cells: (number | null)[] = Array.from({ length: lead }, () => null);
  for (let date = 1; date <= days; date++)
    cells.push(new Date(year, index, date).getTime());
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let at = 0; at < cells.length; at += 7)
    weeks.push(cells.slice(at, at + 7));
  return weeks;
}

/**
 * ‹ › で行き来できる月。**行のある月だけ** (いちばん古い録画からいちばん先の予約まで、間の空の月は飛ばす)。
 * `always` (今日の月・いま見ている月) は行が無くても入れる。古い順
 */
export function navigableMonths(
  days: Iterable<number>,
  always: number[],
): number[] {
  const months = new Set(always);
  for (const day of days) months.add(monthOf(day));
  return [...months].sort((a, b) => a - b);
}

/** `current` の前 (`-1`) か次 (`1`) の行き先。無ければ null */
export function stepMonth(
  months: number[],
  current: number,
  direction: -1 | 1,
): number | null {
  if (direction < 0) return months.findLast((month) => month < current) ?? null;
  return months.find((month) => month > current) ?? null;
}

/** 矢印の鍵で動かした先の日 (←→ は1日、↑↓ は1週)。ほかの鍵なら null */
export function moveDay(day: number, key: string): number | null {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[key];
  if (step === undefined) return null;
  const d = new Date(day);
  d.setDate(d.getDate() + step);
  return d.getTime();
}

/** 読み上げの名前 (「10月19日 (今日)、予約 3件」)。行が無ければ「なし」 */
export function dayAriaLabel(
  day: number,
  mark: DayMark | undefined,
  today: number,
): string {
  const d = new Date(day);
  const name = `${d.getMonth() + 1}月${d.getDate()}日${day === today ? " (今日)" : ""}`;
  const parts: string[] = [];
  if (mark !== undefined) {
    if (mark.recorded > 0) parts.push(`録画 ${mark.recorded}件`);
    if (mark.missed > 0) parts.push(`録り逃し ${mark.missed}件`);
    if (mark.ended > 0) parts.push(`終わった予約 ${mark.ended}件`);
    if (mark.recording > 0) parts.push(`録画中 ${mark.recording}件`);
    if (mark.reserved > 0) parts.push(`予約 ${mark.reserved}件`);
  }
  return `${name}、${parts.length === 0 ? "なし" : parts.join("、")}`;
}
