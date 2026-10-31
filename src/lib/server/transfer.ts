import { Database } from "bun:sqlite";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import { and, asc, count, eq, gt } from "drizzle-orm";

import { pad, size as formatSize } from "../format";
import { config } from "./config";
import { bootstrap, closeDatabase, MIGRATIONS, orm } from "./db";
import { freeBytes } from "./disk";
import { recordedHistory, recordings, reservations, rules } from "./schema";
import { readTar, type TarSource, writeTar } from "./tar";

/**
 * **denpa を別の機械へ移す** (設定の「連携」の「denpa を別の機械へ移す」。docs/migrate.md「別の機械へ移す」)。
 *
 * 書き出すのは DB の写しとロゴの置き場 (`logos/`。局ロゴと CM 検出のために覚えたロゴ) だけ。
 * **録画のファイルは入れない** — 録画はユーザーがフォルダごと写す (denpa は録画をファイルとして持ち出す機能を持たない)。
 *
 * 取り込めるのは、まだ使っていない denpa だけ。送られたファイルを検証し、写しに drizzle の migrate を当て、
 * 録画のファイルが置き場にあるかを数えてから、次の起動の最初で入れ替える (`swapAtBoot`)。
 * 動いている DB を差し替えると、予約やエンコードの待ち行列などメモリにある状態が古いまま残るので、
 * 入れ替えはプロセスの起き直しに任せる。
 *
 * **形式のバージョンは持たない。** 中身を決めるのは写しの `__drizzle_migrations` だけで、上げるのは
 * 起動と同じ drizzle の migrate。`denpa-export.json` は画面に出すためだけで、無くても取り込める
 */

/** 書き出しのファイルの中の名前 */
const MANIFEST = "denpa-export.json";
const DB_ENTRY = "denpa.db";
const LOGOS = "logos";

/** 送るときの 1 回の大きさの上限。画面は 256 KiB ずつ送る (本文の上限 `BODY_SIZE_LIMIT` は既定 512K) */
export const CHUNK_LIMIT = 512 * 1024;
/** 送れるファイルの大きさの上限 (縮めたもの) */
const UPLOAD_LIMIT = 4 * 1024 ** 3;
/** 開いたときの中身の合計とエントリの数の上限。縮めたものが膨らみすぎるのを止める */
const EXTRACT_LIMITS = { maxBytes: 4 * 1024 ** 3, maxEntries: 50_000 };
/** 送りかけのまま放っておかれたものを消すまで */
const ABANDON_AFTER = 24 * 60 * 60_000;
/** 置き場に無い録画の一覧に出す数 */
const MISSING_LIST = 50;

export class TransferError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 書き出したときの控え (`denpa-export.json`)。画面に出すだけで、検証には使わない */
export interface Manifest {
  version: string;
  exportedAt: number;
  counts: Counts;
}

export interface Counts {
  rules: number;
  reservations: number;
  recordings: number;
  logos: number;
}

/** 送ったファイルの名乗り。同じファイルなら続きから送る */
export interface UploadMeta {
  name: string;
  size: number;
  lastModified: number;
}

/** 置き場の確かめ。**この機械の** `ENCODED_DIR`・`RAW_DIR` で引く */
export interface FileCheck {
  /** 削除済みでない録画のうち、ファイルがあったもの */
  present: number;
  /** エンコードしたものが無い (取り込むと起動直後の照合が削除済みにする) */
  missing: number;
  /** 元のTSだけの録画 (エンコード待ち・失敗・エンコードしない設定) で、TS が無いもの */
  rawMissing: number;
  /** 置き場の外の絶対パスで持っていて、そこに無いもの (Windows で書かれた古い行など) */
  outside: number;
  /** 待っているエンコードのうち、元のTSが無いもの */
  jobsMissing: number;
  /** 無いものの頭から (名前と DB にある場所) */
  list: { name: string; path: string }[];
}

export interface CheckResult {
  manifest: Manifest | null;
  counts: Counts;
  files: FileCheck;
  /** 無いものがあるか。あれば「取り込む」は 2 回押しにする */
  blocked: boolean;
}

