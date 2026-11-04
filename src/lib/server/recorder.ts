import { once } from "node:events";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type EitEvent, EpgReader } from "@danything/arib/eit";
import { ServiceFilter } from "@danything/arib/service-filter";
import { and, eq, sql } from "drizzle-orm";

import { TsHead } from "#lib/ts/ts-head.js";

import type { Recording, Reservation } from "../types";
import { fileSize } from "./chase";
import { config } from "./config";
import { now, orm } from "./db";
import { enqueue } from "./encoder";
import { savePrograms } from "./epg";
import { emit } from "./events";
import { moveFile, removeIfExists } from "./fsx";
import { libraryPath, recordedPath } from "./library";
import { refreshLineup } from "./lineup-follow";
import { writeThumbnail } from "./metadata";
import { PfEvent } from "./pf-event";
import { fillTsHead, recordingSummary } from "./recording";
import { duplicateAtStart } from "./rules";
import { programs, recordings, reservations, rules, services } from "./schema";
import { chunks } from "./stream";
import { parseTitle } from "./title";
import {
  openChannelStream,
  recordingUse,
  type StreamUse,
  TuneError,
} from "./tuner";
import { notify } from "./webhook";

/**
 * 録り始めてから PMT でコピー禁止と分かり、1 バイトも保存しなかった録画の理由
 * (番組表が古い・無かったとき。ふだんは予約の時点で止まる: `format.COPY_NEVER_REASON`)
 */
const COPY_NEVER_RECORDING = "コピー禁止の番組なので録画しませんでした";

/** 録画中のストリームを止めるための手段。プロセス内にしか無いので再起動で失われる (起動時に回収する: recoverOrphanedRecordings) */
const active = new Map<number, AbortController>();

export function activeRecordingIds(): number[] {
  return [...active.keys()];
}

export function stopRecording(recordingId: number): void {
  active.get(recordingId)?.abort();
}

function fail(recordingId: number, error: string): void {
  /*
   * 理由を書けば状態は決まる (recordings.state は生成列)。
   * チューナーを使うのも終わりなので、録り終えた時刻も同時に埋める
   */
  orm()
    .update(recordings)
    .set({
      error,
      finished_at: sql`COALESCE(${recordings.finished_at}, ${now()})`,
      updated_at: now(),
    })
    .where(eq(recordings.id, recordingId))
    .run();
  const rec = recordingById(recordingId);
  if (rec !== undefined) {
    notify({
      event: "recording.failed",
      text: `録画に失敗しました: ${rec.name} (${rec.service_name})`,
      recording: recordingSummary(rec),
      error,
    });
  }
  // 予約側には何も書かない。失敗したことは録画の行が持っている
}

function recordingById(id: number): Recording | undefined {
  return orm().select().from(recordings).where(eq(recordings.id, id)).get();
}

