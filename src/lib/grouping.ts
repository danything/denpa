/**
 * ホームの「まとめて表示」(issue #480)。**画面に触らない所だけ**を置く (単体テストで見る)。
 * 時間軸の両側 (予約と録れたもの) に効かせるのは `#lib/timeline.ts`。
 *
 * まとめる単位は**番組 (シリーズ)**。鍵はサーバが付ける (`+page.server.ts` の
 * `seriesGroup`) — エンコードしたものを置くシリーズのフォルダと同じ名前なので、
 * ディスクで1つのフォルダに並ぶものが一覧でも1つにまとまる。
 *
 * 並びは2段:
 *
 * - **番組どうしは時刻の遅い順** (ホームの時間軸は逆にして、早い順に並べる)。番組の位置は `anchor` の回で決める
 * - **番組の中は放送順** (第1話が上)。開いた番組を上から読めば話が進む
 *
 * **1本しか無い番組はまとめない。** 見出しを押してやっと1行出るのでは手間が増える
 * だけなので、ふつうの行としてその日付の位置に混ぜる。
 */

/** まとめられる行。予約・録画・録り逃しの行を、この形式にして渡す */
export interface Groupable {
    /** 行の鍵 (`res-5` / `rec-12` / `missed-3`) */
    key: string;
    /** 放送の開始時刻。並びはこれで決める */
    at: number;
    /** まとめる鍵 (シリーズのフォルダ名) */
    group: string;
    /** 見出しに出す番組名 */
    groupName: string;
}

/** 2本以上ある番組 */
export interface SeriesGroup<T extends Groupable> {
    /** 見出しの鍵。行の鍵 (`rec-` / `missed-`) と混ざらないよう接頭辞を付ける */
    key: string;
    /** まとめる鍵そのもの。開いているかどうかはこれで覚える */
    group: string;
    name: string;
    /** 放送順 (古い回が先) */
    items: T[];
    /** いちばん新しい回 */
    newest: T;
}

export type GroupEntry<T extends Groupable> =
    | { kind: 'single'; item: T }
    | { kind: 'group'; group: SeriesGroup<T> };

/** 画面に描く1行。見出しか、行そのもの (`nested` は番組の中の行) */
export type GroupLine<T extends Groupable> =
    | { kind: 'head'; key: string; group: SeriesGroup<T>; open: boolean }
    | { kind: 'row'; key: string; item: T; nested: boolean };

/**
 * 番組ごとにまとめて並べる。渡す順は問わない。
 * 同じ時刻どうしは渡した順を保つ (並べ替えは安定)
 *
 * @param anchor 番組の位置をどの回で決めるか。`latest` はいちばん新しい回 (録画の一覧)、
 *     `earliest` はいちばん早い回 (これからの予約。次に録る回の位置に置く)。どちらも並びは時刻の遅い順
 */
export function groupBySeries<T extends Groupable>(
    items: T[],
    anchor: 'latest' | 'earliest' = 'latest',
): GroupEntry<T>[] {
    const buckets = new Map<string, T[]>();
    for (const item of items) {
        const bucket = buckets.get(item.group);
        if (bucket === undefined) buckets.set(item.group, [item]);
        else bucket.push(item);
    }

    const entries: { at: number; entry: GroupEntry<T> }[] = [];
    for (const [group, bucket] of buckets) {
        const ordered = [...bucket].sort((a, b) => a.at - b.at);
        const newest = ordered[ordered.length - 1]!;
        if (ordered.length === 1) {
            entries.push({ at: newest.at, entry: { kind: 'single', item: newest } });
            continue;
        }
        entries.push({
            at: anchor === 'latest' ? newest.at : ordered[0]!.at,
            entry: {
                kind: 'group',
                group: { key: `group-${group}`, group, name: newest.groupName, items: ordered, newest },
            },
        });
    }
    return entries.sort((a, b) => b.at - a.at).map(({ entry }) => entry);
}

/**
 * 描く行に開く。閉じている番組は見出しだけ、開いている番組は見出しの下に中身を続ける
 *
 * @param isOpen その番組 (まとめる鍵) を開いているか
 */
export function groupLines<T extends Groupable>(
    entries: GroupEntry<T>[],
    isOpen: (group: string) => boolean,
): GroupLine<T>[] {
    const lines: GroupLine<T>[] = [];
    for (const entry of entries) {
        if (entry.kind === 'single') {
            lines.push({ kind: 'row', key: entry.item.key, item: entry.item, nested: false });
            continue;
        }
        const open = isOpen(entry.group.group);
        lines.push({ kind: 'head', key: entry.group.key, group: entry.group, open });
        if (!open) continue;
        for (const item of entry.group.items) lines.push({ kind: 'row', key: item.key, item, nested: true });
    }
    return lines;
}

/**
 * 端末ごとに覚える cookie。**読むのはサーバ** (`+page.server.ts`) — 描く前に
 * どちらの表示か分かっていれば、覚えを読むまで枠を隠さずに済む
 */
export const GROUPED_COOKIE = 'denpa_recordings_grouped';

/** 覚えていた値。**既定はまとめない** (今までどおりの一覧) */
export function storedGrouped(saved: string | undefined): boolean {
    return saved === '1';
}
