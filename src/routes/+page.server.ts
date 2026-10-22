import { fail } from "@sveltejs/kit";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { channelNotice } from "#lib/channel-notice.js";
import { capacityLabel } from "#lib/format.js";
import { GROUPED_COOKIE, storedGrouped } from "#lib/grouping.js";
import { fileSize } from "#lib/server/chase.js";
import { now, orm } from "#lib/server/db.js";
import { capacity } from "#lib/server/disk.js";
import {
  CM_CUT_ALREADY,
  cancel as cancelEncode,
  enqueue,
  isCanceling,
  pump,
} from "#lib/server/encoder.js";
import { serviceCounts } from "#lib/server/epg.js";
import { emit } from "#lib/server/events.js";
import { deleteRecordingFiles, reconcile } from "#lib/server/files.js";
import { seriesFolder } from "#lib/server/library.js";
import { watchProgress } from "#lib/server/playback.js";
import { recordingFromForm } from "#lib/server/recording.js";
import { cancel, restore } from "#lib/server/reservations.js";
import {
  activeEncodeJobId,
  encodeJobs,
  lastEncodeError,
  recordings as recordingTable,
  reservationState,
  reservations as reservationTable,
  rules as ruleTable,
  services,
} from "#lib/server/schema.js";
import { settings } from "#lib/server/settings.js";
import { parseTitle } from "#lib/server/title.js";
import { cmRedo, encodeSource } from "#lib/source.js";
import type {
  EncodeJob,
  Recording,
  Reservation,
  ReservationState,
} from "#lib/types.js";

interface RecordingRow extends Recording {
  /** 直近のエンコード失敗の理由。詳細で見せる */
  encode_error: string | null;
  /** 動いているエンコード。無ければ null。行の状態としてそのまま出す */
  job_id: number | null;
  job_state: EncodeJob["state"] | null;
  job_phase: EncodeJob["phase"] | null;
  job_percent: number | null;
  job_eta_ms: number | null;
  job_log: string | null;
  /**
   * 中止をリクエストしてあって、まだ畳み終わっていない。中止のボタンを回したまま
   * にするための印 (`encoder.isCanceling`)。DB には無く、動いている間だけ
   */
  job_canceling: boolean;
  /**
   * 元のTSの大きさ。エンコード済みと**両方ある**ときだけ入る。
   *
   * `ts_size` はいま配っているファイルの大きさで、エンコードが終わると
   * mkv のものに書き換わる。元のTSを残す設定だと「消していいのか、どれだけ
   * 空くのか」が画面から分からなかった
   */
  raw_size: number | null;
  /**
   * もう一方のコーデック (H.264) の大きさ。**両方エンコードしたときだけ**入る。
   *
   * `ts_size` は主 (AV1) のぶんしか持っていないので、両方エンコードすると画面に出る
   * 数字と実際に置き場が使っている量が食い違っていた
   */
  alt_size: number | null;
  /**
   * どこから来た1本か。**予約の行から引く** (録画には写さない)。
   *
   * 写していないので、ルールの条件を変えても「何で録れたか」は変わらない。
   * ルールごと消えたときだけ `rule_id` が NULL になり (rules の delete が外す)、
   * 「(削除済み)」として残る
   */
  rule_id: number | null;
  rule_name: string | null;
  /** 手動予約か。取り込んだ録画のように予約が無いものは null */
  from_manual: boolean | null;
  /** 局ロゴを取得できているか。局名の隣に出す */
  has_logo: boolean | null;
  /**
   * 一覧の「残り」の位置と尺 (ms)。観る物差しに直したもの (`playback.watchProgress`)。続きが無ければ null。
   * `resume_ms` は元の TS の物差しなので、エンコードしたものの尺と比べると CM を切ったものでは食い違う
   */
  progress: { at: number; length: number } | null;
  /** 「まとめて表示」でまとめる鍵と見出し (`seriesGroup`) */
  group_key: string;
  group_name: string;
}

/**
 * 「まとめて表示」の単位。**エンコードしたものを置くシリーズのフォルダと同じ名前でまとめる**
 * (`library.seriesFolder`)。見出しに出すのは削る前のシリーズ名
 */
