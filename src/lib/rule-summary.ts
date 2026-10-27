import { genreName } from "./arib";
import { SERVICE_TYPE_LABEL, time } from "./format";
import { type Slot, slotSummary } from "./rule-time";
import { parseSearchFields, SEARCH_FIELD_LABEL } from "./search";
import { dayName } from "./timeline";

/**
 * **ルールの条件を1行で** (ルールの一覧の「条件」の列)。
 * 探す所 ・ 局 ・ ジャンル ・ 時間帯と曜日 ・ 同じ回は1度 ・ 前の回は録らない ・ 除外、の順。キーワードは名前の列に出ているので書かない
 */

interface Summarized extends Slot {
  search_fields: string;
  service_ids: number[] | null;
  service_types: string[] | null;
  genres: string[] | null;
  dedupe: boolean;
  skip_earlier: boolean;
  ignore_keyword: string;
}

/** 局の名前を引く。無ければ ID のまま */
export function conditionSummary(
  rule: Summarized,
  serviceName: (id: number) => string | undefined,
): string {
  const parts = [
    parseSearchFields(rule.search_fields)
      .map((field) => SEARCH_FIELD_LABEL[field])
      .join("・"),
  ];
  const stations = [
    ...(rule.service_types ?? []).map(
      (type) => SERVICE_TYPE_LABEL[type] ?? type,
    ),
    ...(rule.service_ids ?? []).map((id) => serviceName(id) ?? String(id)),
  ];
  parts.push(
    stations.length === 0
      ? "全局"
      : stations.length <= 2
        ? stations.join("・")
        : `${stations.slice(0, 2).join("・")} ほか ${stations.length - 2} 局`,
  );
  if (rule.genres !== null && rule.genres.length > 0)
    parts.push(rule.genres.map(genreName).join("・"));
  const slot = slotSummary(rule);
  if (slot !== null) parts.push(slot);
  if (rule.dedupe) parts.push("同じ回は1度");
  if (rule.skip_earlier) parts.push("前の回は録らない");
  if (rule.ignore_keyword.trim() !== "")
    parts.push(`除外: ${rule.ignore_keyword.trim()}`);
  return parts.join(" ・ ");
}

/**
 * 次の放送の日時。今日と明日は言葉で、それより先は月/日 (ルールの一覧の「次の放送」)。
 * 日付の切れ目は端末の時計 (画面で使う)
 */
export function upcomingLabel(at: number, now: number): string {
  const name = dayName(at, now);
  const d = new Date(at);
  const day =
    name === "今日" || name === "明日"
      ? name
      : `${d.getMonth() + 1}/${d.getDate()}`;
  return `${day} ${time(at)}`;
}
