/**
 * **EDCB (EpgTimer) からの引き継ぎ。** EpgTimerSrv に TCP (CtrlCmd) で繋いでルール・手で入れた予約・
 * 録画済みの一覧を読み (`edcb-ctrlcmd.ts`)、denpa のルール・予約・録画の履歴に写す。
 * 入口は設定画面の「EDCB からの引き継ぎ」、使い方は docs/migrate.md。
 *
 * 進み具合・記録・走っている間の締め出しは EPGStation の引き継ぎと同じもの (`migrate.ts` の `track`) を使う。
 * 録画のファイルは持ってこない (CtrlCmd にファイルを送るコマンドは無く、ファイルの形式も denpa と違う)。
 * EDCB が重複の確認に使う履歴 (`RecInfo2.txt`) を返すコマンドも無いので、録画済みの一覧から消した回は移らない。
 *
 * 何度実行しても二重にはならない。ルールと履歴は `source` (`edcb:<ID>`・`edcb:recinfo:<キー>` など) で見分ける。
 * 値は設定フォルダのファイルを読んでいたころと同じなので、そのころ取り込んだものも飛ぶ
 */
import { eq } from "drizzle-orm";

import { parseSearchFields } from "#lib/search.js";

import { toHalfWidth } from "../fold";
import type { Slot } from "../rule-time";
import { now, orm } from "./db";
import {
  EdcbClient,
  type EdcbDate,
  type EdcbRecInfo,
  type EdcbReserve,
  type EdcbRule,
  parseTarget,
} from "./edcb-ctrlcmd";
import {
  addHistory,
  counts,
  insertRule,
  type MigrateOptions,
  record,
  recordCounts,
  recordPlan,
  ruleImported,
  running,
  serviceById,
  SlotWindows,
  track,
} from "./migrate";
import { reserve } from "./reservations";
import { programs } from "./schema";
import { programKey, serviceKey } from "./tuner";

/**
 * EDCB のジャンル1件を denpa の書き方 (`"7"` / `"7-0"`) に。写せないものは null。
 *
 * 値は `(大分類 << 24) | (中分類 << 16) | …` を符号付きで書いたもので、大分類が 0x80 以上だと負になる。
 * `>>> 0` で符号なしに戻してから分ける。中分類 0xFF は「その大分類の全部」。
 * 「ジャンル情報なし」(0xFF/0xFF) と拡張ジャンル (大分類 0x60〜0x7F) は denpa に当たるものが無い
 */
export function genreOf(value: number): string | null {
  const bits = value >>> 0;
  const major = bits >>> 24;
  const minor = (bits >>> 16) & 0xff;
  if (major > 0xf) return null;
  if (minor === 0xff) return String(major);
  return minor <= 0xf ? `${major}-${minor}` : null;
}

/** 時間帯と曜日を写した結果 ({@link parseDateList}) */
export type DateListResult =
  | {
      slot: Slot;
      /** 日をまたぐ時間帯で、次の日の曜日も足した (当たる番組が増える) */
      widened: boolean;
    }
  | { skip: string };

const DAY_MINUTES = 24 * 60;

/**
 * EDCB の時間帯と曜日 (`EPGDB_SEARCH_DATE_INFO` の並び) を denpa の時間帯と曜日 (`rule-time.ts`) に。
 *
 * EDCB は番組の始まる時刻が、週の頭からの分で `開始 ≤ 始まる時刻 ≤ 終了` なら当たる (**両端を含む**)。
 * どれか1件に入れば当たる。denpa は `time_from` 以上 `time_to` 未満なので:
 *
 * - **同じ曜日の中** (月 20:00〜月 21:30) → `time_to` を1分後ろにする (20:00〜21:31)。23:59 までなら 0:00 になり、
 *   denpa では「その時刻から日の終わりまで」と同じ。0:00〜23:59 は丸一日なので時刻では絞らない
 * - **次の日にまたぐ** (月 23:00〜火 01:00) → 23:00〜01:01。denpa は日をまたぐ時間帯も**始まる日の暦の曜日**で
 *   見るので、そのままだと火曜の 0〜1 時が外れる。**次の日の曜日も足す** (月・火)。当たる番組は増える
 *   (月曜の 0〜1 時と火曜の 23 時台) ので、記録に残す。曜日が7日そろえば EDCB と同じになる
 * - 2日以上にわたるもの (日 0:00〜土 23:59 のような「期間で指定」) → 0:00 に始まり 23:59 に終わるなら、
 *   その曜日を全部の日として写す。途中から始まる・途中で終わるものは写せない
 *
 * denpa のルールは時間帯を1つしか持てないので、時刻の同じものは曜日をまとめ、時刻の違うものが残れば写せない。
 * 範囲を外れた値は丸める (EDCB も丸めて使う)
 */