function seriesGroup(
  series: string,
  name: string,
): { group_key: string; group_name: string } {
  const key = seriesFolder(series, name);
  const shown = (series === "" ? parseTitle(name).series : series).trim();
  // 名前が空白だけのときはフォルダ名 (`untitled`) を出す。見出しが「N本」だけになるため
  return { group_key: key, group_name: shown === "" ? key : shown };
}

/**
 * 録り逃し。**録画の行を持たない** (始まらないまま放送が終わったので、録れた
 * ファイルどころか recordings の行も無い)。予約の行から、時間軸に差し込むのに
 * 要る分だけ持ってくる。
 */
interface MissedRow {
  id: number;
  program_id: number | null;
  name: string;
  description: string;
  service_id: number;
  service_name: string;
  has_logo: boolean | null;
  start_at: number;
  end_at: number;
  manual: boolean;
  rule_id: number | null;
  rule_name: string | null;
  /** チューナー不足で落とされたものは理由を持っている。詳細で見せる */
  conflict_reason: string | null;
  /** 「まとめて表示」でまとめる鍵と見出し。録画の行と同じ決め方 (`seriesGroup`) */
  group_key: string;
  group_name: string;
}

interface ReservationRow extends Omit<Reservation, "state"> {
  /** 画面に出す状態。録り始めてからは録画の行から引く (reservationState) */
  state: ReservationState;
  service_name: string;
  rule_name: string | null;
  /** 局ロゴを取得できているか。局名の隣に出す */
  has_logo: boolean | null;
  /** 録画中の録画のID。追っかけ再生 (`/chase/<id>`) への入口 (issue #16) */
  recording_id: number | null;
  /** 録画の行が1本でもあるか (消したものも含む)。終わった予約を録画の行にまとめる (`mergeRecorded`) */
  recorded: boolean;
  /** 「まとめて表示」でまとめる鍵と見出し。録画の行と同じ決め方 (`seriesGroup`) */
  group_key: string;
  group_name: string;
}

/**
 * 予約と録画を1画面に並べる。
 *
 * 「これから何が録れるか」と「録れたものが今どうなっているか」は続きものなので、
 * 行き来せずに見えるほうがいい。1本の時間軸に並べる (上が予約、下が録れたもの。並べるのは画面の `#lib/timeline.ts`)。
 *
 * **番組名で探すのはここではない** (全体の検索 `/search?q=`)。ホームは絞り込みのボタンだけで絞る
 */
