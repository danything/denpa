/**
 * ホームの**1本の時間軸**。予約と録画を1つの一覧に並べる。**画面に触らない所だけ**を置く (単体テストで見る)。
 *
 * **下へ行くほど時間が進む** (番組表と同じ向き)。上から順に:
 *
 * - **録れたもの** (録画と録り逃し) — 古い順
 * - **録画中の行** — 始まった順。いちばん新しく始まったものが「いま」の線のすぐ上
 * - **「いま」の線**
 * - **これからの予約** — 近い順。いちばん早い予約が線のすぐ下、遠い先がいちばん下
 *
 * つまり**始まった時刻の順**で、いまより前に始まったものは録画中も含めて全部線の上に来る。
 * 録画中の行はあと何分かを自分で出し (`TimelineRow`)、線は次の録画までを出す (`nowStatus`)。
 *
 * 日付の見出しはその日の頭に立ち、見出しの下も時刻の早い順。**見出しは1日に1つ** — 今日の録画、
 * 録画中と「いま」の線、今日の予約を、1つの「今日」の下に並べる。今日の録画が無ければ見出しは
 * 録画中の行の上 (録画中も無ければ線のすぐ上) に立つ。画面は見出しごとに包み (`blocks`)、
 * 見出しは包みの中で貼り付くので、今日を読む間は線をまたいでも「今日」が頭に残る。
 * どちらの側も「いま」に近いものが線の近くに来るので、開いて線を映せば、最後に録れたものと次に録るものが
 * 同じ画面に入る。
 *
 * どの日を今日とするかは描いた時刻 (`LineOptions.now`) で決める。「いま」の時刻や「今日」「昨日」の呼び名と
 * 同じ物差しなので、開いたまま 0 時を越えても食い違わない。読み直すと、前の日の行は「昨日」の下に移る。
 *
 * **まとめて表示** (`#lib/grouping.ts`) は両側に効く。同じ番組でも、録画は線の上、予約は線の下と
 * **側ごとに別の見出し**を立てる。1つにまとめると、見出しの位置が時間の並びから外れる
 * (線の下にあるのに中身は過去の回) うえ、開いたときに線をまたいで中身が並ぶため。
 * 見出しの位置は**その側でいちばん線に近い回**で決める (予約は次の回、録画は最新の回)。
 * 番組の見出しには日付が無いので、側の見出し (「録画」「これからの予約」) を貼り付けて、
 * 線から離れても、いまどちらの側を読んでいるかを見せる。
 * 録画中の行は「録画」の側の末尾 (線のすぐ上) に、番組でまとめずにそのまま並べる —
 * 閉じた番組の中に入ると、いま録っていることが見えなくなるため
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
    /** 失敗した録画 (録画の失敗・エンコードの失敗) */
    failed: boolean;
    /** 録り逃し (始まらないまま放送が終わった予約) */
    missed?: boolean;
    /** チューナーが足りずに録れない予約 (競合) */
    conflict?: boolean;
    /** 局ロゴで CM を判定できなかった録画 (無音だけで判定) */
    cmlogo?: boolean;
}

/** 絞り込み。サイドバーの並び・狭い画面のチップの並びもこの順 */
export const FILTERS = [
    { id: 'all', label: 'すべて' },
    { id: 'reservations', label: '予約' },
    { id: 'recording', label: '録画中' },
    { id: 'unfinished', label: '未視聴' },
] as const;

/**
 * **見てほしいこと** (手を止めてほしいもの)。絞り込みと同じ仕組みで、件数があるときだけ出す
 * (広い画面はサイドバーの絞り込みの続き、狭い画面は絞り込みのチップの後ろ。どちらも注意の色)
 */
export const ATTENTION_FILTERS = [
    { id: 'conflict', label: '競合' },
    { id: 'failed', label: '失敗' },
    { id: 'missed', label: '録り逃し' },
    { id: 'cmlogo', label: 'CMの判定' },
] as const;

export type Filter = (typeof FILTERS)[number]['id'] | (typeof ATTENTION_FILTERS)[number]['id'];

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
        case 'missed':
            return item.zone === 'past' && traits.missed === true;
        case 'conflict':
            return item.zone === 'future' && traits.conflict === true;
        case 'cmlogo':
            return item.zone === 'past' && traits.cmlogo === true;
    }
}

/** 絞り込みごとの件数 (並びとチップに添える数) */
export function countFilters<T extends TimelineItem>(
    items: T[],
    traitsOf: (item: T) => Traits,
): Record<Filter, number> {
    const ids = [...FILTERS, ...ATTENTION_FILTERS].map((filter) => filter.id);
    const counts = Object.fromEntries(ids.map((id) => [id, 0])) as Record<Filter, number>;
    for (const item of items) {
        const traits = traitsOf(item);
        for (const id of ids) if (passes(id, item, traits)) counts[id] += 1;
    }
    return counts;
}

