import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { error } from "@sveltejs/kit";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";

import {
  type Clip,
  CLIP_BYTES_MOST,
  CLIP_PAGE,
  type ClipPlace,
  type ClipQuery,
} from "../clips";
import type { FileSource } from "../source";
import { fromTsTime, toTsTime } from "../ts/watch";
import type { Recording } from "../types";
import { config } from "./config";
import { now, orm } from "./db";
import { pruneEmptyDirs, removeIfExists } from "./fsx";
import { rulerOf } from "./playback";
import { tsHeadOf } from "./recording";
import { clips, programs, recordings, services } from "./schema";
import { searchQuery, searchWords } from "./search";
import { run } from "./stream";
import { searchable } from "./title";

/**
 * **切り抜き** (観ている1コマを字幕ごと写した静止画) を受けて置く。
 *
 * 画面は撮った1コマを WebP か JPEG で送ってくる (`components/player/snapshot.ts`)。ここで ffmpeg に通して
 * **AVIF** (SVT-AV1 の静止画) にし、一覧用の小さいもの (幅 480) と一緒に置き場 (`clipsDir()`) に置く。
 * ffmpeg に通すのは、小さくするためと、**画像として読めるかの確認**を兼ねる (読めなければ断る)。
 *
 * 番組の情報はサーバが引く。画面が送るのは「どの録画のどこか」か「どの局のいつか」だけで、
 * 番組名・局名・番組の始めからの位置はここで決めて写しておく (番組表は流れ、録画は消える)。
 *
 * - 置き場は `<年月>/<ID>.avif` と `<年月>/<ID>-small.avif`。**自動では消さない**。録画を消しても残す
 * - EXIF などは書かない (`-map_metadata -1`)。ログに番組名を出さない
 */

/** 一覧用の幅 (px)。グリッドの1枚は広い画面でも 240px ほどなので、2倍の密度まで */
export const SMALL_WIDTH = 480;
/**
 * AVIF の画質 (SVT-AV1 の CRF。小さいほどきれいで大きい)。1080 の1コマで数百 KB に収まり、
 * 字幕の縁が崩れない所。一覧用は縮めて見るだけなので粗くてよい
 */
const FULL_CRF = 28;
const SMALL_CRF = 36;
/** SVT-AV1 の速さ。1080 の1枚が1秒ほどで済む所 */
const PRESET = 6;
/** 受ける縦横の範囲 (px)。SVT-AV1 は小さすぎる画像をエンコードできない。上は 8K まで */
const SIDE_LEAST = 64;
const SIDE_MOST = 8192;
/** ffmpeg 1回の上限 (ms)。固まったものに居座らせない */
const CONVERT_TIMEOUT = 60_000;
/** 字幕の文字の上限 (字)。字幕1枚に収まる量より十分多く */
const CAPTIONS_MOST = 500;
/** まとめて消す数の上限 */
export const DELETE_MOST = 500;

/** 断る理由と HTTP のステータス */
export class ClipError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ImageType = "png" | "jpeg" | "webp";

/**
 * 送られてきた画像の形式と縦横を頭から読む。**中身で見る** (`Content-Type` は信じない)。
 * PNG・JPEG・WebP のどれでもなければ null
 */
export function imageInfo(
  bytes: Uint8Array,
): { type: ImageType; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (offset: number, text: string): boolean =>
    bytes.length >= offset + text.length &&
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));

  if (bytes.length >= 24 && has(0, "\x89PNG\r\n\x1a\n") && has(12, "IHDR"))
    return {
      type: "png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    };

  if (bytes.length >= 30 && has(0, "RIFF") && has(8, "WEBP")) {
    if (has(12, "VP8 "))
      return {
        type: "webp",
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    if (has(12, "VP8L") && bytes[20] === 0x2f) {
      const b = (i: number) => bytes[21 + i]!;
      return {
        type: "webp",
        width: 1 + (((b(1) & 0x3f) << 8) | b(0)),
        height: 1 + (((b(3) & 0x0f) << 10) | (b(2) << 2) | (b(1) >> 6)),
      };
    }
    if (has(12, "VP8X")) {
      const u24 = (i: number) =>
        bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16);
      return { type: "webp", width: 1 + u24(24), height: 1 + u24(27) };
    }
    return null;
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // 区切り (FF xx) を辿って、縦横を持つ SOF を探す
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      const sof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (sof)
        return {
          type: "jpeg",
          width: view.getUint16(i + 7),
          height: view.getUint16(i + 5),
        };
      i += 2 + view.getUint16(i + 2);
    }
    return null;
  }
  return null;
}