export interface TransferStatus {
  exporting: boolean;
  /** まだ使っていない denpa か (取り込めるのはこのときだけ) */
  empty: boolean;
  upload: (UploadMeta & { received: number }) | null;
  /** 送ったファイルを開いて確かめ終えたか */
  prepared: boolean;
  /** 入れ替えを待っている (次の起動で入れ替わる) */
  ready: boolean;
  /** いちばん近い予約の始まり。書き出したあと古い denpa を止めてもらうために出す */
  nextReservation: number | null;
}

const root = () => join(config.dataDir, "transfer");
const uploadMeta = () => join(root(), "upload.json");
const uploadPart = () => join(root(), "upload.part");
const staging = () => join(root(), "staging");
const prepared = () => join(root(), "staging.json");
const ready = () => join(root(), "ready");

let exporting = false;
/** 開いて確かめている最中。2 つ同時に開かない */
let working = false;

/** 取り込みの途中か (送りかけ・確かめ終えて待っている・入れ替えを待っている) */
function importing(): boolean {
  return existsSync(uploadMeta()) || existsSync(join(ready(), DB_ENTRY));
}

/**
 * 書き出しか取り込みの途中か。**この間は EPGStation・EDCB の引き継ぎも断る** (1 回に 1 つだけ)
 */
export function busy(): boolean {
  return exporting || importing();
}

export const BUSY_MESSAGE =
  "denpa の書き出しか取り込みの途中です。取り込みをやめるなら「denpa を別の機械へ移す」の取消を押してください";

/**
 * まだ使っていないか。**録画・ルール・録画の履歴・手動予約が 1 件も無い**こと。
 * 番組表と局は入れたばかりでも持っているが、数えない (丸ごと置き換える)
 */
function isEmpty(): boolean {
  const one = (rows: { n: number } | undefined) => (rows?.n ?? 0) > 0;
  return !(
    one(orm().select({ n: count() }).from(recordings).get()) ||
    one(orm().select({ n: count() }).from(rules).get()) ||
    one(orm().select({ n: count() }).from(recordedHistory).get()) ||
    one(
      orm()
        .select({ n: count() })
        .from(reservations)
        .where(eq(reservations.manual, true))
        .get(),
    )
  );
}

function assertEmpty(): void {
  if (!isEmpty())
    throw new TransferError(
      409,
      "この denpa には録画・ルール・手動予約・録画の履歴のどれかがあります。取り込めるのは、まだ使っていない denpa だけです",
    );
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function status(): TransferStatus {
  const meta = readJson<UploadMeta>(uploadMeta());
  const next = orm()
    .select({ start_at: reservations.start_at })
    .from(reservations)
    .where(
      and(
        eq(reservations.state, "scheduled"),
        gt(reservations.start_at, Date.now()),
      ),
    )
    .orderBy(asc(reservations.start_at))
    .limit(1)
    .get();
  return {
    exporting,
    empty: isEmpty(),
    upload: meta === null ? null : { ...meta, received: received() },
    prepared: existsSync(prepared()),
    ready: existsSync(join(ready(), DB_ENTRY)),
    nextReservation: next?.start_at ?? null,
  };
}

// ---- 書き出す ----

/**
 * **DB の写しを取る。** 動いているまま `VACUUM INTO` で、読み取りのトランザクション 1 つぶんの
 * 一貫した写しを取る (録画やエンコードの書き込みは止めない。bun:sqlite は backup API を出していない)。
 * 写しからログインの控え (`sessions`) とペアリングの途中 (`device_codes`) を消し、`secure_delete` と
 * `VACUUM` で消した行の中身もファイルに残さない。
 *
 * **別のプロセスで回す。** 数百 MB の DB だと数秒かかり、その間この (1 本しかない) スレッドが止まると
 * ライブ視聴や画面が詰まる
 */
const SNAPSHOT = `
import { Database } from "bun:sqlite";
const from = process.env.DENPA_SNAPSHOT_FROM;
const to = process.env.DENPA_SNAPSHOT_TO;
const live = new Database(from, { readwrite: true, create: false });
live.exec("PRAGMA busy_timeout = 5000");
live.query("VACUUM INTO ?").run(to);
live.close();
const copy = new Database(to, { readwrite: true, create: false });
copy.exec("PRAGMA journal_mode = DELETE");
copy.exec("PRAGMA secure_delete = ON");
copy.exec("DELETE FROM sessions");
copy.exec("DELETE FROM device_codes");
copy.exec("VACUUM");
copy.close();
`;

async function snapshot(from: string, to: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "-e", SNAPSHOT], {
    env: { ...process.env, DENPA_SNAPSHOT_FROM: from, DENPA_SNAPSHOT_TO: to },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`DB の写しを取れませんでした: ${stderr.trim()}`);
}

