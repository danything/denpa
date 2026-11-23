import {
  type Dirent,
  existsSync,
  readdirSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { HW_CODECS, type HwCodec } from "#lib/hw.js";

import type { Recording } from "../types";
import { dropCaptionIndex, pruneCaptionIndex } from "./caption-index";
import { config } from "./config";
import { affected, now, orm } from "./db";
import { emit } from "./events";
import { pruneEmptyDirs, removeIfExists } from "./fsx";
import { encodedCandidates, encodedPaths, libraryCandidates } from "./library";
import { removeSidecars, SIDECAR_SUFFIXES } from "./metadata";
import {
  clips,
  cmMaterials,
  encodeJobs,
  recordings,
  reservations,
} from "./schema";

const SIDECAR_ORPHAN = new RegExp(
  `^(.+?)(?:${SIDECAR_SUFFIXES.map((suffix) => suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
  "i",
);

/**
 * 録画ファイルの実体まわり。
 *
 * 削除は denpa の画面からする。外から (ファイルマネージャや別のマシンから)
 * 消されることもあるので、DB と実体を突き合わせて消えたものを一覧から落とす仕組みも持つ。
 */

export function deleteRecordingFiles(
  recording: Recording,
  reason: string,
): void {
  // いくつものコーデックでエンコードしていれば最大 3 本ある。どれもサイドカーごと消す
  for (const path of encodedPaths(recording)) {
    removeIfExists(path);
    // サイドカー (サムネイル・データ放送・字幕) も一緒に。取り残すと片付かないゴミになる
    removeSidecars(path);
    pruneEmptyDirs(path);
  }
  removeIfExists(recording.ts_path);
  // 失敗した録画を消したときに理由を上書きすると、なぜ失敗したのかが分からなくなる。
  // 元の理由があるならそちらを残す
  orm()
    .update(recordings)
    .set({
      deleted_at: now(),
      library_path: null,
      hevc_path: null,
      alt_path: null,
      ts_path: null,
      error: sql`COALESCE(NULLIF(${recordings.error}, ''), ${reason})`,
      updated_at: now(),
    })
    .where(eq(recordings.id, recording.id))
    .run();
  // 字幕のインデックスも消す (消した録画は検索に出さない。`caption-index.ts`)
  dropCaptionIndex(recording.id);
  // 切り抜きは残す (撮ったときの番組名を持っている)。録画への行き先だけ外す
  orm()
    .update(clips)
    .set({ recording_id: null })
    .where(eq(clips.recording_id, recording.id))
    .run();
}

/**
 * 人が消す (画面の削除と `DELETE /api/recordings/<id>`)。**録画中は消さない** (使っているチューナーと
 * 書きかけのファイルが残る)。消したら `recordings` を通知し、開いているほかの画面の一覧も取り直させる
 *
 * @returns 録画中で消さなかったら false
 */
export function removeRecording(recording: Recording, reason: string): boolean {
  if (recording.finished_at === null) return false;
  deleteRecordingFiles(recording, reason);
  emit("recordings");
  return true;
}

/**
 * その置き場所を**他の録画**が現に使っているか (`library_path` / `hevc_path` / `alt_path`)。
 * はぐれファイルを片付けるとき、万一の同名衝突で他の録画を巻き添えにしないために見る
 */
export function usedByOther(path: string, recordingId: number): boolean {
  return (
    orm()
      .select({ id: recordings.id })
      .from(recordings)
      .where(
        and(
          or(
            eq(recordings.library_path, path),
            eq(recordings.hevc_path, path),
            eq(recordings.alt_path, path),
          ),
          ne(recordings.id, recordingId),
        ),
      )
      .get() !== undefined
  );
}

/**
 * 保存先の実体と DB を突き合わせる。**両方向を見る。**
 *
 * - **行はあるが実体が無い。** ファイルマネージャなど外から録画を消すと、DB には
 *   実体の無い行だけが残る。削除済みに倒して一覧から外す
 * - **実体はあるが行が無い。** 動画のサイドカー (作業ファイル・サムネイル・データ放送・字幕) は
 *   動画と同じ名前で隣に置くので、動画が消えたあとに取り残されることがある
 *
 * **動画そのものには触らない。** 行の無い動画は、手で置いたものかもしれない。
 * 数だけ数えて、消すかどうかは人が決める。
 *
 * **保存先に繋がっていない回は、行を書き換えない** (`unreachable`)。保存先そのものが開けないか、
 * 2 本以上ある録画が 1 本も見つからない回をそう読む。「全部消された」と読むと、録画が全部削除済みになり、元の TS まで消す。
 * NAS に置いて、NAS の資格情報を持たないユーザー (Windows の SYSTEM) で動かしたときに起きていた。
 * 録画が 1 本だけなら、外から消したものとして削除済みにする (2 本以上を外から全部消したのは、外れたマウントと見分けられない)。
 * 削除済みにした録画のファイルが置き場に戻っていれば、行を戻す (`restoreFound`)
 */
export function reconcile(): {
  checked: number;
  removed: number;
  restored: number;
  unreachable: boolean;
  swept: number;
  strays: number;
  pruned: number;
} {
  const restored = restoreFound();
  const placed = orm()
    .select()
    .from(recordings)
    .where(
      and(isNotNull(recordings.library_path), isNull(recordings.deleted_at)),
    )
    .all();
  const unreachable =
    placed.length > 0 &&
    (!existsSync(config.encodedDir) ||
      (placed.length > 1 &&
        !placed.some((recording) =>
          encodedPaths(recording).some((path) => existsSync(path)),
        )));
  if (unreachable)
    console.warn(
      `[files] 保存先 (${config.encodedDir}) に録画が 1 本も見つかりません。保存先に繋がっていないとみて、削除済みにしません`,
    );

  let removed = 0;
  /** 行を書き換えたか。開いている画面に知らせる (定期チェックでも、押したときでも) */
  let changed = restored > 0;
  for (const recording of unreachable ? [] : placed) {
    // 主でないもの (H.265・H.264) だけが外から消えたら、その控えだけ外す。主は無事なので録画は残る
    let hevc = recording.hevc_path;
    let alt = recording.alt_path;
    for (const [column, path] of [
      ["hevc_path", hevc],
      ["alt_path", alt],
    ] as const) {
      if (path === null || existsSync(path)) continue;
      orm()
        .update(recordings)
        .set({ [column]: null, updated_at: now() })
        .where(eq(recordings.id, recording.id))
        .run();
      removeSidecars(path);
      changed = true;
      if (column === "hevc_path") hevc = null;
      else alt = null;
      console.log(
        `[files] 控えが保存先から消えていたので外しました: ${recording.name}`,
      );
    }
    if (existsSync(recording.library_path!)) continue;
    /*
     * **主が外から消えても、もう一方が残っていれば繰り上げる** (H.265 が先、無ければ H.264。小さいほうを主にする
     * 順と同じ)。いくつものコーデックでエンコードした録画で、外から AV1 のほうだけ消されたときに録画ごと
     * 消してしまわないため。どれも無ければ、いつもどおり削除済みに倒す
     */
    const next = hevc ?? alt;
    if (next !== null) {
      orm()
        .update(recordings)
        .set({
          library_path: next,
          hevc_path: next === hevc ? null : hevc,
          alt_path: next === alt ? null : alt,
          updated_at: now(),
        })
        .where(eq(recordings.id, recording.id))
        .run();
      console.log(`[files] 主が消えたので繰り上げました: ${recording.name}`);
      changed = true;
      continue;
    }
    deleteRecordingFiles(recording, MISSING);
    removed++;
    changed = true;
    console.log(
      `[files] 保存先から消えていたので削除済みにしました: ${recording.name}`,
    );
  }

  if (changed) emit("recordings");

  const left = sweepLeftovers();
  return { checked: placed.length, removed, restored, unreachable, ...left };
}

/** 照合が削除済みにした録画に付ける理由 (戻したら外す) */
const MISSING = "保存先から消えていました";

/**
 * **削除済みにした録画のうち、置き場の決まった名前のファイルが在るものを戻す。** 行は消してから 2 週間残る
 * (`pruneHistory`) ので、その間に保存先に繋がれば一覧に戻る。
 *
 * 探すのは置くときと同じ名前 (`libraryCandidates`) で、エンコードしたもの (`encodedCandidates`) が先、無ければ
 * エンコードせずに置いた元の TS。主は AV1 → H.265 → H.264 の先頭 (`encoder.ts` と同じ)。
 * 画面から消した録画はファイルも消してあるので当たらない。ほかの録画が使っている名前も取らない。
 * 引き継いだ録画 (EPGStation・EDCB の名前のまま置いたもの) は名前が違うので戻らない。
 * 元の TS の置き場 (`ts_path`) と切り抜きの行き先は、削除済みにしたときに外したので戻らない
 */
function restoreFound(): number {
  const rows = orm()
    .select()
    .from(recordings)
    .where(
      and(
        isNotNull(recordings.deleted_at),
        isNull(recordings.library_path),
        isNotNull(recordings.finished_at),
      ),
    )
    .all();
  let restored = 0;
  for (const row of rows) {
    const find = (paths: string[]) =>
      paths.find((path) => existsSync(path) && !usedByOther(path, row.id)) ??
      null;
    const encoded = HW_CODECS.map((codec) => ({
      codec,
      path: find(encodedCandidates(row, codec)),
    })).filter((found) => found.path !== null);
    const primary =
      encoded[0]?.path ??
      find([".m2ts", ".mmts"].flatMap((ext) => libraryCandidates(row, ext)));
    if (primary === null) continue;
    const secondary = (codec: HwCodec) =>
      encoded.find((found) => found.codec === codec && found.path !== primary)
        ?.path ?? null;
    orm()
      .update(recordings)
      .set({
        library_path: primary,
        hevc_path: secondary("hevc"),
        alt_path: secondary("h264"),
        deleted_at: null,
        error: sql`NULLIF(${recordings.error}, ${MISSING})`,
        updated_at: now(),
      })
      .where(eq(recordings.id, row.id))
      .run();
    restored++;
    console.log(
      `[files] 削除済みにした録画が保存先で見つかったので戻しました: ${row.name}`,
    );
  }
  return restored;
}

/** 動画そのものの拡張子。これの隣に置くものが「サイドカー」 */
const VIDEO_EXTENSIONS = ["m2ts", "mmts", "ts", "mkv", "mp4"];
const VIDEO = new RegExp(`\\.(?:${VIDEO_EXTENSIONS.join("|")})$`, "i");
/** EPGStation の引き継ぎの書きかけ (`migrate.ts` の `temporaryPath`)。`.epgstation-12.m2ts.migrating` は下の `TRAILING` にも当たる */
export const MIGRATING = /^\.epgstation-\d+\..+\.migrating$/;
/** 作業ファイル。動画の名前をまるごと先頭に持つ (`….m2ts.chapters.txt`) */
const TRAILING = new RegExp(
  `^(.+\\.(?:${VIDEO_EXTENSIONS.join("|")}))\\.[^/]+$`,
  "i",
);
/**
 * **エンコードの作業ファイル。** 動画の名前のあとにジョブの番号を持つ (`encoder.ts`)。
 * 書いている間の `<動画>.<ジョブ>.<コーデック>.encoding` とその隣の `.post`・`.chapters.txt`、
 * チャプターの書き直しの `<動画>.<ジョブ>.post` と `<元の TS>.<ジョブ>.chapters.txt`。
 * 1 つめの括弧がジョブの番号
 */
const WORKING = new RegExp(
  `^.+\\.(?:${VIDEO_EXTENSIONS.join("|")})\\.(\\d+)\\.(?:[a-z0-9]+\\.encoding(?:\\.post|\\.chapters\\.txt)?|post|chapters\\.txt)$`,
  "i",
);

/**
 * 触らずに置いておく、書きたてのもの。
 *
 * **これから動画になるファイルを巻き添えにしないため。** 名前だけで
 * 「元の動画が無い」と決めているので、*まだ出来ていない動画*のサイドカーは
 * 全部そう見える。エンコードは出来上がるまで `<名前>.<jobId>.<codec>.encoding` に書いていて、
 * その `.mkv` はまだどこにも無い (消すと置き換えるところで `ENOENT ... rename` になる)。
 *
 * 書いている最中なら更新時刻が新しいので、そこで避ける。名前で除外しないのは、
 * 作業ファイルの名前がこの先も増えるため。**落ちて取り残されたものも、
 * しばらく経てば普通に片付く。**
 */
const SETTLE = 60 * 60_000;

/** まだ書いている最中かもしれないもの。**読めないものも触らない** */
function settling(path: string, at: number): boolean {
  try {
    return at - statSync(path).mtimeMs < SETTLE;
  } catch {
    return true;
  }
}

/**
 * 元の動画を失ったサイドカーを片付ける。
 *
 * サイドカーは**動画と同じ名前で隣に置く**決まりなので、名前から元の動画が分かる。
 *
 * - `<動画>.…` … 作業ファイル (`.chapters.txt` など)
 * - `<動画から拡張子を取ったもの>-poster.jpg` / `.bml.jsonl` / `.captions.json` … サムネイル・録画のデータ放送・4K の局の字幕 (`SIDECAR_SUFFIXES`)
 *
 * 元の TS を残さない設定だと、TS が消えたあともサイドカーだけが残り、録るたびに積もる。
 */
function sweepLeftovers(): { swept: number; strays: number; pruned: number } {
  const known = new Set(
    orm()
      .select({
        ts_path: recordings.ts_path,
        library_path: recordings.library_path,
        hevc_path: recordings.hevc_path,
        alt_path: recordings.alt_path,
      })
      .from(recordings)
      .all()
      .flatMap((row) => [
        ...(row.ts_path === null ? [] : [row.ts_path]),
        ...encodedPaths(row),
      ]),
  );

  /** 走っているエンコードのジョブ。その作業ファイルには触らない (`orphan`) */
  const running = new Set(
    orm()
      .select({ id: encodeJobs.id })
      .from(encodeJobs)
      .where(eq(encodeJobs.state, "running"))
      .all()
      .map((row) => row.id),
  );

  const at = now();
  let swept = 0;
  let strays = 0;
  for (const root of [config.rawDir, config.encodedDir]) {
    const { files } = walk(root);
    const videos = new Set(files.filter((path) => VIDEO.test(path)));
    for (const path of videos) {
      // 動画は消さない。手で置いたものかもしれないので、数えるだけ。
      // エンコードの途中で作る復号した TS (`<入力>.decoded.m2ts`) と、4K の録画を詰め替えた MP4 (`<入力>.remux.mp4`) を数に入れないよう、書きたては飛ばす
      if (!known.has(path) && !settling(path, at)) strays++;
    }
    for (const path of files) {
      if (videos.has(path)) continue;
      if (!orphan(path, videos, running)) continue;
      if (settling(path, at)) continue;
      removeIfExists(path);
      pruneEmptyDirs(path);
      swept++;
    }
  }

  /*
   * **すでに空のフォルダも消す。**
   *
   * 上の掃除は、ファイルを消したフォルダしか消さない。ファイルの無い
   * フォルダは `walk` のファイルの一覧に出ないので、**ずっと残る**。
   *
   * 深いものから試す。親は子が消えてはじめて空になる。**空でなければ
   * `rmdir` が失敗する**ので、中身の確認はしない。作りたては飛ばす
   * (エンコードがこれからファイルを置くところかもしれない)。
   *
   * **古さは消す前にまとめて見る。** 子を `rmdir` すると親の mtime が
   * いまになるので、消しながら見ると**自分の掃除で親が作りたてに見えて**
   * シリーズのフォルダだけ残る
   */
  const dirs = walk(config.encodedDir)
    .dirs.filter((dir) => !settling(dir, at))
    .sort((a, b) => b.length - a.length);
  let pruned = 0;
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
      pruned++;
    } catch {
      // 空でない。それが正常
    }
  }

  if (swept > 0)
    console.log(`[files] 元の動画の無いサイドカーを片付けました: ${swept} 件`);
  if (pruned > 0) console.log(`[files] 空のフォルダを消しました: ${pruned} 件`);
  return { swept, strays, pruned };
}

/**
 * サイドカーで、かつ元の動画が 1 つも無いか。
 *
 * **エンコードの作業ファイルは、動画があっても、そのジョブが走っていなければ片付ける** (`WORKING`)。
 * 再エンコードやチャプターの書き直しで落ちたものは、置き換える前の動画が同じ名前で残っているので、
 * 動画の有る無しだけで見ると片付けから外れていた。走っているジョブのものは、書き終えて別のコーデックを
 * エンコードしている間 (更新時刻が古くなる) も残す
 */
function orphan(
  path: string,
  videos: Set<string>,
  running: Set<number>,
): boolean {
  // 引き継ぎの書きかけは次の実行で続きから取るので触らない。片付けは引き継ぎがする (`migrate.sweepTemporaries`)
  if (MIGRATING.test(basename(path))) return false;
  const working = WORKING.exec(path);
  if (working?.[1] !== undefined) return !running.has(Number(working[1]));
  const trailing = TRAILING.exec(path);
  if (trailing?.[1] !== undefined) return !videos.has(trailing[1]);
  // サムネイル・データ放送・字幕。動画の拡張子を取り替えた名前 (metadata.ts の SIDECAR_SUFFIXES)
  const base = SIDECAR_ORPHAN.exec(path);
  if (base === null) return false;
  // どの入れ物で置いたかまでは名前から分からないので、当てはまるものを全部見る
  return !VIDEO_EXTENSIONS.some((extension) =>
    videos.has(`${base[1]}.${extension}`),
  );
}

/** 置き場の下を全部集める (ファイルとフォルダを分けて)。置き場がまだ無ければ空 */
function walk(
  dir: string,
  out = { files: [] as string[], dirs: [] as string[] },
): { files: string[]; dirs: string[] } {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.dirs.push(path);
      walk(path, out);
    } else out.files.push(path);
  }
  return out;
}

/**
 * 古い履歴を捨てる。
 *
 * 残すのは「録れたか」を後から確かめるためだけなので、期限を切って消す。
 * 対象は**終わった予約**と**消した録画の行**だけ。ファイルが残っているものには
 * 触らない (消すかどうかは人が決める)。
 */
export function pruneHistory(): {
  reservations: number;
  recordings: number;
  jobs: number;
} {
  const cutoff = now() - config.historyRetention;

  /*
   * 録画中や予約中のものは、いつ立てたかに関係なく残す。
   * 「終わった予約」は**取り消し・録り逃し・録画しない (コピー禁止) か、もう録り始めたもの**。
   * 録り始めたあとの顛末は録画の行が持っているので、予約側では見ない。
   * **録画の行が指している予約は残す。** 何で録れたか (ルール・手動) は予約の行から引くので
   * (`/` の一覧の `rule_id`、ルールの一覧の録れた数と最後に録れた日)、消すと 2 週間より前の録画がどれも引き継いだものと同じに見える。
   * 録画の行を消した (`deleted_at` から 2 週間たった) あとの回で消える
   */
  const droppedReservations = affected(
    orm()
      .delete(reservations)
      .where(
        and(
          or(
            inArray(reservations.state, ["canceled", "missed", "skipped"]),
            isNotNull(reservations.started_at),
          ),
          lt(reservations.end_at, cutoff),
          notInArray(
            reservations.id,
            orm()
              .select({ id: recordings.reservation_id })
              .from(recordings)
              .where(isNotNull(recordings.reservation_id)),
          ),
        ),
      ),
  );

  // 実体はもう無い (deleted_at が立つときに消してある)
  const droppedRecordings = affected(
    orm()
      .delete(recordings)
      .where(
        and(
          isNotNull(recordings.deleted_at),
          lt(recordings.deleted_at, cutoff),
        ),
      ),
  );

  // 録画の行を消したら、ぶら下がっていたエンコードの記録も要らない
  orm()
    .delete(encodeJobs)
    .where(
      notInArray(
        encodeJobs.recording_id,
        orm().select({ id: recordings.id }).from(recordings),
      ),
    )
    .run();
  /*
   * CM 検出の材料の控えも。スキーマの `onDelete: cascade` は外部キーを有効にしていない (`PRAGMA foreign_keys`) ので効かない。
   * 行を消すのはここと、録り始めてすぐやめた録画 (`recorder.skipDuplicate`。エンコードする前なので控えは無い) だけなので、ここで消す
   */
  orm()
    .delete(cmMaterials)
    .where(
      notInArray(
        cmMaterials.recording_id,
        orm().select({ id: recordings.id }).from(recordings),
      ),
    )
    .run();
  // 字幕のインデックスも (消すときに消しているはずのものの念のため。FTS5 の行を先に消す。`caption-index.pruneCaptionIndex`)
  pruneCaptionIndex();

  /*
   * 終わったエンコードの記録も期限を切る (録画の行が残っていても)。
   *
   * **いちばん新しい 1 件だけは残す。** 一覧はそれを見て
   * 「いま失敗しているか」を決めているため、消してしまうと状態が読めなくなる。
   */
  const jobs = affected(
    orm()
      .delete(encodeJobs)
      .where(
        and(
          inArray(encodeJobs.state, ["done", "failed", "canceled"]),
          lt(
            sql`COALESCE(${encodeJobs.finished_at}, ${encodeJobs.created_at})`,
            cutoff,
          ),
          notInArray(
            encodeJobs.id,
            orm()
              .select({ id: max(encodeJobs.id) })
              .from(encodeJobs)
              .groupBy(encodeJobs.recording_id),
          ),
        ),
      ),
  );

  if (droppedReservations > 0 || droppedRecordings > 0 || jobs > 0) {
    console.log(
      `[files] 古い履歴を片付けました: 予約 ${droppedReservations} 件 / 録画 ${droppedRecordings} 件 / エンコード ${jobs} 件`,
    );
  }
  return {
    reservations: droppedReservations,
    recordings: droppedRecordings,
    jobs,
  };
}