/** 送られてきた画像を確かめる。大きすぎれば 413、読めない形式なら 415 */
export function checkImage(bytes: Uint8Array): {
  type: ImageType;
  width: number;
  height: number;
} {
  if (bytes.length > CLIP_BYTES_MOST)
    throw new ClipError(413, "画像が大きすぎます");
  if (bytes.length === 0) throw new ClipError(400, "画像がありません");
  const info = imageInfo(bytes);
  if (info === null)
    throw new ClipError(415, "PNG・JPEG・WebP の画像を送ってください");
  if (info.width > SIDE_MOST || info.height > SIDE_MOST)
    throw new ClipError(413, "画像が大きすぎます");
  if (info.width < SIDE_LEAST || info.height < SIDE_LEAST)
    throw new ClipError(415, "画像が小さすぎます");
  return info;
}

/** AVIF の色の書き方。canvas の画素は sRGB なので、BT.709 の行列でフルレンジの YUV にする */
const AVIF_COLOR = [
  "-color_range",
  "pc",
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "iec61966-2-1",
];

/**
 * ffmpeg の引数。1回の起動で AVIF を2枚 (そのままの大きさと一覧用) 書く。
 * 4:2:0 は縦横が偶数でないとエンコードできないので、奇数なら1画素削る
 */
export function avifArgs(input: string, full: string, small: string): string[] {
  const encode = (crf: number) => [
    "-frames:v",
    "1",
    "-c:v",
    "libsvtav1",
    "-preset",
    String(PRESET),
    "-crf",
    String(crf),
    // 静止画向けの設定 (SVT-AV1 の `avif`)
    "-svtav1-params",
    "avif=1",
    ...AVIF_COLOR,
    "-f",
    "avif",
  ];
  const yuv = "out_color_matrix=bt709:out_range=full,format=yuv420p";
  return [
    "-y",
    "-v",
    "error",
    "-nostdin",
    "-i",
    input,
    "-map_metadata",
    "-1",
    "-filter_complex",
    `[0:v:0]split[a][b];` +
      `[a]scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2:${yuv}[full];` +
      `[b]scale=w='min(${SMALL_WIDTH},trunc(iw/2)*2)':h=-2:${yuv}[small]`,
    "-map",
    "[full]",
    ...encode(FULL_CRF),
    full,
    "-map",
    "[small]",
    ...encode(SMALL_CRF),
    small,
  ];
}

/**
 * 切り抜きの画像の置き場。**エンコード済みの置き場の下** — 既定の構成で残る置き場は DB (`/data`。5GB ほどの小さいもの) と
 * 元のTS・エンコード済みだけで、`MEDIA_DIR` そのものはボリュームではない。録画と同じディスクに置けば、
 * 置き場を移すときも一緒に写る
 */
export function clipsDir(): string {
  return join(config.encodedDir, "clips");
}

/** 置き場からの相対の名前 (`2026-10/12.avif`)。年月はサーバの時計で、撮った時刻から */
export function clipFile(id: number, takenAt: number): string {
  const at = new Date(takenAt);
  const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
  return `${month}/${id}.avif`;
}

/** 一覧用の名前 (`2026-10/12-small.avif`) */
export function smallFile(file: string): string {
  return file.replace(/\.avif$/, "-small.avif");
}

/** 画像の置き場の絶対パス。`small` なら一覧用 */
export function clipPath(file: string, small = false): string {
  return join(clipsDir(), small ? smallFile(file) : file);
}

/**
 * **一度に1枚ずつ変換する。** 続けて押されても SVT-AV1 を並べて CPU を取り合わない
 * (録画のエンコードと同じ機械で動く)。1枚は1秒ほど
 */
let line: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const next = line.then(task, task);
  line = next.catch(() => undefined);
  return next;
}

/** 撮った場所から引いた番組の情報 (DB にそのまま写す) */
export interface Scene {
  place: ClipPlace;
  recording_id: number | null;
  service_id: number;
  service_name: string;
  event_id: number | null;
  program_start_at: number | null;
  program_name: string;
  offset_ms: number | null;
}

/** 番組ID (`tuner.programKey`) から event_id */
function eventOf(programId: number | null): number | null {
  return programId === null ? null : programId % 100000;
}

/**
 * **録画のどこかで撮った** (観る画面・追っかけ)。位置は観ているものの物差し (`source`) の秒で来るので、
 * 元の TS の物差しに直してから放送時刻にし、番組の始めからの位置を出す
 */
