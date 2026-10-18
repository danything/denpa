/**
 * ホームの**1本の時間軸**。予約と録画を1つの一覧に並べる。**画面に触らない所だけ**を置く (単体テストで見る)。
 *
 * 上から順に:
 *
 * - **これからの予約** — 遠い先が上、「いま」に近いほど下 (いちばん早い予約が「いま」のすぐ上)
 * - **「いま」の線** と、その下に録画中の行
 * - **録れたもの** (録画と録り逃し) — 新しい順。「いま」に近いほど上
 *
 * どちらの側も「いま」に近いものが線の近くに来るので、開いて線を映せば、次に録るものと
 * 最後に録れたものが同じ画面に入る。
 *
 * **まとめて表示** (`#lib/grouping.ts`) は両側に効く。同じ番組でも、予約は線の上、録画は線の下と
 * **側ごとに別の見出し**を立てる。1つにまとめると、見出しの位置が時間の並びから外れる
 * (線の上にあるのに中身は過去の回) うえ、開いたときに線をまたいで中身が並ぶため。
 * 見出しの位置は**その側でいちばん線に近い回**で決める (予約は次の回、録画は最新の回)
 */

import { type Groupable, type GroupEntry, groupBySeries, groupLines, type SeriesGroup } from './grouping';

/** 時間軸のどこに置くか */
export type Zone = 'future' | 'now' | 'past';

/** 時間軸に並べる行。予約・録画・録り逃しを、この形式にして渡す */
export interface TimelineItem extends Groupable {
    zone: Zone;
}

/**
 * 行の性質。絞り込みの判定と件数に使う。**決めるのは画面** (観られるか・失敗かは画面の関数が知っている)
 */
export interface Traits {
    /** 観終えていない録画 (未視聴の点か、続きのバーが出ているもの) */
    unfinished: boolean;
    /** 失敗したもの (録画の失敗・エンコードの失敗・録り逃し) */
    failed: boolean;
}

/** 絞り込み。ボタンの並びもこの順 */
export const FILTERS = [
    { id: 'all', label: 'すべて' },
    { id: 'reservations', label: '予約' },
    { id: 'recording', label: '録画中' },
    { id: 'unfinished', label: '未視聴' },
    { id: 'failed', label: '失敗' },
] as const;

export type Filter = (typeof FILTERS)[number]['id'];

/** その絞り込みに入るか */
export function passes(filter: Filter, item: TimelineItem, traits: Traits): boolean {
    switch (filter) {
        case 'all':
            return true;
        case 'reservations':
            return item.zone === 'future';
        case 'recording':
            return item.zone === 'now';
        case 'unfinished':
            return item.zone === 'past' && traits.unfinished;
        case 'failed':
            return item.zone === 'past' && traits.failed;
    }
}

/** 絞り込みごとの件数 (ボタンに添える数) */
export function countFilters<T extends TimelineItem>(
    items: T[],
    traitsOf: (item: T) => Traits,
): Record<Filter, number> {
    const counts: Record<Filter, number> = {
        all: 0,
        reservations: 0,
        recording: 0,
        unfinished: 0,
        failed: 0,
    };
    for (const item of items) {
        const traits = traitsOf(item);
        for (const { id } of FILTERS) if (passes(id, item, traits)) counts[id] += 1;
    }
    return counts;
}

/** 側ごとに分けて並べたもの */
export interface Sections<T extends TimelineItem> {
    /** これからの予約。遠い先が先頭 (描く順) */
    future: T[];
    /** 録画中。始まった順 */
    now: T[];
    /** 録れたもの。新しい順 */
    past: T[];
}

/**
 * 側ごとに分けて、描く順に並べる。渡す順は問わない。同じ時刻どうしは渡した順を保つ (並べ替えは安定)
 */
export function sections<T extends TimelineItem>(items: T[]): Sections<T> {
    const future = items.filter((item) => item.zone === 'future').sort((a, b) => b.at - a.at);
    const now = items.filter((item) => item.zone === 'now').sort((a, b) => a.at - b.at);
    const past = items.filter((item) => item.zone === 'past').sort((a, b) => b.at - a.at);
    return { future, now, past };
}

/** 画面に描く1行 */
export type TimelineLine<T extends TimelineItem> =
    /** 日付の見出し。`at` はその日の 0 時 */
    | { kind: 'day'; key: string; zone: 'future' | 'past'; at: number }
    /** まとめて表示のときの側の見出し (「予約」「録画」) */
    | { kind: 'side'; key: string; zone: 'future' | 'past' }
    /** 「いま」の線 */
    | { kind: 'now'; key: 'now' }
    /** 番組の見出し (まとめて表示) */
    | { kind: 'head'; key: string; zone: 'future' | 'past'; group: SeriesGroup<T>; open: boolean }
    | { kind: 'row'; key: string; item: T; nested: boolean };