/** ロゴの置き場の中で、書き出すもの (と、取り込むときに受け入れるもの) */
const LOGO_NAMES = [
  /^logos\/\d+\.png$/,
  /^logos\/satellite-relays\.json$/,
  /^logos\/cm\/\d+\/own-logo-\d+x\d+\.bin$/,
];
const LOGO_DIRS = [/^logos$/, /^logos\/cm$/, /^logos\/cm\/\d+$/];

/** 置き場の下のファイルを `logos/…` の名前で集める。書きかけ (`.writing`) などは外れる */
function logoFiles(dir: string, prefix = LOGOS): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    const entry = `${prefix}/${name}`;
    let folder: boolean;
    try {
      folder = statSync(path).isDirectory();
    } catch {
      // 読んでいる間に消えた (ロゴの書き直しと重なった)
      return [];
    }
    if (folder) return logoFiles(path, entry);
    return LOGO_NAMES.some((re) => re.test(entry)) ? [entry] : [];
  });
}

function countRows(db: Database): Omit<Counts, "logos"> {
  const n = (sql: string) => (db.query(sql).get() as { n: number }).n;
  return {
    rules: n("SELECT count(*) AS n FROM rules"),
    reservations: n(
      `SELECT count(*) AS n FROM reservations WHERE state = 'scheduled' AND started_at IS NULL`,
    ),
    recordings: n(
      "SELECT count(*) AS n FROM recordings WHERE deleted_at IS NULL",
    ),
  };
}

/**
 * `YYYYMMDD-HHmm` (書き出しのファイル名)。`seconds` なら秒まで付ける
 * (入れ替えで退けた先の名前。同じ分に 2 回取り込んでも重ねない)
 */
