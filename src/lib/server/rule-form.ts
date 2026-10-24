import { eq } from "drizzle-orm";

import { genreName } from "../arib";
import { SERVICE_TYPE_LABEL } from "../format";
import { parseSearchFields } from "../search";
import type { Rule } from "../types";
import { orm } from "./db";
import { coveringRule, prefillFrom, type RulePrefill } from "./rules";
import {
  programs,
  recordings,
  reservations,
  rules as ruleTable,
  services as serviceTable,
} from "./schema";

/**
 * **ルールの書く欄の読み取り** (検索の画面の「ルールとして保存」)。
 *
 * 画面から来る経路が2つある — 初期値 (録画・番組から作る、`?keyword=` を付けて来る) は
 * URL のクエリで、下見 (`?/preview`) と保存はフォームの POST で来る。どちらも `get` / `getAll` を持つ。
 * **下見も保存もここを通る** — 別々に読んでいた頃は、画面に出ている結果と保存されるものがズレた
 */
export interface Fields {
  get(key: string): unknown;
  getAll(key: string): unknown[];
}

/** 保存する形に直した条件。並びは**空なら NULL** (指定なし) にするところまでがここの仕事 */
export interface Conditions {
  keyword: string;
  ignoreKeyword: string;
  searchFields: string;
  serviceIds: number[] | null;
  serviceTypes: string[] | null;
  genres: string[] | null;
  /** 同じ回は最初の放送だけ録る (`rules.dedupe`)。送られてこなければ null (`dedupeOf`) */
  dedupe: boolean | null;
  /** 何も入っていない。全番組に当たってディスクを埋めるので、保存はさせない */
  empty: boolean;
}

/** 入力を条件として読む */
export function conditionsOf(fields: Fields): Conditions {
  const text = (key: string) => String(fields.get(key) ?? "").trim();
  const list = (key: string) => fields.getAll(key).map(String).filter(Boolean);
  const some = <T>(values: T[]) => (values.length === 0 ? null : values);

  const keyword = text("keyword");
  const ids = list("serviceIds").map(Number).filter(Number.isFinite);
  const types = list("serviceTypes");
  const genres = list("genres");
  return {
    keyword,
    ignoreKeyword: text("ignoreKeyword"),
    // 番組表から来たときは指定が無い。既定 (番組名だけ) に戻る
    searchFields: parseSearchFields(list("searchFields").join(",")).join(","),
    serviceIds: some(ids),
    serviceTypes: some(types),
    genres: some(genres),
    dedupe: dedupeOf(fields),
    empty:
      keyword === "" &&
      ids.length === 0 &&
      types.length === 0 &&
      genres.length === 0,
  };
}

/**
 * 「同じ回は最初の放送だけ」。フォームは**隠しの `0` とチェックの `1`** を両方送る
 * (外したチェックは何も送らないので、隠しが無いと「外した」と「指定なし」が
 * 区別できない)。
 *
 * **送られてこなければ null。** 新しく作るとき (下見・追加) は入れる。
 * **更新では今の値のまま** — 書く欄は必ず送るが、それ以外の経路から来た更新で、
 * 入れていないルールが黙って変わらないように
 */
function dedupeOf(fields: Fields): boolean | null {
  const sent = fields.getAll("dedupe").map(String);
  return sent.length === 0 ? null : sent.includes("1");
}

/**
 * 予約どうしを比べる数。**0 も受ける。**
 *
 * `Number(...) || 2` と書いていた頃は、0 を入れると既定に戻っていた
 * (`0 || 2` は 2)。「いちばん譲る」を選べないことになる。
 * 既定はルールの 1 で、手動予約はその上の 2。
 *
 * **空欄と 0 は別物。** `Number('')` は 0 なので、まとめて読むと**箱を空にした
 * だけで「いちばん譲る」に落ちる**。無ければ既定に戻す
 */
export function rulePriority(fields: Fields): number {
  const raw = fields.get("priority");
  if (raw === null || raw === undefined || raw === "") return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
}

/** 条件をルールの列にしたもの (`draftRule` と `ruleValues` で同じ) */
function columns(conditions: Conditions) {
  return {
    keyword: conditions.keyword,
    ignore_keyword: conditions.ignoreKeyword,
    search_fields: conditions.searchFields,
    service_ids: conditions.serviceIds,
    service_types: conditions.serviceTypes,
    genres: conditions.genres,
  };
}

/**
 * 入力中の条件を、保存していないルールとして組み立てる (下見に渡す形)。
 * 条件が空なら null (全番組に当たるだけなので数えない)
 */
export function draftRule(fields: Fields): Rule | null {
  const conditions = conditionsOf(fields);
  if (conditions.empty) return null;

  return {
    id: 0,
    name: "",
    ...columns(conditions),
    // 無料放送の扱いは**全体設定** (ルールには持たない)
    enabled: true,
    /*
     * **打ち込んだ値をそのまま持ち回る。** 1 で埋めていた頃は、下見を見るたびに優先度が 1 に
     * 戻っていた (見るだけのつもりで押して、そのまま保存すると静かに書き換わる)
     */
    priority: rulePriority(fields),
    dedupe: conditions.dedupe ?? true,
    source: null,
    created_at: 0,
  };
}

