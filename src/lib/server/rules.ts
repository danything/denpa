import type { Genre } from "@danything/arib/eit";
import {
  and,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  ne,
  or,
} from "drizzle-orm";

import { genreMatches } from "#lib/arib.js";

import { globTerms, toHalfWidth } from "../fold";
import { hasTime, inTime, jstOf } from "../rule-time";
import { parseSearchFields, type SearchField } from "../search";
import type { Program, Rule } from "../types";
import { config } from "./config";
import { now, orm } from "./db";
import {
  type Airing,
  type Described,
  earlierAirings,
  episodeOf,
  firstAirings,
  type Known,
  type Skip,
  type Taken,
} from "./episode";
import {
  programs as programTable,
  recordedHistory,
  recordings,
  reservations,
  rules as ruleTable,
  services,
} from "./schema";
import { settings } from "./settings";
import { parseTitle, searchable, withoutSeason, withoutSlot } from "./title";

/** 空の並びは「指定なし」。NULL と同じに扱う */
function nonEmpty<T>(list: T[] | null): T[] | null {
  return list === null || list.length === 0 ? null : list;
}

/** 詳細は見出し付き。見出しごと繋いで、素のテキストとして探せるようにする */
function extendedText(extended: Record<string, string> | null): string {
  if (extended === null) return "";
  return Object.entries(extended)
    .map(([heading, body]) => `${heading} ${body}`)
    .join(" ");
}

/** 検索対象のテキスト */
export function haystack(
  program: Pick<Program, "name" | "description" | "extended">,
  fields: SearchField[],
): string {
  const parts = fields.map((field) =>
    field === "extended" ? extendedText(program.extended) : program[field],
  );
  return searchable(parts.join(" "));
}

/**
 * 判定が番組から読む列。**全列は要らない** — 下見 (`rule-preview.ts`) は
 * 読む列を絞って引くので、ここを `Program` にしていると渡せない
 */
export type Matchable = Pick<
  Program,
  "service_id" | "is_free" | "genres" | "genre_detail" | "start_at"
>;

/**
 * 番組のジャンル。中分類まで持っている genre_detail を使い、
 * 取り込みが古くて入っていないものは大分類だけの genres で代用する
 */
function parseGenreDetail(program: Matchable): Genre[] {
  return (
    nonEmpty(program.genre_detail) ??
    (program.genres ?? []).map((lv1) => ({ lv1, lv2: -1 }))
  );
}

/**
 * 判定に使う形式にほどいたルール。
 *
 * ほどく作業 (JSON の読み出し、キーワードの分割、全角の直し) を**ルール1つにつき
 * 1回**にするために分けてある。以前は判定のたびにやっていて、実機では
 * 有効なルール 318 × これから放送される番組 25,608 = **810万回**それをやっていた。
 * ルールを1つ足すだけで十数秒待たされていたのはこれが理由。
 */
interface CompiledRule {
  rule: Rule;
  services: number[] | null;
  types: string[] | null;
  genres: string[] | null;
  /** 時間帯 (0:00 からの分)。無ければ null (`rule-time.ts`) */
  time: { from: number; to: number } | null;
  /** 曜日 (0 が日曜)。毎日なら null */
  weekdays: number[] | null;
  fields: SearchField[];
  keywords: string[];
  ignores: string[];
}

export function compile(rule: Rule): CompiledRule {
  return {
    rule,
    services: nonEmpty(rule.service_ids),
    types: nonEmpty(rule.service_types),
    genres: nonEmpty(rule.genres),
    time: hasTime(rule) ? { from: rule.time_from, to: rule.time_to } : null,
    // 7日とも選んだものは毎日と同じ
    weekdays:
      rule.weekdays !== null && rule.weekdays.length < 7
        ? nonEmpty(rule.weekdays)
        : null,
    fields: parseSearchFields(rule.search_fields),
    // キーワードは空白区切りの AND。「アニメ 再放送」で両方含むものだけ当たる
    keywords: searchable(rule.keyword).split(/\s+/).filter(Boolean),
    // 除外キーワードは OR。1つでも当たれば落とす
    ignores: searchable(rule.ignore_keyword).split(/\s+/).filter(Boolean),
  };
}