export function load({ url, cookies }) {
  const showFinished = url.searchParams.get("all") === "1";
  const showDeleted = url.searchParams.get("deleted") === "1";

  /*
   * 並びは**放送日時の近い順**で固定する。録画中だけは真っ先に見たいので先頭に置く。
   *
   * 「完了した予約も表示」で向きを変えていた頃は、押した瞬間に一覧がひっくり返って、
   * さっきまで見ていた行がどこへ行ったのか分からなくなっていた。
   * 出るものが増えるだけで、並びは変わらないほうがいい
   *
   * 予約が録り始めてからの状態は**録画の行から引く**。予約側に 'recording' /
   * 'done' / 'failed' を書き写していた頃は、録画が失敗しても予約が録画中のまま
   * 残ることがあった。持っているのは「録り始めた時刻」だけにしてある
   */
  /*
   * まだ始まっていないものと、いま録っているものだけ。「完了した予約も表示」なら全部。
   *
   * **録り逃したもの (`missed`) はここには出さない** — あれは「これから録るもの」
   * ではなく**録画の結果**なので、録画の一覧のほうに出す (下の `missed`)。
   * 予約側に出していた頃は、放送が終わった行が予約の列に居座って、
   * 「これから何が録れるか」の中に過去が混ざっていた。
   *
   * **取り消したものは既定では出さない** — 人が押した結果で、驚くことが無い
   * (「完了した予約も表示」では出す。戻すボタンのため)
   *
   * **録画しない (コピー禁止の `skipped`) は放送が終わるまで出す。** 終わったあとも録り逃しには
   * 移さず (意図して録らなかったものを失敗に見せない)、「完了した予約も表示」で理由ごと見られる
   */
  const r = alias(reservationTable, "r");
  const rec = alias(recordingTable, "rec");
  const pending = showFinished
    ? not(and(eq(r.state, "missed"), isNull(r.started_at))!)
    : or(
        and(inArray(r.state, ["scheduled", "conflict"]), isNull(r.started_at)),
        and(eq(r.state, "skipped"), isNull(r.started_at), gt(r.end_at, now())),
        eq(rec.state, "recording"),
      );
  const reservations: ReservationRow[] = orm()
    .select({
      ...getTableColumns(r),
      service_name: services.name,
      has_logo: services.has_logo,
      rule_name: ruleTable.name,
      state: reservationState(r, rec),
      recording_id: sql<
        number | null
      >`CASE WHEN ${rec.state} = 'recording' THEN ${rec.id} END`,
      // 録画の行が1本でもあるか (消したものも)。終わった予約を録画の行にまとめるのに使う (`timeline.ts` の `mergeRecorded`)
      recorded:
        sql<number>`EXISTS (SELECT 1 FROM recordings WHERE reservation_id = ${r.id})`.mapWith(
          Boolean,
        ),
    })
    .from(r)
    .innerJoin(services, eq(services.id, r.service_id))
    .leftJoin(ruleTable, eq(ruleTable.id, r.rule_id))
    // その予約で録れた最新の録画
    .leftJoin(
      rec,
      eq(
        rec.id,
        sql`(SELECT id FROM recordings WHERE reservation_id = ${r.id} ORDER BY id DESC LIMIT 1)`,
      ),
    )
    .where(pending)
    .orderBy(desc(sql`${rec.state} = 'recording'`), asc(r.start_at))
    .limit(300)
    .all()
    // まとめて表示の鍵。予約はシリーズ名を持たないので、番組名から切り出す (録るときと同じ)
    .map((row) => ({ ...row, ...seriesGroup("", row.name) }));

  /*
   * エンコードは録画の行そのものに出す。
   *
   * 別のカードにして一覧の上に積んでいた頃は、エンコードが増えるたびに表が下へ
   * ずれてページごとスクロールバーが生えていた。同じ番組が2箇所に並んでもいた。
   * 「録れたものが今どうなっているか」の一形態なので、行の状態として出すのが素直。
   */
  const res = alias(reservationTable, "res");
  const j = alias(encodeJobs, "j");
  const recordings: RecordingRow[] = orm()
    .select({
      ...getTableColumns(recordingTable),
      // 失敗の理由は詳細で見せる。一覧には「失敗」とだけ出す
      encode_error: lastEncodeError(recordingTable.id),
      job_id: j.id,
      job_state: j.state,
      job_phase: j.phase,
      job_percent: j.percent,
      job_eta_ms: j.eta_ms,
      job_log: j.log,
      has_logo: services.has_logo,
      // 何で録れた1本か。予約とルールから引く (録画には持たせない)
      rule_id: res.rule_id,
      from_manual: res.manual,
      rule_name: ruleTable.name,
    })
    .from(recordingTable)
    .leftJoin(services, eq(services.id, recordingTable.service_id))
    .leftJoin(res, eq(res.id, recordingTable.reservation_id))
    .leftJoin(ruleTable, eq(ruleTable.id, res.rule_id))
    .leftJoin(j, eq(j.id, activeEncodeJobId(recordingTable.id)))
    .where(
      and(
        // 録画中のものは予約の行として出ている。ここにも出すと同じ番組が2箇所に並ぶ
        ne(recordingTable.state, "recording"),
        /*
         * 「削除済みも表示」は消したものを**足す**。消したものだけに切り替えていた頃は、
         * 消したかどうかを確かめるのに一覧を行き来することになっていた
         */
        showDeleted ? undefined : isNull(recordingTable.deleted_at),
      ),
    )
    /*
     * 並びは放送日順に固定する。エンコードが始まったものを上へ動かしていた頃は、
     * 眺めている間に行が飛んで、どれを見ていたのか分からなくなっていた
     */
    .orderBy(desc(recordingTable.start_at))
    .limit(300)
    .all()
    .map((row) => ({
      ...row,
      // 実ファイルを見る。外から消されていることがあるため (files.reconcile)。出すときの決まりは RecordingRow
      raw_size:
        row.library_path === null || row.ts_path === null
          ? null
          : fileSize(row.ts_path),
      alt_size: row.alt_path === null ? null : fileSize(row.alt_path),
      job_canceling: row.job_id !== null && isCanceling(row.job_id),
      progress: watchProgress(row),
      ...seriesGroup(row.series, row.name),
    }));

  /*
   * 録り逃し。**録れたものに混ぜて出す** (画面側で放送日順に差し込む)。
   * チューナーが足りずに落とされたものが黙って消えると、録れたつもりのまま
   * 気付かれずに終わる — いちばん知りたいのは「録れなかった」ほうなのに。
   *
   * **録画しない (コピー禁止の `skipped`) は入れない。** 意図して録らなかったもので、失敗ではない
   * (放送が終わっても `skipped` のまま。`scheduler.tick`)
   *
   * 溜まり続けはしない。終わった予約は履歴の片付けで消える
   * (`server/files.ts`。既定で14日)
   */
  const missed: MissedRow[] = orm()
    .select({
      id: r.id,
      program_id: r.program_id,
      name: r.name,
      description: r.description,
      service_id: r.service_id,
      start_at: r.start_at,
      end_at: r.end_at,
      manual: r.manual,
      rule_id: r.rule_id,
      conflict_reason: r.conflict_reason,
      rule_name: ruleTable.name,
      service_name: services.name,
      has_logo: services.has_logo,
    })
    .from(r)
    .innerJoin(services, eq(services.id, r.service_id))
    .leftJoin(ruleTable, eq(ruleTable.id, r.rule_id))
    .where(and(eq(r.state, "missed"), isNull(r.started_at)))
    .orderBy(desc(r.start_at))
    .limit(100)
    .all()
    // 予約はシリーズ名を持たないので、番組名から切り出す (録るときと同じ)
    .map((row) => ({ ...row, ...seriesGroup("", row.name) }));

  const room = capacity();

  return {
    /** 局が無いときに上に出す案内 (`#lib/channel-notice.ts`。出すのは `+layout.svelte`) */
    channelNotice: channelNotice(serviceCounts()),
    reservations,
    recordings,
    missed,
    showFinished,
    showDeleted,
    /** サイドバーの「今日」に出す空きと、あと何時間録れるかの目安 (`disk.capacity`)。読めなければ null */
    capacity: room === null ? null : capacityLabel(room.free, room.hours),
    /** まとめて表示 (`#lib/grouping.ts`)。サーバで描く形を、端末の覚えに合わせる */
    grouped: storedGrouped(cookies.get(GROUPED_COOKIE)),
  };
}

