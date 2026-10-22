import {
  and,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Program, Rule } from "../types";
import { config } from "./config";
import { contentions, type Occupant, settled } from "./conflict";
import { now, orm } from "./db";
import {
  canceledBroadcasts,
  compile,
  globPatterns,
  haystack,
  keepsReservation,
  type Miss,
  missOf,
  previewSkips,
} from "./rules";
import { tunerState } from "./scheduler";
import { programs, reservations, services as serviceTable } from "./schema";
import { settings } from "./settings";

/**
 * **ルールの下見** — 書きかけの条件で、これからの放送の何を録るか。
 *
 * 判定は予約を立てるときと同じもの (`rules.missOf` と、同じ回をまとめる `rules.previewSkips`)。
 * 呼ぶのは検索の画面の「ルールとして保存」(`?/preview`)。**ここ以外で「録るかどうか」を
 * 組み立てない** — 画面ごとに組んでいた頃は、片方だけ直してズレた
 */

/**
 * 下見に出す、立っている予約。**録らないと決めたもの (コピー禁止の `skipped`) も出す** — 行に
 * 状態と取消を出すため。録らないので、予約数とチューナーの取り合いには数えない。
 * 放送が終わった `skipped` は履歴なので出さない (録り逃しには移さず残っている。`scheduler.tick`)
 */
const stillHeld = () =>
  and(
    inArray(reservations.state, ["scheduled", "conflict", "skipped"]),
    isNull(reservations.started_at),
    or(ne(reservations.state, "skipped"), gt(reservations.end_at, now())),
  );

/**
 * **録らない理由** (同じ回は最初の放送だけ。`episode.firstAirings`)。
 * `repeat` は同じ回を別の放送で録る (その放送の局と時刻)、`recorded` はもう録ってある。
 * `copy-never` はコピー禁止の番組 (`format.COPY_NEVER_REASON`)。`declined` は人が取り消した放送
 * (ルールは立て直さない。`rules.canceledBroadcasts`)
 */
export type Skip =
  | { kind: "repeat" | "recorded"; service_name: string; start_at: number }
  | { kind: "copy-never" | "declined" }
  | null;

/**
 * 「この条件で録れる番組」の1行。
 *
 * **予約と下見は同じ表に出す。** 別々に並べていた頃は、同じ番組が2箇所に
 * 出るうえ、「押さえている予約」と「これから当たる番組」を頭の中で突き合わせる
 * ことになっていた。1本の時系列にして、その番組がいまどうなっているかを行に書く。
 */
export interface PreviewRow {
  id: number;
  name: string;
  /** 詳細から「視聴」でライブへ飛ぶときの局。番組表の詳細と同じ */
  service_id: number;
  service_name: string;
  start_at: number;
  end_at: number;
  /** 立っている予約。取り消せるように id も持つ */
  reservation_id: number | null;
  reservation_state: string | null;
  /** いまの条件に当たるか。false なら「条件から外れたが予約は残っている」 */
  matched: boolean;
  /** チューナーを取り合う他の番組。**全部**入れる。取り合わなければ空 */
  conflicts: string[];
  /** スケジューラが既にチューナー不足と判断していれば、その理由 */
  conflict_reason: string | null;
  /** 録らない理由。録るなら null */
  skip: Skip;
}

/**
 * **頼まれた番組1つずつの「この条件で録るか」** (検索の結果の行に出す)。
 *
 * - `record` 録る
 * - `reserved` もう予約がある (手動・ほかのルール・この条件のどれでも)。保存しても変わらない
 * - `skip` 録らない。`reason` は {@link Skip} の kind か、条件に当たらない理由 (`rules.Miss`)、
 *   放送が始まっている (`airing`。ルールはこれから始まる放送にだけ予約を立てる)
 */
export type Verdict =
  | { kind: "record" }
  | { kind: "reserved"; state: string }
  | {
      kind: "skip";
      reason:
        "repeat" | "recorded" | "copy-never" | "declined" | "airing" | Miss;
    };

/**
 * 条件の下見ひとまとめ (`previewFor`)。
 *
 * `failed` は組めなかった理由。組めていれば null
 */
export interface Preview {
  total: number;
  /** 同じ回の2回目以降などで、録らないもの (`PreviewRow.skip`) */
  skipped: number;
  programs: PreviewRow[];
  conflicts: number;
  /** 頼まれた番組 (`options.ids`) の「録るか」。番組 ID → 結果 */
  verdicts: Record<number, Verdict>;
  failed: string | null;
}

interface Pending {
  id: number;
  rule_id: number | null;
  manual: boolean;
  program_id: number;
  name: string;
  service_id: number;
  service_name: string;
  /** チャンネル種別 (GR/BS/CS)。チューナーはこの単位で台数が決まる */
  type: string;
  /** 物理チャンネル。同じチャンネルなら1台のチューナーで足りる */
  channel: string;
  start_at: number;
  end_at: number;
  state: string;
  conflict_reason: string | null;
}