export function parseDateList(dates: readonly EdcbDate[]): DateListResult {
  const windows = new SlotWindows();
  const add = windows.add.bind(windows);
  const starts = new Set<number>();
  let crossing = false;
  for (const date of dates) {
    const startDay = date.startDay % 7;
    const endDay = date.endDay % 7;
    const clock = (hour: number, minute: number) =>
      (hour % 24) * 60 + (minute % 60);
    const from = clock(date.startHour, date.startMinute);
    const until = clock(date.endHour, date.endMinute);
    const span = (endDay - startDay + 7) % 7;
    starts.add(startDay);
    if (span === 0 && from <= until) {
      if (from === 0 && until === DAY_MINUTES - 1) add(null, null, [startDay]);
      else add(from, (until + 1) % DAY_MINUTES, [startDay]);
    } else if (span === 1 && until < from) {
      crossing = true;
      add(from, until + 1, [startDay, (startDay + 1) % 7]);
    } else if (from === 0 && until === DAY_MINUTES - 1 && span > 0) {
      add(
        null,
        null,
        Array.from({ length: span + 1 }, (_, i) => (startDay + i) % 7),
      );
    } else {
      return { skip: "2日以上にわたる時間帯は取り込めません" };
    }
  }
  const slot = windows.slot();
  if (slot === null)
    return { skip: "時刻の違う時間帯が2つ以上あるので取り込めません" };
  return { slot, widened: crossing && starts.size < 7 };
}

/** andKey の頭の印を外す。印は `^!{999}` (無効)・`C!{999}` (大小を区別)・`D!{1MMMMNNNN}` (番組の長さ) の順に付く */
export function splitAndKey(andKey: string): {
  disabled: boolean;
  caseSensitive: boolean;
  duration: boolean;
  keyword: string;
} {
  let rest = andKey;
  const disabled = rest.startsWith("^!{999}");
  if (disabled) rest = rest.slice(7);
  const caseSensitive = rest.startsWith("C!{999}");
  if (caseSensitive) rest = rest.slice(7);
  const duration = /^D!\{1\d{8}\}/.test(rest);
  if (duration) rest = rest.slice(13);
  return { disabled, caseSensitive, duration, keyword: rest };
}

/** notKey の頭のメモ (`:note:` から最初の空白まで) を外す。メモは検索に使わない */
export function stripNote(notKey: string): string {
  if (!notKey.startsWith(":note:")) return notKey;
  const at = notKey.search(/[ 　]/);
  return at < 0 ? "" : notKey.slice(at + 1);
}

/** 空白 (全角も) で区切った語 */
function wordsOf(text: string): string[] {
  return text
    .replaceAll("　", " ")
    .split(" ")
    .filter((word) => word !== "");
}

/** 語ごとに探す範囲を変える印 (`:title:` など) と、語ごとの正規表現 (`::`) */
const PER_WORD = /^(::|:(title|event|genre|video|audio):)/;

/** ルールに入れる値 ({@link convertRule}) */
export interface EdcbRuleValues {
  name: string;
  keyword: string;
  ignore_keyword: string;
  search_fields: string;
  service_ids: number[];
  genres: string[] | null;
  time_from: number | null;
  time_to: number | null;
  weekdays: number[] | null;
  enabled: boolean;
  dedupe: boolean;
}

export type ConvertedRule =
  { values: EdcbRuleValues; notes: string[] } | { skip: string };

/**
 * EDCB のルール1件を denpa のルールに。写せないものは `skip` に理由を、写したが意味が少し変わる
 * ものは `notes` に書く (どちらも記録に出す)。局は `serviceOf` で引く (ONID と SID。TSID は denpa に無い)。
 *
 * **局が空のルールは飛ばす。** EDCB は局の並びにある局の番組だけを探すので、局が空なら何にも当たらない。
 * denpa の「局が空 = 全局」とは逆になる
 */
