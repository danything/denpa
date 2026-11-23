/**
 * **番組のシリーズ名を決める** (録画のフォルダ名・「まとめて表示」・「ルールを作る」の下書き)。
 * DB に触らない純粋な計算だけを置く。控えを読み書きするのは `series-heads.ts`。
 *
 * `parseTitle` は話数・副題・期・編を外すだけなので、その回のタイトルを番組名に続ける番組
 * (`ダークサイドミステリー　連続怪死！…` `おんがく交差点【…】`) は 1 回ごとに別の名前になる。
 * そこで、**同じ局の番組表と録画で何度も出る先頭の部分**を学び、それをシリーズ名にする。
 *
 * - 番組名は `withoutSlot(parseTitle(name).series)` を区切りで**切れ端**に分ける (`segmentsOf`)
 * - 切れ端の並びを局ごとの木に積み、回が 2 種類以上ある点を「続いている」とみる
 * - 下の分かれが 2 つ以上あり、続いている子が無い点を**先頭**として採る (`learnHeads`)。
 *   続いている子が 2 つ以上ある点は枠 (`韓国ドラマ　X` `韓国ドラマ　Y`) なので、どの局でも採らない
 * - 当てるのは局を問わない。採った先頭のうちいちばん長いもので切る (`splitSeries`)
 *
 * **同じ回の判定 (`episode.ts`) には使わない。** 1 回だけの番組がまとまると (`連続ドラマW`)、
 * 別の番組の第 1 話どうしが同じ回になり、片方を録らない
 */
import { toHalfWidth } from "../fold";
import {
  displayTitle,
  parseTitle,
  sanitizeFileName,
  withoutSlot,
} from "./title";

/** 学ぶ 1 行。局と、`strictSeries` の名前 */
export interface SeriesRow {
  station: string;
  series: string;
  /** その名前で見た回の種類。2 で頭打ち (続いているかを見るだけなので、それより上は数えない) */
  titles: number;
  /** ジャンルが映画だけの番組 */
  movieOnly: boolean;
}

/**
 * 局のキー。局名を半角に寄せて空白を除く。サブチャンネル (`ＢＳ日テレ` の 3 つ) と、
 * ケーブルで同じ局を受けたもの (`ＬａＬａＴＶ` と `LaLa TV`) が 1 つになる。局名が空なら null (学ばない)
 */
export function stationKey(serviceName: string): string | null {
  const key = toHalfWidth(serviceName ?? "").replace(/\s+/g, "");
  return key === "" ? null : key;
}

/** 学ぶ元の名前。`parseTitle` の作品名から枠の名前 (`アニメ　`) を外したもの。**シリーズ名は、先頭を採っても採らなくてもこれから切る** */
export function strictSeries(name: string): string {
  return withoutSlot(parseTitle(name).series.trim());
}

/** 回の種類を数えるキー。番組名から飾りと外字の印 (🈑🈞) を外して均したもの。再放送は同じキーになる */
export function titleKey(name: string): string {
  return keyOf(
    displayTitle(name)
      .replace(/[\u{1F100}-\u{1F2FF}]/gu, "")
      // NHK の再放送の印 (`釣りびと万歳選　…`)。同じ回の再放送を別の回と数えない (`withoutSen`)
      .replace(/選(?=[\s　▼▽【「『])/u, ""),
  );
}

/** 切れ端・先頭を比べるキー (ファイル名と同じ寄せ方で、空白を除いて小文字に) */
export function keyOf(text: string): string {
  return sanitizeFileName(text).toLowerCase().replace(/\s+/g, "");
}

const PAIRS: Record<string, string> = {
  "【": "】",
  "「": "」",
  "『": "』",
  "<": ">",
  "＜": "＞",
  "[": "]",
  "［": "］",
  "(": ")",
  "（": "）",
  "〈": "〉",
  "《": "》",
};
/** この前で区切る括弧。`[` `(` は名前の中にも出る (`頭文字[イニシャル]D` `よしもと新喜劇(2014～)`) ので区切らない */
const CUT_OPEN = new Set([..."【「『<＜"]);
/** この前で区切る印 */
const MARKS = new Set([..."▽▼◇◆■□★☆～~〜"]);
const CLOSE = new Set(Object.values(PAIRS));
const LATIN = /[A-Za-z0-9]/;

/**
 * 名前を切れ端に分ける。区切りは切れ端の頭に付く。
 *
 * - 全角の空白と `【「『＜<` `▽▼◇◆■□★☆～` の前で区切る。括弧の中では区切らない
 * - 全角の空白の両側が英数字なら区切らない (`ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ`)
 * - `【「『＜<` が閉じた後ろと、先頭の枠の印 (`[見]` `将棋）`) の後ろで区切る
 */
