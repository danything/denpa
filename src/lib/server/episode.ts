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
import { displayTitle, parseTitle, toHalfWidth } from './title';

/** 比べる前に揃える。空白の有無・大文字小文字は局によって揺れる */
function squash(text: string): string {
    return toHalfWidth(text).replace(/\s+/g, '').toLowerCase();
}

/** 回を読む元。番組表の番組と録画のどちらも持っている */
export interface Described {
    name: string;
    description: string;
    /** 詳細 (拡張形式)。JSON {見出し:本文} */
    extended: Record<string, string> | null;
}

/** その回が何か (`episodeOf`)。2つが同じ回かは `sameEpisode` */
export interface Episode {
    /** シリーズ名を均したもの */
    series: string;
    /** シリーズ名のうちいちばん長い語。局ごとの飾り (頭の「アニメ」、後ろの枠の名前) を除けた芯 */
    core: string;
    number: number | null;
    /** 副題を均したもの */
    subtitle: string;
}

const KANJI_DIGITS = '〇一二三四五六七八九';
const NUMERAL = `\\d{1,4}|[${KANJI_DIGITS}十百]{1,5}`;
/** 概要に出る話数と副題。`#18「月下の花」` `第18話「…」` `第十八話『…』` */
const NUMBERED_SUBTITLE = new RegExp(
    `(?:#\\s*(\\d{1,4})|第\\s*(${NUMERAL})\\s*[話回])\\s*[「『]([^」』]{1,80})[」』]`,
    'g',
);
/** 副題の無い話数。地の文に紛れやすい「第3回」は読まない */
const NUMBER_ONLY = new RegExp(`#\\s*(\\d{1,4})(?!\\d)|第\\s*(${NUMERAL})\\s*話`, 'g');
/** 「前回 #17「…」」「次回 第19話」はこの回の話数ではない */
const ANOTHER_EPISODE = /(前回|次回|予告)[\s:は、の]*$/;

/** `18` / `十八` / `一〇` を数に */
function numeral(text: string): number {
    if (/^\d+$/.test(text)) return Number(text);
    if (!/[十百]/.test(text)) return Number([...text].map((c) => KANJI_DIGITS.indexOf(c)).join(''));
    let total = 0;
    let current = 0;
    for (const c of text) {
        if (c === '百' || c === '十') {
            total += (current || 1) * (c === '百' ? 100 : 10);
            current = 0;
        } else current = KANJI_DIGITS.indexOf(c);
    }
    return total + current;
}

/** 概要・詳細から、この回の話数と副題 (読めなければ null) */
function describedEpisode(texts: string[]): { number: number | null; subtitle: string } | null {
    for (const [pattern, withSubtitle] of [
        [NUMBERED_SUBTITLE, true],
        [NUMBER_ONLY, false],
    ] as const) {
        for (const text of texts) {
            for (const match of text.matchAll(pattern)) {
                if (ANOTHER_EPISODE.test(text.slice(0, match.index))) continue;
                return {
                    number: numeral((match[1] ?? match[2])!),
                    subtitle: withSubtitle ? squash(match[3]!) : '',
                };
            }
        }
    }
    return null;
}

/** 「第2期」のように、`parseTitle` が話数に読んでしまう期の番号 */
const SEASON = /^(期|シーズン|クール|章|部)$/;

/**
 * **その回が何か。** 回が分からなければ null。
 *
 * - 回は**話数と副題の両方**で見分ける (`sameEpisode`)。片方だけで当てると、`第2期 #1` が
 *   「第2話」に読める (`parseTitle` の癖) ので、2期の全話が1つの回に潰れる。
 *   局によって副題を出したり出さなかったりすると同じ回でも別の回に見えるが、
 *   そのときは2本録れるだけ (録り逃すより安い)
 * - **題名に話数も副題も無ければ、概要 (無ければ詳細) から読む。** 題名は飾りだけで
 *   (「薬屋のひとりごと FRIDAY ANIME NIGHT」)、話数は概要の `#18「月下の花」` に
 *   しか無い局がある。題名に片方でもあれば題名だけを使う — 概要で埋めると、埋められた局と
 *   埋められなかった局で同じ回が別の回になる
 * - **どちらにも無ければ null**。その番組は「回」が分からないので、
 *   時刻をまたいでは束ねない (毎日の「ニュース」が初回しか録れなくなる)。
 *   同じ時刻に同じ題名が流れる同時放送だけは束ねる (`firstAirings`)
 */
export function episodeOf(program: Described): Episode | null {
    const parsed = parseTitle(program.name);
    let series = parsed.series;
    let number = parsed.episode;
    let subtitle = squash(parsed.subtitle);
    if (number !== null && SEASON.test(subtitle)) {
        // 「X 第2期」だけの題名。毎回同じなので、話数ではなくシリーズ名の一部
        series = `${series} 第${number}${subtitle}`;
        number = null;
        subtitle = '';
    }
    if (number === null && subtitle === '') {
        const texts = [program.description, Object.values(program.extended ?? {}).join('\n')].map(
            toHalfWidth,
        );
        const described = describedEpisode(texts);
        if (described === null) return null;
        ({ number, subtitle } = described);
    }
    // ARIB の囲み文字 (🈑🈞) は局によって付いたり付かなかったりする
    const bare = series.replace(/[\u{1F210}-\u{1F23B}]/gu, ' ');
    const words = bare
        .split(/[\s[\]【】<>()〈〉《》≪≫]+/)
        .map(squash)
        .filter((word) => word !== '');
    const core = words.reduce((longest, word) => (word.length > longest.length ? word : longest), '');
    return { series: squash(bare), core, number, subtitle };
}