export function convertRule(
  rule: EdcbRule,
  serviceOf: (networkId: number, serviceId: number) => number | undefined,
): ConvertedRule {
  const { disabled, caseSensitive, duration, keyword } = splitAndKey(
    rule.andKey,
  );
  if (rule.regExp) return { skip: "正規表現のルールは取り込めません" };
  if (duration) return { skip: "番組の長さの条件があるので取り込めません" };
  const words = wordsOf(keyword);
  const ignores = wordsOf(stripNote(rule.notKey));
  if (words.includes("|"))
    return { skip: "OR ( | ) で分けたキーワードは取り込めません" };
  if ([...words, ...ignores].some((word) => PER_WORD.test(word)))
    return {
      skip: "語ごとの範囲や正規表現の印 (:title: など) があるので取り込めません",
    };
  if (rule.notContent && rule.contents.length > 0)
    return { skip: "ジャンルの NOT は取り込めません" };
  if (rule.notDate && rule.dates.length > 0)
    return { skip: "時間帯の NOT は取り込めません" };
  if (rule.freeCA === 2)
    return { skip: "有料放送だけのルールは取り込めません" };

  const dates = parseDateList(rule.dates);
  if ("skip" in dates) return dates;

  if (rule.services.length === 0)
    return { skip: "局が空なので取り込めません (EDCB では何にも当たらない)" };
  const notes: string[] = [];
  const serviceIds = new Set<number>();
  const unknown: string[] = [];
  for (const { networkId, serviceId } of rule.services) {
    const id = serviceOf(networkId, serviceId);
    if (id === undefined) unknown.push(`${networkId}-${serviceId}`);
    else serviceIds.add(id);
  }
  if (serviceIds.size === 0)
    return { skip: "局が1つも見つからないので取り込めません" };
  if (unknown.length > 0)
    notes.push(`見つからない局を外しました (${unknown.join("・")})`);

  const genres = new Set<string>();
  let droppedGenres = 0;
  for (const content of rule.contents) {
    const genre = genreOf(content);
    if (genre === null) droppedGenres++;
    else genres.add(genre);
  }
  if (rule.contents.length > 0 && genres.size === 0)
    return { skip: "写せるジャンルが無いので取り込めません" };
  if (droppedGenres > 0)
    notes.push(
      `写せないジャンル (ジャンル情報なし・拡張ジャンル) を ${droppedGenres} 件外しました`,
    );

  const text = toHalfWidth(words.join(" ")).trim();

  if (rule.aimai) notes.push("あいまい検索は普通の検索として取り込みました");
  if (caseSensitive)
    notes.push("大文字と小文字の区別は普通の検索として取り込みました");
  const recording = rule.recMode >= 0 && rule.recMode <= 3;
  if (!disabled && !recording)
    notes.push("録画しないルールなので無効にして取り込みました");
  if (dates.widened)
    notes.push(
      "日をまたぐ時間帯は、次の日の曜日も足して取り込みました (当たる番組が増えます)",
    );

  return {
    values: {
      name: text !== "" ? text : `EDCB #${rule.id}`,
      keyword: text,
      ignore_keyword: toHalfWidth(ignores.join(" ")).trim(),
      // `:event:` は番組名 + 概要 + 詳細
      search_fields: parseSearchFields(
        rule.titleOnly ? "name" : "name,description,extended",
      ).join(","),
      service_ids: [...serviceIds],
      genres: genres.size === 0 ? null : [...genres],
      ...dates.slot,
      enabled: !disabled && recording,
      dedupe: rule.chkRecEnd,
    },
    notes,
  };
}

/** 局の内部ID。denpa の局に無ければ undefined */
function serviceOf(networkId: number, serviceId: number): number | undefined {
  return serviceById(serviceKey(networkId, serviceId))?.id;
}

/** 記録に出すルールの呼び名 */
function ruleLabel(rule: EdcbRule): string {
  const keyword = splitAndKey(rule.andKey).keyword.trim();
  return keyword === "" ? `#${rule.id}` : `#${rule.id} ${keyword}`;
}

