import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import {
  cancelable,
  COPY_NEVER_REASON,
  NOT_CANCELABLE_REASON,
} from "../format";
import { parseId } from "../id";
import {
  type Reservation,
  type ReservationState,
  undecodableReason,
} from "../types";
import { now, orm } from "./db";
import { stopRecording } from "./recorder";
import { resolveConflicts } from "./scheduler";
import {
  latestReservationRecordingId,
  programs,
  recordings,
  reservations,
  reservationState,
  services,
} from "./schema";
import { settings } from "./settings";

/**
 * **途中で止めた予約を、もう一度録れるようにする** (`started_at` を空に戻す)。
 * 録り始めた時刻が残っていると、スケジューラは録り始めたものとして二度と起こさない。
 * 取り消して止めたものと、録画が途中で失敗して止まったもの (いま録っている録画の行が無い) が対象。
 * 録っている最中のものはそのまま (二重に録らない)。次の録画は別の行・別のファイルになる
 */
const rerecord = sql`CASE
  WHEN ${reservations.state} = 'canceled' THEN NULL
  WHEN NOT EXISTS (
    SELECT 1 FROM ${recordings}
     WHERE ${recordings.reservation_id} = ${reservations.id} AND ${recordings.state} = 'recording'
  ) THEN NULL
  ELSE ${reservations.started_at}
END`;

/** 手動予約。ルール由来の予約が既にあれば手動扱いにし、優先度は 2 とルールの優先度の高いほうにする */
export async function reserve(programId: number): Promise<Reservation> {
  const program = orm()
    .select()
    .from(programs)
    .where(eq(programs.id, programId))
    .get();
  if (program === undefined)
    throw new Error(`番組 ${programId} が見つかりません`);

  const at = now();
  // 終わった番組を予約しても録れない。予約表に並べても取り消す手間が増えるだけ
  if (program.end_at <= at) throw new Error("この番組は放送が終わっています");
  /*
   * **コピー禁止の番組は録らない** (`format.COPY_NEVER_REASON`)。手で押したものも断る。
   * 予約を立てても「録画しない」になるだけで、押した人には録れたように見えてしまう
   */
  if (program.copy_never) throw new Error(COPY_NEVER_REASON);
  /*
   * **復号できない局の番組も録らない** (`services.decodable`)。番組表を読める局は番組表に出るが、録ってもスクランブルのままで観られない
   * (局の行が無い番組は断らない。番組は局の行がある局にしか書かないので、ふつうは起きない)
   */
  const service = orm()
    .select({
      type: services.type,
      transport: services.transport,
      decodable: services.decodable,
    })
    .from(services)
    .where(eq(services.id, program.service_id))
    .get();
  if (service !== undefined && !service.decodable)
    throw new Error(undecodableReason(service.type, service.transport));
  // 手動で入れたものはルール由来 (既定 1) より上。**予約どうしだけの物差し**
  const priority = 2;
  // 録画のしかたは全体で 1 つ。「エンコードするか否か」だけ予約時に固定する。
  // エンコードの細目 (元の TS を残すか・コーデック) はエンコードするときに settings を見る
  const encode = settings().encode;

  orm()
    .insert(reservations)
    .values({
      program_id: program.id,
      rule_id: null,
      service_id: program.service_id,
      name: program.name,
      description: program.description,
      start_at: program.start_at,
      end_at: program.end_at,
      priority,
      manual: true,
      encode,
      state: "scheduled",
      created_at: at,
      updated_at: at,
    })
    .onConflictDoUpdate({
      target: reservations.program_id,
      set: {
        manual: true,
        // ルールの優先度のほうが高ければそのまま (押して下がると、それまで勝っていた競合に黙って負ける)
        priority: sql`MAX(${reservations.priority}, excluded.priority)`,
        encode: sql`excluded.encode`,
        state: sql`CASE WHEN ${reservations.state} = 'canceled' THEN 'scheduled' ELSE ${reservations.state} END`,
        started_at: rerecord,
        // 取り消しを解除したので、印も消す
        canceled_by: null,
        updated_at: sql`excluded.updated_at`,
      },
    })
    .run();

  await resolveConflicts();
  return orm()
    .select()
    .from(reservations)
    .where(eq(reservations.program_id, programId))
    .get()!;
}

/**
 * 画面の「予約」のアクション (番組表・検索)。フォームの `programId` を予約し、予約した番組の ID を返す。
 * 断ったときはその理由 (`refused`) を返す
 */