export function recordingScene(
  recording: Recording,
  place: "chase" | "watch",
  at: number,
  source: FileSource | null,
): Scene {
  const tsAt = toTsTime(Math.max(0, at), rulerOf(recording, source));
  const aired = tsHeadOf(recording) + tsAt * 1000;
  return {
    place,
    recording_id: recording.id,
    service_id: recording.service_id,
    service_name: recording.service_name,
    event_id: eventOf(recording.program_id),
    program_start_at: recording.start_at,
    program_name: recording.name,
    offset_ms: Math.round(aired - recording.start_at),
  };
}

/**
 * **ライブで撮った**。局と放送時刻から番組表を引く。同じ番組を録っていれば、その録画を付ける
 * (「この場面から観る」で行ける)。番組表に無い時刻なら番組の情報は空のまま
 */
export function liveScene(serviceId: number, aired: number): Scene {
  const service = orm()
    .select({ name: services.name })
    .from(services)
    .where(eq(services.id, serviceId))
    .get();
  if (service === undefined) throw new ClipError(404, "局が見つかりません");
  const program = orm()
    .select({
      id: programs.id,
      event_id: programs.event_id,
      start_at: programs.start_at,
      name: programs.name,
    })
    .from(programs)
    .where(
      and(
        // 番組の service_id は局の内部ID (services.id) で持っている
        eq(programs.service_id, serviceId),
        sql`${programs.start_at} <= ${aired}`,
        sql`${programs.end_at} > ${aired}`,
      ),
    )
    .orderBy(desc(programs.start_at))
    .get();
  const recorded =
    program === undefined
      ? undefined
      : orm()
          .select({ id: recordings.id })
          .from(recordings)
          .where(
            and(
              eq(recordings.program_id, program.id),
              isNull(recordings.deleted_at),
            ),
          )
          .orderBy(desc(recordings.id))
          .get();
  return {
    place: "live",
    recording_id: recorded?.id ?? null,
    service_id: serviceId,
    service_name: service.name,
    event_id: program?.event_id ?? null,
    program_start_at: program?.start_at ?? null,
    program_name: program?.name ?? "",
    offset_ms: program === undefined ? null : aired - program.start_at,
  };
}

/**
 * 「この場面から観る」の位置。番組の始めからの位置 (ms) を、観る画面の物差し (`rulerOf(recording, null)`) の秒にする。
 * 録画の頭より前 (頭が欠けた録画) なら 0
 */
export function sceneTime(recording: Recording, offsetMs: number): number {
  const tsAt = Math.max(
    0,
    (recording.start_at + offsetMs - tsHeadOf(recording)) / 1000,
  );
  return fromTsTime(tsAt, rulerOf(recording, null));
}

/** 字幕の文字を揃える (改行と続く空白を1つの空白に、長すぎるものは切る) */
export function captionsText(raw: string): string {
  return [...raw.replace(/\s+/g, " ").trim()].slice(0, CAPTIONS_MOST).join("");
}

/** DB の行を API の形に。消した録画は付けない */
type ClipRow = typeof clips.$inferSelect & { alive: number | null };
function toClip(row: ClipRow): Clip {
  return {
    id: row.id,
    takenAt: row.taken_at,
    place: row.place,
    recordingId: row.alive === null ? null : row.recording_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    programName: row.program_name,
    programStartAt: row.program_start_at,
    eventId: row.event_id,
    offsetMs: row.offset_ms,
    captions: row.captions,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
  };
}

/** 録画が生きているか (消した録画を指したままの古い行でも、行き先を出さない) */
const ALIVE = sql<
  number | null
>`(SELECT id FROM recordings WHERE id = ${clips.recording_id} AND deleted_at IS NULL)`;

/** 作業ファイルを残しておく長さ。これより古いものは落ちて残ったもの */
const WORK_KEEP = 60 * 60_000;

/** 落ちて残った作業ファイル (変換の途中で止まったもの) を片付ける */
function sweepWork(work: string): void {
  let names: string[];
  try {
    names = readdirSync(work);
  } catch {
    return;
  }
  const before = Date.now() - WORK_KEEP;
  for (const name of names) {
    const path = join(work, name);
    try {
      if (statSync(path).mtimeMs < before) rmSync(path, { force: true });
    } catch {
      // 読んでいる間に消えた
    }
  }
}

/**
 * 1枚を受けて置く。画像を確かめ、AVIF にし、行を足して置き場へ移す。
 * 変換できなかった (画像として読めない) ものは 415
 */