/**
 * SQL の `GLOB` で候補を減らすための形式。**減らすだけで、当てるのは `matchesCompiled`。**
 *
 * 下見 (`rule-preview.ts`) はこれから放送される番組を全部引いて JS で絞っていた。
 * 実データ相当 (33,000 件) で全列を読むだけで 330〜400ms、条件が1語でも同じだけ
 * かかる。番組名に `GLOB '*語*'` を掛ければ当たった行だけ読める。
 *
 * **必ず含むはずの語だけ使う。** キーワードは空白区切りの AND なので、1語でも
 * 含まない番組は当たらない — SQL で落としても結果は変わらない。ただし
 *
 * - `extended` (詳細説明) は JSON のまま入っているので、検索範囲がそこまで及ぶときは
 *   SQL では当てない (null を返す)
 * - 番組名と概要は放送のとおり全角混じりで、語は半角に寄せてある。英数・記号は1字ごとに
 *   全角と大文字も並べた組 (`[ｖＶvV]`) にして当てる (`fold.globTerms`)。組を作れない
 *   大文字小文字を持つ非 ASCII の字 (キリル文字など) を含む語は使わない
 * - 外字は規格の字 (𠮷 🈟) のまま入っていて、語のほうは昔の書き方 (吉 [新]) に
 *   寄せてある (`fold.ts`)。寄せた字が絡む所は抜き、残りの切れ端を当てる
 *
 * @returns `GLOB` に渡す形式 (`*語*`)。使えなければ null
 */
export function globPatterns(compiled: CompiledRule): string[] | null {
  if (compiled.fields.includes("extended")) return null;
  const patterns = globTerms(compiled.keywords);
  return patterns.length === 0 ? null : patterns;
}

/**
 * **ルールに当たらない理由** ({@link missOf})。下見の行に「なぜ録らないか」を書くのに使う。
 *
 * - `paid` 有料放送 (全体設定で無料放送だけにしているとき)
 * - `service` 局の条件から外れる
 * - `genre` ジャンルの条件から外れる
 * - `time` 始まる時刻が時間帯の外
 * - `weekday` 始まる時刻の曜日が条件の外
 * - `empty` 条件が何も無い (全番組に当たってしまうので当てない)
 * - `keyword` キーワードを含まない
 * - `ignore` 除外する言葉を含む
 */
export type Miss =
  | "paid"
  | "service"
  | "genre"
  | "time"
  | "weekday"
  | "empty"
  | "keyword"
  | "ignore";

/**
 * ほどいたルールに番組が当てはまらない理由。当てはまれば null。
 *
 * 検索用テキストは**関数で受け取る**。文字を作るのが一番高くつくので、
 * 局やジャンルで落ちる番組にはそもそも作らせない。
 * 同じ番組に何本ものルールを当てるときは、呼ぶ側が作ったものを使い回せる。
 *
 * **当てるのはここ1つ。** 予約を立てる (`applyRules`)・下見 (`rule-preview.ts`)・検索の
 * 「これからの放送」(`search.ts`) はどれもここを通る (`matchesCompiled` はその真偽)
 */
export function missOf(
  compiled: CompiledRule,
  program: Matchable,
  serviceType: string | undefined,
  freeOnly: boolean,
  textOf: (fields: SearchField[]) => string,
): Miss | null {
  if (freeOnly && !program.is_free) return "paid";

  const { services, types, genres, time, weekdays, keywords, ignores } =
    compiled;

  // 局の条件は「種別」と「個別の局」のOR。
  // 「地上波全部 + BS11だけ」のような指定ができるようにするため
  if (services !== null || types !== null) {
    const byService = services?.includes(program.service_id) ?? false;
    const byType =
      serviceType !== undefined && (types?.includes(serviceType) ?? false);
    if (!byService && !byType) return "service";
  }

  // ジャンルは "7"(大分類だけ)と "7-0"(中分類まで)の2通りで持つ。
  // 昔のルールは数値の配列だが、読み出し時に文字列へ揃えてある (schema.ts の strings)
  if (genres !== null) {
    const detail = parseGenreDetail(program);
    if (detail.length === 0) return "genre";
    if (!genreMatches(genres, detail)) return "genre";
  }

  // 全条件が空のルールは全番組にマッチしてしまうので無効扱いにする。時間帯と曜日は絞り込みで、それだけでは
  // その時間の全局を録ってディスクを埋めるので条件に数えない
  if (
    keywords.length === 0 &&
    services === null &&
    types === null &&
    genres === null
  )
    return "empty";

  // 時間帯と曜日は番組の始まる時刻を日本時間で見る。日をまたぐ時間帯も、曜日は始まる日の暦 (`rule-time.ts`)
  if (time !== null || weekdays !== null) {
    const start = jstOf(program.start_at);
    if (time !== null && !inTime(time.from, time.to, start.minutes))
      return "time";
    if (weekdays !== null && !weekdays.includes(start.weekday))
      return "weekday";
  }

  if (keywords.length === 0 && ignores.length === 0) return null;

  const text = textOf(compiled.fields);
  if (!keywords.every((k) => text.includes(k))) return "keyword";
  return ignores.some((k) => text.includes(k)) ? "ignore" : null;
}