function stamp(at: number, seconds = false): string {
  const d = new Date(at);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${seconds ? pad(d.getSeconds()) : ""}`;
}

/**
 * 書き出す。tar を zstd で縮めながら流す。受け手が読み終える (かやめる) と、写しを消す。
 * 1 回に 1 つだけ。取り込みの途中も断る
 */
export async function exportArchive(): Promise<{
  stream: ReadableStream<Uint8Array>;
  filename: string;
}> {
  if (exporting) throw new TransferError(409, "書き出しの途中です");
  if (importing()) throw new TransferError(409, BUSY_MESSAGE);
  exporting = true;
  const at = Date.now();
  const work = join(root(), `export-${at}`);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(work, { recursive: true, force: true });
    exporting = false;
  };
  try {
    mkdirSync(work, { recursive: true });
    const db = join(work, DB_ENTRY);
    await snapshot(config.dbPath, db);

    /*
     * ロゴも写しを取ってから流す。動いている denpa は書き出しの間にもロゴを書き直すので
     * (別名に書いて置き換える)、流している途中で大きさが変わらないように
     */
    const logos = logoFiles(join(config.dataDir, LOGOS)).filter((name) => {
      try {
        mkdirSync(dirname(join(work, name)), { recursive: true });
        copyFileSync(join(config.dataDir, name), join(work, name));
        return true;
      } catch {
        return false;
      }
    });
    const copy = new Database(db, { readonly: true });
    let counts: Counts;
    try {
      counts = {
        ...countRows(copy),
        logos: logos.filter((name) => name.endsWith(".png")).length,
      };
    } finally {
      copy.close();
    }
    const manifest: Manifest = {
      version: config.version,
      exportedAt: at,
      counts,
    };
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify(manifest, null, 2),
    );
    const file = (name: string, path: string): TarSource => ({
      name,
      size: statSync(path).size,
      body: () => Bun.file(path).stream(),
    });
    const entries: TarSource[] = [
      {
        name: MANIFEST,
        size: manifestBytes.length,
        body: () => new Blob([manifestBytes]).stream(),
      },
      file(DB_ENTRY, db),
      ...logos.map((name) => file(name, join(work, name))),
    ];

    const reader = writeTar(entries, at)
      .pipeThrough(new CompressionStream("zstd" as CompressionFormat))
      .getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            cleanup();
          } else controller.enqueue(value);
        } catch (error) {
          cleanup();
          controller.error(error);
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason);
      },
    });
    return { stream, filename: `denpa-export-${stamp(at)}.tar.zst` };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---- 送る ----

function received(): number {
  try {
    return statSync(uploadPart()).size;
  } catch {
    return 0;
  }
}

/** 送られたものと、確かめるために開いたものを消す (入れ替えを待っている `ready` は残す) */
function clearUpload(): void {
  for (const path of [uploadMeta(), uploadPart(), prepared()])
    rmSync(path, { force: true });
  rmSync(staging(), { recursive: true, force: true });
}

/** 取り込みのために置いたものを全部消す (書き出しの写しには触らない) */
function clearImport(): void {
  clearUpload();
  rmSync(ready(), { recursive: true, force: true });
}

/**
 * 送り始める。**同じファイル (名前・大きさ・更新時刻) を送りかけていれば、続きの位置を返す**
 * (画面を開き直しても続きから送れる)。違うファイルなら前のものを消して頭から
 */
export function beginUpload(meta: UploadMeta): {
  offset: number;
  prepared: boolean;
} {
  if (exporting) throw new TransferError(409, "書き出しの途中です");
  if (working) throw new TransferError(409, "確かめている最中です");
  if (existsSync(join(ready(), DB_ENTRY)))
    throw new TransferError(
      409,
      "取り込みはもう決まっていて、再起動を待っています",
    );
  assertEmpty();
  if (!Number.isFinite(meta.lastModified))
    throw new TransferError(400, "ファイルの更新時刻が読めません");
  if (
    !Number.isSafeInteger(meta.size) ||
    meta.size <= 0 ||
    meta.size > UPLOAD_LIMIT
  )
    throw new TransferError(
      400,
      `ファイルの大きさが読めないか、大きすぎます (${formatSize(UPLOAD_LIMIT)} まで)`,
    );

  const current = readJson<UploadMeta>(uploadMeta());
  if (
    current !== null &&
    current.name === meta.name &&
    current.size === meta.size &&
    current.lastModified === meta.lastModified
  ) {
    return { offset: received(), prepared: existsSync(prepared()) };
  }

  clearImport();
  mkdirSync(root(), { recursive: true });
  /*
   * **送る前に空きを見る。** 送ったもの・開いたもの・migrate を当てる写しで、ファイルの 3 倍ほど要る
   * (縮めてあるので開くと大きくなるが、DB は縮みにくい)
   */
  const free = freeBytes(root());
  if (free !== null && free < meta.size * 3)
    throw new TransferError(
      409,
      `DB の置き場の空きが足りません (要る量の目安 ${formatSize(meta.size * 3)}、空き ${formatSize(free)})`,
    );
  writeFileSync(
    uploadMeta(),
    JSON.stringify({
      name: String(meta.name),
      size: meta.size,
      lastModified: meta.lastModified,
    } satisfies UploadMeta),
  );
  writeFileSync(uploadPart(), new Uint8Array(0));
  return { offset: 0, prepared: false };
}

/**
 * 続きを足す。**`offset` が今の大きさと合わなければ足さずに今の大きさを返す** (409)。
 * 途中で切れたら、画面はそこから送り直す
 */
export function appendUpload(
  offset: number,
  chunk: Uint8Array,
): { offset: number } {
  const meta = readJson<UploadMeta>(uploadMeta());
  if (meta === null)
    throw new TransferError(
      409,
      "送りかけのファイルがありません。初めから選び直してください",
    );
  const have = received();
  if (offset !== have) throw new OffsetMismatch(have);
  if (chunk.length === 0 || chunk.length > CHUNK_LIMIT)
    throw new TransferError(400, "送る大きさが読めません");
  if (have + chunk.length > meta.size)
    throw new TransferError(400, "名乗った大きさより多く送られました");
  appendFileSync(uploadPart(), chunk);
  return { offset: have + chunk.length };
}

/** 送る位置が食い違った。今の位置を返して、そこから送り直してもらう */
export class OffsetMismatch extends TransferError {
  constructor(readonly offset: number) {
    super(409, "送る位置が食い違いました");
  }
}

// ---- 開いて確かめる ----

/** 写しの migrate がどこまで当たっているか (いちばん新しいものの時刻)。表が無ければ null */
function appliedUpTo(db: Database): number | null {
  const table = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get();
  if (table === null) return null;
  const row = db
    .query("SELECT max(created_at) AS at FROM __drizzle_migrations")
    .get() as { at: number | null };
  return row.at;
}

/** このバージョンが持っている、いちばん新しいマイグレーションの時刻 (`drizzle/meta/_journal.json`) */
function latestMigration(): number {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as { entries: { when: number }[] };
  return Math.max(...journal.entries.map((entry) => entry.when));
}

/** sqlite_master のうち、名前と SQL まで同じであってほしいもの (トリガーとビュー) */
function triggersAndViews(db: Database): string[] {
  return (
    db
      .query(
        "SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY type, name",
      )
      .all() as { type: string; name: string; sql: string | null }[]
  ).map((row) => `${row.type} ${row.name}: ${row.sql ?? ""}`);
}

/**
 * 送られたファイルを開いて、使ってよい写しかを確かめる。
 *
 * 1. tar を開く。**普通のファイルとフォルダだけ、名前は決めたものだけ** (`readTar` と下の名前の一覧)
 * 2. 写しのほうが新しいバージョンの DB なら断る (drizzle の migrate は自分より新しいものを黙って
 *    素通しし、列の確かめも余分な列では止まらないので、ここで見ないと壊れたまま動く)
 * 3. 起動と同じ `bootstrap` (migrate と列の確かめ) を写しに当てる。古い形を読む層は持たない
 * 4. 整合性・外部キー、トリガーとビューが空の DB に migrate を当てたものと同じか
 *    (手で足したトリガーやビューは、入れ替えたあとの書き込みのたびに動いてしまう)
 */
async function prepare(): Promise<void> {
  rmSync(staging(), { recursive: true, force: true });
  rmSync(prepared(), { force: true });
  mkdirSync(staging(), { recursive: true });

  try {
    await readTar(
      Bun.file(uploadPart())
        .stream()
        .pipeThrough(new DecompressionStream("zstd" as CompressionFormat)),
      EXTRACT_LIMITS,
      (entry) => {
        if (entry.type === "dir") {
          if (!LOGO_DIRS.some((re) => re.test(entry.name)))
            throw new Error(
              `思っていないフォルダ (${JSON.stringify(entry.name)}) が入っています`,
            );
          return null;
        }
        if (
          entry.name !== MANIFEST &&
          entry.name !== DB_ENTRY &&
          !LOGO_NAMES.some((re) => re.test(entry.name))
        )
          throw new Error(
            `思っていない名前 (${JSON.stringify(entry.name)}) が入っています`,
          );
        const path = join(staging(), entry.name);
        mkdirSync(dirname(path), { recursive: true });
        // 同じ名前が 2 つあれば、2 つめで断る (`wx`)
        const fd = openSync(path, "wx");
        return {
          write: (chunk) => {
            for (let at = 0; at < chunk.length;)
              at += writeSync(fd, chunk, at, chunk.length - at);
          },
          close: () => closeSync(fd),
        };
      },
    );
  } catch (error) {
    // 空きが無いなど、ファイルのせいでない失敗はそのまま (送ったものは消さない)
    if ((error as NodeJS.ErrnoException).code !== undefined) throw error;
    throw new TransferError(
      400,
      `denpa の書き出したファイルとして読めません: ${(error as Error).message}`,
    );
  }

  const dbPath = join(staging(), DB_ENTRY);
  if (!existsSync(dbPath))
    throw new TransferError(
      400,
      "denpa の書き出したファイルではありません (DB が入っていません)",
    );
  const head = new Uint8Array(
    await Bun.file(dbPath).slice(0, 16).arrayBuffer(),
  );
  if (new TextDecoder().decode(head) !== "SQLite format 3\u0000")
    throw new TransferError(
      400,
      "入っている DB が SQLite のファイルではありません",
    );
  const manifest = readJson<Manifest>(join(staging(), MANIFEST));

  let db: Database;
  try {
    db = new Database(dbPath, { readwrite: true, create: false });
  } catch (error) {
    throw new TransferError(
      400,
      `DB を開けません: ${(error as Error).message}`,
    );
  }
  try {
    // 写しに仕込まれた関数呼び出しのあるビューやトリガーを、確かめる前に動かさない
    db.exec("PRAGMA trusted_schema = OFF");
    db.exec("PRAGMA journal_mode = DELETE");

    let applied: number | null;
    try {
      applied = appliedUpTo(db);
    } catch (error) {
      throw new TransferError(
        400,
        `DB が読めません: ${(error as Error).message}`,
      );
    }
    if (applied !== null && applied > latestMigration()) {
      const from =
        manifest?.version !== undefined && manifest.version !== "dev"
          ? `denpa ${manifest.version} 以上`
          : "書き出した denpa と同じか新しいバージョン";
      throw new TransferError(
        409,
        `この denpa より新しいバージョンで書き出されたファイルです。${from}に上げてから取り込んでください`,
      );
    }

    try {
      bootstrap(db);
    } catch (error) {
      throw new TransferError(400, (error as Error).message);
    }

    const integrity = db.query("PRAGMA integrity_check").all() as {
      integrity_check: string;
    }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw new TransferError(
        400,
        `DB が壊れています (${integrity
          .slice(0, 3)
          .map((row) => row.integrity_check)
          .join(" / ")})`,
      );
    if (db.query("PRAGMA foreign_key_check").all().length > 0)
      throw new TransferError(400, "DB の行どうしの繋がりが壊れています");

    const fresh = new Database(":memory:");
    try {
      bootstrap(fresh);
      const want = triggersAndViews(fresh);
      const have = triggersAndViews(db);
      if (JSON.stringify(want) !== JSON.stringify(have))
        throw new TransferError(
          400,
          "DB に denpa の作らないトリガーかビューがあります",
        );
    } finally {
      fresh.close();
    }
  } finally {
    db.close();
  }

  writeFileSync(prepared(), JSON.stringify({ manifest, at: Date.now() }));
}

/** DB にある場所を、この機械の置き場で引く。置き場の外の絶対パスはそのまま */
function locate(raw: string, base: string): { path: string; outside: boolean } {
  if (!isAbsolute(raw)) return { path: join(base, raw), outside: false };
  const rel = relative(base, raw);
  return {
    path: raw,
    outside: rel === "" || rel.startsWith("..") || isAbsolute(rel),
  };
}

/** 写しの件数と、録画のファイルが置き場にあるか */
function inspect(): CheckResult {
  const manifest =
    readJson<{ manifest: Manifest | null }>(prepared())?.manifest ?? null;
  const db = new Database(join(staging(), DB_ENTRY), { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT name, ts_path, library_path, hevc_path, alt_path, finished_at FROM recordings
         WHERE deleted_at IS NULL ORDER BY start_at`,
      )
      .all() as {
      name: string;
      ts_path: string | null;
      library_path: string | null;
      hevc_path: string | null;
      alt_path: string | null;
      finished_at: number | null;
    }[];
    const files: FileCheck = {
      present: 0,
      missing: 0,
      rawMissing: 0,
      outside: 0,
      jobsMissing: 0,
      list: [],
    };
    const note = (name: string, path: string) => {
      if (files.list.length < MISSING_LIST) files.list.push({ name, path });
    };
    for (const row of rows) {
      if (row.library_path !== null) {
        const main = locate(row.library_path, config.encodedDir);
        // 主が無くても、もう一方 (H.265・H.264) があれば観られる (照合で繰り上がる。`files.reconcile`)
        const others = [row.hevc_path, row.alt_path].flatMap((path) =>
          path === null ? [] : [locate(path, config.encodedDir)],
        );
        if (
          existsSync(main.path) ||
          others.some((other) => existsSync(other.path))
        ) {
          files.present++;
          continue;
        }
        if (main.outside) files.outside++;
        else files.missing++;
        note(row.name, row.library_path);
      } else if (row.ts_path !== null && row.finished_at !== null) {
        // 録り終えて、まだエンコードしていない (か、しない) もの。録画中の行は起動時に回収される
        const ts = locate(row.ts_path, config.rawDir);
        if (existsSync(ts.path)) {
          files.present++;
          continue;
        }
        if (ts.outside) files.outside++;
        else files.rawMissing++;
        note(row.name, row.ts_path);
      }
    }
    const jobs = db
      .query(
        `SELECT r.ts_path AS ts_path FROM encode_jobs j JOIN recordings r ON r.id = j.recording_id
         WHERE j.state IN ('queued', 'running') AND r.deleted_at IS NULL`,
      )
      .all() as { ts_path: string | null }[];
    files.jobsMissing = jobs.filter(
      (job) =>
        job.ts_path === null ||
        !existsSync(locate(job.ts_path, config.rawDir).path),
    ).length;

    const counts: Counts = {
      ...countRows(db),
      logos: logoFiles(join(staging(), LOGOS)).filter((name) =>
        name.endsWith(".png"),
      ).length,
    };
    return {
      manifest,
      counts,
      files,
      blocked:
        files.missing + files.rawMissing + files.outside + files.jobsMissing >
        0,
    };
  } finally {
    db.close();
  }
}