/** 側ごとに分けて並べたもの */
export interface Sections<T extends TimelineItem> {
    /** 録れたもの。古い順 (描く順) */
    past: T[];
    /** 録画中。始まった順 (線のすぐ上) */
    now: T[];
    /** これからの予約。近い順 */
    future: T[];
}

/**
 * 側ごとに分けて、描く順 (どの側も時刻の早い順) に並べる。渡す順は問わない。
 * 同じ時刻どうしは渡した順を保つ (並べ替えは安定)
 */
export function sections<T extends TimelineItem>(items: T[]): Sections<T> {
    const byTime = (zone: Zone) => items.filter((item) => item.zone === zone).sort((a, b) => a.at - b.at);
    return { past: byTime('past'), now: byTime('now'), future: byTime('future') };
}

/** 画面に描く1行 */
export type TimelineLine<T extends TimelineItem> =
    /** 日付の見出し。`at` はその日の 0 時。1日に1つ (今日は線をまたいで1つ) */
    | { kind: 'day'; key: string; at: number }
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

/**
 * 日付の見出しを挟んで並べる。見出しの鍵は `day-<その日の 0 時>` で、1日に1つ。
 *
 * - 予約の側には今日の見出しを立てない (今日の見出しは線の上に立つ)。放送が始まったのに録画に入っていない
 *   予約 (日付が今日より前) も今日に入れる — 線の下に前の日の見出しが立たないように
 * - 録れたものの日付が今日より先 (時計のずれ) なら、その日の見出しは側を付けた鍵にする。予約の側の
 *   同じ日の見出しと鍵が重ならないように (線の上と下に1つずつ立つ)
 */
function byDay<T extends TimelineItem>(
    items: T[],
    zone: 'future' | 'past',
    today: number,
): TimelineLine<T>[] {
    const lines: TimelineLine<T>[] = [];
    let last: number | null = zone === 'future' ? today : null;
    for (const item of items) {
        const day = zone === 'future' ? Math.max(dayStart(item.at), today) : dayStart(item.at);
        if (day !== last) {
            const key = zone === 'past' && day > today ? `day-past-${day}` : `day-${day}`;
            lines.push({ kind: 'day', key, at: day });
            last = day;
        }
        lines.push({ kind: 'row', key: item.key, item, nested: false });
    }
    return lines;
}

/**
 * 番組ごとに並べる。見出しの鍵に側を付ける (同じ番組が両側に立つため)。
 * `groupBySeries` は遅い順に返すので、逆にして早い順にする
 */