function createRecording(reservation: Reservation): Recording {
  const service = orm()
    .select()
    .from(services)
    .where(eq(services.id, reservation.service_id))
    .get();
  const program = orm()
    .select()
    .from(programs)
    .where(eq(programs.id, reservation.program_id))
    .get();

  /*
   * 名前と概要は**録り始める瞬間の番組表**から取る。
   *
   * 番組表は放送直前まで書き換わる (「[新]」が付く、サブタイトルが入る、
   * 誤字が直る)。予約の行が追い付くのは番組表を集め終えたとき (`epg.settle`) だけ
   * なので、そのまま写すと**古い名前で保存先に並ぶ**ことがある。
   *
   * 逆に、録り終えたあとは動かさない。番組表の行は 24 時間で消えるうえ、
   * ファイル名も画面に出す番組情報 (DB) も既に固まっている (docs/data.md)
   */
  const name = program?.name ?? reservation.name;
  const description = program?.description ?? reservation.description;
  // 詳細 (拡張形式) は番組表にしか無い。予約の行は持っていないので program からだけ取る
  const extended = program?.extended ?? null;
  const parsed = parseTitle(name);
  const at = now();

  const { id } = orm()
    .insert(recordings)
    // finished_at を入れないので、この行は「録画中」として読まれる
    .values({
      reservation_id: reservation.id,
      program_id: reservation.program_id,
      service_id: reservation.service_id,
      service_name: service?.name ?? "",
      name,
      series: parsed.series,
      subtitle: parsed.subtitle,
      description,
      extended,
      start_at: reservation.start_at,
      end_at: reservation.end_at,
      /*
       * **譲った区間を写す。** チューナーの取り合いで先頭か末尾を譲ったときだけ
       * 入っている (`conflict.ts` の「入るところまで録る」)。一覧で
       * 先頭が欠けていると示すのに要る
       */
      record_from: reservation.record_from,
      record_to: reservation.record_to,
      audio_type: program?.audio_type ?? null,
      // 番組表の行は 24 時間で消える。録り直しのときにも要るので写しておく
      genre_detail: program?.genre_detail ?? null,
      // エンコードしたものの音声トラックに番組表と同じ名前を入れるのに要る (`audioTitles`)
      audios: program?.audios ?? null,
      // 番組詳細の「第 N 話」と、同じ回の見分け (`episode.episodeOf`) に要る。番組表の行は 24 時間で消える
      series_episode: program?.series_episode ?? null,
      series_last_episode: program?.series_last_episode ?? null,
      series_repeat: program?.series_repeat ?? null,
      created_at: at,
      updated_at: at,
    })
    .returning({ id: recordings.id })
    .get()!;
  // ファイル名は録画 ID を含めるため、行を作ってからでないと決まらない
  const path = recordedPath({
    id,
    series: parsed.series,
    subtitle: parsed.subtitle,
    start_at: reservation.start_at,
  });
  orm()
    .update(recordings)
    .set({ ts_path: path })
    .where(eq(recordings.id, id))
    .run();

  return recordingById(id)!;
}

/**
 * 予約を録画に移す。ストリームの読み出しは待たずにバックグラウンドで動かし、
 * 呼び出し側 (スケジューラの tick) を塞がないようにする。
 *
 * `after` は、同じ定期チェックで止めた録画の利用者。チューナーを使うとき、エージェントはそれらを
 * もう離れたものとして選ぶ (引き継ぎ。docs/agent.md「選ぶ順の約束」)
 */
export async function startRecording(
  reservation: Reservation,
  after: readonly StreamUse[] = [],
): Promise<Recording> {
  const recording = createRecording(reservation);
  emit("recordings");
  /*
   * **「同じ回は最初の放送だけ」のルールの予約は、録り始めに同じ回かを見直す** (`pump`)。
   * やめたものに「録画を開始しました」を送らないよう、通知は見直したあと
   */
  const checks = ruleDedupes(reservation);
  if (!checks) announce(recording);
  launch(recording, after, checks);
  return recording;
}

/** 録画を開始したと知らせる (`recording.started`) */
function announce(recording: Recording): void {
  notify({
    event: "recording.started",
    text: `録画を開始しました: ${recording.name} (${recording.service_name})`,
    recording: recordingSummary(recording),
  });
}

/** 「同じ回は最初の放送だけ」を入れた、有効なルールの予約か (`duplicateAtStart` と同じ条件)。手動の予約は見ない */
function ruleDedupes(reservation: Reservation): boolean {
  if (reservation.manual || reservation.rule_id === null) return false;
  const rule = orm()
    .select({ dedupe: rules.dedupe, enabled: rules.enabled })
    .from(rules)
    .where(eq(rules.id, reservation.rule_id))
    .get();
  return rule?.dedupe === true && rule.enabled;
}

/**
 * 読み出しをバックグラウンドで動かす。止める手段 (`active`) はここで立てる。
 * `checks` は録り始めに同じ回かを見直すか (`startRecording`)。見直すものは、開始の通知も `pump` が送る
 */
function launch(
  recording: Recording,
  after: readonly StreamUse[] = [],
  checks = false,
): void {
  const controller = new AbortController();
  active.set(recording.id, controller);
  void pump(recording, controller, after, checks).catch((error) => {
    active.delete(recording.id);
    fail(recording.id, String(error));
  });
}