/** ほどいたルールに番組が当てはまるか ({@link missOf} が理由を返さないか) */
export function matchesCompiled(
  compiled: CompiledRule,
  program: Matchable,
  serviceType: string | undefined,
  freeOnly: boolean,
  textOf: (fields: SearchField[]) => string,
): boolean {
  return missOf(compiled, program, serviceType, freeOnly, textOf) === null;
}

/**
 * ルールに番組が当てはまるか。1件だけ見るとき用 (いまはテストだけが使う。画面と予約は `matchesCompiled`)。
 *
 * 有料放送を対象にするかは全体設定なので、呼ぶ側が渡す
 * (ここで設定を読むと純粋関数でなくなり、テストから条件を作れない)。
 */
export function matches(
  rule: Rule,
  program: Program,
  serviceType?: string,
  freeOnly = true,
): boolean {
  return matchesCompiled(
    compile(rule),
    program,
    serviceType,
    freeOnly,
    (fields) => haystack(program, fields),
  );
}

/**
 * 番組1つぶんの検索用テキストを、対象範囲ごとに1度だけ作って使い回す。
 * ほとんどのルールは同じ範囲 (番組名だけ) を見るので、実際にはほぼ1回で済む。
 */
function textCache(program: Program): (fields: SearchField[]) => string {
  const cache = new Map<string, string>();
  return (fields) => {
    const key = fields.join(",");
    const text = cache.get(key) ?? haystack(program, fields);
    cache.set(key, text);
    return text;
  };
}

/** 録画・番組から作るルールの下書き (`prefillFrom`) */
export interface RulePrefill {
  keyword: string;
}

/** 録画・番組から読む分 */
interface RuleSource {
  name: string;
  service_id: number;
  genre_detail: Genre[] | null;
  /** 始まる時刻。ルールの時間帯と曜日に当てる (この放送をそのルールが録るか) */
  start_at: number;
}

/**
 * シリーズ名。**録画でもいまの番組名から切り出す** — 録画の `series` は録ったときの
 * 切り出し方のままで、`「東京リベンジャーズ」三天戦争編` のように鍵括弧ごと残っているものがある
 */
function seriesOf(source: Pick<RuleSource, "name">): string {
  return source.name.trim() === ""
    ? ""
    : withoutSeason(withoutSlot(parseTitle(source.name).series.trim()));
}

/**
 * **録画・番組から作るルールの下書き** (詳細の「ルールを作る」)。
 *
 * - キーワードは**シリーズ名**。話数・副題・`[新]`・期 (`Season 2`) を落とした名前なので、次の回にも次の期にも当たる。
 *   ルールのキーワードは空白で区切った語を**すべて含む**もので、引用の書き方は無い。
 *   シリーズ名は番組名の一部なので、空白で割れても同じ番組に当たる
 * - 局は絞らない。同じ回が別の局で流れても、ルールの「同じ回は最初の放送だけ」が
 *   いちばん早いものを選ぶ。局を絞ると、そちらで先に流れたときに遅いほうを待つことになる
 * - ジャンルは入れない (全ジャンル)。局によって付け方が揺れ、同じシリーズでも回によって
 *   違うことがあるので、絞ると録り逃す
 *
 * シリーズ名が読めなければ null (条件が何も無いので、ルールにならない)
 */
export function prefillFrom(source: RuleSource): RulePrefill | null {
  const keyword = seriesOf(source);
  return keyword === "" ? null : { keyword };
}

/**
 * **このシリーズを既に録っているルール。** 有効なものを先に返す。
 *
 * 当てるのは録れた回のタイトルではなく**シリーズ名だけ**。`[新]` で当たった第1話は
 * 「[新]」のルールにも当たるが、そのルールは第2話を録らない。
 * 次の回のタイトルに何が付くかは分からないので、いちばん素の名前で確かめる
 */
export function coveringRule(
  rules: Rule[],
  source: RuleSource,
  serviceType?: string,
): Rule | undefined {
  const name = seriesOf(source);
  if (name === "") return undefined;
  const future = { name, description: "", extended: null };
  const program = {
    service_id: source.service_id,
    is_free: true,
    genres: null,
    genre_detail: source.genre_detail,
    start_at: source.start_at,
  };
  return [...rules]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))
    .find((rule) =>
      matchesCompiled(compile(rule), program, serviceType, false, (fields) =>
        haystack(future, fields),
      ),
    );
}

/** 取り消し済みの放送に、番組が当たるかどうか */
interface Declined {
  has(
    program: Pick<Program, "name" | "start_at"> & { channel: string },
  ): boolean;
}

