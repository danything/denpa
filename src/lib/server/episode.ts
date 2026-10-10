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
import { displayTitle, parseTitle, searchable, toHalfWidth } from './title';

/** 比べる前に揃える。空白の有無・大文字小文字は局によって揺れる。外字は昔の書き方に (`fold.ts`) */
function squash(text: string): string {
    return searchable(text).replace(/\s+/g, '');
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
    /** シリーズ名 (編まで) を均したもの */
    series: string;
    /** 編を除いた作品名を均したもの */
    work: string;
    /** 編 (`parseTitle` の `arc`) を均したもの。無ければ空 */
    arc: string;
    /** シリーズ名のうちいちばん長い語。局ごとの飾り (頭の「アニメ」、後ろの枠の名前) を除けた芯 */
    core: string;
    number: number | null;
    /** 副題を均したもの */
    subtitle: string;
    /**
     * 副題が確かでない (題名に話数しか無く概要から足したもの、括弧の無い副題、題名の印の後ろ)。
     * 揃えば同じ回の決め手にするが、食い違っても別の回とはしない (`sameEpisode`)
     */
    inferred: boolean;
    /**
     * 概要を均したもの。短いもの (`SUMMARY_MIN` 文字未満) は空。局を替えても概要はそのまま
     * 流れることが多く、話数と概要がぴったり同じなら、題名の飾りや副題が違っても同じ回とみる (`sameSummary`)
     */
    summary: string;
}

/** 回の決め手にする概要の長さ。短いものはどの回にも当たりやすい */
const SUMMARY_MIN = 30;

/**
 * 局が作品名の頭に付ける枠の名前 (`アニメA・貸した魔力は…` `ドラマ・天狗の台所`)。
 * 「・」で始まる頭はほかにも多い (`新・BS日本のうた` `続・深夜食堂` `ザ・ミステリー`) ので決め打ち
 */
const SLOT = /^(?:アニメ|ドラマ)[A-Za-z]?・/;

const KANJI_DIGITS = '〇一二三四五六七八九';
const NUMERAL = `\\d{1,4}|[${KANJI_DIGITS}十百]{1,5}`;
/** 英語の話数 (`Chapter 15` `Episode.2` `EP108`)。語の途中 (`Step12`) は読まない */
const LABEL = '(?<![A-Za-z0-9])(?:chapter|episode|ep)\\s*\\.?\\s*(\\d{1,4})';
/** 概要に出る話数と副題。`#18「月下の花」` `第18話「…」` `第十八話『…』` `Chapter 18「…」` */
const NUMBERED_SUBTITLE = new RegExp(
    `(?:#\\s*(\\d{1,4})|第\\s*(${NUMERAL})\\s*[話回]|${LABEL})\\s*[「『]([^」』]{1,80})[」』]`,
    'gi',
);
/**
 * 副題の無い話数。**行の頭に単独で出たものだけ** (`#18 猫猫は…`)。地の文の「第3話から登場」
 * 「#1ヒット」は読まない。「第3回」も地の文に紛れやすいので読まない
 */
const NUMBER_ONLY = new RegExp(
    `^\\s*(?:#\\s*(\\d{1,4})|第\\s*(${NUMERAL})\\s*話|${LABEL})(?=[\\s「『:.、。]|$)`,
    'gmi',
);
/**
 * 行の頭の話数に続く、括弧の無い副題 (`Chapter 15 百足坑道の主`)。行の残りが短く、
 * 文になっていない (句読点や … が無い) ものだけ。`#18 猫猫は壬氏に連れられて…` は副題にしない
 */
const BARE_SUBTITLE = /^[^。、,!?！？…]{1,40}$/;
/** 副題の後ろの区切り (`百足坑道の主▼レベルアップし…`)。その先は粗筋 */
const SUBTITLE_END = /[▼▽◆◇■□]/;
/**
 * 題名の話数の後ろが印で始まるもの (`#15◆スーパーアニメイズムTURBO` `#44 ◆松平健`)。
 * 枠の名前か出演者で、副題とは限らない
 */
const MARKED = /^[▼▽◆◇■□★☆]/;
/**
 * 「前回 #17「…」」「前回のあらすじ #17「…」」はこの回の話数ではない。同じ文の前のほうを見る
 * (`NUMBERED_SUBTITLE` 用。`NUMBER_ONLY` は行の頭だけなので前置きがあれば当たらない)
 */