export function segmentsOf(series: string): string[] {
  const chars = [...series];
  const out: string[] = [];
  let current = "";
  const stack: string[] = [];
  /** いまの切れ端が括弧で始まり、その括弧がまだ閉じていない (先頭の印かもしれない) */
  let leading = false;
  /** いちばん外の開き括弧 */
  let outer = "";
  const push = () => {
    if (current.trim() !== "") out.push(current);
    current = "";
  };
  chars.forEach((c, i) => {
    const prev = chars[i - 1] ?? "";
    if (stack.length === 0 && current.trim() !== "") {
      const cut =
        CUT_OPEN.has(c) ||
        MARKS.has(c) ||
        (c === "　" &&
          !(
            LATIN.test(toHalfWidth(prev)) &&
            LATIN.test(toHalfWidth(chars[i + 1] ?? ""))
          ));
      if (cut) push();
    }
    if (current.trim() === "" && PAIRS[c] !== undefined && out.length === 0)
      leading = true;
    current += c;
    if (PAIRS[c] !== undefined) {
      if (stack.length === 0) outer = c;
      stack.push(PAIRS[c]);
    } else if (stack.length > 0 && c === stack[stack.length - 1]) {
      stack.pop();
      // 先頭の枠の印と、区切る括弧 (`「作品名」` `【回のタイトル】`) が閉じたら、そこで区切る
      if (stack.length === 0 && (leading || CUT_OPEN.has(outer))) {
        leading = false;
        push();
      }
    } else if (
      stack.length === 0 &&
      out.length === 0 &&
      CLOSE.has(c) &&
      [...current.trim()].length <= 5
    ) {
      // 開きの無い `将棋）` は枠の名前
      push();
    }
  });
  push();
  return out;
}

/** 枠の印だけの切れ端 (`【名車一挙】` `[見]` `★【録画可能】` `将棋）` `★`) */
function isLabel(segment: string): boolean {
  const text = toHalfWidth(segment).trim();
  return /^[\s★☆●◆◇■□▽▼~〜]*(?:[【[<(（［＜][^】\]>)）］＞]{0,20}[】\]>)）］＞][\s★☆●]*|[^()（）]{1,4}[)）]|無料)?$/u.test(
    text,
  );
}

/** 3 文字未満の先頭は採らない (`映画『冬の華』` の「映画」) */
const MIN_HEAD = 3;

/**
 * 先頭の切れ端の終わりの「選」(NHK の再放送の印。`ダークサイドミステリー選　…` `美の壺選`)。
 * **「選」を外した切れ端が、ほかにもあるときだけ外す。** `名作選` `傑作選` のような語を壊さない
 */
function withoutSen(segments: string[], known: (key: string) => boolean) {
  const first = segments[0];
  if (first === undefined || segments.length < 2) return segments;
  const trimmed = first.trimEnd();
  if (!trimmed.endsWith("選") || [...trimmed].length < 2) return segments;
  const bare = trimmed.slice(0, -1);
  return known(keyOf(bare)) ? [bare, ...segments.slice(1)] : segments;
}

interface Node {
  /** 下を通った回の種類 (2 で頭打ち) */
  titles: number;
  kids: Map<string, Node>;
  /** ここで終わる名前の数 */
  ends: number;
  /** 下を通った行の数と、そのうち映画だけで次が `「` `『` のもの */
  rows: number;
  movieQuoted: number;
}

const node = (): Node => ({
  titles: 0,
  kids: new Map(),
  ends: 0,
  rows: 0,
  movieQuoted: 0,
});
const steady = (n: Node) => n.titles >= 2;

/** 採った先頭と、どこか 1 つの局で枠だったもの */
export interface Learned {
  heads: Set<string>;
  frames: Set<string>;
}

/** 学んでいる間に、何行ごとに手を離すか (`series-heads.relearn` が間にほかの処理を挟む) */
export const LEARN_STEP = 2000;

/**
 * **先頭を学ぶ。** `LEARN_STEP` 行ごとに yield する (呼ぶ側が間にほかの処理を挟む)。返す値は渡した行の順に依らない
 */