/**
 * 確かめる。送り終えていれば、初めの 1 回だけ開いて migrate を当て (`prepare`)、
 * 毎回、置き場と突き合わせる (録画のフォルダを写したあとの「もう一度確かめる」は送り直さずに済む)。
 * **使えないファイルなら、送ったものを消す**
 */
export async function check(): Promise<CheckResult> {
  if (working) throw new TransferError(409, "確かめている最中です");
  const meta = readJson<UploadMeta>(uploadMeta());
  if (meta === null) throw new TransferError(409, "送ったファイルがありません");
  if (received() !== meta.size)
    throw new TransferError(409, "まだ送り終えていません");
  assertEmpty();
  working = true;
  try {
    if (!existsSync(prepared())) {
      try {
        await prepare();
      } catch (error) {
        /*
         * 検証で断ったものは送ったものごと消す。空きが無いなどのそのほかの失敗は、開きかけだけ消して
         * 送ったものは残す (空けてから確かめ直せば、送り直さずに済む)
         */
        if (error instanceof TransferError) clearImport();
        else {
          rmSync(staging(), { recursive: true, force: true });
          rmSync(prepared(), { force: true });
        }
        throw error;
      }
    }
    return inspect();
  } finally {
    working = false;
  }
}

/**
 * 取り込む。写しとロゴを `ready/` に移し、次の起動の最初で入れ替える (`swapAtBoot`)。
 * 置き場に無い録画があれば、`force` が無い限り断る (無い行は起動直後の照合が削除済みにする)。
 * 呼んだ側がプロセスを終える (`restartSoon`)
 */