/** その時刻の日の 0 時 (端末の時刻帯) */
export function dayStart(at: number): number {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/**
 * 日付の呼び名。今日・明日・昨日だけ言葉にし、ほかは null (画面が日付を書く)。
 * 日の差は 0 時どうしで数える (夏時間の無い時刻帯でも、時刻の差で割ると端で外れる)
 */
export function dayName(at: number, now: number): '今日' | '明日' | '昨日' | null {
    const a = new Date(dayStart(at));
    const b = new Date(dayStart(now));
    const diff = Math.round(
        (Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) -
            Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) /
            86_400_000,
    );
    if (diff === 0) return '今日';
    if (diff === 1) return '明日';
    if (diff === -1) return '昨日';
    return null;
}

/** 日付の見出しを挟んで並べる */
function byDay<T extends TimelineItem>(items: T[], zone: 'future' | 'past'): TimelineLine<T>[] {
    const lines: TimelineLine<T>[] = [];
    let last: number | null = null;
    for (const item of items) {
        const day = dayStart(item.at);
        if (day !== last) {
            lines.push({ kind: 'day', key: `day-${zone}-${day}`, zone, at: day });
            last = day;
        }
        lines.push({ kind: 'row', key: item.key, item, nested: false });
    }
    return lines;
}

/** 番組ごとに並べる。見出しの鍵に側を付ける (同じ番組が両側に立つため) */
function bySeries<T extends TimelineItem>(
    items: T[],
    zone: 'future' | 'past',
    isOpen: (zone: 'future' | 'past', group: string) => boolean,
): TimelineLine<T>[] {
    if (items.length === 0) return [];
    const entries: GroupEntry<T>[] = groupBySeries(items, zone === 'future' ? 'earliest' : 'latest').map(
        (entry) =>
            entry.kind === 'group'
                ? { kind: 'group', group: { ...entry.group, key: `${zone}-${entry.group.key}` } }
                : entry,
    );
    const lines: TimelineLine<T>[] = [{ kind: 'side', key: `side-${zone}`, zone }];
    for (const line of groupLines(entries, (group) => isOpen(zone, group))) {
        lines.push(line.kind === 'head' ? { ...line, zone } : line);
    }
    return lines;
}

/** 時間軸の描き方 */
export interface LineOptions {
    /** まとめて表示 */
    grouped: boolean;
    /** その側のその番組を開いているか (まとめて表示のとき) */
    isOpen: (zone: 'future' | 'past', group: string) => boolean;
}

/**
 * 描く行に開く。上の側 (予約)、「いま」の線と録画中、下の側 (録れたもの) を1本にする。
 * 返すのは2つに分けたもの — 下の側だけ少しずつ描くため (`Paged`)。
 * 上の側は全部描く (上へ足すと、位置合わせの無いブラウザでは読んでいる所が跳ねる)
 */
export function timelineLines<T extends TimelineItem>(
    parts: Sections<T>,
    options: LineOptions,
): { above: TimelineLine<T>[]; below: TimelineLine<T>[] } {
    const side = (items: T[], zone: 'future' | 'past') =>
        options.grouped ? bySeries(items, zone, options.isOpen) : byDay(items, zone);
    const above: TimelineLine<T>[] = [...side(parts.future, 'future'), { kind: 'now', key: 'now' }];
    for (const item of parts.now) above.push({ kind: 'row', key: item.key, item, nested: false });
    return { above, below: side(parts.past, 'past') };
}

/**
 * 開いたときに映す録画。**観終えていない録画のうち、いちばん古いもの** — 溜まったぶんを古い順に
 * 片付けられるように。無ければ null (「いま」の線を映す)
 */
export function catchUp<T extends TimelineItem>(past: T[], unfinished: (item: T) => boolean): T | null {
    let oldest: T | null = null;
    for (const item of past) {
        if (item.zone === 'past' && unfinished(item) && (oldest === null || item.at < oldest.at))
            oldest = item;
    }
    return oldest;
}

/**
 * その行を映すには、描く行の何番目まで要るか。閉じた番組の中にあれば、その見出し。
 * 見つからなければ -1
 */
export function lineIndex<T extends TimelineItem>(lines: TimelineLine<T>[], key: string): number {
    return lines.findIndex(
        (line) =>
            (line.kind === 'row' && line.key === key) ||
            (line.kind === 'head' && !line.open && line.group.items.some((item) => item.key === key)),
    );
}