export function* learnSteps(
  rows: Iterable<SeriesRow>,
): Generator<void, Learned> {
  // 局ごとに、切れ端に分けた行
  const byStation = new Map<string, { row: SeriesRow; segments: string[] }[]>();
  let n = 0;
  for (const row of rows) {
    const list = byStation.get(row.station) ?? [];
    byStation.set(row.station, list);
    list.push({ row, segments: segmentsOf(row.series) });
    if (++n % LEARN_STEP === 0) yield;
  }

  const trees = new Map<string, Node>();
  const items: { station: string; row: SeriesRow; segments: string[] }[] = [];
  for (const [station, list] of byStation) {
    const firsts = new Set(
      list.map(({ segments }) => keyOf(segments[0] ?? "")),
    );
    const root = node();
    trees.set(station, root);
    for (const entry of list) {
      const segments = withoutSen(entry.segments, (key) => firsts.has(key));
      items.push({ station, row: entry.row, segments });
      let at = root;
      segments.forEach((segment, i) => {
        const key = keyOf(segment);
        const next = at.kids.get(key) ?? node();
        at.kids.set(key, next);
        next.titles = Math.min(2, next.titles + entry.row.titles);
        next.rows++;
        if (entry.row.movieOnly && /^[「『]/.test(segments[i + 1] ?? ""))
          next.movieQuoted++;
        at = next;
      });
      at.ends++;
      if (++n % LEARN_STEP === 0) yield;
    }
  }

  // 枠: 続いている子が 2 つ以上ある点。どこか 1 つの局で枠なら、どの局でも採らない
  const frames = new Set<string>();
  const walkFrames = (at: Node, prefix: string) => {
    let steadyKids = 0;
    for (const [key, kid] of at.kids) {
      if (steady(kid)) steadyKids++;
      walkFrames(kid, prefix + key);
    }
    if (prefix !== "" && steadyKids >= 2) frames.add(prefix);
  };
  for (const root of trees.values()) walkFrames(root, "");

  /**
   * 1 行をたどって、どこで切るか (切らなければ null)。`borrowed` は 1 回目に採った先頭。
   * 2 回目は、ほかの局で採った先頭なら、この局で分かれが 1 つでも切る
   */
  const cutOf = (
    item: (typeof items)[number],
    borrowed: ReadonlySet<string> | null,
  ): string | null => {
    let at = trees.get(item.station)!;
    let prefix = "";
    let raw = "";
    const { segments } = item;
    for (let k = 0; k < segments.length - 1; k++) {
      const segment = segments[k]!;
      at = at.kids.get(keyOf(segment))!;
      prefix += keyOf(segment);
      raw += segment;
      const child = at.kids.get(keyOf(segments[k + 1]!))!;
      if (steady(child)) continue;
      const branches = at.kids.size + (at.ends > 0 ? 1 : 0);
      if (branches < 2 && !(borrowed?.has(prefix) ?? false)) continue;
      if (frames.has(prefix)) continue;
      if (segments.slice(0, k + 1).every(isLabel)) continue;
      // 映画だけの番組の `「作品名」` の前では切らない (`シネマ「飢餓海峡」` `午後ロー「…」`)
      if (at.movieQuoted * 2 > at.rows) return null;
      if ([...keyOf(raw)].length < MIN_HEAD) return null;
      return prefix;
    }
    return null;
  };

  const first = new Set<string>();
  for (const item of items) {
    const cut = cutOf(item, null);
    if (cut !== null) first.add(cut);
    if (++n % LEARN_STEP === 0) yield;
  }
  const heads = new Set<string>();
  // 2 回目の結果を、当てる側 (いちばん長い先頭) が同じに出せるよう、切らない行の名前も足す
  const wholes: string[][] = [];
  for (const item of items) {
    const cut = cutOf(item, first);
    if (cut !== null) heads.add(cut);
    else {
      const keys = item.segments.map(keyOf);
      wholes.push(keys.map((_, i) => keys.slice(0, i + 1).join("")));
    }
    if (++n % LEARN_STEP === 0) yield;
  }
  for (const prefixes of wholes) {
    // 先頭が無い名前は足さなくても同じ。採った先頭の下にあるもの (`ＮＨＫニュース　おはよう日本`) だけ足す
    if (prefixes.slice(0, -1).some((prefix) => heads.has(prefix)))
      heads.add(prefixes[prefixes.length - 1]!);
  }
  return { heads, frames };
}

/** `learnSteps` を最後まで回す (単体テスト用。サーバは `series-heads.relearn` が間を空けて回す) */
export function learnHeads(rows: Iterable<SeriesRow>): Learned {
  const steps = learnSteps(rows);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}

/**
 * **この番組名のシリーズ名になりうる名前を全部** (`rules.seriesEpisodes` が録画の列を引く)。
 * `parseTitle` の作品名、枠の名前を外した名前 (`strictSeries`)、その切れ端ごとの先頭 (どの先頭を学んでいたときに
 * 録っても、列はこのどれかになる。「選」を外したものも)
 */
export function seriesNames(name: string): string[] {
  const parsed = parseTitle(name).series.trim();
  const strict = strictSeries(name);
  const names = new Set([parsed, strict]);
  const segments = segmentsOf(strict);
  for (const each of [segments, withoutSen(segments, () => true)]) {
    let raw = "";
    for (const segment of each) {
      raw += segment;
      names.add(raw.trim());
    }
  }
  return [...names].filter((each) => each !== "");
}

/**
 * **番組名をシリーズ名と残りに分ける。** シリーズ名は番組名から切り出した字のまま (全角は全角のまま)。
 * 採った先頭が無ければ `strictSeries` がそのままシリーズ名で、残りは空
 */
export function splitSeries(
  name: string,
  heads: ReadonlySet<string>,
): { series: string; rest: string } {
  const strict = strictSeries(name);
  const segments = withoutSen(segmentsOf(strict), (key) => heads.has(key));
  let prefix = "";
  let raw = "";
  let best: { series: string; rest: string } | null = null;
  segments.forEach((segment, k) => {
    prefix += keyOf(segment);
    raw += segment;
    if (heads.has(prefix))
      best = {
        series: raw.trim(),
        rest: segments
          .slice(k + 1)
          .join("")
          .replace(/^[\s　]+/, "")
          .trim(),
      };
  });
  return best ?? { series: strict, rest: "" };
}
