/**
 * **季節の演出** (年越しと正月。docs/design.md「季節の演出」・docs/screens.md「季節の演出」) の決め方。画面に触らない所で、単体テストで見る。
 *
 * - 日付は日本時間で決める (端末の時計ではなくサーバの時計。`season.svelte.ts` がずれを持つ)
 * - 年越しのカウントダウンは、映している場面の放送の時刻で数える (ライブは放送からの遅れを引き、録画と追っかけは再生位置の放送の時刻)
 * - 紙吹雪は、年越しの前後で実況の勢いが跳ねたら 1 回だけ。実況を開いていなければ 0:00 に 1 回だけ
 */

const HOUR = 3_600_000;
/** 日本時間は UTC+9 で、夏時間は無い */
const JST = 9 * HOUR;

/** カウントダウンを始める秒 (23:59:50 から 10・9・8…) */
export const COUNT_FROM = 10;
/** 0:00 に「あけましておめでとうございます」を出しておく長さ */
export const GREET_FOR = 3_000;
/** 紙吹雪を出しておく長さ。落ちきるまで (`NewYear.svelte` の動きの長さより少し長く) */
export const CONFETTI_FOR = 3_500;

/** 勢いの比べる元を測る間 (年越しの何 ms 前から何 ms 前まで) */
const BASE_FROM = 90_000;
const BASE_TO = 20_000;
/** 跳ねたかを見る間 (年越しの前後) */
const SPIKE_FROM = 20_000;
const SPIKE_TO = 90_000;
/** 跳ねたとみなす勢いの下限 (1 分あたりのコメント数)。少ない局の揺れで降らせない */
export const SPIKE_MIN = 20;
/** 跳ねたとみなす倍率 (前の勢いの何倍か) */
export const SPIKE_RATIO = 2;