export async function saveClip(
  image: Uint8Array,
  scene: Scene,
  captions: string,
): Promise<Clip> {
  const info = checkImage(image);
  const work = join(clipsDir(), ".work");
  const stem = join(work, `${Date.now()}-${crypto.randomUUID()}`);
  const input = `${stem}.${info.type}`;
  const full = `${stem}.avif`;
  const small = `${stem}-small.avif`;
  try {
    await oneAtATime(async () => {
      sweepWork(work);
      mkdirSync(work, { recursive: true });
      writeFileSync(input, image);
      const result = await run(
        [config.ffmpeg, ...avifArgs(input, full, small)],
        {
          timeoutMs: CONVERT_TIMEOUT,
          stderr: true,
        },
      );
      if (result.code !== 0) {
        console.warn(
          `[clips] AVIF にできませんでした (code ${result.code}): ${result.stderr.trim().split("\n").slice(-3).join(" / ")}`,
        );
        throw new ClipError(415, "画像を読めませんでした");
      }
    });

    const takenAt = now();
    const text = captionsText(captions);
    const bytes = statSync(full).size + statSync(small).size;
    /*
     * **行を足すのと置き場へ移すのは1つのトランザクションで。** 名前は ID で決まるので行を先に足すが、
     * 移せなかった (途中で落ちた) ときに、名前の無い行を残さない
     */
    const row = orm().transaction((tx) => {
      const added = tx
        .insert(clips)
        .values({
          ...scene,
          taken_at: takenAt,
          captions: text,
          search_text: searchable(
            [scene.program_name, scene.service_name, text].join("\n"),
          ),
          width: info.width - (info.width % 2),
          height: info.height - (info.height % 2),
          bytes,
        })
        .returning()
        .get();
      const file = clipFile(added.id, takenAt);
      try {
        mkdirSync(dirname(clipPath(file)), { recursive: true });
        renameSync(full, clipPath(file));
        renameSync(small, clipPath(file, true));
      } catch (error) {
        removeIfExists(clipPath(file));
        throw error;
      }
      tx.update(clips).set({ file }).where(eq(clips.id, added.id)).run();
      return { ...added, file };
    });
    return toClip({ ...row, alive: row.recording_id });
  } finally {
    rmSync(input, { force: true });
    rmSync(full, { force: true });
    rmSync(small, { force: true });
  }
}

/**
 * `/api/clips/<id>` 系の前置き。id を確かめて1枚引く。数字でなければ 400、無ければ 404
 */
export function clipOr404(idLike: string): Clip & { file: string } {
  const id = Number(idLike);
  if (!Number.isSafeInteger(id) || id <= 0) error(400, "切り抜きIDが不正です");
  const clip = clipById(id);
  if (clip === undefined) error(404, "切り抜きが見つかりません");
  return clip;
}

/** 1枚引く。無ければ undefined */
export function clipById(id: number): (Clip & { file: string }) | undefined {
  const row = orm()
    .select({ ...clipColumns(), alive: ALIVE })
    .from(clips)
    .where(and(eq(clips.id, id), ne(clips.file, "")))
    .get();
  return row === undefined ? undefined : { ...toClip(row), file: row.file };
}

function clipColumns() {
  return {
    id: clips.id,
    taken_at: clips.taken_at,
    place: clips.place,
    recording_id: clips.recording_id,
    service_id: clips.service_id,
    event_id: clips.event_id,
    program_start_at: clips.program_start_at,
    program_name: clips.program_name,
    service_name: clips.service_name,
    offset_ms: clips.offset_ms,
    captions: clips.captions,
    search_text: clips.search_text,
    file: clips.file,
    width: clips.width,
    height: clips.height,
    bytes: clips.bytes,
  };
}