export function apply(force: boolean): CheckResult {
  if (working) throw new TransferError(409, "確かめている最中です");
  if (!existsSync(prepared()))
    throw new TransferError(409, "先に確かめてください");
  assertEmpty();
  const result = inspect();
  if (result.blocked && !force)
    throw new TransferError(
      409,
      "置き場に無い録画があります。録画のフォルダを写してからもう一度確かめてください",
    );

  rmSync(ready(), { recursive: true, force: true });
  mkdirSync(ready(), { recursive: true });
  writeFileSync(join(ready(), "stamp"), stamp(Date.now(), true));
  if (existsSync(join(staging(), LOGOS)))
    renameSync(join(staging(), LOGOS), join(ready(), LOGOS));
  // DB を最後に置く。`ready/denpa.db` があることが「入れ替えを待っている」印
  renameSync(join(staging(), DB_ENTRY), join(ready(), DB_ENTRY));
  clearUpload();
  console.log(
    "[transfer] 取り込む DB を置きました。再起動の最初で入れ替えます",
  );
  return result;
}

/** 取消。送ったもの・開いたもの・入れ替えを待っているものを消す */
export function cancel(): void {
  if (working) throw new TransferError(409, "確かめている最中です");
  clearImport();
}

/**
 * プロセスを終える。compose (`restart: unless-stopped`)・Helm (Pod の再起動) が起こし直し、
 * 起動の最初で入れ替わる。いつもの止まり方 (SIGTERM。`runtime.ts` の drain) で降りる。
 * 空の denpa なので録画を待つことはない
 */