export async function reserveFromForm(
  form: FormData,
): Promise<{ programId: number } | { refused: string }> {
  const programId = parseId(form.get("programId"));
  if (programId === null) return { refused: "番組 ID が不正です" };
  try {
    await reserve(programId);
    return { programId };
  } catch (error) {
    return { refused: reason(error) };
  }
}

/** `reserve` が断った理由の文 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 取り消した予約を戻す。
 *
 * ルールが作った予約を手で取り消すと、以後ルールは作り直さない
 * (`INSERT OR IGNORE` と、放送単位で当てる `rules.canceledBroadcasts` が弾く)。
 * 気が変わったときに戻す方法がここ。
 */
export async function restore(reservationId: number): Promise<void> {
  const reservation = byId(reservationId);
  if (reservation === undefined) throw new Error("予約が見つかりません");
  if (reservation.state !== "canceled")
    throw new Error("取り消した予約ではありません");
  if (reservation.end_at <= now())
    throw new Error("この番組は放送が終わっています");

  orm()
    .update(reservations)
    // 録っている途中で取り消したものも、戻せば残りを録る (`rerecord` と同じ。次の録画は別の行・別のファイル)
    .set({
      state: "scheduled",
      started_at: null,
      canceled_by: null,
      updated_at: now(),
    })
    .where(eq(reservations.id, reservationId))
    .run();
  await resolveConflicts();
}

function byId(reservationId: number): Reservation | undefined {
  return orm()
    .select()
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .get();
}

/**
 * 予約の取り消し。録画中なら止めて、そこまでの分は録画済みとして残す
 * (途中まででも見たいことがあるのでファイルは捨てない)。録画を止めたら true
 */
export async function cancel(reservationId: number): Promise<boolean> {
  const reservation = byId(reservationId);
  if (reservation === undefined) return false;

  // 録っている最中なら止める。録っている最中かは録画の行で分かる
  const recording = orm()
    .select({ id: recordings.id })
    .from(recordings)
    .where(
      and(
        eq(recordings.reservation_id, reservationId),
        eq(recordings.state, "recording"),
      ),
    )
    .get();
  if (recording !== undefined) stopRecording(recording.id);

  // 人が押した印。**この放送にはルールが二度と立てない** (rules.ts の canceledBroadcasts)
  orm()
    .update(reservations)
    .set({ state: "canceled", canceled_by: "user", updated_at: now() })
    .where(eq(reservations.id, reservationId))
    .run();
  await resolveConflicts();
  return recording !== undefined;
}

/**
 * **番組の予約を取り消す** (番組表の「予約取消」と、アプリの `DELETE /api/programs/<id>/record`)。
 * 予約は番組ごとに 1 本 (`reservations.program_id` が一意)。取り消していない予約が無ければ 404、
 * 録り終えた・録り逃したものは 409 ({@link cancelable}。取り消しにすると記録だけが書き換わるため)。
 * 録画中なら止めて、そこまでの録画は残す ({@link cancel})
 */
export async function cancelProgram(
  programId: number,
  at = now(),
): Promise<CancelResult> {
  const reservation = orm()
    .select({ id: reservations.id })
    .from(reservations)
    .where(
      and(
        eq(reservations.program_id, programId),
        ne(reservations.state, "canceled"),
      ),
    )
    .get();
  if (reservation === undefined)
    return { ok: false, status: 404, message: "予約が見つかりません" };
  return cancelReservation(reservation.id, at);
}

type CancelResult =
  | { ok: true; stopped: boolean }
  | { ok: false; status: 404 | 409; message: string };

/**
 * **予約を ID で取り消す** (ホームと検索の画面の取消)。決まりは {@link cancelProgram} と同じで、
 * 予約が無いか取り消し済みなら 404、録り終えた・録り逃したものは 409
 */
export async function cancelReservation(
  reservationId: number,
  at = now(),
): Promise<CancelResult> {
  const reservation = byId(reservationId);
  if (reservation === undefined || reservation.state === "canceled")
    return { ok: false, status: 404, message: "予約が見つかりません" };
  const state =
    reservationStates([reservation.program_id]).get(reservation.program_id) ??
    null;
  if (!cancelable(state, reservation.end_at, at))
    return { ok: false, status: 409, message: NOT_CANCELABLE_REASON };
  return { ok: true, stopped: await cancel(reservation.id) };
}

/** {@link recordAiring}・{@link recordProgram} の答え。断ったときは HTTP の状態と、そのまま出せる文言を持つ */
type RecordAiring =
  | {
      ok: true;
      programId: number;
      name: string;
      state: ReservationState;
      /** 録らない理由 (`conflict_reason`)。競合・コピー禁止など。録るなら null */
      reason: string | null;
    }
  | { ok: false; status: 400 | 404; message: string };