const ANOTHER_EPISODE = /前回|次回|予告/;

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
function describedEpisode(
    texts: string[],
): { number: number | null; subtitle: string; bracketed: boolean } | null {
    for (const [pattern, withSubtitle] of [
        [NUMBERED_SUBTITLE, true],
        [NUMBER_ONLY, false],
    ] as const) {
        for (const text of texts) {
            for (const match of text.matchAll(pattern)) {
                const sentence =
                    text
                        .slice(0, match.index)
                        .split(/[。\n」』]/)
                        .at(-1) ?? '';
                if (ANOTHER_EPISODE.test(sentence)) continue;
                const line = text
                    .slice(match.index + match[0].length)
                    .split('\n')[0]!
                    .split(SUBTITLE_END)[0]!
                    .replace(/^[\s:.]+/, '')
                    .trim();
                const subtitle = withSubtitle ? match[4]! : BARE_SUBTITLE.test(line) ? line : '';
                return {
                    number: numeral((match[1] ?? match[2] ?? match[3])!),
                    subtitle: squash(subtitle),
                    bracketed: withSubtitle,
                };
            }
        }
    }
    return null;
}

/**
 * **その回が何か。** 回が分からなければ null。
 *
 * - 回は**話数と副題**で見分ける (`sameEpisode`)。`第2期 #1` の「第2期」は編として
 *   シリーズ名の側に入る (`parseTitle` の `arc`) ので、2期の全話が1つの回に潰れることはない
 * - **題名に話数も副題も無ければ、概要 (無ければ詳細) から読む。** 題名は飾りだけで
 *   (「薬屋のひとりごと FRIDAY ANIME NIGHT」)、話数は概要の `#18「月下の花」` に
 *   しか無い局がある。題名に副題があれば題名だけを使う
 * - **題名に話数だけあれば、副題は概要から足す** (話数が題名と同じときだけ)。
 *   `追放された…#15◆スーパーアニメイズムTURBO` と `アニメ 追放された… Chapter 15` は
 *   飾りが違うので、副題 (`Chapter 15「百足坑道の主」`) が揃って初めて同じ回と分かる。
 *   足せなかった局とは、片方に副題が無いときの見方 (`sameEpisode`) で今までどおり比べる。
 *   話数の後ろの `◆枠の名前` `▼出演者` も副題とは限らないので、概要に副題があればそちらを使う
 * - **どちらにも無ければ null**。その番組は「回」が分からないので、
 *   時刻をまたいでは束ねない (毎日の「ニュース」が初回しか録れなくなる)。
 *   同じ時刻に同じ題名が流れる同時放送だけは束ねる (`firstAirings`)
 */
export function episodeOf(program: Described): Episode | null {
    const parsed = parseTitle(program.name);
    let number = parsed.episode;
    let subtitle = squash(parsed.subtitle);
    let inferred = MARKED.test(subtitle);
    if (subtitle === '' || inferred) {
        const texts = [program.description, Object.values(program.extended ?? {}).join('\n')].map(
            toHalfWidth,
        );
        const described = describedEpisode(texts);
        if (number === null) {
            if (subtitle === '') {
                if (described === null) return null;
                ({ number, subtitle } = described);
                inferred = !described.bracketed;
            }
        } else if (described?.number === number && described.subtitle !== '') {
            subtitle = described.subtitle;
            inferred = true;
        }
    }
    // ARIB の囲み文字 (🈑🈞) は局によって付いたり付かなかったりする
    const bare = (text: string) => text.replace(/[\u{1F210}-\u{1F23B}]/gu, ' ');
    const work = parsed.series.replace(SLOT, '') || parsed.series;
    const series = bare(`${work} ${parsed.arc}`);
    const words = series
        .split(/[\s[\]【】<>()〈〉《》≪≫]+/)
        .map(squash)
        .filter((word) => word !== '');
    const core = words.reduce((longest, word) => (word.length > longest.length ? word : longest), '');
    return {
        series: squash(series),
        work: squash(bare(work)),
        arc: squash(bare(parsed.arc)),
        core,
        number,
        subtitle,
        inferred,
        summary: summaryOf(program.description),
    };
}

function summaryOf(description: string): string {
    const summary = squash(description ?? '');
    return summary.length >= SUMMARY_MIN ? summary : '';
}