export interface PreviewOptions {
  /** 編集中のルール。条件から外れたのに残っている、そのルールの予約も混ぜる */
  editing?: Rule | undefined;
  /** 「録るか」を1つずつ知りたい番組 (検索の結果の行)。当たらないものは理由も返す */
  ids?: number[];
}

/**
 * 条件に当たる番組の下見。**いちばん重い。**
 *
 * これから先の番組を**全部**引いて JS で絞るので、実データでは番組表の
 * 24時間ぶんより重い。画面は書く欄を打ち直すたびに、少し待ってから呼ぶ (`?/preview`)。
 * 同じタブからは1つずつしか送らない (送っている間に変わったぶんは、返ってから最後の条件で1回)。
 *
 * **転んでも投げ返さない。** 理由を `failed` に入れて返す (画面は「数えられませんでした」と出す)
 */
export async function previewFor(
  conditions: Rule,
  options: PreviewOptions = {},
): Promise<Preview> {
  try {
    return { ...(await countPreview(conditions, options)), failed: null };
  } catch (error) {
    console.error("[rules] 下見を組めませんでした", error);
    return {
      total: 0,
      skipped: 0,
      programs: [],
      conflicts: 0,
      verdicts: {},
      failed: String(error),
    };
  }
}

/** 下見を数える本体。転んだら投げる (受け止めるのは `previewFor`) */
async function countPreview(
  conditions: Rule,
  { editing, ids = [] }: PreviewOptions,
): Promise<Omit<Preview, "failed">> {
  const defaults = settings();
  const at = now();
  /*
   * チューナーの台数。**スケジューラと同じところから取る。**
   * 取れなければ空 (= 何も競合として出さない)。エージェントが落ちているときに
   * 予約表を赤くしても直しようが無いので、スケジューラもそう振る舞う
   */
  const { capacity, busy } = await tunerState();
  // 使う区間は前後マージンぶん延びる。スケジューラと同じ物差しで数える
  const margins = { start: config.startMargin, end: config.endMargin };
  /** まだ録っていない予約。重なりの判定と、条件から外れた予約を出すのに使う */
  const pending: Pending[] = orm()
    .select({
      id: reservations.id,
      rule_id: reservations.rule_id,
      manual: reservations.manual,
      program_id: reservations.program_id,
      name: reservations.name,
      service_id: reservations.service_id,
      start_at: reservations.start_at,
      end_at: reservations.end_at,
      state: reservations.state,
      conflict_reason: reservations.conflict_reason,
      service_name: serviceTable.name,
      type: serviceTable.type,
      channel: serviceTable.channel,
    })
    .from(reservations)
    .innerJoin(serviceTable, eq(serviceTable.id, reservations.service_id))
    .where(stillHeld())
    .orderBy(reservations.start_at)
    .all();
  const reserved = new Map(pending.map((row) => [row.program_id, row]));

  // 条件のほどきは1回だけ。番組ごとにやり直すと、番組の数だけ JSON を読むことになる
  const compiled = compile(conditions);
  /*
   * **SQL で候補を減らしてから JS で当てる。** これから放送される全番組
   * (実データ相当で 33,000 件) を全列で読むだけで 330〜400ms かかり、条件が
   * 1語でもそれは同じだった。番組名 (と概要) に `GLOB` を掛ければ当たった
   * 行だけ読めて 33ms。当てるのは今までどおり `missOf` で、
   * SQL は「必ず含むはずの語」を落とすだけ (`globPatterns`)
   */
  const patterns = globPatterns(compiled);
  const columns = compiled.fields.includes("description")
    ? [programs.name, programs.description]
    : [programs.name];
  const narrowed = (patterns ?? []).map((pattern) =>
    or(...columns.map((column) => sql`${column} GLOB ${pattern}`)),
  );
  /*
   * **読む列も絞る。** 判定に要らない JSON 列 (音声 106KB、映像) は読まない。
   * 詳細説明は検索範囲に入っているときと、同じ回を見分けるとき (タイトルに話数・副題が無い局は
   * 概要・詳細から読む。`episode.episodeOf`) だけ。JSON 列の読み出しが 33,000 行ぶんで
   * 43ms あった
   */
  const {
    audios: _audios,
    video_type: _video,
    video_resolution: _resolution,
    extended,
    ...light
  } = getTableColumns(programs);
  const select = {
    ...light,
    extended:
      compiled.fields.includes("extended") || conditions.dedupe
        ? extended
        : sql<Program["extended"]>`NULL`,
    service_type: serviceTable.type,
    service_name: serviceTable.name,
    service_channel: serviceTable.channel,
  };
  const all = orm()
    .select(select)
    .from(programs)
    .innerJoin(serviceTable, eq(serviceTable.id, programs.service_id))
    .where(and(gt(programs.start_at, at), ...narrowed))
    .orderBy(programs.start_at)
    .all();
  // 判定が読むのは局・ジャンル・無料かどうか・検索範囲の文字だけ (`Matchable`。読まない列は上で外した)
  const missFor = (program: (typeof all)[number]) =>
    missOf(
      compiled,
      program,
      program.service_type,
      defaults.freeOnly,
      (fields) => haystack(program, fields),
    );
  const hits = all.filter((program) => missFor(program) === null);

  /*
   * **同じ回は最初の放送だけ。** 録らないものも行には出す (黙って消すと、
   * 条件が当たっていないのか、当たったうえで外したのか読めない)。
   * 選び方は予約を立てるときと同じもの (`rules.previewSkips`)
   */
  const skips: ReturnType<typeof previewSkips<(typeof hits)[number]>> =
    conditions.dedupe ? previewSkips(hits, at) : new Map();
  /**
   * **人が取り消した放送は録らない** (`applyRules` も立て直さない)。下見で「録る」と出して、
   * 保存しても予約が立たない、ということが無いように
   */
  const declined = canceledBroadcasts(at);
  const skipOf = (p: (typeof hits)[number]): Skip => {
    // コピー禁止の番組は録らない (`format.COPY_NEVER_REASON`)。手動でも同じ
    if (p.copy_never) return { kind: "copy-never" };
    if (declined.has({ ...p, channel: p.service_channel }))
      return { kind: "declined" };
    const skip = skips.get(p.id);
    if (skip === undefined) return null;
    return skip.kind === "repeat"
      ? {
          kind: "repeat",
          service_name: skip.first.service_name,
          start_at: skip.first.start_at,
        }
      : {
          kind: "recorded",
          service_name: skip.service_name,
          start_at: skip.start_at,
        };
  };

  /*
   * 重なりを数える相手。**立っている予約と、この条件で録れる番組の両方。**
   *
   * 予約としか比べていなかった頃は、保存前のルールでは重なりが1件も
   * 出なかった (比べる相手がまだいない)。同じ番組が両方に出てくるので、
   * 番組IDで1つにまとめる
   */
  const occupants = new Map<number, Occupant>();
  for (const p of hits) {
    // 録らないものはチューナーを取り合わない
    if (skipOf(p) !== null) continue;
    occupants.set(p.id, {
      programId: p.id,
      name: p.name,
      serviceName: p.service_name,
      type: p.service_type,
      channel: p.service_channel,
      start_at: p.start_at,
      end_at: p.end_at,
    });
  }
  for (const row of pending) {
    if (row.state === "skipped") continue;
    occupants.set(row.program_id, {
      programId: row.program_id,
      name: row.name,
      serviceName: row.service_name,
      type: row.type,
      channel: row.channel,
      start_at: row.start_at,
      end_at: row.end_at,
    });
  }
  const rows: PreviewRow[] = hits.map((p) => {
    const held = reserved.get(p.id) ?? null;
    return {
      id: p.id,
      name: p.name,
      service_id: p.service_id,
      service_name: p.service_name,
      start_at: p.start_at,
      end_at: p.end_at,
      reservation_id: held?.id ?? null,
      reservation_state: held?.state ?? null,
      matched: true,
      // 重なりは出す 100 件にだけ当てる (下)。スケジューラが既にチューナー
      // 不足と判断していれば、その理由も添える (何台足りないのかはあちらしか知らない)
      conflicts: [],
      conflict_reason:
        held?.state === "conflict"
          ? (held.conflict_reason ?? "チューナーが足りません")
          : null,
      // 引っ込めない予約 (手動・猶予の内) が立っているなら録る。「録らない」とは言わない
      skip:
        held !== null && keepsReservation(held, at) && !p.copy_never
          ? null
          : skipOf(p),
    };
  });

  /*
   * 条件から外れたのに残っている予約 (手動・猶予の内。`keepsReservation`) も同じ表に混ぜる
   */
  if (editing !== undefined) {
    const shown = new Set(rows.map((row) => row.id));
    for (const held of pending) {
      if (shown.has(held.program_id)) continue;
      if (held.rule_id !== editing.id) continue;
      rows.push({
        id: held.program_id,
        name: held.name,
        service_id: held.service_id,
        service_name: held.service_name,
        start_at: held.start_at,
        end_at: held.end_at,
        reservation_id: held.id,
        reservation_state: held.state,
        matched: false,
        conflicts: [],
        conflict_reason:
          held.state === "conflict"
            ? (held.conflict_reason ?? "チューナーが足りません")
            : null,
        skip: null,
      });
    }
  }
  rows.sort((a, b) => a.start_at - b.start_at);

  /*
   * **重なりは、出す 100 件にだけ当てる。**
   *
   * 重なりは**録ろうとした時点で初めて分かる**ので先に見せるのだが、当たった
   * 全部に当てていた頃は、ゆるい条件 (詳細まで・27,000 件) で 7.5 秒かかり、
   * その間サーバごと止まっていた (SQLite も判定も同期)。画面に出るのは先頭 100 件
   * だけなので、そこにだけ当てる。
   *
   * **比べる相手は、その 100 件が掛かる時間帯の全部と、そこから誰も使っていない瞬間まで
   * さかのぼったぶん** (`settled`)。出さない番組とも取り合うので相手は減らせない。どのチューナーに
   * 入るかはその前に誰がどのチューナーに入ったかで変わる (#668) ので、時間帯の頭からなぞると答えが
   * 変わる。誰も使っていない瞬間を挟めば振り出しに戻るので、そこより前と、時間帯より後は渡さない。
   *
   * 「競合 N 件」もその 100 件の中の数になる。画面ではそう書く
   */
  const shown = rows.slice(0, 100);
  const mine = shown.flatMap((row) =>
    row.skip === null ? (occupants.get(row.id) ?? []) : [],
  );
  const from = settled(
    occupants.values(),
    margins,
    Math.min(...mine.map((o) => o.start_at)) - margins.start,
  );
  const to = Math.max(...mine.map((o) => o.end_at)) + margins.end;
  const contended = contentions(
    [...occupants.values()].filter(
      (o) => o.start_at - margins.start < to && from < o.end_at + margins.end,
    ),
    capacity,
    margins,
    busy,
  );
  for (const row of shown) {
    if (row.skip === null) row.conflicts = contended.get(row.id) ?? [];
  }

  return {
    total: rows.length,
    skipped: rows.filter((row) => row.skip !== null).length,
    // 数えるのは**行の数**。1行に3本重なっていても、困っている番組は1つ
    conflicts: shown.filter(
      (row) => row.conflicts.length > 0 || row.conflict_reason !== null,
    ).length,
    programs: shown,
    verdicts: verdictsOf(ids),
  };

  /**
   * 頼まれた番組の「録るか」。**当たった番組の行 (`rows`) から読む** — 同じ回をまとめるのは
   * 当たった番組すべてで比べるので、頼まれた番組だけで組み直すと答えが変わる。
   * 当たらなかった番組だけ読み直して、当たらない理由 (`missOf`) を添える
   */
  function verdictsOf(wanted: number[]): Record<number, Verdict> {
    const out: Record<number, Verdict> = {};
    if (wanted.length === 0) return out;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const rest = wanted.filter((id) => byId.get(id)?.matched !== true);
    const missed =
      rest.length === 0
        ? []
        : orm()
            .select(select)
            .from(programs)
            .innerJoin(serviceTable, eq(serviceTable.id, programs.service_id))
            .where(inArray(programs.id, rest))
            .all();
    const missById = new Map(missed.map((program) => [program.id, program]));
    for (const id of wanted) {
      const held = reserved.get(id);
      const row = byId.get(id);
      if (row?.matched) {
        out[id] =
          row.skip !== null
            ? { kind: "skip", reason: row.skip.kind }
            : held !== undefined && held.state !== "skipped"
              ? { kind: "reserved", state: held.state }
              : { kind: "record" };
        continue;
      }
      /*
       * 当たらない番組。**ほかで立っている予約はそのまま残る** (手動・ほかのルール・猶予の内) ので
       * 「予約済み」。保存すると引っ込む予約 (このルールが立てたもの) は、当たらない理由を出す
       */
      if (
        held !== undefined &&
        held.state !== "skipped" &&
        (held.rule_id === null ||
          held.rule_id !== editing?.id ||
          keepsReservation(held, at))
      ) {
        out[id] = { kind: "reserved", state: held.state };
        continue;
      }
      const program = missById.get(id);
      if (program === undefined) continue;
      /*
       * 条件に当たらないなら、その理由。当たるのに行が無いのは、もう始まっている番組だけ
       * (下見はこれから始まる番組から引く。ルールも始まった番組には予約を立てない)
       */
      const reason =
        missFor(program) ?? (program.start_at <= at ? "airing" : null);
      // 当たって始まってもいないのに行が無いことは無いはず。黙って「録る」とも「録らない」とも言わない
      if (reason === null)
        console.warn("[rules] 下見の行に無い番組が当たりました", id);
      else out[id] = { kind: "skip", reason };
    }
    return out;
  }
}
