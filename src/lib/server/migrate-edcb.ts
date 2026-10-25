/**
 * **EDCB (EpgTimer) からの引き継ぎ。** 設定フォルダ (`Setting`) のテキストを読んで、
 * ルール (`EpgAutoAdd.txt`)・手で入れた予約 (`Reserve.txt`)・録画の履歴 (`RecInfo2.txt` と `RecInfo.txt`) を入れる。
 * 入口は設定画面の「EDCB からの引き継ぎ」、使い方は docs/migrate.md。
 *
 * 進み具合・記録・走っている間の締め出しは EPGStation の引き継ぎと同じもの (`migrate.ts` の `track`) を使う。
 * 録画のファイルは持ってこない (EDCB の録画フォルダは Windows の中にあり、ファイルの形式も denpa と違う)。
 *
 * ファイルの形式は EDCB の `ParseTextInstances.cpp` に合わせてある:
 *
 * - 1 行が 1 件、列はタブ区切り。値の中にタブと改行は入らない
 * - `;` で始まる行はコメント (`;;NextID=` のフッタも)。タブを含まない行は飛ばす
 * - 改行は `\r\n` か `\n`
 * - 数の列は `wcstol` で読むので、空や数でない値は 0。**後ろの列が無い古い行も、足りない列は 0 か空**として読む
 * - 文字コードは、頭に BOM があれば UTF-8、無ければ CP932 (Windows 用)。Unix 用は BOM が無くても UTF-8 なので、
 *   UTF-8 として正しく読めればそちらを取る ({@link decodeText})
 * - 時刻は日本時間の壁時計 (`YYYY/MM/DD` と `HH:MM:SS` を別の列に)
 *
 * 何度実行しても二重にはならない。ルールと履歴は `source` (`edcb:<ID>`・`edcb:recinfo2:<鍵>` など) で見分ける
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { parseSearchFields } from "#lib/search.js";

import { toHalfWidth } from "../fold";
import type { Slot } from "../rule-time";
import { now, orm } from "./db";
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

/** 読むファイル。Windows から写すと大文字小文字が変わることがあるので、探すときは区別しない ({@link settingFiles}) */
const EDCB_FILES = {
  autoAdd: "EpgAutoAdd.txt",
  reserve: "Reserve.txt",
  recInfo: "RecInfo.txt",
  recInfo2: "RecInfo2.txt",
} as const;

export type EdcbFiles = Partial<Record<keyof typeof EDCB_FILES, string>>;

/**
 * フォルダの中の EDCB のファイル。1つも無ければ null。
 *
 * `Setting` フォルダそのものを指されても、その上 (EDCB のフォルダ) を指されても読めるよう、
 * 指された場所に無ければ中の `Setting` を見る
 */
export function settingFiles(dir: string): EdcbFiles | null {
  for (const candidate of [dir, join(dir, "Setting")]) {
    let names: string[];
    try {
      if (!statSync(candidate).isDirectory()) continue;
      names = readdirSync(candidate);
    } catch {
      continue;
    }
    const byLower = new Map(names.map((name) => [name.toLowerCase(), name]));
    const found: EdcbFiles = {};
    for (const [key, name] of Object.entries(EDCB_FILES) as [
      keyof typeof EDCB_FILES,
      string,
    ][]) {
      const actual = byLower.get(name.toLowerCase());
      if (actual !== undefined) found[key] = join(candidate, actual);
    }
    if (Object.keys(found).length > 0) return found;
  }
  return null;
}

/**
 * ファイルの中身を文字にする。BOM があれば UTF-8、無ければ CP932。
 *
 * CP932 は `TextDecoder("shift_jis")` で読む。WHATWG の Shift_JIS は Windows の CP932 と同じ表
 * (NEC 特殊文字の `①`、`～` が U+FF5E になるところまで) なので、別の表は要らない。
 * BOM の無い UTF-8 (Unix 用の EDCB) は、UTF-8 として壊れずに読めるかで見分ける —
 * CP932 の日本語は UTF-8 としてはまず読めない (かなと漢字の1バイト目が UTF-8 の続きのバイトに当たる)
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** 行を列に分ける。コメント (`;` で始まる行。`;;NextID=` も) とタブの無い行は飛ばす */
export function rowsOf(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => !line.startsWith(";") && line.includes("\t"))
    .map((line) => line.split("\t"));
}