function bySeries<T extends TimelineItem>(
    items: T[],
    zone: 'future' | 'past',
    isOpen: (zone: 'future' | 'past', group: string) => boolean,
): TimelineLine<T>[] {
    if (items.length === 0) return [];
    const entries: GroupEntry<T>[] = groupBySeries(items, zone === 'future' ? 'earliest' : 'latest')
        .reverse()
        .map((entry) =>
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
    /** 描いた時刻。どの日を今日とするか (今日の見出しを線の上に立てる) */
    now: number;
    /** まとめて表示 */
    grouped: boolean;
    /** その側のその番組を開いているか (まとめて表示のとき) */
    isOpen: (zone: 'future' | 'past', group: string) => boolean;
}

/**
 * 描く行に開く。上の側 (録れたもの)、録画中と「いま」の線、下の側 (予約) の3つに分けて返す —
 * 上の側だけ、線の側から古いほうへ少しずつ描くため (`pageStart`)。録画中と予約は全部描く。
 * `now` は録画中の行 (始まった順) のあとに線を置く。
 *
 * 日ごとのとき、今日の見出しは1つだけ。今日の録画があればその頭 (`past` の中)、無ければ `now` の頭
 * (録画中の行の上)。前の日から続けて録っている行も、いま録っているので今日の見出しの下に置く。
 * 予約の側には今日の見出しを立てない (今日の予約は線の下にそのまま続く)。
 *
 * まとめて表示のとき、録画中の行は「録画」の側の末尾。録れたものが無ければ `now` の頭に「録画」の見出しを立てる
 */
export function timelineLines<T extends TimelineItem>(
    parts: Sections<T>,
    options: LineOptions,
): { past: TimelineLine<T>[]; now: TimelineLine<T>[]; future: TimelineLine<T>[] } {
    const now: TimelineLine<T>[] = [
        ...parts.now.map((item) => ({ kind: 'row' as const, key: item.key, item, nested: false })),
        { kind: 'now', key: 'now' },
    ];
    if (options.grouped) {
        const past = bySeries(parts.past, 'past', options.isOpen);
        if (past.length === 0 && parts.now.length > 0)
            now.unshift({ kind: 'side', key: 'side-past', zone: 'past' });
        return { past, now, future: bySeries(parts.future, 'future', options.isOpen) };
    }
    const today = dayStart(options.now);
    const past = byDay(parts.past, 'past', today);
    const heads = past.filter((line) => line.kind === 'day');
    if (heads.at(-1)?.key !== `day-${today}`) {
        // 今日の録画のあとに日付が先の録れたもの (時計のずれ) が挟まったときだけ、線の上にもう1つ立てる
        const again = heads.some((line) => line.key === `day-${today}`);
        now.unshift({ kind: 'day', key: again ? `day-now-${today}` : `day-${today}`, at: today });
    }
    return { past, now, future: byDay(parts.future, 'future', today) };
}

/** 画面で1つに包む行 (見出しは包みの中だけで貼り付く) */
export interface TimelineBlock<T extends TimelineItem> {
    key: string;
    lines: TimelineLine<T>[];
}

/**
 * 描く行 (上の側・録画中と線・下の側をつないだもの) を、見出しごとの包みに分ける。日付と側の見出しで包みを替える。
 * 日ごとのときは、今日の包みが線と今日の予約まで抱える (今日の見出しが線をまたいで貼り付く)。
 * まとめて表示のときは「録画」の包みを線の手前で閉じ (録画中の行は「録画」の包みに入る)、線は見出しの無い包みにする
 * (線より下で「録画」が頭に残らないように)
 */
export function blocks<T extends TimelineItem>(lines: TimelineLine<T>[]): TimelineBlock<T>[] {
    const out: TimelineBlock<T>[] = [];
    let head: TimelineLine<T>['kind'] | null = null;
    for (const line of lines) {
        const opens =
            line.kind === 'day' ||
            line.kind === 'side' ||
            (line.kind === 'now' && head !== 'day') ||
            out.length === 0;
        if (opens) {
            out.push({
                key: line.kind === 'row' || line.kind === 'head' ? `block-${line.key}` : line.key,
                lines: [],
            });
            head = line.kind;
        }
        out.at(-1)?.lines.push(line);
    }
    return out;
}

/**
 * 録れたものを末尾 (線の側) から `count` 行だけ描くとき、何行目から描くか。
 * 頭が日付の見出しの途中 (見出しより下の行) や開いた番組の中に落ちたら、その見出しまで戻す —
 * 頭の行が見出し無しで描かれないように
 */
export function pageStart<T extends TimelineItem>(lines: TimelineLine<T>[], count: number): number {
    const grouped = lines[0]?.kind === 'side';
    let at = Math.max(0, lines.length - count);
    while (at > 0) {
        const line = lines[at]!;
        if (line.kind !== 'row' || (grouped && !line.nested)) break;
        at -= 1;
    }
    // 残りが側の見出し (「録画」) だけなら、それも描く
    return at === 1 && grouped ? 0 : at;
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

/**
 * **終わった予約と、それで録れた録画を 1 本にまとめる** (「完了した予約も表示」のとき)。録画が見つかる予約 (録画の `reservation_id` が予約を指すか、
 * 予約を持たない録画と番組が同じ) は行を出さず、録画の行が代わりに立つ。
 *
 * 録画の行に足りないものは予約から持ってくる。いまは番組名だけ — 録った後に番組表の名前が縮んだ録画
 * (副題「#3「…」」が落ちたもの) は、予約の長いほうの名前を使う (`names`。片方がもう片方を含むときだけ)。
 * 録画の見つからない予約 (取消・始まる前の失敗など) はそのまま残す。一覧に録画が無くても、録画の行が
 * あった予約 (`recorded`。消した録画・300 件の外) は出さない。件数も 1 本として数える
 */
export function mergeRecorded<
    R extends {
        id: number;
        program_id: number | null;
        end_at: number;
        state: string;
        name: string;
        recorded?: boolean;
    },
    C extends { id: number; reservation_id: number | null; program_id: number | null; name: string },
>(reservations: R[], recordings: C[], now: number): { reservations: R[]; names: Map<number, string> } {
    const byReservation = new Map<number, C>();
    const byProgram = new Map<number, C>();
    for (const rec of recordings) {
        if (rec.reservation_id !== null) byReservation.set(rec.reservation_id, rec);
        else if (rec.program_id !== null) byProgram.set(rec.program_id, rec);
    }
    const names = new Map<number, string>();
    const kept = reservations.filter((res) => {
        // まだ終わっていない予約 (これから・録画中) はそのまま
        if (res.end_at > now || res.state === 'recording') return true;
        const rec =
            byReservation.get(res.id) ??
            (res.program_id === null ? undefined : byProgram.get(res.program_id));
        // 録画が一覧に無くても (消した・300 件の外)、録画の行がある予約は出さない。消した録画の予約が化けて戻らないように
        if (rec === undefined) return res.recorded !== true;
        if (res.name !== rec.name && res.name.includes(rec.name)) names.set(rec.id, res.name);
        return false;
    });
    return { reservations: kept, names };
}
