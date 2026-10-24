import { fail, redirect } from "@sveltejs/kit";

import { orm } from "#lib/server/db.js";
import { relative } from "#lib/server/paths.js";
import { deleteRule, toggleRule } from "#lib/server/rule-actions.js";
import { listRules, ruleSummary } from "#lib/server/rule-list.js";
import { services as serviceTable } from "#lib/server/schema.js";

/**
 * 書く欄の名前。前のルールの画面は `/rules?keyword=…` のように条件を URL に載せて書く欄を開いていた。
 * 書く欄は検索の画面 (`/search` の「ルールとして保存」) に移したので、同じ値を持ってそちらへ送る
 */
const FORM_KEYS = [
  "keyword",
  "ignoreKeyword",
  "searchFields",
  "serviceIds",
  "serviceTypes",
  "genres",
  "priority",
  "dedupe",
];

/**
 * **前の URL は検索の画面へ送る。** ブックマークや、前の版のホームの「ルールを作る」(`?recording=` / `?program=`)・
 * ルール名のリンク (`?edit=`) がそのまま効くように。今のリンクは送り先を直接指す
 *
 * - `?edit=<ID>` → `/search?rule=<ID>`
 * - `?program=<ID>` / `?recording=<ID>` → `/search?from=program:<ID>` / `from=recording:<ID>` (シリーズ名を言葉にして出直す)
 * - `?keyword=` など書く欄の値 → `/search?q=<キーワード>&…` (書く欄はその値で始まる)
 * - `?new` → `/search`
 */
function movedTo(params: URLSearchParams): string | null {
  if (params.has("edit"))
    return `/search?${new URLSearchParams({ rule: params.get("edit") ?? "" })}`;
  for (const kind of ["program", "recording"] as const) {
    if (params.has(kind))
      return `/search?${new URLSearchParams({ from: `${kind}:${params.get(kind)}` })}`;
  }
  if (FORM_KEYS.some((key) => params.has(key))) {
    const next = new URLSearchParams();
    const keyword = (params.get("keyword") ?? "").trim();
    if (keyword !== "") next.set("q", keyword);
    for (const key of FORM_KEYS)
      for (const value of params.getAll(key)) next.append(key, value);
    return `/search?${next}`;
  }
  if (params.has("new")) return "/search";
  return null;
}

/**
 * **ルールの一覧と管理** (`/rules`)。並べて見比べ、スイッチで止める・戻す、2回押しで消す。
 * 作る・直すのは検索の画面 (行を押すと `/search?rule=<ID>`)
 */
export function load({ url }) {
  const moved = movedTo(url.searchParams);
  if (moved !== null) redirect(303, relative(url, moved));

  // 条件の列に局の名前を出す。取り残しの局も含める (ルールが指している局は名前で出したい)
  const services = orm()
    .select({ id: serviceTable.id, name: serviceTable.name })
    .from(serviceTable)
    .all();
  return { rules: listRules(), summary: ruleSummary(), services };
}

/** フォームの `id` (ルール) */
function idOf(form: FormData): number | null {
  const id = Number(form.get("id"));
  return Number.isInteger(id) ? id : null;
}

export const actions = {
  /** 有効と無効を入れ替える (行のスイッチ) */
  toggle: async ({ request }) => {
    const id = idOf(await request.formData());
    if (id === null) return fail(400, { message: "ルールIDが不正です" });
    await toggleRule(id);
    return { success: true };
  },

  /** ルールを消す (行の削除。2回押し) */
  delete: async ({ request }) => {
    const id = idOf(await request.formData());
    if (id === null) return fail(400, { message: "ルールIDが不正です" });
    return { success: true, canceled: await deleteRule(id) };
  },
};