/**
 * **録っている番組の EIT[p/f] で、番組の情報を書き直す** (番組表の行と録画の行)。
 *
 * 録画の行は録り始める瞬間の番組表から作る (`createRecording`) が、その番組表は数日前に集めたもので、
 * 局によっては話数を放送の直前の p/f にしか載せない (実機の BS日テレ。数日前の番組表では概要が空、
 * p/f の概要に「第5話　副題」)。書き直さないと、あとで別の局に来る同じ回と突き合わせられない
 * (`rules.recordedEpisodes` は録画の行の名前・概要・詳細から回を読む)。
 *
 * **空では塗り潰さない** (`epg.savePrograms` と同じ)。シリーズ記述子は p/f が言っていれば (`series` が
 * undefined でなければ) その値にする。時刻は書かない (延長の追従は `extendIfLonger`)
 */
function refreshFromPf(recording: Recording, event: EitEvent): void {
  const extended =
    Object.keys(event.extended).length === 0 ? null : event.extended;
  const said = event.series !== undefined;
  /** 中身のあるものだけ書く */
  const text = {
    ...(event.name === "" ? {} : { name: event.name }),
    ...(event.description === "" ? {} : { description: event.description }),
    ...(extended === null ? {} : { extended }),
  };
  const at = now();
  if (recording.program_id !== null) {
    orm()
      .update(programs)
      .set({
        ...text,
        ...(said
          ? {
              series_id: event.series?.seriesId ?? null,
              series_repeat: event.series?.repeatLabel ?? null,
              series_episode: event.series?.episode ?? null,
              series_last_episode: event.series?.lastEpisode ?? null,
              series_name: event.series?.name ?? null,
            }
          : {}),
        updated_at: at,
      })
      .where(eq(programs.id, recording.program_id))
      .run();
  }
  const parsed = parseTitle(text.name ?? recording.name);
  orm()
    .update(recordings)
    .set({
      ...text,
      series: parsed.series,
      subtitle: parsed.subtitle,
      ...(said
        ? {
            series_episode: event.series?.episode ?? null,
            series_last_episode: event.series?.lastEpisode ?? null,
            series_repeat: event.series?.repeatLabel ?? null,
          }
        : {}),
      updated_at: at,
    })
    .where(eq(recordings.id, recording.id))
    .run();
}

/**
 * **録り始めてから同じ回をもう録ってあると分かった録画を、無かったことにする** (`duplicateAtStart`)。
 *
 * 書いたのは開始マージンと数秒ぶんだけなので、ファイルも録画の行も消す (失敗にすると、録らないと
 * 決めたものが一覧に失敗として残る)。予約は「録画しない」(`skipped`) にして理由を持たせる。
 * **録り始めた時刻 (`started_at`) は消さない。** スケジューラ・チューナーの割り振り・ルールの当て直しは
 * どれも録り始めていない予約しか拾わないので、もう一度録り始めない。手で予約し直せば録れる
 * (`reservations.reserve` が録り始めた時刻を空に戻す)
 */
function skipDuplicate(recording: Recording, reason: string): void {
  removeIfExists(recording.ts_path);
  orm().delete(recordings).where(eq(recordings.id, recording.id)).run();
  if (recording.reservation_id !== null) {
    orm()
      .update(reservations)
      .set({ state: "skipped", conflict_reason: reason, updated_at: now() })
      .where(
        and(
          eq(reservations.id, recording.reservation_id),
          eq(reservations.state, "scheduled"),
        ),
      )
      .run();
  }
  console.log(
    `[rec] 録画をやめました: ${recording.name} (${recording.service_name})。${reason}`,
  );
  emit("recordings");
  emit("reservations");
}

/**
 * チューナーが空くのを少し待つ。
 *
 * 使えない理由は「本当に足りない」だけとは限らない。番組の先頭を数秒落としてでも
 * 録れたほうがいいので、すぐには諦めない。
 */
const OPEN_RETRIES = 5;
const OPEN_RETRY_WAIT = 2000;