/**
 * 同じキーのものを1つにまとめる (先に出たほうを残す)。同じ `source` を2回数えると、下見では2件、
 * 取り込みでは1件 (2件目は入らない) になって件数が食い違う
 */
function firstBy<T>(list: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of list)
    if (!seen.has(keyOf(item))) seen.set(keyOf(item), item);
  return [...seen.values()];
}

/** ルールを入れる。取り込み済みは `source` (`edcb:<ID>`) で見分けて飛ばす。同じ ID の行は先のものだけ */
export function importEdcbRules(
  list: EdcbRule[],
  options: MigrateOptions,
): void {
  const tally = counts().rules;
  for (const rule of firstBy(list, (item) => String(item.id))) {
    const source = `edcb:${rule.id}`;
    if (ruleImported(source)) {
      tally.skipped++;
      continue;
    }
    const converted = convertRule(rule, serviceOf);
    if ("skip" in converted) {
      record(`${converted.skip}: ${ruleLabel(rule)}`);
      tally.skipped++;
      continue;
    }
    const { values, notes } = converted;
    recordPlan(options, "ルール", values.name);
    for (const note of notes) record(`  ${note}: ${ruleLabel(rule)}`);
    tally.imported++;
    // 優先度 (EDCB の 1〜5) と録画の設定は写さない (`insertRule`)
    if (options.apply) insertRule({ ...values, service_types: null }, source);
  }
}

/**
 * 手で入れた予約を入れる。ルールが作った予約 (`EPG自動予約` で始まるコメント) は、ルールを入れれば
 * denpa が作り直すので触らない。番組は ONID・SID・event_id で引く (`programKey`。EPGStation と同じく番組の ID で予約する)
 */
export async function importEdcbReservations(
  list: EdcbReserve[],
  options: MigrateOptions,
): Promise<void> {
  const tally = counts().reservations;
  const at = now();
  const manual = list.filter((row) => !row.comment.startsWith("EPG自動予約"));
  if (manual.length < list.length)
    record(
      `ルールが作った予約 ${list.length - manual.length} 件は、ルールから作り直すので飛ばします`,
    );
  for (const row of manual) {
    const endAt = row.startAt === null ? null : row.startAt + row.duration;
    if (endAt === null || endAt <= at) {
      tally.skipped++;
      continue;
    }
    if (row.recMode < 0 || row.recMode > 3) {
      record(`録画しない予約は取り込めません: ${row.title}`);
      tally.skipped++;
      continue;
    }
    if (row.eventId === 0xffff) {
      record(
        `番組に結び付かない予約 (時刻だけの予約) は取り込めません: ${row.title}`,
      );
      tally.skipped++;
      continue;
    }
    const program = orm()
      .select({ id: programs.id })
      .from(programs)
      .where(
        eq(programs.id, programKey(row.networkId, row.serviceId, row.eventId)),
      )
      .get();
    if (program === undefined) {
      // 番組表を集める前だと出る。集めてからもう一度実行すれば入る
      record(`番組表に無いので取り込めません: ${row.title}`);
      tally.skipped++;
      continue;
    }
    if (options.apply) {
      try {
        await reserve(program.id);
      } catch (error) {
        record(
          `予約できません: ${row.title} (${error instanceof Error ? error.message : String(error)})`,
        );
        tally.skipped++;
        continue;
      }
    }
    recordPlan(options, "予約", row.title);
    tally.imported++;
  }
}

/** 正しく録れたものの recStatus (録画終了・次の予約のためにキャンセル・開始時間が変わった・空き不足で別フォルダへ) */
const RECORDED = new Set([1, 4, 6, 11]);

/**
 * 録画の履歴 (「録ったことのある回」`recorded_history`) を、録画済みの一覧のうち正しく録れたものから入れる。
 * 名前は予約の番組名、終わりは録画の開始 + 長さ (履歴は終わりの時刻を始まりの代わりに使う。`episode.Taken`)。
 *
 * キーは局 (ONID・TSID・SID) と EPG の開始。`source` は `edcb:recinfo:<キー>` で、前に `RecInfo2.txt` から
 * `edcb:recinfo2:<キー>` で取り込んだ回も飛ばす。局名は denpa の局から引き、無ければ EDCB の局名
 */