/** `wcstol` と同じく、読めなければ 0 */
function int(field: string | undefined): number {
  const value = Number.parseInt((field ?? "").trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

const JST = 9 * 60 * 60 * 1000;

/** `2026/10/25` と `21:00:00` (日本時間) を時刻に。読めなければ null */
export function jstAt(
  date: string | undefined,
  time: string | undefined,
): number | null {
  const d = (date ?? "").trim().match(/^(\d+)\/(\d+)\/(\d+)$/);
  const t = (time ?? "").trim().match(/^(\d+):(\d+):(\d+)$/);
  if (d === null || t === null) return null;
  return (
    Date.UTC(
      Number(d[1]),
      Number(d[2]) - 1,
      Number(d[3]),
      Number(t[1]),
      Number(t[2]),
      Number(t[3]),
    ) - JST
  );
}

/** 長さ `00:54:00` をミリ秒に。時の桁は 2 桁より増えることがある。読めなければ null */
function durationOf(text: string | undefined): number | null {
  const t = (text ?? "").trim().match(/^(\d+):(\d+):(\d+)$/);
  if (t === null) return null;
  return (Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) * 1000;
}

/** `,` 区切りの並び */
function listOf(field: string | undefined): string[] {
  return (field ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** `EpgAutoAdd.txt` の1行 (使う列だけ) */
export interface EdcbRule {
  id: number;
  andKey: string;
  notKey: string;
  regExp: boolean;
  titleOnly: boolean;
  /** ジャンル。符号付きの 32 ビットで書かれている ({@link genreOf}) */
  contents: number[];
  /** 時間帯と曜日 `曜-時分-曜-時分` ({@link parseDateList}) */
  dates: string[];
  /** 局 `(ONID << 32) | (TSID << 16) | SID` の 16 進 */
  services: string[];
  /** 0〜3 は録る、4 は視聴、5〜9 は「無効」(当たっても録らない予約を作る) */
  recMode: number;
  /** あいまい検索 */
  aimai: boolean;
  /** ジャンルの条件を NOT にする */
  notContent: boolean;
  /** 時間帯の条件を NOT にする */
  notDate: boolean;
  /** 0 = どちらでも、1 = 無料だけ、2 = 有料だけ */
  freeCA: number;
  /** 録ったことのある番組名なら予約を無効にする */
  chkRecEnd: boolean;
}

/**
 * `EpgAutoAdd.txt` を読む。列の位置は録画フォルダの数 (N、20 列目) と部分受信用フォルダの数
 * (M、28+N 列目) でずれる。ID が 0 か範囲外の行は EDCB も捨てる
 */
export function parseAutoAdd(text: string): EdcbRule[] {
  return rowsOf(text).flatMap((f) => {
    const id = int(f[0]);
    if (id <= 0 || id > 100_000_000) return [];
    const n = Math.max(0, int(f[19]));
    const m = Math.max(0, int(f[27 + n]));
    return [
      {
        id,
        andKey: f[1] ?? "",
        notKey: f[2] ?? "",
        regExp: int(f[3]) !== 0,
        titleOnly: int(f[4]) !== 0,
        contents: listOf(f[5]).map(int),
        dates: listOf(f[6]),
        services: listOf(f[7]),
        recMode: int(f[8]),
        aimai: int(f[23 + n]) !== 0,
        notContent: int(f[24 + n]) !== 0,
        notDate: int(f[25 + n]) !== 0,
        freeCA: int(f[26 + n]),
        chkRecEnd: int(f[28 + n + m]) !== 0,
      },
    ];
  });
}

/** `Reserve.txt` の1行 (使う列だけ) */
export interface EdcbReserve {
  startAt: number | null;
  duration: number | null;
  title: string;
  networkId: number;
  serviceId: number;
  /** 65535 は番組に結び付かない予約 (時刻だけで録る) */
  eventId: number;
  recMode: number;
  /** ルールが作った予約は `EPG自動予約` で始まる */
  comment: string;
}

export function parseReserve(text: string): EdcbReserve[] {
  return rowsOf(text).flatMap((f) => {
    const id = int(f[11]);
    if (id <= 0 || id > 100_000_000) return [];
    return [
      {
        startAt: jstAt(f[0], f[1]),
        duration: durationOf(f[2]),
        title: f[3] ?? "",
        networkId: int(f[5]),
        serviceId: int(f[7]),
        eventId: int(f[8]),
        recMode: int(f[12]),
        comment: f[16] ?? "",
      },
    ];
  });
}

/** `RecInfo.txt` の1行 (使う列だけ) */
export interface EdcbRecInfo {
  title: string;
  startAt: number | null;
  duration: number | null;
  serviceName: string;
  networkId: number;
  transportStreamId: number;
  serviceId: number;
  recStatus: number;
  /** 予約したときの番組の開始 (EPG の開始)。`RecInfo2.txt` の開始と同じもの */
  epgStartAt: number | null;
}

export function parseRecInfo(text: string): EdcbRecInfo[] {
  return rowsOf(text).map((f) => ({
    title: f[1] ?? "",
    startAt: jstAt(f[2], f[3]),
    duration: durationOf(f[4]),
    serviceName: f[5] ?? "",
    networkId: int(f[6]),
    transportStreamId: int(f[7]),
    serviceId: int(f[8]),
    recStatus: int(f[12]),
    epgStartAt: jstAt(f[13], f[14]),
  }));
}

/** `RecInfo2.txt` の1行。局名・長さは持っていない */
export interface EdcbRecInfo2 {
  networkId: number;
  transportStreamId: number;
  serviceId: number;
  /** EPG の番組の開始 (録画の開始ではない) */
  startAt: number | null;
  /** EPG のイベント名 */
  name: string;
}

export function parseRecInfo2(text: string): EdcbRecInfo2[] {
  return rowsOf(text).map((f) => ({
    networkId: int(f[0]),
    transportStreamId: int(f[1]),
    serviceId: int(f[2]),
    startAt: jstAt(f[3], f[4]),
    name: f[5] ?? "",
  }));
}

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
 * EDCB の時間帯と曜日 (`曜-時分-曜-時分` の並び) を denpa の時間帯と曜日 (`rule-time.ts`) に。
 *
 * EDCB は番組の始まる時刻が、週の頭からの分で `開始 ≤ 始まる時刻 ≤ 終了` なら当たる (**両端を含む**)。
 * 時分は `(時 << 16) | 分`。どれか1件に入れば当たる。denpa は `time_from` 以上 `time_to` 未満なので:
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
 * 読めない1件は飛ばす (EDCB も読めない値は数に直して丸めるだけで、壊れた行は作らない)
 */
export function parseDateList(dates: string[]): DateListResult {
  const windows = new SlotWindows();
  const add = windows.add.bind(windows);
  const starts = new Set<number>();
  let crossing = false;
  for (const date of dates) {
    const parts = date.split("-");
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part)))
      continue;
    const [sd, st, ed, et] = parts.map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const startDay = sd % 7;
    const endDay = ed % 7;
    const clock = (value: number) =>
      ((value >>> 16) % 24) * 60 + ((value & 0xffff) % 60);
    const from = clock(st);
    const until = clock(et);
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
  for (const hex of rule.services) {
    if (!/^[0-9a-fA-F]{1,12}$/.test(hex)) {
      unknown.push(hex);
      continue;
    }
    const value = Number.parseInt(hex, 16);
    const networkId = Math.floor(value / 2 ** 32) % 0x10000;
    const serviceId = value % 0x10000;
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
  // 局は必ず入っているのでここには来ないが、denpa の決まり (条件が空なら全番組に当たる) を崩さないように見ておく
  if (text === "" && serviceIds.size === 0 && genres.size === 0)
    return { skip: "条件が空になるので取り込めません" };

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
 * 同じ鍵のものを1つにまとめる (先に出たほうを残す)。同じ `source` を2回数えると、下見では2件、
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
    const endAt =
      row.startAt === null ? null : row.startAt + (row.duration ?? 0);
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
 * 録画の履歴 (「録ったことのある回」`recorded_history`) を入れる。
 *
 * - `RecInfo2.txt` (EDCB の重複の確認に使う履歴) を主にする。名前は EPG のイベント名。終わりの時刻を持たないので、
 *   `RecInfo.txt` に同じ局・同じ EPG の開始の行があればその録画の終わりを使い、無ければ開始の時刻で代える
 *   (履歴は終わりの時刻を始まりの代わりに使う。`episode.Taken`)
 * - `RecInfo.txt` (録画済みの一覧) のうち、正しく録れていて `RecInfo2.txt` に無いものも足す。名前は予約の番組名
 *
 * 鍵は局 (ONID・TSID・SID) と EPG の開始。`source` は `edcb:recinfo2:<鍵>` と `edcb:recinfo:<鍵>` で、
 * どちらかで取り込み済みなら飛ばす (`RecInfo2.txt` は件数で古いものから消えていくので、次の実行で
 * `RecInfo.txt` の側から同じ回をもう一度入れないように)。局名は denpa の局から引き、無ければ EDCB の局名
 */
export function importEdcbHistory(
  recInfo2: EdcbRecInfo2[],
  recInfo: EdcbRecInfo[],
  options: MigrateOptions,
): void {
  const keyOf = (
    row: { networkId: number; transportStreamId: number; serviceId: number },
    at: number,
  ) => `${row.networkId}-${row.transportStreamId}-${row.serviceId}-${at}`;
  const recorded = new Map<string, EdcbRecInfo>();
  for (const row of recInfo) {
    const at = row.epgStartAt ?? row.startAt;
    if (at === null || row.startAt === null || !RECORDED.has(row.recStatus))
      continue;
    recorded.set(keyOf(row, at), row);
  }

  const entries: Parameters<typeof addHistory>[0][] = [];
  const covered = new Set<string>();
  for (const row of recInfo2) {
    if (row.startAt === null || row.name === "") continue;
    const key = keyOf(row, row.startAt);
    covered.add(key);
    const match = recorded.get(key);
    entries.push({
      sources: [`edcb:recinfo2:${key}`, `edcb:recinfo:${key}`],
      name: row.name,
      serviceId: serviceKey(row.networkId, row.serviceId),
      serviceName: match?.serviceName ?? "",
      // `recorded` に入れたものは startAt を持っている
      endAt:
        match === undefined
          ? row.startAt
          : (match.startAt ?? row.startAt) + (match.duration ?? 0),
    });
  }
  for (const [key, row] of recorded) {
    if (covered.has(key) || row.title === "" || row.startAt === null) continue;
    entries.push({
      sources: [`edcb:recinfo:${key}`, `edcb:recinfo2:${key}`],
      name: row.title,
      serviceId: serviceKey(row.networkId, row.serviceId),
      serviceName: row.serviceName,
      endAt: row.startAt + (row.duration ?? 0),
    });
  }

  for (const entry of firstBy(entries, (item) => item.sources[0]))
    addHistory(entry, options);
}

/** ファイルを読んで文字にする。無ければ記録に残して null */
function readSetting(
  files: EdcbFiles,
  key: keyof typeof EDCB_FILES,
): string | null {
  const path = files[key];
  if (path === undefined) {
    record(`${EDCB_FILES[key]} が無いので飛ばします`);
    return null;
  }
  return decodeText(readFileSync(path));
}

/** 最後に指定されたフォルダ。画面の入力欄に戻す */
let lastDir: string | null = null;

export function edcbDir(): string | null {
  return lastDir;
}

/**
 * 引き継ぎを走らせる。順番は EPGStation と同じく録画の履歴 → ルール → 予約
 * (ルールが当たり出したときに、もう録った回を予約しないように)。テストからは終わるまで待てる
 */
export function runEdcb(
  files: EdcbFiles,
  options: MigrateOptions,
): Promise<void> {
  return track("edcb", options, async () => {
    const recInfo2 = readSetting(files, "recInfo2");
    const recInfo = readSetting(files, "recInfo");
    importEdcbHistory(
      recInfo2 === null ? [] : parseRecInfo2(recInfo2),
      recInfo === null ? [] : parseRecInfo(recInfo),
      options,
    );
    const autoAdd = readSetting(files, "autoAdd");
    if (autoAdd !== null) importEdcbRules(parseAutoAdd(autoAdd), options);
    const reserveText = readSetting(files, "reserve");
    if (reserveText !== null)
      await importEdcbReservations(parseReserve(reserveText), options);
    recordCounts();
  });
}

/**
 * 設定画面から呼ぶ入口。フォルダを確かめたら走り出したことだけ返す。
 * どちらかの引き継ぎが走っている間は断る (進み具合を1つしか持たないため)
 */
export function startEdcb(
  dir: string,
  options: MigrateOptions,
): { started: boolean; message: string } {
  if (running()) return { started: false, message: "すでに実行中です" };
  const trimmed = dir.trim();
  if (trimmed === "")
    return { started: false, message: "EDCB の設定フォルダを指定してください" };
  lastDir = trimmed;
  const files = settingFiles(trimmed);
  if (files === null)
    return {
      started: false,
      message: `${trimmed} に EDCB の設定ファイル (EpgAutoAdd.txt など) が見つかりません`,
    };
  void runEdcb(files, options);
  return {
    started: true,
    message: options.apply ? "取り込みを開始しました" : "下見を開始しました",
  };
}