export const actions = {
  delete: async ({ request }) => {
    const recording = recordingFromForm(await request.formData());
    if (recording === undefined)
      return fail(400, { message: "録画が見つかりません" });
    deleteRecordingFiles(recording, "手動削除");
    return { success: true };
  },

  reencode: async ({ request }) => {
    const recording = recordingFromForm(await request.formData());
    if (recording === undefined)
      return fail(400, { message: "録画が見つかりません" });
    // 元になるのは元のTS。エンコード済みを元に録り直しても画質は戻らない
    if (encodeSource(recording) === null) {
      return fail(400, {
        message: "元のTSが残っていないため再エンコードできません",
      });
    }
    /*
     * どのコーデックでエンコードするかは**そのときの設定**。押した人はエンコードしたいので、
     * 録ったときの設定を再現したいわけではない。設定が「エンコードしない」
     * だとエンコードするものが決まらないので、ここで断る
     */
    if (settings().codec === "none") {
      return fail(400, {
        message:
          "映像コーデックが選ばれていません。設定で AV1 か H.264 を選んでください",
      });
    }
    enqueue(recording.id);
    pump();
    return { success: true };
  },

  /**
   * 「CM検出をやり直す」(詳細の「その他…」)。再エンコードせず、CM を探し直してエンコードしたもののチャプターを
   * 書き直す (`encoder.runCmJob`)。エンコードするジョブと同じ待ち行列に並び、同じ録画に2つは積まない
   */
  redetectCm: async ({ request }) => {
    const recording = recordingFromForm(await request.formData());
    if (recording === undefined)
      return fail(400, { message: "録画が見つかりません" });
    const redo = cmRedo(recording);
    if (redo.state === "hidden")
      return fail(400, { message: "CM検出に使えるファイルがありません" });
    if (redo.state === "disabled") return fail(400, { message: redo.reason });
    // 切ったものからは戻せない。元のTSはあるので、再エンコードを促す
    if (redo.state === "prompt") return fail(400, { message: CM_CUT_ALREADY });
    enqueue(recording.id, "cm");
    pump();
    return { success: true };
  },

  cancelEncode: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get("id"));
    if (!Number.isFinite(id))
      return fail(400, { message: "ジョブIDが不正です" });
    // 畳み終わってから返る。ここで待たないと、この直後の読み直しが
    // まだ「エンコード中」を読んで、押しても何も変わらないように見える
    await cancelEncode(id);
    return { success: true };
  },

  /**
   * 「視聴済みにする」「未視聴に戻す」(詳細の「その他…」)。**どちらも続きの位置を消す。**
   * 一覧は続きの位置があれば進捗バーを出し、印 (点) を出さない。残したままだと、
   * 視聴済みにしても進捗バーのまま・未視聴に戻しても点が出ない、と押した結果が見えない。
   * 末尾まで観たとき (`api/recordings/<id>/resume`) と同じ形 (観終えた = 位置なし) に揃える
   */
  watched: async ({ request }) => {
    const form = await request.formData();
    const recording = recordingFromForm(form);
    if (recording === undefined)
      return fail(400, { message: "録画が見つかりません" });
    const watched = form.get("watched") === "1";
    orm()
      .update(recordingTable)
      .set({
        watched_at: watched ? now() : null,
        resume_ms: null,
        updated_at: now(),
      })
      .where(eq(recordingTable.id, recording.id))
      .run();
    // 同じ一覧を見ているほかの端末の印も変える
    emit("recordings");
    return { success: true };
  },

  reconcile: () => {
    // 「ファイルと照合」ボタン。外から消した分をすぐ一覧に反映したいとき用
    const result = reconcile();
    // 押した本人以外の画面も更新する。同じものを見ている端末が食い違うのを防ぐ
    emit("recordings");
    return { success: true, reconcile: result };
  },

  /**
   * 録り逃しを一覧から消す。**消すのは予約の行そのもの** — 録画の行が無い
   * (始まらないまま終わった) ので、失敗した録画の削除とは消す先が違う。
   * 放って置いても履歴の片付け (14日) で消えるが、見るたびに並んだままなのは
   * 失敗した録画と同じで、確かめ終わったら畳みたい
   */
  deleteMissed: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get("id"));
    if (!Number.isFinite(id)) return fail(400, { message: "IDが不正です" });
    // 状態も見て消す。録り逃し以外 (これからの予約など) を同じアクションで消させない
    const gone = orm()
      .delete(reservationTable)
      .where(
        and(
          eq(reservationTable.id, id),
          eq(reservationTable.state, "missed"),
          isNull(reservationTable.started_at),
        ),
      )
      .returning({ id: reservationTable.id })
      .get();
    if (gone === undefined)
      return fail(400, { message: "録り逃した予約ではありません" });
    emit("reservations");
    return { success: true };
  },

  /** 取り消した予約を戻す。ルールは作り直さないので、ここからしか戻せない */
  restore: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get("id"));
    if (!Number.isFinite(id)) return fail(400, { message: "IDが不正です" });
    try {
      await restore(id);
    } catch (error) {
      return fail(400, {
        message: `予約に戻せませんでした: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return { success: true };
  },

  cancel: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get("id"));
    if (!Number.isFinite(id)) return fail(400, { message: "予約IDが不正です" });
    await cancel(id);
    return { success: true };
  },
};