export function restartSoon(): void {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
}

// ---- 起動の最初 ----

/**
 * **起動の最初 (DB とロゴに触る前) に入れ替える。** `ready/` があれば、今の DB (`-wal`・`-shm` も) と
 * `logos/` を `*.before-import-<時刻>` に退け、`ready/` のものを置く。
 *
 * 途中で落ちても、もう一度起動すれば同じ結果になる。退けた先が既にあれば退け直さず、
 * DB を最後に置く (`ready/denpa.db` が残っている間は、まだ終わっていない)
 */
export function swapAtBoot(): boolean {
  const dir = ready();
  const db = join(dir, DB_ENTRY);
  if (!existsSync(db)) {
    // 置き終えて消す前に落ちた跡
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    return false;
  }
  const at = readFileSync(join(dir, "stamp"), "utf8").trim() || "unknown";
  // 先にどこかが開いていても、古いファイルを掴んだままにしない
  closeDatabase();
  const logos = join(config.dataDir, LOGOS);
  const aside = (path: string) => {
    const to = `${path}.before-import-${at}`;
    if (existsSync(path) && !existsSync(to)) renameSync(path, to);
  };
  aside(logos);
  for (const suffix of ["", "-wal", "-shm"]) aside(`${config.dbPath}${suffix}`);
  if (existsSync(join(dir, LOGOS)) && !existsSync(logos))
    renameSync(join(dir, LOGOS), logos);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  renameSync(db, config.dbPath);
  rmSync(dir, { recursive: true, force: true });
  console.log(
    `[transfer] 取り込んだ DB とロゴに入れ替えました (前のものは *.before-import-${at})`,
  );
  return true;
}

/** 送りかけのまま 1 日たったものと、落ちて残った書き出しの写しを消す (`runtime.ts` の片付けの周期) */
export function pruneTransfer(): void {
  if (!existsSync(root())) return;
  if (!exporting) {
    for (const name of readdirSync(root()))
      if (name.startsWith("export-"))
        rmSync(join(root(), name), { recursive: true, force: true });
  }
  if (working || existsSync(join(ready(), DB_ENTRY))) return;
  try {
    if (Date.now() - statSync(uploadPart()).mtimeMs > ABANDON_AFTER) {
      clearImport();
      console.log("[transfer] 送りかけのまま 1 日たった取り込みを消しました");
    }
  } catch {
    // 送りかけは無い
  }
}