/**
 * **同じ回か。** 話数と副題が揃っていて、シリーズも同じもの。
 *
 * シリーズ名は局によって飾りが違う (「アニメ 薬屋のひとりごと」と
 * 「薬屋のひとりごと FRIDAY ANIME NIGHT」)。飾りを並べて消すのではなく、
 * **片方の芯 (いちばん長い語) がもう片方に入っていれば**同じシリーズとみる。
 * ただしそれは**副題まで揃っているときだけ**。話数だけで緩めると、1期の再放送と
 * 「X 2」の同じ話数がくっつく。副題の無い回はシリーズ名がぴったり同じものだけ
 */
export function sameEpisode(a: Episode, b: Episode): boolean {
    if (a.number !== b.number || a.subtitle !== b.subtitle) return false;
    if (a.series === b.series) return true;
    if (a.subtitle === '') return false;
    return (
        (a.core.length >= 2 && b.series.includes(a.core)) || (b.core.length >= 2 && a.series.includes(b.core))
    );
}

/** 字幕付きか。放送の題名に `[字]` (外字。ARIB の囲み文字なら 🈑) が付く */
export function captioned(name: string): boolean {
    return /\[字\]|【字】|🈑/u.test(toHalfWidth(name));
}

/** 衛星 (BS/CS)。地上波と同時に流れているなら、地方の差し替えが無いぶんこちらを録る */
function satellite(type: string): boolean {
    return type !== 'GR';
}

export interface Airing extends Described {
    id: number;
    start_at: number;
    end_at: number;
    service_id: number;
    /** チャンネル種別 (GR/BS/CS/SKY) */
    type: string;
}

/** 録ったことのある回と、いつ・どこで録ったか。同じ回は `sameEpisode` で探す */
export type Taken = { episode: Episode; start_at: number; service_name: string }[];

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
 * 1. 同じ回 (`sameEpisode`) をまとめ、**いちばん早く始まる放送**を録る
 * 2. それと時間が重なっている放送 (同時放送) があれば、その中から
 *    **字幕のあるもの → 衛星** の順に選ぶ
 * 3. **選んだものがチューナー不足で弾かれていたら** (`blocked`)、次の放送も録る。
 *    同じ回の別の放送が空いたチューナーで録れるなら、そちらで拾う
 * 4. 同じ回をもう録ってあれば (`taken`)、どれも録らない
 *
 * 話数も副題も無い番組は**同じ時刻に同じ題名が流れているときだけ**まとめる
 * (`episodeOf` の注)。
 *
 * @param blocked チューナー不足で弾かれている放送 (予約の状態が `conflict`)
 * @param taken 録ったことのある回
 */
export function firstAirings<T extends Airing>(
    airings: readonly T[],
    blocked: ReadonlySet<number> = new Set(),
    taken: Taken = [],
): Map<number, Skip<T>> {
    const skips = new Map<number, Skip<T>>();
    /** 話数と副題が同じ放送。シリーズ名は飾りの違いを許すので、この中で `sameEpisode` で束ねる */
    const numbered = new Map<string, { airing: T; episode: Episode }[]>();
    /** 回の分からない放送。題名ごとに、同じ時刻のものだけ束ねる */
    const loose = new Map<string, T[]>();
    for (const airing of airings) {
        const episode = episodeOf(airing);
        if (episode === null) {
            const at = squash(displayTitle(airing.name));
            const list = loose.get(at);
            if (list === undefined) loose.set(at, [airing]);
            else list.push(airing);
            continue;
        }
        const at = `${episode.number}\n${episode.subtitle}`;
        const list = numbered.get(at);
        if (list === undefined) numbered.set(at, [{ airing, episode }]);
        else list.push({ airing, episode });
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

    for (const list of numbered.values()) {
        // 飾りの違うシリーズ名は芯で繋がるので、繋がったものを1つの回にまとめる (並び順に依らない)
        const group = list.map((_, i) => i);
        const root = (i: number): number => {
            let at = i;
            while (group[at] !== at) at = group[at]!;
            return at;
        };
        for (let i = 0; i < list.length; i++)
            for (let j = i + 1; j < list.length; j++)
                if (sameEpisode(list[i]!.episode, list[j]!.episode)) group[root(j)] = root(i);
        const clusters = new Map<number, { airing: T; episode: Episode }[]>();
        list.forEach((entry, i) => {
            const cluster = clusters.get(root(i));
            if (cluster === undefined) clusters.set(root(i), [entry]);
            else cluster.push(entry);
        });
        for (const cluster of clusters.values()) {
            const done = taken.find((t) => cluster.some(({ episode }) => sameEpisode(t.episode, episode)));
            if (done !== undefined) {
                const { start_at, service_name } = done;
                for (const { airing } of cluster)
                    skips.set(airing.id, { kind: 'recorded', start_at, service_name });
                continue;
            }
            settle(cluster.map(({ airing }) => airing));
        }
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