/**
 * 取り消した回と開始が 10 分以内なら同じ放送。延長や繰り下げで開始が少し動いても
 * 追いかけられ、同じ日の再放送 (1時間後など) は別の回として扱える
 */
const DECLINE_WINDOW = 10 * 60 * 1000;

/**
 * **人が取り消した放送。** 番組の id ではなく、**物理チャンネル + タイトル + 開始時刻**で持つ。
 *
 * 取り消しの記録は `reservations.program_id` (局 + event_id) に付いていて、ルールは
 * `INSERT OR IGNORE` がそれに当たることで「二度と立てない」を成り立たせていた。
 * ところが id が同じでなくなるケースが2つあり、どちらも実機で**取り消したはずの回が
 * 録れた**として出た。
 *
 * - **枝番違い。** 同じ放送が 23608 と 23609 の両方に載るとき、束ねが一時的に
 *   外れる (片方だけ延長が先に届く、タイトルがまだ違う) と、取り消していないほうの
 *   枝番に予約が無いので立つ。放送直前なら猶予 (`ruleRetractGrace`) の中で
 *   引っ込まず、そのまま録れる
 * - **event_id の変更。** 局が同じ番組を別の event_id で送り直すと、番組表の
 *   取り込みは重なる行を消して新しい id で入れる。取り消し行は古い id を指したまま
 *   残り、新しい id には予約が無いので立つ
 *
 * どちらも「同じ物理チャンネルで、同じタイトルが、同じ頃に始まる」ことは変わらないので、
 * そこで当てる。
 *
 * **システムの取り消しは含めない。** 選局できなくなった局の予約はシステムが
 * 取り消す (`epg.clearBelongings`、`canceled_by = 'system'`) が、それは「局が戻ったなら
 * 録る」でよい。列を足す前の行 (NULL) は人が押したものとして扱う。
 * 手動予約を人が取り消したぶんは含める — 今までも id が同じ限りルールを止めていたので、
 * その振る舞いを id が変わっても続けるだけ。
 */
export function canceledBroadcasts(at: number): Declined {
  const rows = orm()
    .select({
      channel: services.channel,
      name: reservations.name,
      start_at: reservations.start_at,
    })
    .from(reservations)
    .innerJoin(services, eq(services.id, reservations.service_id))
    .where(
      and(
        eq(reservations.state, "canceled"),
        gt(reservations.end_at, at),
        or(
          isNull(reservations.canceled_by),
          ne(reservations.canceled_by, "system"),
        ),
      ),
    )
    .all();
  /** 物理チャンネル + タイトル → 取り消した回 */
  const starts = Map.groupBy(
    rows.filter((row) => row.name !== ""),
    (row) => `${row.channel} ${row.name}`,
  );
  return {
    has(program) {
      return (starts.get(`${program.channel} ${program.name}`) ?? []).some(
        (row) => Math.abs(row.start_at - program.start_at) <= DECLINE_WINDOW,
      );
    },
  };
}

/**
 * 「録ってある回」として見る範囲。同じ回の再放送は**だいたい同じクールの内**に
 * 流れるので、それより昔の録画は読まない (毎回ぜんぶ読むと録画の数だけ重くなる)
 */
const TAKEN_WINDOW = 30 * 24 * 60 * 60 * 1000;

/**
 * **もう録ってある回** (`episode.firstAirings` の `taken`)。
 *
 * これが無いと、いちばん早い放送を録り終えた途端 (番組表の「これから」から
 * 抜けた途端)、次の再放送が「いちばん早い放送」に繰り上がって録れてしまう。
 *
 * **失敗した録画は数えない** — 再放送は録り直す好機。消したものは数える
 * (観て消したものをまた録っても困る)
 */
function recordedEpisodes(at: number): Taken {
  return takenOf(
    orm()
      .select(TAKEN_COLUMNS)
      .from(recordings)
      .where(
        and(
          gt(recordings.start_at, at - TAKEN_WINDOW),
          ne(recordings.state, "failed"),
        ),
      )
      .orderBy(recordings.start_at)
      .all(),
  );
}

/** 「録ってある回」として録画から読む列 */
const TAKEN_COLUMNS = {
  name: recordings.name,
  description: recordings.description,
  extended: recordings.extended,
  series_episode: recordings.series_episode,
  start_at: recordings.start_at,
  service_name: recordings.service_name,
};

/** 録画の行を回に。番組表の番組と同じ読み方をする (録画は録ったときのタイトル・概要・詳細を持っている) */
function takenOf(
  rows: {
    name: string;
    description: string;
    extended: Record<string, string> | null;
    series_episode: number | null;
    start_at: number;
    service_name: string;
  }[],
): Taken {
  return rows.flatMap(({ start_at, service_name, ...described }) => {
    const episode = episodeOf(described);
    return episode === null ? [] : [{ episode, start_at, service_name }];
  });
}

