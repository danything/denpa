import { fail, redirect } from "@sveltejs/kit";
import { and, eq, inArray } from "drizzle-orm";

import { now, orm } from "#lib/server/db.js";
import { currentServices, watchableServices } from "#lib/server/epg.js";
import { deleteRecordingFiles } from "#lib/server/files.js";
import { relative } from "#lib/server/paths.js";
import { recordingFromForm } from "#lib/server/recording.js";
import { cancel, reserve } from "#lib/server/reservations.js";
import {
  createRule,
  deleteRule,
  toggleRule,
  updateRule,
} from "#lib/server/rule-actions.js";
import { draftRule, originOf } from "#lib/server/rule-form.js";
import { previewFor } from "#lib/server/rule-preview.js";
import {
  programs,
  reservations,
  rules as ruleTable,
  services as serviceTable,
} from "#lib/server/schema.js";
import {
  searchPrograms,
  searchQuery,
  searchRecordings,
  searchReservations,
  searchRules,
} from "#lib/server/search.js";
import { settings } from "#lib/server/settings.js";

/** 画面が受け取る下見の形 (`rule-preview.ts`) */
export type { Preview, PreviewRow, Verdict } from "#lib/server/rule-preview.js";

/**
 * 1つの節に渡す上限。画面は先頭の数件だけ出し、「もっと見る」でここまで広げる。
 * これより多いときは件数だけ本当の数を出し、言葉を足してもらう
 */
const LIMIT = 100;

/**
 * `?program=<番組ID>` で開く番組。ヘッダーの候補 (`SearchField`) から番組や予約を選ぶと、
 * 結果の画面を開いてその番組の詳細を出す (番組表には番組を名指しで開く URL が無いため)
 */
function focusOf(url: URL) {
  const id = Number(url.searchParams.get("program"));
  if (!url.searchParams.has("program") || !Number.isInteger(id)) return null;
  return (
    orm()
      .select({
        id: programs.id,
        name: programs.name,
        description: programs.description,
        service_id: programs.service_id,
        service_name: serviceTable.name,
        start_at: programs.start_at,
        end_at: programs.end_at,
        copy_never: programs.copy_never,
        reservation_id: reservations.id,
      })
      .from(programs)
      .innerJoin(serviceTable, eq(serviceTable.id, programs.service_id))
      .leftJoin(
        reservations,
        and(
          eq(reservations.program_id, programs.id),
          inArray(reservations.state, ["scheduled", "conflict", "skipped"]),
        ),
      )
      .where(eq(programs.id, id))
      .get() ?? null
  );
}

/** 編集するルール (`?rule=<ID>`)。無ければ undefined */
function ruleById(raw: unknown) {
  const id = Number(raw);
  if (!Number.isInteger(id)) return undefined;
  return orm().select().from(ruleTable).where(eq(ruleTable.id, id)).get();
}

/**
 * **検索の結果** (`/search?q=`)。GET なので URL をそのまま人に渡せる。
 * 番組表・録画・予約・ルールを1度に引き、節ごとに件数と先頭を返す (`#lib/server/search.ts`)。
 *
 * **右の「ルールとして保存」もここ。** 言葉で探して、その場で条件を詰めてルールにする。
 *
 * - `?rule=<ID>` そのルールを書く欄に読み込んで直す (URL のまま人に渡せる・戻れる)
 * - `?from=program:<ID>` / `?from=recording:<ID>` 詳細の「ルールを作る」から。シリーズ名を言葉にして出直す
 * - `?keyword=` `?serviceIds=` など書く欄の名前 — その値で書く欄を始める (前のルールの画面のリンク)
 */