/**
 * シリーズ名が同じか。編を書く局と書かない局 (`「東京リベンジャーズ」三天戦争編 第51話` と
 * `東京リベンジャーズ #51`) は、作品名が同じなら同じシリーズとみる
 */
function sameSeries(a: Episode, b: Episode): boolean {
    return a.series === b.series || (a.work === b.work && (a.arc === '' || b.arc === ''));
}

/** シリーズ名の中の数字 (`汚職特捜班 5` の 5)。期の数字のことが多い */
const digits = (text: string) => text.match(/\d+/g)?.join(' ') ?? '';

/**
 * 話数と概要がぴったり同じか (`Episode.summary`)。シリーズ名は同じか、片方がもう片方を
 * そっくり含むもの (`【釣りの日SP】ロンブー亮の…` と `ロンブー亮の…`) だけ。芯だけ重なるものは
 * 除く — 曜日ごとの枠 (`… Monday #4` と `… Tuesday #4`) が同じ番組紹介を持つ。
 * 話数の無いもの、確かな副題が食い違うもの、シリーズ名の数字が違うもの
 * (`汚職特捜班 5 #6` と `汚職特捜班 6 #6` が「エピソード6」+ 番組紹介 の同じ概要を持つ) も除く
 */
function sameSummary(a: Episode, b: Episode): boolean {
    if (a.number === null || a.number !== b.number || a.summary === '' || a.summary !== b.summary)
        return false;
    if (a.subtitle !== '' && b.subtitle !== '' && a.subtitle !== b.subtitle && !a.inferred && !b.inferred)
        return false;
    if (a.series !== b.series && digits(a.series) !== digits(b.series)) return false;
    return sameSeries(a, b) || a.series.includes(b.series) || b.series.includes(a.series);
}

/**
 * **同じ回か。** 話数が同じで、副題が食い違わず、シリーズも同じもの。
 *
 * シリーズ名は局によって飾りが違う (「アニメ 薬屋のひとりごと」と
 * 「薬屋のひとりごと FRIDAY ANIME NIGHT」)。飾りを並べて消すのではなく、
 * **片方の芯 (いちばん長い語) がもう片方に入っていれば**同じシリーズとみる。
 * ただしそれは**副題まで揃っているときだけ**。話数だけで緩めると、1期の再放送と
 * 「X 2」の同じ話数がくっつく。芯が2文字以下なら緩めない (「最終回」のような
 * 短い副題で別の番組に紛れる)。
 *
 * **副題を出さない局もある** (`東京リベンジャーズ 三天戦争編▼第52話` と、同じ回に
 * `「Be left behind the times」` を付ける局)。片方に副題が無ければ、シリーズ名が
 * 同じ (`sameSeries`) ものを同じ回とみる。確かでない副題 (`Episode.inferred`) が
 * 食い違うときも同じ。
 *
 * **話数と概要がぴったり同じなら** (`sameSummary`)、飾りや副題の有無が違っても同じ回
 * (`ロンブー亮の釣りならまかせろ! #42` と `【釣りの日SP】ロンブー亮の… #42`)。
 * 毎週同じ番組紹介を流す番組は、呼ぶ側 (`firstAirings`) が概要を消してから渡す
 *
 * **編がどちらにも書いてあって違えば別の回** (`水戸黄門・第36部 #9` と `第37部 #9`)
 */