/**
 * **よそから引き継いだ録画の履歴** (`schema.recordedHistory`)。EPGStation や EDCB で録った回を denpa が
 * また録らないように、録ってある回に足す。引き継いだときから増えないので、期間で切らずに全部読む
 * (引き継ぎのあとに来る一挙放送は、前の回を録ってから何か月も先のことがある)
 */
function historyEpisodes(): Taken {
  const rows = orm()
    .select({
      name: recordedHistory.name,
      end_at: recordedHistory.end_at,
      service_name: recordedHistory.service_name,
    })
    .from(recordedHistory)
    .all();
  return rows.flatMap(({ name, end_at, service_name }) => {
    // 履歴はタイトルしか持たない。始まりの時刻も無いので、終わりの時刻を入れる
    const episode = episodeOf({ name, description: "", extended: null });
    return episode === null
      ? []
      : [{ episode, start_at: end_at, service_name }];
  });
}

/**
 * **当たった放送と同じシリーズの録画** (「前の回は録らない」の相手。`episode.earlierAirings`)。
 * **期間で切らない** — 1期を数か月前に録り終え、2期の頃に別の局で1期が流れる、を外したい。
 * 全部の録画を読むと録画の数だけ重くなるので、当たった放送のシリーズ名 (`recordings.series`。
 * 録るときに `parseTitle` で入れたもの) で引く (索引 `recordings_series`)。全角・半角のどちらで
 * 入っていても当たるよう両方で引き、同じシリーズかは `earlierAirings` が回の読み方で決める。
 * 失敗した録画は数えない。消したもの (行が残っている間) は数える
 */
function seriesEpisodes(list: readonly Described[]): Taken {
  const names = new Set<string>();
  for (const { name } of list) {
    names.add(parseTitle(name).series);
    names.add(parseTitle(toHalfWidth(name)).series);
  }
  const taken: Taken = [];
  // SQLite の引数の数には上限がある。シリーズ名は多くても数百なので、刻んで引く
  const all = [...names];
  for (let i = 0; i < all.length; i += 500) {
    taken.push(
      ...takenOf(
        orm()
          .select(TAKEN_COLUMNS)
          .from(recordings)
          .where(
            and(
              inArray(recordings.series, all.slice(i, i + 500)),
              ne(recordings.state, "failed"),
            ),
          )
          .all(),
      ),
    );
  }
  return taken;
}

/**
 * **予約してある回** (「前の回は録らない」の相手。`episode.earlierAirings`)。録り始めたものは録画の行
 * ({@link seriesEpisodes}) にいるので入れない。録らない予約 (チューナー不足の `conflict`、コピー禁止の `skipped`) と
 * 取り消しも入れない — 録らない6話のせいで、別の局の5話まで外さない
 */
function reservedEpisodes(at: number): Known {
  const rows = orm()
    .select({
      name: reservations.name,
      description: reservations.description,
      start_at: reservations.start_at,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.state, "scheduled"),
        isNull(reservations.started_at),
        gt(reservations.end_at, at),
      ),
    )
    .all();
  return rows.flatMap(({ start_at, ...described }) => {
    const episode = episodeOf({ ...described, extended: null });
    return episode === null ? [] : [{ episode, start_at }];
  });
}

/** チューナー不足で弾かれている番組。同じ回の次の放送で録る (`episode.firstAirings` の `blocked`) */
function blockedPrograms(): Set<number> {
  const rows = orm()
    .select({ id: reservations.program_id })
    .from(reservations)
    .where(eq(reservations.state, "conflict"))
    .all();
  return new Set(rows.map((row) => row.id));
}

/** 「録らない」を決めるのに渡す放送。番組表の行に局の種別を添えたもの */
type Candidate = Omit<Airing, "type"> & {
  service_type: string;
  copy_never: boolean;
};

/**
 * **同じ回の読み方で決める「録らない」** — ルールの「同じ回は最初の放送だけ」(`dedupe`。
 * `episode.firstAirings`) と「前の回は録らない」(`skip_earlier`。`episode.earlierAirings`)。
 * それぞれ、そのスイッチを入れたルールが当たった放送を渡す。録らない番組 → 理由。
 * 予約を立てるとき (`applyRules`) と下見 (`rule-preview.ts`) で同じものを使う
 */
