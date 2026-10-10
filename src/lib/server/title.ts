/**
 * 番組名からシリーズ名とサブタイトルを切り出す。
 *
 * 保存先では「シリーズ名のフォルダ + 日付ベースの録画」として並べたいので、
 * 毎回変わる部分(話数・サブタイトル)を番組名から落として安定したシリーズ名を作るのが目的。
 * 放送局ごとに表記が揺れるため完璧は狙わず、実害の出やすいパターンだけ潰す。
 */
import { FOLD, foldForSearch } from '../fold';

// 【新】【終】[字][解][再] のような装飾記号。先頭・末尾どこにでも出る
const DECORATION = /[【[(]\s*(新|終|再|字|解|デ|二|多|SS|初|最終回|無料|無|生|映)\s*[】\])]/g;

// 同じ記号の外字 (🈟🈡🈑…)。番組表は規格の字のまま持つので、こちらも落とす
const DECORATION_MARK = new RegExp(
    `[${[...FOLD]
        .filter(([, folded]) => new RegExp(`^${DECORATION.source}$`).test(folded))
        .map(([mark]) => mark)
        .join('')}]`,
    'gu',
);

// 局が頭に付ける枠の名前。`<アニメギルド>てつりょー!` (全角の ＜＞ は半角に寄せてから見る)
const FRAME = /^<[^<>]{1,20}>\s*/;

// 「サブタイトル」形式。番組名の末尾に出てきたものだけをサブタイトル扱いにする
const BRACKET_SUBTITLE = /[「『](.+?)[」』]\s*$/;

// 頭の「作品名」。後ろは編の名前 (`「東京リベンジャーズ」三天戦争編`)
const LEADING_TITLE = /^[「『]([^「『」』]+)[」』]\s*(.*)$/;