/** 日本時間の年・月・日 */
export function jstDate(ms: number): {
  year: number;
  month: number;
  day: number;
} {
  const d = new Date(ms + JST);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** `year` 年 1 月 1 日 0:00 (日本時間) の unix ms */
export function newYearOf(year: number): number {
  return Date.UTC(year, 0, 1) - JST;
}

/** `ms` に近いほうの年越し (その年か次の年の 1 月 1 日 0:00) */
export function nearestNewYear(ms: number): number {
  const { year } = jstDate(ms);
  const start = newYearOf(year);
  const next = newYearOf(year + 1);
  return ms - start < next - ms ? start : next;
}

export type Countdown = { kind: "count"; n: number } | { kind: "greet" } | null;

/**
 * 放送の時刻 `ms` に出すもの。23:59:50 から 0:00 の手前までは残りの秒 (10〜1)、
 * 0:00 から `GREET_FOR` の間は「あけましておめでとうございます」、ほかは何も出さない
 */
export function countdown(ms: number): Countdown {
  const left = nearestNewYear(ms) - ms;
  if (left > 0 && left <= COUNT_FROM * 1000)
    return { kind: "count", n: Math.ceil(left / 1000) };
  if (left <= 0 && -left < GREET_FOR) return { kind: "greet" };
  return null;
}

/** ヘッダーのロゴに正月の飾りを付けるか (1 月 1〜3 日) */
export function decorated(ms: number): boolean {
  const { month, day } = jstDate(ms);
  return month === 1 && day <= 3;
}

/**
 * 「denpa の 1 年」の通知を出す年。1 月 1〜7 日で、その年にまだ出していなければその年、ほかは null。
 * `greeted` は世帯で最後に出した年 (`server/season.ts`)
 */
export function greetingYear(
  ms: number,
  greeted: number | null,
): number | null {
  const { year, month, day } = jstDate(ms);
  return month === 1 && day <= 7 && greeted !== year ? year : null;
}

/** 勢いが跳ねたか。前の勢い `before` から `SPIKE_RATIO` 倍になり、`SPIKE_MIN` 以上あれば跳ねた */
export function spiked(before: number, now: number): boolean {
  return now >= SPIKE_MIN && now >= before * SPIKE_RATIO;
}

/**
 * **紙吹雪を降らせる時を決める。** 映している場面の放送の時刻と、そのときの勢い (実況を開いていなければ null) を
 * 何度も渡し、降らせる時だけ true を返す。降らせるのは年越しごとに 1 回だけ
 *
 * - 勢いがあるとき: 年越しの 90〜20 秒前の勢いのいちばん大きいものを元にし、20 秒前から 90 秒後までに `spiked` になったら
 * - 勢いが無いとき: 0:00 から `GREET_FOR` の間に来たら
 */
export class ConfettiTrigger {
  /** 降らせた年越し */
  private done: number | null = null;
  /** 元にする勢い (年越しごと) */
  private base = 0;
  private baseOf: number | null = null;

  feed(ms: number, force: number | null): boolean {
    const edge = nearestNewYear(ms);
    if (this.done === edge) return false;
    const from = ms - edge;
    if (force === null) {
      if (from >= 0 && from < GREET_FOR) {
        this.done = edge;
        return true;
      }
      return false;
    }
    if (this.baseOf !== edge) {
      this.baseOf = edge;
      this.base = 0;
    }
    if (from >= -BASE_FROM && from < -BASE_TO) {
      this.base = Math.max(this.base, force);
      return false;
    }
    if (from >= -SPIKE_FROM && from < SPIKE_TO && spiked(this.base, force)) {
      this.done = edge;
      return true;
    }
    return false;
  }
}

/** 年越しの近く (カウントダウンと紙吹雪を見る間) か。近い間だけ細かく見る */
export function nearNewYear(ms: number): boolean {
  const from = ms - nearestNewYear(ms);
  return from >= -BASE_FROM - 5_000 && from < SPIKE_TO;
}

/** 「denpa の 1 年」の数 (`POST /api/season/greeting` の返事。`server/season.ts` の `yearSummary`) */
export interface YearSummary {
  /** 数えた年 (去年) */
  year: number;
  /** 録画した本数 (失敗したものは入れない。あとで消したものは入れる) */
  recorded: number;
  /** 録画した長さの合計 (ms) */
  recordedMs: number;
  /** いちばん録った局。録画が無ければ null */
  topRecorded: string | null;
  /** 観終えた録画の本数 */
  watched: number;
  /** 観終えた録画がいちばん多い局。無ければ null */
  topWatched: string | null;
}

/** 長さを「300 時間」「45 分」に。1 時間に満たなければ分 */
export function spanWords(ms: number): string {
  const hours = Math.floor(ms / HOUR);
  if (hours >= 1) return `${hours.toLocaleString("ja-JP")} 時間`;
  return `${Math.max(1, Math.round(ms / 60_000))} 分`;
}

/** 通知の 1 行目 */
export const GREETING =
  "あけましておめでとうございます。今年もよろしくお願いします";

/**
 * 「denpa の 1 年」の通知の文。1 行目はあいさつ、続けて去年の数。**0 のもの・無いものは書かない**
 */
export function greetingText(summary: YearSummary | null): string {
  const lines = [GREETING];
  if (summary === null) return lines.join("\n");
  if (summary.recorded > 0) {
    const span =
      summary.recordedMs > 0 ? `・${spanWords(summary.recordedMs)}` : "";
    lines.push(
      `${summary.year} 年は ${summary.recorded.toLocaleString("ja-JP")} 本${span}を録画しました`,
    );
  }
  if (summary.topRecorded !== null)
    lines.push(`いちばん録った局: ${summary.topRecorded}`);
  if (summary.watched > 0)
    lines.push(`観終えた録画: ${summary.watched.toLocaleString("ja-JP")} 本`);
  if (summary.topWatched !== null)
    lines.push(`いちばん観た局: ${summary.topWatched}`);
  return lines.join("\n");
}
