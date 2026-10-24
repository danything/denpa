import { pad, WEEKDAYS } from "./format";

/**
 * **ルールの時間帯と曜日** (`rules.time_from` / `time_to` / `weekdays`)。当てるのはサーバ
 * (`rules.missOf`)、書く欄の要約とルールの一覧の要約は画面。どちらもここを使う。
 *
 * - 見るのは番組の**始まる時刻**。日本時間で決める (サーバの TZ に頼らない。日本は夏時間が無いので +9 時間で足りる)
 * - 時間帯は `time_from` 以上 `time_to` 未満 (0:00 からの分)。`time_from > time_to` は日をまたぐ (23:00〜02:00)。
 *   同じ値は書く欄で断る (`rule-form.conditionsOf`)。片方だけ・同じ値の行が来ても、時間帯は無いものとして扱う
 * - 曜日は 0 が日曜 (`Date#getDay`・EPGStation と同じ)。日をまたぐ時間帯でも、**始まる時刻の暦の曜日**で見る
 *   (金 23:00〜02:00 は、金曜の 23 時台と、金曜の 0〜2 時に始まる番組。土曜の 1 時は入らない)
 * - どちらも NULL なら「いつでも」
 */

/** 時間帯と曜日の列 */
export interface Slot {
  time_from: number | null;
  time_to: number | null;
  weekdays: number[] | null;
}

/**
 * 要約で曜日を並べる順。月曜から (「月〜金」「土・日」)。書く欄のチップは日曜から
 * (ホームのカレンダーと同じ。並びは `WEEKDAYS` のまま)
 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const JST = 9 * 60 * MINUTE;

/** 0:00 からの分を `19:00` に */
export function clockOf(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** `19:00` を 0:00 からの分に。読めなければ null (`<input type="time">` は空か `HH:MM`) */
export function minutesOf(text: string): number | null {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** 時間帯が効いているか。片方だけ・同じ値は無いものとして扱う */
export function hasTime(
  slot: Pick<Slot, "time_from" | "time_to">,
): slot is { time_from: number; time_to: number } {
  return (
    slot.time_from !== null &&
    slot.time_to !== null &&
    slot.time_from !== slot.time_to
  );
}

/** 時刻の日本時間での分 (0:00 から) と曜日 */
export function jstOf(at: number): { minutes: number; weekday: number } {
  const local = at + JST;
  const day = Math.floor(local / DAY);
  return {
    minutes: Math.floor((local - day * DAY) / MINUTE),
    // 1970-01-01 は木曜
    weekday: (((day + 4) % 7) + 7) % 7,
  };
}

/** 分が時間帯の内か。`from > to` は日をまたぐ */
export function inTime(from: number, to: number, minutes: number): boolean {
  return from < to
    ? from <= minutes && minutes < to
    : minutes >= from || minutes < to;
}

/** 曜日を短く。続く3日以上は「月〜金」にまとめる (月曜から数える) */
function weekdaysText(weekdays: number[]): string {
  const days = WEEK_ORDER.filter((day) => weekdays.includes(day));
  const runs: number[][] = [];
  for (const day of days) {
    const last = runs.at(-1);
    const prev = last?.at(-1);
    if (
      last !== undefined &&
      prev !== undefined &&
      WEEK_ORDER.indexOf(day) === WEEK_ORDER.indexOf(prev) + 1
    )
      last.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) =>
      run.length >= 3
        ? `${WEEKDAYS[run[0]!]}〜${WEEKDAYS[run.at(-1)!]}`
        : run.map((day) => WEEKDAYS[day]).join("・"),
    )
    .join("・");
}

/**
 * 時間帯と曜日の要約 (「金 19:00〜20:00」「月〜金」「23:00〜02:00」)。指定が無ければ null
 * (書く欄は「いつでも」と出し、ルールの一覧は書かない)
 */
export function slotSummary(slot: Slot): string | null {
  const parts: string[] = [];
  if (
    slot.weekdays !== null &&
    slot.weekdays.length > 0 &&
    slot.weekdays.length < 7
  )
    parts.push(weekdaysText(slot.weekdays));
  if (hasTime(slot))
    parts.push(`${clockOf(slot.time_from)}〜${clockOf(slot.time_to)}`);
  return parts.length === 0 ? null : parts.join(" ");
}