// 第2期 / 第3シーズン。話数ではなく編として持つ。話数の前か題名の終わりにあるものだけ —
// 「将棋)第34期 銀河戦」のように後ろに名前が続くものは、どこまでが編か分からない
const SEASON =
    /\s*第\s*(?:\d{1,4}|[一二三四五六七八九十]{1,3})\s*(?:期|シーズン|クール|章|部)(?=\s*(?:#|第\s*\d|$))/;

// #12 / 第12話 / ＃12 のような話数表記
const EPISODE = /\s*(?:#|＃|第)\s*(\d{1,4})\s*(?:話|回)?/;

// 英語の話数 (`Chapter 15` `Episode.2` `EP108` `Ep17`)。#/第 が無いときだけ見る。
// 作品ごとの呼び方 (`request 15.` `FILE.2` `Case 3` `Act.5` `Lesson 4` `Mission 7` `Karte 8`) も話数。
// `Season 2` `Part 2` `Vol.3` は話数ではない (期や巻) ので読まない。語の途中 (`Step12`) や
// `【EP356】` のような括弧の中、`SONG FILE 70年代` の年も読まない。後ろのドットは話数の終わり
const LABELED_EPISODE =
    /\s*(?<![A-Za-z0-9【[(])(?:chapter|episode|ep|request|file|case|act|lesson|mission|karte)\s*\.?\s*(\d{1,4})(?!\.?\d|年)\.?/i;

// 話数の後ろが枠の名前だけ (`第51話【アニメイズム】`) なら副題ではない
const LABELS_ONLY = /^(?:【[^】]*】\s*)+$/;

// 名前の後ろに残る区切り記号 (`番組名 - ` や、`作品名 編▼第52話` の ▼。外字の ⛊⛉ も)
const TRAILING_SEPARATOR = /[\s\-~〜:：|｜▼▽⛊⛉]+$/u;

// ファイル名に使えない文字。制御文字は別途コードポイントで弾く
const FORBIDDEN = '/\\:*?"<>|';

/** 全角英数・記号を半角に寄せる。放送波の局名/番組名は全角混じりで検索しづらい */
export function toHalfWidth(input: string): string {
    return input
        .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
        .replace(/　/g, ' ');
}

/** 探すときの形。全角を半角に、外字を昔の書き方に (`fold.ts`)、小文字に */
export function searchable(input: string): string {
    return foldForSearch(toHalfWidth(input)).toLowerCase();
}

/**
 * 人に見せる用の番組名。[字][デ] のような装飾記号だけ落とし、話数も
 * サブタイトルも ARIB の囲み文字 (🈚🈑) も残す。エンコードの入れ物の title にも焼き込む
 */
export function displayTitle(rawName: string): string {
    const cleaned = toHalfWidth(rawName ?? '')
        .replace(DECORATION, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned === '' ? (rawName ?? '').trim() : cleaned;
}

export interface ParsedTitle {
    /** 作品名。ルールの下書きのキーワード・保存先のフォルダ・録画一覧のまとめに使う */
    series: string;
    /**
     * 作品名に続く編・期 (`「東京リベンジャーズ」三天戦争編` の「三天戦争編」、`第2期`)。
     * 話数を編ごとに振り直す番組があるので、同じ回か (`episode.episodeOf`) はこれも含めて見る
     */
    arc: string;
    subtitle: string;
    episode: number | null;
}

export function parseTitle(rawName: string): ParsedTitle {
    const name = toHalfWidth(rawName ?? '')
        .replace(DECORATION, '')
        .replace(DECORATION_MARK, '')
        .trim();

    let subtitle = '';
    let series = name.replace(FRAME, '');

    // 頭の鍵括弧は副題ではなく作品名 (`「名探偵コナン」` `「東京リベンジャーズ」三天戦争編`)。副題はその後ろから探す
    const head = series.match(LEADING_TITLE)?.[1]?.length;
    const from = head === undefined ? 0 : head + 2;
    const bracket = series.slice(from).match(BRACKET_SUBTITLE);
    if (bracket !== null) {
        subtitle = (bracket[1] ?? '').trim();
        series = series.slice(0, from + (bracket.index ?? 0)).trim();
    }

    const arcs: string[] = [];
    const season = series.match(SEASON);
    if (season !== null) {
        // 「X 第2期 #1」の「第2」を話数に読まないよう、先に抜く
        arcs.push(season[0].trim());
        const at = season.index ?? 0;
        series = `${series.slice(0, at)} ${series.slice(at + season[0].length)}`.trim();
    }

    let episode: number | null = null;
    const ep = series.match(EPISODE) ?? series.match(LABELED_EPISODE);
    if (ep !== null) {
        episode = Number(ep[1]);
        // 話数以降(「番組名 #12 サブタイトル」の後半)はサブタイトル扱いにして series からは落とす
        const tail = series.slice((ep.index ?? 0) + ep[0].length).trim();
        if (subtitle === '' && tail !== '' && !LABELS_ONLY.test(tail)) subtitle = tail;
        series = series.slice(0, ep.index).trim();
    }

    const lead = series.replace(TRAILING_SEPARATOR, '').match(LEADING_TITLE);
    if (lead !== null) {
        series = lead[1] ?? '';
        const rest = (lead[2] ?? '').replace(TRAILING_SEPARATOR, '').trim();
        if (rest !== '') arcs.unshift(rest);
    }

    // 区切り記号だけが残るケース (「番組名 - 」など) を掃除する
    series = series.replace(TRAILING_SEPARATOR, '').trim();
    if (series === '') series = name === '' ? 'untitled' : name;

    return { series, arc: arcs.join(' '), subtitle, episode };
}

/**
 * ファイル名・ディレクトリ名に使える形に落とす。
 * ext4 で壊れるのは `/` と NUL だけだが、SMB 経由で覗くことを考えて Windows の禁止文字も落とす。
 */
export function sanitizeFileName(input: string): string {
    const replaced = Array.from(input ?? '')
        .map((c) => (c.codePointAt(0)! < 0x20 || FORBIDDEN.includes(c) ? ' ' : c))
        .join('');
    const cleaned = replaced
        .replace(/\s+/g, ' ')
        .trim()
        // 末尾のドット・スペースは Windows が扱えない
        .replace(/[\s.]+$/, '');
    // ext4 のファイル名上限は255バイト。日本語(UTF-8で3バイト)でも収まる長さに切る
    const limited = cleaned.slice(0, 60).trim();
    return limited === '' ? 'untitled' : limited;
}