export function importEdcbHistory(
  recInfo: EdcbRecInfo[],
  options: MigrateOptions,
): void {
  const entries: Parameters<typeof addHistory>[0][] = [];
  for (const row of recInfo) {
    const at = row.epgStartAt ?? row.startAt;
    if (
      at === null ||
      row.startAt === null ||
      row.title === "" ||
      !RECORDED.has(row.recStatus)
    )
      continue;
    const key = `${row.networkId}-${row.transportStreamId}-${row.serviceId}-${at}`;
    entries.push({
      sources: [`edcb:recinfo:${key}`, `edcb:recinfo2:${key}`],
      name: row.title,
      serviceId: serviceKey(row.networkId, row.serviceId),
      serviceName: row.serviceName,
      endAt: row.startAt + row.duration,
    });
  }
  for (const entry of firstBy(entries, (item) => item.sources[0]))
    addHistory(entry, options);
}

/** EpgTimerSrv から読んだもの ({@link fetchEdcb}) */
interface EdcbLists {
  /** 記録に出す宛先 */
  label: string;
  recInfo: EdcbRecInfo[];
  autoAdd: EdcbRule[];
  reserve: EdcbReserve[];
  /** 読む間に出た警告 (ver の違い)。走り出してから記録に移す (`track` が記録を作り直すため) */
  notes: string[];
}

/** 3 つの一覧を読む。どれも数秒で返る。繋がらない・切られた・断られたら理由を投げる (`EdcbError`) */
async function fetchEdcb(input: string): Promise<EdcbLists> {
  const target = parseTarget(input);
  const notes: string[] = [];
  const client = new EdcbClient(target, (message) => {
    console.warn(message);
    notes.push(message);
  });
  const recInfo = await client.recInfos();
  const autoAdd = await client.autoAdds();
  const reserveList = await client.reserves();
  return {
    label: target.label,
    recInfo,
    autoAdd,
    reserve: reserveList,
    notes,
  };
}

/** 最後に入れられた宛先。画面の入力欄に戻す (メモリにだけ持つ。設定には書かない) */
let lastTarget: string | null = null;

export function edcbTarget(): string | null {
  return lastTarget;
}

/**
 * 引き継ぎを走らせる。順番は EPGStation と同じく録画の履歴 → ルール → 予約
 * (ルールが当たり出したときに、もう録った回を予約しないように)
 */
function runEdcb(lists: EdcbLists, options: MigrateOptions): Promise<void> {
  return track("edcb", options, async () => {
    record(
      `EpgTimerSrv (${lists.label}): 録画済み ${lists.recInfo.length} 件・ルール ${lists.autoAdd.length} 件・予約 ${lists.reserve.length} 件`,
    );
    for (const note of lists.notes) record(note);
    importEdcbHistory(lists.recInfo, options);
    importEdcbRules(lists.autoAdd, options);
    await importEdcbReservations(lists.reserve, options);
    recordCounts();
  });
}

/** 一覧を読んでいる間。二重に押されても1つしか走らせない */
let starting = false;

/**
 * 設定画面から呼ぶ入口。**先に 3 つの一覧を読み、繋がらなければその場で理由を返す**
 * (裏で走らせてから失敗にしない)。読めたら走り出したことだけ返す。
 * どちらかの引き継ぎが走っている間は断る (進み具合を1つしか持たないため)
 */
export async function startEdcb(
  input: string,
  options: MigrateOptions,
): Promise<{ started: boolean; message: string }> {
  if (running() || starting)
    return { started: false, message: "すでに実行中です" };
  const trimmed = input.trim();
  if (trimmed === "")
    return {
      started: false,
      message: "EpgTimerSrv の宛先を入れてください (例: 192.168.1.10:4510)",
    };
  lastTarget = trimmed;
  starting = true;
  let lists: EdcbLists;
  try {
    lists = await fetchEdcb(trimmed);
  } catch (error) {
    return {
      started: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    starting = false;
  }
  // 読んでいる間に EPGStation の引き継ぎが走り出していたら譲る
  if (running()) return { started: false, message: "すでに実行中です" };
  void runEdcb(lists, options);
  return {
    started: true,
    message: options.apply ? "取り込みを開始しました" : "下見を開始しました",
  };
}