async function openWithRetry(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  let last: unknown;
  for (let attempt = 0; attempt < OPEN_RETRIES; attempt++) {
    if (signal.aborted) throw new Error("録画が中止されました");
    try {
      return await open(signal);
    } catch (error) {
      last = error;
      if (attempt < OPEN_RETRIES - 1) {
        await Bun.sleep(OPEN_RETRY_WAIT);
      }
    }
  }
  throw new Error(
    `チューナーを ${OPEN_RETRIES} 回試しましたが確保できませんでした: ${last}`,
  );
}

/**
 * 放送の延長に追い付く。**録画中の TS に入っている EIT[p/f] を見る。**
 *
 * **問い合わせる相手が要らない。**
 * いま録っているチャンネルの TS にそのまま流れてくるので、読むだけで分かる。
 *
 * 縮む方向には追わない。番組表が短くなったからといって録画を早く切ると、
 * 実際にはまだ流れていたときに取り返しがつかない。
 */
function extendIfLonger(recording: Recording, endAt: number): void {
  const current = orm()
    .select({ end_at: recordings.end_at })
    .from(recordings)
    .where(eq(recordings.id, recording.id))
    .get();
  if (current === undefined || endAt <= current.end_at) return;

  const at = now();
  orm()
    .update(recordings)
    .set({ end_at: endAt, updated_at: at })
    .where(eq(recordings.id, recording.id))
    .run();
  if (recording.reservation_id !== null) {
    orm()
      .update(reservations)
      .set({ end_at: endAt, updated_at: at })
      .where(eq(reservations.id, recording.reservation_id))
      .run();
  }
  const minutes = Math.round((endAt - current.end_at) / 60000);
  console.log(`[rec] 放送が延びました: ${recording.name} (+${minutes} 分)`);
  emit("recordings");
  emit("reservations");
}

/** 実際に録れた長さを足す。再開したぶんも合算するので加算にする */
function addDuration(recordingId: number, ms: number): void {
  if (ms <= 0) return;
  orm()
    .update(recordings)
    .set({ duration_ms: sql`COALESCE(${recordings.duration_ms}, 0) + ${ms}` })
    .where(eq(recordings.id, recordingId))
    .run();
}

/**
 * 録画中に取得した番組表を書き出す間隔。
 *
 * **ただで手に入るぶん。** 録画で開いているチャンネルには EIT[schedule] も
 * 流れてきているので、読んで捨てる理由が無い。番組表の取得がそのチャンネルへ
 * 行く手間がまるごと省ける
 */
const EPG_SAVE_INTERVAL = 5 * 60_000;