export function sameEpisode(a: Episode, b: Episode): boolean {
    if (a.number !== b.number) return false;
    if (a.arc !== '' && b.arc !== '' && a.arc !== b.arc) return false;
    if (sameSummary(a, b)) return true;
    if (a.subtitle === '' || b.subtitle === '') return sameSeries(a, b);
    // 確かでない副題は、食い違っても副題が無いものとして見る
    if (a.subtitle !== b.subtitle) return (a.inferred || b.inferred) && sameSeries(a, b);
    if (sameSeries(a, b)) return true;
    return (
        (a.core.length >= 3 && b.series.includes(a.core)) || (b.core.length >= 3 && a.series.includes(b.core))
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
 * 渡された放送と録画のうち、話数の違う回にも出てくる概要 (毎週同じ番組紹介) は、
 * 同じ回の決め手 (`sameSummary`) にしない
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
    /** 話数が同じ放送。この中で `sameEpisode` で束ねる */
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
        const at = String(episode.number);
        const list = numbered.get(at);
        if (list === undefined) numbered.set(at, [{ airing, episode }]);
        else list.push({ airing, episode });
    }
    // 話数の違う回にも出てくる概要は、毎週同じ番組紹介。回の決め手にしない。
    // 数字は除いて比べる (「エピソード6」+ 番組紹介 のように話数だけ差し替えるものがある)
    const template = (summary: string) => summary.replace(/\d+/g, '#');
    const numbers = new Map<string, Set<number | null>>();
    const known = [
        ...[...numbered.values()].flat().map(({ episode }) => episode),
        ...taken.map((t) => t.episode),
    ];
    for (const { summary, number } of known) {
        if (summary === '') continue;
        const key = template(summary);
        const seen = numbers.get(key);
        if (seen === undefined) numbers.set(key, new Set([number]));
        else seen.add(number);
    }
    const generic = (e: Episode) => e.summary !== '' && numbers.get(template(e.summary))!.size > 1;
    for (const list of numbered.values())
        for (const entry of list)
            if (generic(entry.episode)) entry.episode = { ...entry.episode, summary: '' };
    const recorded = taken.map((t) =>
        generic(t.episode) ? { ...t, episode: { ...t.episode, summary: '' } } : t,
    );

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
        for (const cluster of episodes(list)) {
            const done = recorded.find((t) => cluster.some(({ episode }) => sameEpisode(t.episode, episode)));
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

/**
 * 話数の同じ放送を、回ごとに束ねる (並び順に依らない)。
 *
 * 1. **確かに同じ回のもの**を繋ぐ。副題が揃うもの (飾りの違うシリーズ名は芯で繋がる) と、
 *    副題の無い、シリーズ名のぴったり同じもの
 * 2. **副題を出す局と出さない局、編を書く局と書かない局** (`sameEpisode`) は、
 *    互いに相手が1つに決まるときだけ繋ぐ。`X #5` に `「X」A編 #5` と `「X」B編 #5` の
 *    両方が当たるなら、どちらとも繋がない — 1本多く録るだけで、取り違えて録り逃すよりよい
 */
function episodes<T>(list: { airing: T; episode: Episode }[]): { airing: T; episode: Episode }[][] {
    // 確かでない副題 (`Episode.inferred`) は、揃わなければ副題が無いものとして見る。
    // ただし確かでない副題どうしが食い違うなら、確かとはしない (相手が1つに決まるときだけ繋ぐ)
    const blank = (e: Episode) => e.subtitle === '' || e.inferred;
    const sure = (a: Episode, b: Episode) =>
        sameSummary(a, b) ||
        (a.subtitle !== '' && a.subtitle === b.subtitle
            ? sameEpisode(a, b)
            : (a.subtitle === '' || b.subtitle === '') && blank(a) && blank(b) && a.series === b.series);
    const group = list.map((_, i) => i);
    const root = (i: number): number => {
        let at = i;
        while (group[at] !== at) at = group[at]!;
        return at;
    };
    for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
            if (sure(list[i]!.episode, list[j]!.episode)) group[root(j)] = root(i);
    const roots = new Map<number, { airing: T; episode: Episode }[]>();
    list.forEach((entry, i) => {
        const cluster = roots.get(root(i));
        if (cluster === undefined) roots.set(root(i), [entry]);
        else cluster.push(entry);
    });
    const clusters = [...roots.values()];

    /** 束どうしで、同じ回と読める組み合わせがあるもの。飾りの違う局は副題で束ねてあるので、どれか1つと読めればよい */
    const partners = clusters.map((one) =>
        clusters.filter(
            (other) =>
                other !== one &&
                one.some(({ episode: a }) => other.some(({ episode: b }) => sameEpisode(a, b))),
        ),
    );
    const merged: { airing: T; episode: Episode }[][] = [];
    clusters.forEach((cluster, i) => {
        const [only, ...more] = partners[i]!;
        if (only === undefined || more.length > 0) {
            merged.push(cluster);
            return;
        }
        const j = clusters.indexOf(only);
        // 相手も自分しか候補が無いときだけ1つにする。2つ目の側で足す (二重に足さない)
        if (partners[j]!.length !== 1) merged.push(cluster);
        else if (j < i) merged.push([...only, ...cluster]);
    });
    return merged;
}