function episodeSkips<T extends Candidate>(
  lists: { dedupe: T[]; earlier: T[] },
  at: number,
): {
  dedupe: Map<number, Skip<T & Airing>>;
  earlier: Map<number, Skip<T & Airing>>;
} {
  if (lists.dedupe.length === 0 && lists.earlier.length === 0)
    return { dedupe: new Map(), earlier: new Map() };
  // 録画は、同じ回は直近だけ (`recordedEpisodes`)、前の回は同じシリーズを期間で切らずに (`seriesEpisodes`)
  const history = historyEpisodes();
  const typed = (list: T[]) =>
    list.map((program) => ({ ...program, type: program.service_type }));
  /*
   * **コピー禁止の放送も弾かれているのと同じ。** 録らないので、同じ回の次の放送 (禁止でない局) を録る
   * (`format.COPY_NEVER_REASON`)。前の回の相手にもしない (録らない6話のせいで、別の局の5話まで外さない)
   */
  const blocked = blockedPrograms();
  for (const program of [...lists.dedupe, ...lists.earlier])
    if (program.copy_never) blocked.add(program.id);
  return {
    dedupe:
      lists.dedupe.length === 0
        ? new Map()
        : firstAirings(typed(lists.dedupe), blocked, [
            ...recordedEpisodes(at),
            ...history,
          ]),
    earlier:
      lists.earlier.length === 0
        ? new Map()
        : earlierAirings(
            typed(lists.earlier),
            [
              ...seriesEpisodes(lists.earlier),
              ...history,
              ...reservedEpisodes(at),
            ],
            blocked,
          ),
  };
}

/**
 * 下見 (`rule-preview.ts`) の「録らない」({@link episodeSkips})。人が取り消した放送は `applyRules` も
 * 立てないので、「最初の放送」の候補に入れない。両方当たるなら同じ回のほう (`repeat` / `recorded`) を返す
 */
export function previewSkips<T extends Candidate & { service_channel: string }>(
  hits: T[],
  at: number,
  rule: Pick<Rule, "dedupe" | "skip_earlier">,
): Map<number, Skip<T & Airing>> {
  const declined = canceledBroadcasts(at);
  const list = hits.filter(
    (p) => !declined.has({ ...p, channel: p.service_channel }),
  );
  const { dedupe, earlier } = episodeSkips(
    {
      dedupe: rule.dedupe ? list : [],
      earlier: rule.skip_earlier ? list : [],
    },
    at,
  );
  return new Map([...earlier, ...dedupe]);
}

/**
 * 外れても引っ込めない予約か (下見の行に出す。猶予は `applyRules` と同じ)。手動のものと、もうすぐ始まる (猶予の内) もの。
 * 録り始めたものは予約の候補 (`started_at` が空) に入らないので、ここには来ない
 */
export function keepsReservation(
  held: { manual: boolean; start_at: number },
  at: number,
): boolean {
  return held.manual || held.start_at < at + config.ruleRetractGrace;
}

interface RuleSync {
  /** 新しく立てた予約 */
  created: number;
  /** どのルールにも当たらなくなって消した予約 */
  dropped: number;
  /** 別のルールが引き取った予約 */
  moved: number;
  /** ルールの優先度が変わって、付け替えた予約 */
  repriced: number;
}

/**
 * ルールを番組表に当て直して、予約をそろえる。
 *
 * **足すだけでなく、外れたものは消す。** 足すだけだった頃は、番組表が書き換わって
 * 条件から外れた予約がそのまま残り、消す手立てが画面の「取り消し」しか無かった。
 *
 * - 当たるのに予約が無い → **作る**
 * - 予約があるのに、どのルールにも当たらなくなった → **消す**
 * - 当てているルールが変わった (別のルールが引き取った) → **付け替える**
 *
 * **消すのであって「取り消し」にはしない。** 取り消しは*人が押したこと*の記録で、
 * ルールは二度と作り直さない (`INSERT OR IGNORE` と、放送単位で当てる
 * `canceledBroadcasts`)。番組表が動いただけのものを取り消しにすると、条件に
 * 戻ってきても永久に予約が立たなくなる。
 *
 * ### 引っ込めないもの
 *
 * 手違いで消すほうが、余分に録るより高くつく。次のどれかに当たるものは残す。
 *
 * - **手動の予約と、録り始めたもの** (`manual` / `started_at`)
 * - **人が取り消したもの。** 取り消しの記録はそのまま残す
 * - **番組表からその番組ごと消えているとき。** 「条件から外れた」のか
 *   「まだ読めていない」のか区別が付かない
 * - **タイトルが空の番組。** 放送が名前を出していないのではなく、こちらがまだ
 *   読めていないだけのことがある (実機で 23,000 件のうち 11,000 件がそうだった)
 * - **もうすぐ始まるもの** (`config.ruleRetractGrace`)。番組表は放送直前まで
 *   書き換わるので、そこで条件を外れても手遅れになるより録っておく。
 *   ただし**ルールごと消された/止められたぶんは、直前でも引っ込める** —
 *   そちらは人が押した結果なので迷う理由がない
 *
 * @param options.rule そのルールだけを当てる。**足すことしかしない。**
 *   ルールを足した直後用 — 新しいルールは他の予約を外すことができないので、
 *   全ルール × 全番組 (実機で 318 × 25,608) を回し直さずに済む
 */
