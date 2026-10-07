/**
 * **同じ回は1度だけ録る** (ルールの「同じ回は最初の放送だけ録る」)。
 *
 * `[新]` のようなゆるい条件で拾うと、同じ回が局を替えて何度も流れる
 * (MX → BS11 → 地方局、地上波と BS の同時放送)。全部録ってもディスクが
 * 埋まるだけなので、**いちばん早い放送だけ**を予約する。
 *
 * 判定は画面に触らない純粋な計算にしてある (単体テストで固定する)。
 * DB を読むのは呼ぶ側 (`rules.applyRules` とルール画面の下見)。
 */
import { displayTitle, parseTitle, sanitizeFileName, toHalfWidth } from './title';

/** 比べる前に揃える。空白の有無・大文字小文字は局によって揺れる */
function squash(text: string): string {
    return toHalfWidth(text).replace(/\s+/g, '').toLowerCase();
}

/**
 * **その回の名札。** 同じ名札なら同じ回。
 *
 * - シリーズは焼いたものを置くフォルダと同じ決め方 (`library.seriesFolder`)。
 *   録画一覧の「まとめて表示」とも同じ単位になる
 * - 回は**話数と副題の両方**で見分ける。片方だけで当てると、`第2期 #1` が
 *   「第2話」に読める (`parseTitle` の癖) ので、2期の全話が1つの回に潰れる。
 *   局によって副題を出したり出さなかったりすると同じ回でも別の名札になるが、
 *   そのときは2本録れるだけ (録り逃すより安い)
 * - **話数も副題も無ければ null**。その番組は「回」が分からないので、
 *   時刻をまたいでは束ねない (毎日の「ニュース」が初回しか録れなくなる)。
 *   同じ時刻に同じ題名が流れる同時放送だけは束ねる (`firstAirings`)
 */
export function episodeKey(name: string): string | null {
    const parsed = parseTitle(name);
    const subtitle = squash(parsed.subtitle);
    if (parsed.episode === null && subtitle === '') return null;
    // `library.seriesFolder('', name)` と同じもの。題名はもう切ってあるので、切り直さずに使う
    const series = squash(sanitizeFileName(parsed.series));
    const episode = parsed.episode === null ? '' : `#${parsed.episode}`;
    return `${series}\n${episode}\n${subtitle}`;
}

/** 字幕付きか。放送の題名に `[字]` (外字。ARIB の囲み文字なら 🈑) が付く */
export function captioned(name: string): boolean {
    return /\[字\]|【字】|🈑/u.test(toHalfWidth(name));
}

/** 衛星 (BS/CS)。地上波と同時に流れているなら、地方の差し替えが無いぶんこちらを録る */
function satellite(type: string): boolean {
    return type !== 'GR';
}

export interface Airing {
    id: number;
    name: string;
    start_at: number;
    end_at: number;
    service_id: number;
    /** チャンネル種別 (GR/BS/CS/SKY) */
    type: string;
}

/** 録ったことのある回 (`episodeKey` → いつ・どこで) */
export type Taken = Map<string, { start_at: number; service_name: string }>;

/** 録らない放送と、その理由 */
export type Skip<T extends Airing> =
    /** 同じ回を別の放送で録る */
    | { kind: 'repeat'; first: T }
    /** 同じ回をもう録ってある */
    | { kind: 'recorded'; start_at: number; service_name: string };

/**
 * 同時に流れているものの中で、どれを録るか。
 * **字幕のあるもの → 衛星 → 早く始まるもの** の順
 */
function better<T extends Airing>(a: T, b: T): number {
    return (
        Number(captioned(b.name)) - Number(captioned(a.name)) ||
        Number(satellite(b.type)) - Number(satellite(a.type)) ||
        a.start_at - b.start_at ||
        a.service_id - b.service_id ||
        a.id - b.id
    );
}

const overlaps = (a: Airing, b: Airing) => a.start_at < b.end_at && b.start_at < a.end_at;

/**
 * 同じ回の放送のうち、**録らないもの**を返す (番組ID → 理由)。返らなかったものは録る。
 *
 * 1. 同じ回 (`episodeKey`) をまとめ、**いちばん早く始まる放送**を録る
 * 2. それと時間が重なっている放送 (同時放送) があれば、その中から
 *    **字幕のあるもの → 衛星** の順に選ぶ
 * 3. **選んだものがチューナー不足で弾かれていたら** (`blocked`)、次の放送も録る。
 *    同じ回の別の放送が空いたチューナーで録れるなら、そちらで拾う
 * 4. 同じ回をもう録ってあれば (`taken`)、どれも録らない
 *
 * 話数も副題も無い番組は**同じ時刻に同じ題名が流れているときだけ**まとめる
 * (`episodeKey` の注)。
 *
 * @param blocked チューナー不足で弾かれている放送 (予約の状態が `conflict`)
 * @param taken 録ったことのある回
 */
export function firstAirings<T extends Airing>(
    airings: readonly T[],
    blocked: ReadonlySet<number> = new Set(),
    taken: Taken = new Map(),
): Map<number, Skip<T>> {
    const skips = new Map<number, Skip<T>>();
    const episodes = new Map<string, T[]>();
    /** 回の分からない放送。題名ごとに、同じ時刻のものだけ束ねる */
    const loose = new Map<string, T[]>();
    for (const airing of airings) {
        const key = episodeKey(airing.name);
        const [bucket, at] =
            key === null ? [loose, `=${squash(displayTitle(airing.name))}`] : [episodes, key];
        const list = bucket.get(at);
        if (list === undefined) bucket.set(at, [airing]);
        else list.push(airing);
    }

    /** 束ねたものから録る1本 (弾かれていれば次も) を選び、残りを録らないことにする */
    function settle(cluster: T[]): void {
        const rest = [...cluster].sort((a, b) => a.start_at - b.start_at || better(a, b));
        let chosen: T | undefined;
        while (rest.length > 0) {
            const earliest = rest[0]!;
            const pick = rest.filter((a) => overlaps(a, earliest)).sort(better)[0]!;
            rest.splice(rest.indexOf(pick), 1);
            chosen = pick;
            if (!blocked.has(pick.id)) break;
        }
        for (const airing of rest) skips.set(airing.id, { kind: 'repeat', first: chosen! });
    }

    for (const [key, list] of episodes) {
        const done = taken.get(key);
        if (done !== undefined) {
            for (const airing of list) skips.set(airing.id, { kind: 'recorded', ...done });
            continue;
        }
        settle(list);
    }
    for (const list of loose.values()) {
        // 同じ題名でも別の時刻なら別の放送。重なっているものだけを1つに束ねる
        const rest = [...list].sort((a, b) => a.start_at - b.start_at);
        while (rest.length > 0) {
            const earliest = rest[0]!;
            const cluster = rest.filter((a) => overlaps(a, earliest));
            for (const airing of cluster) rest.splice(rest.indexOf(airing), 1);
            if (cluster.length > 1) settle(cluster);
        }
    }
    return skips;
}