async function pump(
  recording: Recording,
  controller: AbortController,
  after: readonly StreamUse[],
  checks: boolean,
): Promise<void> {
  const path = recording.ts_path!;
  mkdirSync(dirname(path), { recursive: true });
  /** 開始の通知。見直すもの (`checks`) は、録ると決まったとき (か終わるとき) に 1 回だけ送る */
  let announced = !checks;
  const announceOnce = () => {
    if (announced) return;
    announced = true;
    const row = recordingById(recording.id);
    if (row !== undefined) announce(row);
  };

  const service = orm()
    .select()
    .from(services)
    .where(eq(services.id, recording.service_id))
    .get();
  if (service === undefined) {
    announceOnce();
    fail(
      recording.id,
      "局の情報がありません。チャンネルスキャンをやり直してください",
    );
    active.delete(recording.id);
    return;
  }

  /*
   * **物理チャンネルを丸ごと開いて、こちらで局を選り分ける。**
   *
   * エージェントは中身を読まないので、1 本の TS にその中継に入っている局が
   * 全部流れてくる。そのまま保存すると 1 つの録画に複数の番組が入る
   * (実機の TOKYO MX は MX1 と MX2 が同居している)。
   */
  const filter = new ServiceFilter(service.service_id);
  /*
   * 同じ TS から番組表も読む。**延長の追従はここから。**
   * 番組情報を誰かに聞き直す必要は無い
   */
  const epg = new EpgReader();
  const eventId =
    recording.program_id === null ? null : recording.program_id % 100000;

  let written = 0;
  /** いまコピー禁止で保存を止めているか (変わり目でだけログに出す) */
  let copyNever = false;
  /**
   * 番組が始まってから書いたか。開始マージンのぶん (前の番組) は数えない。そこを書いていても、
   * 番組が始まった時点で禁止なら録画をやめる。再起動をまたいで続きから録るときは、
   * 番組の途中までもう書いてあるものとして扱う (`recoverOrphanedRecordings`)
   */
  let wroteProgram =
    Date.now() > recording.start_at && (fileSize(path) ?? 0) > 0;
  /** 始めから禁止だったので録画をやめたか。前の番組のぶんを書いていても失敗にする */
  let stoppedForCopyNever = false;
  /*
   * **書いた TS の先頭の放送時刻を測る** (`recordings.ts_head`。実況のコメントを録画中の追っかけでも合わせるため)。
   * 測れるのはファイルの先頭から書くときだけ。再起動をまたいで続きを足すときは、もう先頭が過ぎている
   * (そのときはエンコードのときに測る。`recorded-bml.ts`)。測れたら行に書いて、あとは渡さない
   */
  let measure =
    recording.ts_head === null && (fileSize(path) ?? 0) === 0
      ? new TsHead()
      : null;
  /*
   * **録り始めに、その番組の EIT[p/f] を 1 回読む** (`refreshFromPf`)。局によっては話数を放送の直前の
   * p/f にしか載せないので、番組の情報を書き直す。続きから録るとき (再起動をまたいだとき) は読まない
   * (もう読んである)。届かなければ打ち切って、そのまま録る (`PF_WAIT`)
   */
  let pf =
    eventId !== null && (fileSize(path) ?? 0) === 0
      ? new PfEvent(service.service_id, eventId)
      : null;
  // p/f を読まないものは、同じ回を確かめ直せないので録ると決まっている。開始はすぐ知らせる
  if (pf === null) announceOnce();
  /**
   * 書き直した情報で、同じ回をもう録ってあると分かったときの理由 (`rules.duplicateAtStart`)。
   * 見るのは「同じ回は最初の放送だけ」のルールの予約 (`checks`) だけ
   */
  let duplicate: string | null = null;
  // 何を使っているのかが設定の「チューナー」に出る。番組名は載せず、ID だけ渡して表示する側で引く
  const use = recordingUse(recording.id);

  try {
    // 追記で開く。再起動をまたいで録画を再開したときに、それまでの分を消さないため
    // (MPEG-TS は 188 バイトのパケットの並びなので、そのまま繋げても読める)
    const sink = createWriteStream(path, { flags: "a" });
    // 実際に受け取っていた時間を測る。番組表の尺は予定でしかなく、
    // 途中で止めたときやチューナーを取るのに手間取ったときは実物と合わない。
    // 再開したときは足していく (ファイルも追記なので合計が実物になる)
    const from = Date.now();
    let savedEpgAt = from;
    let interrupted = 0;

    try {
      /*
       * **選局は自分から切るまで終わらない。** 向こうから終わったなら (EOF でも
       * 例外でも) チューナーを取り上げられたか切れたかで、終了時刻 (自分の abort) までは取り直す。
       * EOF を正常終了と読んでいた頃は、チューナーを取り上げられた録画が末尾の欠けたまま「録れた」に
       * なり (HTTP 越しでは失敗も正常終了に見える。`agent/conformance.test.ts`)、
       * 例外で抜けていた頃はエージェントの Pod を入れ替えただけで番組が丸ごと
       * 失敗した (実機)
       */
      // 引き継ぎは最初に使うときだけ。取り直すころには、止めた録画はもう離れている
      let handoff = after;
      while (!controller.signal.aborted) {
        /** 切れた理由。EOF なら null のまま */
        let broke: unknown = null;

        let stream: ReadableStream<Uint8Array>;
        try {
          const leaving = handoff;
          handoff = [];
          stream = await openWithRetry(
            (signal) =>
              openChannelStream(
                service.type,
                // 掛け直すたびに引き直す。放送の一覧が変わってチャンネルを書き換えたら、新しいほうへ行く
                channelOf(service.id) ?? service.channel,
                signal,
                use,
                undefined,
                leaving,
              ).catch((error: unknown) => {
                /*
                 * **衛星で選局できなかったら、放送の一覧を読み直す** (`lineup-follow.refreshLineup`)。
                 * 再編で TS が移ったのなら、書き換えたあとの掛け直しで録れる
                 */
                if (
                  error instanceof TuneError &&
                  (service.type === "BS" || service.type === "CS")
                ) {
                  void refreshLineup(service.type).catch(() => undefined);
                }
                throw error;
              }),
            controller.signal,
          );
        } catch (error) {
          // **取り直せなくても諦めない。** エージェントの Pod 入れ替えは
          // openWithRetry の数十秒を超えることがあり、そこで失敗にすると
          // 「終了時刻まで掛け直す」という上の約束を破って番組を丸ごと
          // 落とす。終了時刻 (自分での abort) が来るまでは待って掛け直す
          if (controller.signal.aborted) break;
          interrupted++;
          console.warn(
            `[recorder] 録画 ${recording.id}: 選局を取り直せません (${interrupted} 回目: ${error})。` +
              `待って掛け直します`,
          );
          await Bun.sleep(OPEN_RETRY_WAIT);
          continue;
        }

        // 取り直したら PCR が飛ぶので、そこまでに測れていなければ諦める (エンコードのときに測る)
        if (written > 0) measure = null;

        try {
          for await (const chunk of chunks(stream)) {
            if (pf !== null) {
              const seen = pf.feed(chunk);
              if (seen !== null) {
                pf = null;
                if (seen === "timeout") {
                  console.warn(
                    `[recorder] 録画 ${recording.id}: 番組の EIT[p/f] が届かないので、番組表の情報のまま録ります`,
                  );
                } else {
                  refreshFromPf(recording, seen);
                  if (checks) duplicate = duplicateAtStart(recording.id);
                }
                /*
                 * **同じ回をもう録ってあれば、ここでやめてチューナーを返す。** 書いたのは開始マージンと
                 * p/f を待った数秒だけ。録る側に倒すので、届かなかったとき・回が読めないときは録る
                 */
                if (duplicate !== null) {
                  controller.abort();
                  break;
                }
                announceOnce();
              }
            }
            if (epg.feed(chunk) && eventId !== null) {
              const present = epg.present.get(service.service_id);
              if (
                present !== undefined &&
                present.eventId === eventId &&
                present.startAt !== null &&
                present.duration !== null
              ) {
                extendIfLonger(recording, present.startAt + present.duration);
              }
              if (Date.now() - savedEpgAt >= EPG_SAVE_INTERVAL) {
                savedEpgAt = Date.now();
                savePrograms(epg.all());
              }
            }

            const out = filter.filter(chunk);
            /*
             * **コピー禁止のあいだは保存しない** (PMT のデジタルコピー制御記述子)。番組表が
             * 古い・無いときの備えで、ふだんは予約の時点で止まっている (`format.COPY_NEVER_REASON`)。
             * 決めるのは PMT を読んでから。それまでのぶん (PAT・番組表) も書かない
             */
            if (!filter.ready) continue;
            if (filter.copyNever) {
              if (!copyNever) {
                copyNever = true;
                console.warn(
                  `[recorder] 録画 ${recording.id}: コピー禁止なので保存を止めます`,
                );
              }
              /*
               * **番組が始まった時点で禁止なら録画をやめてチューナーを返す。** 番組が始まる前
               * (開始マージン) の PMT は前の番組のものなので、番組が始まるまでは待つ
               * (そのあいだに前の番組のぶんを書いていても、本編を 1 バイトも書いていなければやめる)。
               * 本編を書いたあとで禁止に変わったときは止めない。そこまでのぶんは残し、戻れば続きを書く
               */
              if (!wroteProgram && Date.now() >= recording.start_at) {
                stoppedForCopyNever = true;
                controller.abort();
                break;
              }
              continue;
            }
            if (copyNever) {
              copyNever = false;
              console.warn(
                `[recorder] 録画 ${recording.id}: コピー禁止でなくなったので保存を続けます`,
              );
            }
            if (out.length === 0) continue;
            if (!wroteProgram && Date.now() >= recording.start_at)
              wroteProgram = true;
            written += out.byteLength;
            if (!sink.write(out)) await once(sink, "drain");
            if (measure !== null) {
              measure.feed(out);
              if (measure.head !== null) {
                fillTsHead(recording.id, measure.head);
                measure = null;
              }
            }
          }
        } catch (error) {
          broke = error ?? new Error("不明な理由");
        }

        // 終了時刻に達して自分で切った。ここだけが正常な終わり方
        if (controller.signal.aborted) break;

        interrupted++;
        console.warn(
          `[recorder] 録画 ${recording.id}: 選局が切れました (${interrupted} 回目` +
            `${broke === null ? "" : `: ${broke}`})。取り直します`,
        );
        await Bun.sleep(OPEN_RETRY_WAIT);
      }
    } finally {
      if (interrupted > 0) {
        console.warn(
          `[recorder] 録画 ${recording.id}: 途中で ${interrupted} 回切れました`,
        );
      }
      addDuration(recording.id, Date.now() - from);
      await new Promise<void>((resolve, reject) => {
        sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
      // 途中で終わっても、読めたぶんの番組表は残す
      savePrograms(epg.all());
    }
  } catch (error) {
    // 終了時刻に達して自分で abort した場合は正常終了。それ以外だけ失敗にする
    if (!controller.signal.aborted) {
      announceOnce();
      fail(recording.id, String(error));
      return;
    }
  } finally {
    active.delete(recording.id);
  }

  if (duplicate !== null) {
    skipDuplicate(recording, duplicate);
    return;
  }
  // p/f を待っている間に終わった (取り消した・終了時刻が来た) ものも、開始は知らせる
  announceOnce();

  /*
   * 始めから禁止だったものは失敗にする。開始マージンで前の番組のぶんを書いていても、
   * それだけを「録れた」にしない (元の TS は失敗した録画と同じく残す)
   */
  if (stoppedForCopyNever) {
    fail(recording.id, COPY_NEVER_RECORDING);
    return;
  }

  // 統計が取れなくても書き込み量で代用する
  const size = fileSize(path) ?? written;

  if (size === 0) {
    fail(recording.id, "ストリームから 1 バイトも受信できませんでした");
    return;
  }

  finish(recording.id, size);
}

/** 録画完了。エンコードするならキューに積み、しないならそのまま保存先に置く */
function finish(recordingId: number, size: number): void {
  const at = now();
  // 録り終えた時刻が入った時点で「録画済み」になる (recordings.state は生成列)
  orm()
    .update(recordings)
    .set({ finished_at: at, ts_size: size, updated_at: at })
    .where(eq(recordings.id, recordingId))
    .run();

  const recording = recordingById(recordingId)!;
  const reservation =
    recording.reservation_id == null
      ? undefined
      : orm()
          .select({ encode: reservations.encode })
          .from(reservations)
          .where(eq(reservations.id, recording.reservation_id))
          .get();

  emit("recordings");
  notify({
    event: "recording.finished",
    text: `録画が終わりました: ${recording.name} (${recording.service_name})`,
    recording: recordingSummary(recording),
  });

  if (reservation === undefined || reservation.encode) {
    enqueue(recording.id);
    return;
  }

  // エンコードしない設定なら元の TS をそのまま保存先へ移す
  const dest = libraryPath(recording, ".m2ts");
  moveFile(recording.ts_path!, dest);
  void writeThumbnail(dest, (recording.end_at - recording.start_at) / 1000);
  // 保存先に置いた時点で「視聴可能」になる
  orm()
    .update(recordings)
    .set({ library_path: dest, ts_path: null, updated_at: now() })
    .where(eq(recordings.id, recording.id))
    .run();
}

/**
 * その録画が終わっているべき時刻。**末尾を譲っていればそこまで** (`record_to`)。
 *
 * 止めるとき (`scheduler.tick`)・起動時に回収するとき・持ち主のいない行を畳むとき
 * (`failStrayRecordings`) で同じ物差しを使う。書き写していると、片方だけ直したときに
 * 「止めた時刻」と「終わっているはずの時刻」がずれる
 */
export function recordingUntil(rec: {
  end_at: number;
  record_to: number | null;
}): number {
  return rec.record_to ?? rec.end_at + config.endMargin;
}

/**
 * プロセスが落ちた時点で録画中だった行を回収する。
 *
 * AbortController はメモリ上にしか無いので、再起動すると録画は止まったままになる。
 * まだ放送中のものは録り直す。元の TS は追記で開くので、落ちるまでに録れていた分は
 * そのまま残り、抜けるのは止まっていた間だけになる。
 * 放送が終わってしまったものは、もう取り返せないので失敗に倒す。
 */
export function recoverOrphanedRecordings(): {
  resumed: number;
  failed: number;
} {
  const orphans = orm()
    .select()
    .from(recordings)
    .where(eq(recordings.state, "recording"))
    .all();

  let resumed = 0;
  let failed = 0;
  const at = now();
  for (const orphan of orphans) {
    if (orphan.ts_path === null || recordingUntil(orphan) <= at) {
      fail(orphan.id, "アプリの再起動により録画が中断されました");
      failed++;
      continue;
    }

    launch(orphan);
    console.log(`[boot] 録画を再開: ${orphan.name} (${orphan.service_name})`);
    resumed++;
  }
  if (resumed > 0) emit("recordings");
  return { resumed, failed };
}

/**
 * 終了時刻を過ぎてから畳むまでの猶予。**正常に終わる録画に手を出さないため。**
 *
 * 止めてから `finish` までは同じ処理の中で続けて終わるので実際には重ならないが、
 * 急いで畳んで得るものが何も無い
 */
const STRAY_GRACE = 60_000;

/**
 * **持ち主のいない「録画中」を畳む。**
 *
 * 録っている最中の録画はプロセスの中にしか無い (`active`)。ノードごと落とした・Pod を強制終了したなど、
 * **畳む前にプロセスが止まった**ときは、DB の行だけが録画中で残る。
 * 起動時にも同じ片付けをするが (`recoverOrphanedRecordings`)、そのとき**まだ放送中なら
 * 録り直す**ので、再開した先でまたプロセスが止まると次の起動まで畳まれない。
 *
 * 畳まれない行は**一覧の予約の側に残り、録画の側には出てこない**。どちらの振り分けも
 * `recordings.state = 'recording'` で決まっている (`routes/+page.server.ts`)。放送は
 * とうに終わっているのに「録画中」と出たままで、取り消す以外に消す方法が無い。
 *
 * **録っている最中のものには触らない。** 終了時刻を過ぎたものだけを、起動時と同じ理由で
 * 失敗にする。元の TS は消さないので、録れていた分は詳細から再エンコードできる。
 *
 * `at` と `owned` を渡せるようにしてあるのはテストのため (`recorder-stray.test.ts`)
 */
export function failStrayRecordings(
  at = now(),
  owned: ReadonlySet<number> = new Set(active.keys()),
): number {
  const stray = orm()
    .select({
      id: recordings.id,
      end_at: recordings.end_at,
      record_to: recordings.record_to,
    })
    .from(recordings)
    .where(eq(recordings.state, "recording"))
    .all()
    .filter(
      (rec) => !owned.has(rec.id) && at >= recordingUntil(rec) + STRAY_GRACE,
    );

  for (const rec of stray) {
    console.warn(
      `[recorder] 録画 ${rec.id}: 録っている処理が無いまま終了時刻を過ぎました。失敗にします`,
    );
    fail(rec.id, "録画が中断されたまま終了時刻を過ぎました");
  }
  return stray.length;
}

/** 局のいまのチャンネルの名前 (`services.channel`)。局が無ければ null */
function channelOf(serviceId: number): string | null {
  return (
    orm()
      .select({ channel: services.channel })
      .from(services)
      .where(eq(services.id, serviceId))
      .get()?.channel ?? null
  );
}