/** 録画の API の答え (`POST /api/services/<id>/record`・`POST /api/programs/<id>/record`。docs/api.md) */
export function recordedBody(result: Extract<RecordAiring, { ok: true }>) {
  return {
    recorded: result.name,
    programId: result.programId,
    // 競合で弾かれたときは false (チューナーが足りない)。予約そのものは残る
    reserved: result.state === "scheduled" || result.state === "recording",
    // 番組表のマスと同じ物差し (`reservationStates`) と、録らない理由
    state: result.state,
    reason: result.reason,
  };
}

/**
 * **番組 ID を指定して録る** (アプリの `POST /api/programs/<id>/record`)。
 * 番組表に無ければ 404、予約できなければ (放送が終わっている、コピー禁止) 400。
 * 予約は手動予約と同じ処理 ({@link reserve}) で、何度呼んでも二重には録らない
 */
export async function recordProgram(programId: number): Promise<RecordAiring> {
  const program = orm()
    .select({ id: programs.id, name: programs.name })
    .from(programs)
    .where(eq(programs.id, programId))
    .get();
  if (program === undefined)
    return { ok: false, status: 404, message: "番組が見つかりません" };
  return reserveProgram(program);
}

/** 予約して、番組表と同じ物差しの状態を添えて返す (`recordAiring`・`recordProgram`) */
async function reserveProgram(program: {
  id: number;
  name: string;
}): Promise<RecordAiring> {
  let reservation: Reservation;
  try {
    reservation = await reserve(program.id);
  } catch (error) {
    return { ok: false, status: 400, message: reason(error) };
  }
  /*
   * 競合で弾かれたかは予約のあとでしか分からない。番組表と同じ物差しで読む (録画中かは録画の行を見ないと
   * 分からないため)。取り消し扱いで引けなければ、予約の行の状態をそのまま答える
   */
  const state =
    reservationStates([program.id]).get(program.id) ?? reservation.state;
  return {
    ok: true,
    programId: program.id,
    name: program.name,
    state,
    reason: reservation.conflict_reason,
  };
}

/**
 * **局でいま流れている番組を録る** (ライブの録画ボタンと、アプリの `POST /api/services/<id>/record`)。
 *
 * 番組表からいま流れている番組を引いて、手動予約と同じ処理 ({@link reserve}) に通す。
 * 既に始まっている番組の予約は次のスケジューラ周期 (数秒) でそのまま録りはじめる。
 * 既に予約済み・録画中なら upsert されるだけで、二重には録らない (予約は program_id で 1 本)。
 *
 * **画面とアプリで同じものを使う。** 番組の引き方や断り方が入口ごとにずれると、
 * 片方でだけ録れない番組が出る
 */
export async function recordAiring(
  serviceId: number,
  at = now(),
): Promise<RecordAiring> {
  const program = orm()
    .select({ id: programs.id, name: programs.name })
    .from(programs)
    .where(
      and(
        eq(programs.service_id, serviceId),
        lte(programs.start_at, at),
        gt(programs.end_at, at),
      ),
    )
    .orderBy(desc(programs.start_at))
    .limit(1)
    .get();
  if (program === undefined) {
    return {
      ok: false,
      status: 404,
      message: "いま流れている番組が番組表に見つかりません",
    };
  }
  return reserveProgram(program);
}

/**
 * **番組ごとの予約の状態** (番組表のマスと同じ物差し `reservationState`)。
 * 取り消したものと、予約の無い番組は入らない。
 *
 * 録画の状態は録画の行から引く。予約側は録り始めた時刻しか持たないので、
 * `reservations.state` だけでは録画中と録り終えたものの見分けがつかない
 */
export function reservationStates(
  programIds: number[],
): Map<number, ReservationState> {
  if (programIds.length === 0) return new Map();
  const r = alias(reservations, "r");
  const rec = alias(recordings, "rec");
  const rows = orm()
    .select({ programId: r.program_id, state: reservationState(r, rec) })
    .from(r)
    // その予約で録れたいちばん新しい録画 (消したものも含める。`latestReservationRecordingId`)
    .leftJoin(rec, eq(rec.id, latestReservationRecordingId(r.id)))
    .where(and(inArray(r.program_id, programIds), ne(r.state, "canceled")))
    .all();
  return new Map(rows.map((row) => [row.programId, row.state]));
}