/** `YYYY-MM-DD` の日の始めと終わり (サーバの時計) */
function dayRange(day: string): [number, number] {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

/** 条件を SQL に。言葉は空白で区切った語を**すべて**含むもの (揃えた文字で比べる) */
export function clipConditions(query: ClipQuery): SQL[] {
  const where: SQL[] = [ne(clips.file, "")];
  for (const word of searchWords(searchQuery(query.q)))
    where.push(sql`instr(${clips.search_text}, ${word}) > 0`);
  if (query.service !== undefined)
    where.push(eq(clips.service_id, query.service));
  if (query.recording !== undefined)
    where.push(eq(clips.recording_id, query.recording));
  if (query.kind === "live") where.push(eq(clips.place, "live"));
  if (query.kind === "recorded") where.push(ne(clips.place, "live"));
  if (query.day !== undefined) {
    const [from, to] = dayRange(query.day);
    where.push(gte(clips.taken_at, from), lt(clips.taken_at, to));
  }
  return where;
}

/**
 * 探す。新しい順に `CLIP_PAGE` 件ずつ。**続きは ID で切る** (キーセット)。ID は受け取った順に増えるので、
 * 撮った時刻の順と同じ。`next` は次のページの `before` (もう無ければ null)
 */
export function findClips(query: ClipQuery): {
  clips: Clip[];
  next: number | null;
} {
  const where = clipConditions(query);
  if (query.before !== undefined) where.push(lt(clips.id, query.before));
  const rows = orm()
    .select({ ...clipColumns(), alive: ALIVE })
    .from(clips)
    .where(and(...where))
    .orderBy(desc(clips.id))
    .limit(CLIP_PAGE + 1)
    .all();
  const page = rows.slice(0, CLIP_PAGE).map(toClip);
  return {
    clips: page,
    next: rows.length > CLIP_PAGE ? page.at(-1)!.id : null,
  };
}

/** 絞り込みの手がかり (画面のサイドバー)。局ごとの枚数・撮った日・使っている量 */
export interface ClipFacets {
  count: number;
  bytes: number;
  services: { id: number; name: string; count: number }[];
  /** 撮った日 (`YYYY-MM-DD`。サーバの時計の日付) と、その日の枚数。新しい順 */
  days: { day: string; count: number }[];
}

export function clipFacets(): ClipFacets {
  const live = ne(clips.file, "");
  const total = orm()
    .select({
      count: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${clips.bytes}), 0)`,
    })
    .from(clips)
    .where(live)
    .get() ?? { count: 0, bytes: 0 };
  const byService = orm()
    .select({
      id: clips.service_id,
      // 局名は撮ったときのもの。いちばん新しい1枚の名前で出す
      name: sql<string>`(SELECT service_name FROM clips c2 WHERE c2.service_id = ${clips.service_id} AND c2.file <> '' ORDER BY c2.id DESC LIMIT 1)`,
      count: sql<number>`count(*)`,
    })
    .from(clips)
    .where(live)
    .groupBy(clips.service_id)
    .orderBy(desc(sql`count(*)`))
    .all();
  // 日付はサーバの時計で (日付の絞り込み `dayRange` と同じ。DB の localtime もサーバの TZ を読む)
  const day = sql<string>`strftime('%Y-%m-%d', ${clips.taken_at} / 1000, 'unixepoch', 'localtime')`;
  const days = orm()
    .select({ day, count: sql<number>`count(*)` })
    .from(clips)
    .where(live)
    .groupBy(day)
    .orderBy(desc(day))
    .all();
  return {
    count: total.count,
    bytes: total.bytes,
    services: byService,
    days,
  };
}

/** 録画の切り抜きの数 (録画の詳細の「この録画の切り抜き (n)」) */
export function clipCount(recordingId: number): number {
  return (
    orm()
      .select({ n: sql<number>`count(*)` })
      .from(clips)
      .where(and(eq(clips.recording_id, recordingId), ne(clips.file, "")))
      .get()?.n ?? 0
  );
}

/** 消す。画像と行を。消せた数を返す (もう無いものは数えない) */
export function deleteClips(ids: number[]): number {
  if (ids.length === 0) return 0;
  const rows = orm()
    .select({ id: clips.id, file: clips.file })
    .from(clips)
    .where(inArray(clips.id, ids))
    .all();
  for (const row of rows) {
    if (row.file === "") continue;
    removeIfExists(clipPath(row.file));
    removeIfExists(clipPath(row.file, true));
    pruneEmptyDirs(clipPath(row.file));
  }
  orm()
    .delete(clips)
    .where(
      inArray(
        clips.id,
        rows.map((row) => row.id),
      ),
    )
    .run();
  return rows.length;
}

/**
 * 画像を返す。他の API と同じ認証の内側で、**添付にはしない** (開けばそのまま映る)。
 * 同じ ID の画像は変わらない (ID は使い回さない) ので端末に持たせてよいが、世帯の外の
 * 共有のキャッシュには置かせない (`private`)。置き場に無ければ 404
 */
export function clipImage(file: string, small: boolean): Response {
  const path = clipPath(file, small);
  if (!existsSync(path)) error(404, "画像がありません");
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": "image/avif",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