export function load({ url }) {
  const params = url.searchParams;
  const q = searchQuery(params.get("q"));

  const editing = params.has("rule") ? ruleById(params.get("rule")) : undefined;
  /*
   * **無いルールの `?rule=` は外して出直す。** 消したルールのリンクや古い履歴から来ると、直すつもりの欄が
   * 「新しいルール」に化けて、気づかずに別のルールを作ることになる
   */
  if (params.has("rule") && editing === undefined) {
    const rest = new URLSearchParams(params);
    rest.delete("rule");
    redirect(303, relative(url, `/search${rest.size === 0 ? "" : `?${rest}`}`));
  }

  const origin = originOf(params.get("from"));
  /*
   * 録画・番組から来て言葉が無ければ、**シリーズ名を言葉にして出直す**。結果の一覧がそのシリーズの
   * これからの放送になり、右の書く欄はその言葉から始まる。既にこのシリーズを録っているルールがあれば、
   * 書く欄の上にそちらへの入口を出す
   */
  if (origin?.prefill && q === "" && editing === undefined) {
    const next = new URLSearchParams(params);
    next.set("q", origin.prefill.keyword);
    redirect(303, relative(url, `/search?${next}`));
  }

  /*
   * 書く欄の初期値。編集ならそのルール。そうでなければ URL の書く欄の値で、キーワードが無ければ
   * 元の番組のシリーズ名か、探した言葉を入れる (探した言葉そのままでルールにできる)
   */
  const fields = new URLSearchParams(params);
  if (!fields.has("keyword"))
    fields.set("keyword", origin?.prefill?.keyword ?? q);
  const seed = editing ?? draftRule(fields);

  // 取り残しの局は選ばせない (currentServices)。もう録れない局が並ぶだけ
  const services = orm()
    .select({
      id: serviceTable.id,
      name: serviceTable.name,
      type: serviceTable.type,
    })
    .from(serviceTable)
    .where(currentServices())
    .orderBy(serviceTable.type, serviceTable.channel)
    .all();

  const options = { limit: LIMIT, count: true };
  return {
    q,
    programs: searchPrograms(q, options),
    recordings: searchRecordings(q, options),
    reservations: searchReservations(q, options),
    rules: searchRules(q, options),
    /** 詳細を開いておく番組 (`?program=`)。無ければ null */
    focus: focusOf(url),
    // 詳細の「視聴」を出すかどうか。決め方は番組表と揃えてある (watchableServices)
    watchable: watchableServices(now()),
    /** 右の書く欄 */
    draft: {
      editing: editing ?? null,
      seed,
      services,
      /** 録画・番組から作るとき、どれからか (`originOf`) */
      origin:
        origin === null
          ? null
          : {
              kind: origin.kind,
              id: origin.id,
              name: origin.name,
              found: origin.found,
              rule:
                origin.rule === null
                  ? null
                  : {
                      id: origin.rule.id,
                      name: origin.rule.name,
                      enabled: origin.rule.enabled,
                    },
            },
      /** 無料放送だけ録るか (全体設定)。書く欄の下に小さく出す */
      freeOnly: settings().freeOnly,
    },
  };
}

/** 書く欄の `id` (直すルール) */
function idOf(form: FormData): number | null {
  const id = Number(form.get("id"));
  return Number.isInteger(id) ? id : null;
}

export const actions = {
  /** 番組を予約する。録画のしかたは設定画面の1箇所で決める (番組表の予約と同じ) */
  reserve: async ({ request }) => {
    const form = await request.formData();
    const programId = Number(form.get("programId"));
    if (!Number.isFinite(programId))
      return fail(400, { message: "番組IDが不正です" });
    try {
      await reserve(programId);
    } catch (error) {
      return fail(400, { message: String(error) });
    }
    return { success: true };
  },

  /** 予約を取り消す。ルールが立てた予約でも作り直されない (戻すのはホームの「戻す」) */
  cancel: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get("reservationId"));
    if (!Number.isFinite(id)) return fail(400, { message: "予約IDが不正です" });
    await cancel(id);
    return { success: true };
  },

  /** 録画を消す (ホームの行の削除と同じ) */
  delete: async ({ request }) => {
    const recording = recordingFromForm(await request.formData());
    if (recording === undefined)
      return fail(400, { message: "録画が見つかりません" });
    deleteRecordingFiles(recording, "手動削除");
    return { success: true };
  },

  /**
   * **書く欄のいまの値で、何を録るか数える** (`rule-preview.previewFor`)。何も書き換えない。
   *
   * 画面が打ち直しのたびに少し待ってから送る。`ids` は結果の一覧に出している番組で、
   * 行ごとの「録る / 録らない (理由) / 予約済み」を返す。`edit` は直しているルール
   * (条件から外れたそのルールの予約も混ぜる)。条件が空なら数えない (全番組に当たるだけ)
   */
  preview: async ({ request }) => {
    const form = await request.formData();
    const conditions = draftRule(form);
    if (conditions === null) return { preview: null };
    const editing = form.has("edit") ? ruleById(form.get("edit")) : undefined;
    const ids = form
      .getAll("ids")
      .map(Number)
      .filter(Number.isInteger)
      .slice(0, LIMIT * 2);
    return { preview: await previewFor(conditions, { editing, ids }) };
  },

  /** 書く欄の値でルールを足す。足したら書く欄の下にそのルールへの入口を出す */
  createRule: async ({ request }) => {
    const saved = await createRule(await request.formData());
    if ("error" in saved) return fail(400, { message: saved.error });
    return { saved: { ...saved, created: true } };
  },

  /** 直しているルールを書く欄の値で更新する */
  updateRule: async ({ request }) => {
    const form = await request.formData();
    const id = idOf(form);
    if (id === null) return fail(400, { message: "ルールIDが不正です" });
    const saved = await updateRule(id, form);
    if ("error" in saved) return fail(400, { message: saved.error });
    return { saved: { ...saved, created: false } };
  },

  /** 直しているルールを止める・戻す */
  toggleRule: async ({ request }) => {
    const id = idOf(await request.formData());
    if (id === null) return fail(400, { message: "ルールIDが不正です" });
    await toggleRule(id);
    return { toggled: true };
  },

  /** 直しているルールを消す (2回押し)。消したら画面は `?rule=` を外して出直す */
  deleteRule: async ({ request }) => {
    const id = idOf(await request.formData());
    if (id === null) return fail(400, { message: "ルールIDが不正です" });
    return { deletedRule: { canceled: await deleteRule(id) } };
  },
};