export function applyRules(options: { rule?: number } = {}): RuleSync {
  const result: RuleSync = { created: 0, dropped: 0, moved: 0, repriced: 0 };
  const rules = orm()
    .select()
    .from(ruleTable)
    .where(eq(ruleTable.enabled, true))
    .all();
  const adding = options.rule !== undefined;
  if (rules.length === 0 && adding) return result;

  const at = now();
  // 録画のしかたは全体で1つ。ルールごとに持たせるとどこで決まったか分からなくなる
  const recording = settings();
  // 種別(GR/BS/CS)でも絞り込めるよう、番組に局の種別と物理チャンネルを添えて取る
  const programs = orm()
    .select({
      ...getTableColumns(programTable),
      service_type: services.type,
      channel: services.channel,
    })
    .from(programTable)
    .innerJoin(services, eq(services.id, programTable.service_id))
    .where(gt(programTable.start_at, at))
    .orderBy(programTable.start_at)
    .all();

  const compiled = rules.map(compile);
  const searching = adding
    ? compiled.filter((c) => c.rule.id === options.rule)
    : compiled;

  const declined = canceledBroadcasts(at);

  /**
   * 番組 → 受け持つルール。同じ番組に何本当たっても予約は1つで、**先勝ち**。
   * `matched` は当たったルールすべて (当たった順)。下の「同じ回は最初の放送だけ」「前の回は録らない」で
   * 外れたとき、そのスイッチを入れていないルールが受け持つ
   */
  const wanted = new Map<
    number,
    {
      rule: Rule;
      program: (typeof programs)[number];
      matched: Rule[];
    }
  >();
  /**
   * **同じ放送は1本だけ。** 同じ物理チャンネルの中で、同じ時刻に同じ番組名が
   * 流れていたら同じ放送とみなし、いちばん小さい局だけを残す。
   *
   * 局は分割放送のために枝番を持っていて (TOKYO MX なら 23608 / 23609、
   * どちらも名前は「TOKYO MX1」)、**分割していない間は同じ番組が両方に載る**。
   * 素通しにしていた実機では、同じ回が2本録れたうえに、2つのエンコードが
   * 同じ名前のファイルへ同時に書いて中身が壊れた。
   *
   * 中身が違うとき (MX1 と MX2 で別番組) はタイトルが違うので、両方残る。
   *
   * **終了時刻はキーに入れない。** 延長は枝番ごとに別々のタイミングで届く
   * (EIT p/f は局ごと) ので、片方だけ `end_at` が動いた回は「別の放送」に
   * 見えて両方が立っていた。開始とタイトルが同じなら同じ放送。
   */
  const simulcast = new Map<string, { serviceId: number; programId: number }>();
  for (const program of programs) {
    const textOf = textCache(program);
    // 先勝ちの持ち主のほかに、当たったルールを全部見る (下の dedupe / skip_earlier の受け手)
    const matched = searching
      .filter((candidate) =>
        matchesCompiled(
          candidate,
          program,
          program.service_type,
          recording.freeOnly,
          textOf,
        ),
      )
      .map((candidate) => candidate.rule);
    const owner = matched[0];
    if (owner === undefined) continue;
    /*
     * **人が取り消した放送には立てない。** 取り消しの記録は番組の id
     * (局 + event_id) に付いているので、`INSERT OR IGNORE` だけに頼ると
     * 枝番違いや event_id の変更ですり抜ける (上の `canceledBroadcasts`)
     */
    if (declined.has(program)) continue;
    const key = `${program.channel} ${program.start_at} ${program.name}`;
    const twin = simulcast.get(key);
    if (twin !== undefined) {
      // 枝番の小さいほうが本線 (MX1 なら 23608)。並び順に左右されないよう、
      // あとから小さいものが来たら入れ替える
      if (twin.serviceId <= program.service_id) continue;
      wanted.delete(twin.programId);
    }
    simulcast.set(key, {
      serviceId: program.service_id,
      programId: program.id,
    });
    wanted.set(program.id, { rule: owner, program, matched });
  }

  /*
   * **同じ回は最初の放送だけ** (ルールの `dedupe`) と **前の回は録らない** (`skip_earlier`)。
   * 同じ回は、局を替えた再放送・同時放送のうちいちばん早いものだけ残す (`episode.firstAirings`)。
   * 前の回は、先の回を録った・予約したあとに流れる前の話数を外す (`episode.earlierAirings`)。
   * 比べるのはそのスイッチのルールが当たった放送すべて — 持ち主が別のルールでも、録るならそれが
   * 「最初の放送」になる。外したものは、外したスイッチを入れていないルールも当たっていればそちらが
   * 受け持ち、無ければ予約を立てず、立っていれば下で引っ込む (番組表が動いたときと同じ扱い・同じ猶予)
   */
  const entries = [...wanted.values()];
  const skips = episodeSkips(
    {
      dedupe: entries
        .filter((entry) => entry.matched.some((rule) => rule.dedupe))
        .map(({ program }) => program),
      earlier: entries
        .filter((entry) => entry.matched.some((rule) => rule.skip_earlier))
        .map(({ program }) => program),
    },
    at,
  );
  for (const id of new Set([...skips.dedupe.keys(), ...skips.earlier.keys()])) {
    const entry = wanted.get(id)!;
    const keeper = entry.matched.find(
      (rule) =>
        !(rule.dedupe && skips.dedupe.has(id)) &&
        !(rule.skip_earlier && skips.earlier.has(id)),
    );
    if (keeper === undefined) wanted.delete(id);
    else entry.rule = keeper;
  }

  /** いまルールが立てている予約。手動と、録り始めたものは入らない */
  const held = adding
    ? []
    : orm()
        .select({
          id: reservations.id,
          program_id: reservations.program_id,
          rule_id: reservations.rule_id,
          priority: reservations.priority,
          start_at: reservations.start_at,
        })
        .from(reservations)
        .where(
          and(
            eq(reservations.manual, false),
            isNull(reservations.started_at),
            inArray(reservations.state, ["scheduled", "conflict", "skipped"]),
          ),
        )
        .all();
  /** 番組表にまだ載っている番組。読めていないだけのものと区別する */
  const listed = new Map(programs.map((program) => [program.id, program]));
  /** まだ生きているルール。消された/止められたぶんは猶予を置かずに引っ込める */
  const enabled = new Set(rules.map((rule) => rule.id));
  const grace = at + config.ruleRetractGrace;

  orm().transaction((tx) => {
    for (const { rule, program } of wanted.values()) {
      // 同じ番組の予約が既にあれば何もしない (INSERT OR IGNORE)。作れたときだけ行が返る
      const made = tx
        .insert(reservations)
        .values({
          program_id: program.id,
          rule_id: rule.id,
          service_id: program.service_id,
          name: program.name,
          description: program.description,
          start_at: program.start_at,
          end_at: program.end_at,
          priority: rule.priority,
          manual: false,
          encode: recording.encode,
          state: "scheduled",
          created_at: at,
          updated_at: at,
        })
        .onConflictDoNothing()
        .returning({ id: reservations.id })
        .get();
      if (made !== undefined) result.created++;
    }

    for (const reservation of held) {
      const owner = wanted.get(reservation.program_id);
      if (owner !== undefined) {
        /*
         * 別のルールが引き取ったなら付け替えるだけで、録るものは変わらない。
         *
         * **同じルールでも、優先度は当て直す。**
         *
         * 予約は `INSERT OR IGNORE` で立てるので、**もう立っている
         * ぶんは作った日の優先度のまま**だった。ルールの優先度を
         * 上げても効くのは次に立つ予約からで、いま競合している
         * 予約はいくら上げても負けたまま — 実機で、優先度2に
         * 上げた「片田舎のおっさん」が優先度1の裏番組に負け続けて
         * いた (予約側は3件とも1のまま)。
         *
         * 優先度はルールが持つものなので、こちらを本物として扱う
         */
        const moved = owner.rule.id !== reservation.rule_id;
        if (moved || owner.rule.priority !== reservation.priority) {
          tx.update(reservations)
            .set({
              rule_id: owner.rule.id,
              priority: owner.rule.priority,
              updated_at: at,
            })
            .where(eq(reservations.id, reservation.id))
            .run();
          if (moved) result.moved++;
          else result.repriced++;
        }
        continue;
      }
      const program = listed.get(reservation.program_id);
      // 番組表から消えているだけかもしれない。タイトルが空のものも判断材料にならない
      if (program === undefined || program.name === "") continue;
      // ルールが生きているのに外れた = 番組表が動いた。直前なら録っておく
      const byChurn =
        reservation.rule_id !== null && enabled.has(reservation.rule_id);
      if (byChurn && reservation.start_at < grace) continue;
      tx.delete(reservations).where(eq(reservations.id, reservation.id)).run();
      result.dropped++;
    }
  });
  return result;
}