/**
 * ルール名はキーワードから決める。別で名前を付けさせても、結局キーワードと
 * 同じものを打ち込むだけになるため。キーワードが無いときは対象の局で表す。
 */
function ruleName(conditions: Conditions): string {
  if (conditions.keyword !== "") return conditions.keyword;

  const services = orm().select().from(serviceTable).all();
  const parts: string[] = [];
  if (conditions.genres !== null)
    parts.push(...conditions.genres.map(genreName));
  if (conditions.serviceTypes !== null) {
    parts.push(
      ...conditions.serviceTypes.map(
        (type) => SERVICE_TYPE_LABEL[type] ?? type,
      ),
    );
  }
  if (conditions.serviceIds !== null) {
    parts.push(
      ...conditions.serviceIds.map(
        (id) => services.find((s) => s.id === id)?.name ?? String(id),
      ),
    );
  }
  return parts.length === 0
    ? "名前の無いルール"
    : `${parts.slice(0, 3).join("・")}${parts.length > 3 ? " ほか" : ""}`;
}

/** 条件が空だと全番組にマッチしてディスクを埋めるので作らせない */
export const EMPTY_RULE =
  "キーワード・局・ジャンルのいずれかを指定してください";

/**
 * create と update で同じもの。**エンコード方式は書かない** — エンコードもCMも全体設定で、
 * エンコードするときに読む
 */
export function ruleValues(conditions: Conditions, form: Fields) {
  return {
    name: ruleName(conditions),
    ...columns(conditions),
    priority: rulePriority(form),
    // 送られてこなければ触らない (更新では今の値のまま。追加は呼ぶ側で入れる)
    ...(conditions.dedupe === null ? {} : { dedupe: conditions.dedupe }),
  };
}

/** 録画・番組からルールを作るときの元 (`originOf`) */
export interface Origin {
  kind: "recording" | "program";
  id: number;
  name: string;
  found: boolean;
  prefill: RulePrefill | null;
  rule: Rule | null;
}

/**
 * **録画・番組からルールを作るときの元** (詳細の「ルールを作る」)。
 * 検索の画面の `?from=recording:<録画ID>` か `?from=program:<番組ID>` (番組表・予約・録画の詳細から)。
 * `?program=` は検索の画面では番組の詳細を開く鍵なので、別の名前にしてある。
 *
 * 下書き (`rules.prefillFrom`) と、このシリーズを既に録っているルール
 * (`rules.coveringRule`) を一緒に引く。ルールがあれば作らせずにそちらを案内する —
 * 同じ番組のルールが2つあっても予約は1本だが、どちらを直せばいいか分からなくなる
 */
export function originOf(from: string | null): Origin | null {
  const match = (from ?? "").match(/^(recording|program):(-?\d+)$/);
  if (match === null) return null;
  const kind = match[1] as Origin["kind"];
  const id = Number(match[2]);
  const source = Number.isInteger(id)
    ? kind === "recording"
      ? recordingSource(id)
      : programSource(id)
    : undefined;
  if (source === undefined)
    return { kind, id, name: "", found: false, prefill: null, rule: null };
  const rules = orm().select().from(ruleTable).all();
  return {
    kind,
    id,
    name: source.name,
    found: true,
    prefill: prefillFrom(source),
    rule: coveringRule(rules, source, source.type ?? undefined) ?? null,
  };
}

/** 録画から読む分 */
function recordingSource(id: number) {
  return orm()
    .select({
      name: recordings.name,
      service_id: recordings.service_id,
      genre_detail: recordings.genre_detail,
      type: serviceTable.type,
    })
    .from(recordings)
    .leftJoin(serviceTable, eq(serviceTable.id, recordings.service_id))
    .where(eq(recordings.id, id))
    .get();
}

/**
 * 番組から読む分。**番組表の行が無ければ予約の行から** — 番組表は終わった番組を
 * 消していくが、予約の一覧には済んだものも残る。予約の行はジャンルを持たないので、
 * そのときの下書きはキーワードだけになる
 */
function programSource(id: number) {
  const program = orm()
    .select({
      name: programs.name,
      service_id: programs.service_id,
      genre_detail: programs.genre_detail,
      type: serviceTable.type,
    })
    .from(programs)
    .leftJoin(serviceTable, eq(serviceTable.id, programs.service_id))
    .where(eq(programs.id, id))
    .get();
  if (program !== undefined) return program;
  const reservation = orm()
    .select({
      name: reservations.name,
      service_id: reservations.service_id,
      type: serviceTable.type,
    })
    .from(reservations)
    .leftJoin(serviceTable, eq(serviceTable.id, reservations.service_id))
    .where(eq(reservations.program_id, id))
    .get();
  return reservation === undefined
    ? undefined
    : { ...reservation, genre_detail: null };
}
