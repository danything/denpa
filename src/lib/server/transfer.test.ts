import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { count } from "drizzle-orm";

/**
 * denpa を別の機械へ移す (`transfer.ts`)。
 *
 * 1 つのプロセスの中で「古い機械」と「新しい機械」を、DB とロゴの置き場 (`config.dbPath`・`config.dataDir`) を
 * 差し替えて作る。録画の置き場 (`ENCODED_DIR`) も差し替えて、写したとき・写していないときを見る
 */
const { config } = await import("./config");
const work = mkdtempSync(join(tmpdir(), "denpa-transfer-"));

function machine(name: string): { data: string; encoded: string; raw: string } {
  const data = join(work, name, "data");
  const encoded = join(work, name, "encoded");
  const raw = join(work, name, "raw");
  for (const dir of [data, encoded, raw]) mkdirSync(dir, { recursive: true });
  return { data, encoded, raw };
}

let counter = 0;
/** その機械に切り替える (DB は次に使うときに開き直る) */
function use(where: { data: string; encoded: string; raw: string }): void {
  config.dbPath = join(where.data, "denpa.db");
  config.dataDir = where.data;
  config.cmLogoDir = join(where.data, "logos", "cm");
  config.encodedDir = where.encoded;
  config.rawDir = where.raw;
}

const { orm } = await import("./db");
const schema = await import("./schema");
const transfer = await import("./transfer");

const now = Date.now();

/** 古い機械に、移したいものを入れる */
function seedOld(where: ReturnType<typeof machine>): void {
  use(where);
  orm()
    .insert(schema.settings)
    .values({ key: "cmCut", value: '"cut"', updated_at: now })
    .run();
  orm()
    .insert(schema.rules)
    .values({ name: "移すルール", keyword: "移す", created_at: now })
    .run();
  mkdirSync(join(where.encoded, "シリーズ"), { recursive: true });
  writeFileSync(join(where.encoded, "シリーズ", "第1話.mkv"), "video");
  orm()
    .insert(schema.recordings)
    .values({
      service_id: 1,
      name: "移す録画",
      start_at: now - 3_600_000,
      end_at: now - 1_800_000,
      finished_at: now - 1_800_000,
      library_path: join(where.encoded, "シリーズ", "第1話.mkv"),
      created_at: now,
      updated_at: now,
    })
    .run();
  orm()
    .insert(schema.sessions)
    .values({
      id: "cookie-value-secret",
      subject: "someone",
      created_at: now,
      expires_at: now + 3_600_000,
    })
    .run();
  orm()
    .insert(schema.apiTokens)
    .values({ name: "居間のテレビ", token_hash: "hash", created_at: now })
    .run();
  orm()
    .insert(schema.deviceCodes)
    .values({
      device_code_hash: "device-hash",
      user_code: "ABCD-EFGH",
      name: "寝室のテレビ",
      created_at: now,
      expires_at: now + 600_000,
    })
    .run();
  mkdirSync(join(where.data, "logos", "cm", "1024"), { recursive: true });
  writeFileSync(join(where.data, "logos", "1024.png"), "png");
  writeFileSync(join(where.data, "logos", "1024.png.writing"), "half");
  writeFileSync(
    join(where.data, "logos", "cm", "1024", "own-logo-1440x1080.bin"),
    "model",
  );
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 新しい機械へ、画面と同じく小分けにして送る */
async function upload(bytes: Uint8Array, name = "denpa-export.tar.zst") {
  const meta = { name, size: bytes.length, lastModified: 1 };
  let { offset } = transfer.beginUpload(meta);
  const step = 256 * 1024;
  while (offset < bytes.length)
    ({ offset } = transfer.appendUpload(
      offset,
      bytes.subarray(offset, offset + step),
    ));
}

/** tar を自分で組んで縮める (壊れたもの・手を入れたものを作る) */
async function pack(
  files: Record<string, Uint8Array<ArrayBuffer> | string>,
): Promise<Uint8Array> {
  const { writeTar } = await import("./tar");
  const entries = Object.entries(files).map(([name, value]) => {
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : value;
    return { name, size: bytes.length, body: () => new Blob([bytes]).stream() };
  });
  return collect(
    writeTar(entries).pipeThrough(
      new CompressionStream("zstd" as CompressionFormat),
    ),
  );
}

let old: ReturnType<typeof machine>;
let exported: Uint8Array<ArrayBuffer>;
/** 書き出したものの中の DB (手を入れて送り直すときの元) */
let exportedDb: Uint8Array;

beforeEach(() => {
  counter++;
});

describe("書き出す", () => {
  test("DB の写しとロゴを書き出し、ログインの控えとペアリングの途中は外す", async () => {
    old = machine("old");
    seedOld(old);
    const { stream, filename } = await transfer.exportArchive();
    expect(filename).toMatch(/^denpa-export-\d{8}-\d{4}\.tar\.zst$/);
    exported = await collect(stream);

    const { readTar } = await import("./tar");
    const names: string[] = [];
    const files: Record<string, Uint8Array[]> = {};
    await readTar(
      new Blob([exported])
        .stream()
        .pipeThrough(new DecompressionStream("zstd" as CompressionFormat)),
      { maxBytes: 1024 ** 3, maxEntries: 100 },
      (entry) => {
        names.push(entry.name);
        const parts: Uint8Array[] = (files[entry.name] = []);
        return { write: (c) => parts.push(c.slice()), close: () => {} };
      },
    );
    // 書きかけのロゴは入れない。録画のファイルも入れない
    expect(names.sort()).toEqual([
      "denpa-export.json",
      "denpa.db",
      "logos/1024.png",
      "logos/cm/1024/own-logo-1440x1080.bin",
    ]);
    const manifest = JSON.parse(
      new TextDecoder().decode(Buffer.concat(files["denpa-export.json"]!)),
    );
    expect(manifest.counts).toEqual({
      rules: 1,
      reservations: 0,
      recordings: 1,
      logos: 1,
    });

    exportedDb = Buffer.concat(files["denpa.db"]!);
    const path = join(work, "exported.db");
    writeFileSync(path, exportedDb);
    const db = new Database(path, { readonly: true });
    const n = (table: string) =>
      (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(n("sessions")).toBe(0);
    expect(n("device_codes")).toBe(0);
    // アクセストークン (ハッシュだけ) は持っていく
    expect(n("api_tokens")).toBe(1);
    expect(n("rules")).toBe(1);
    db.close();
    // 消した行の中身もファイルに残さない
    expect(Buffer.from(exportedDb).includes("cookie-value-secret")).toBe(false);
    // 写しは消えている
    expect(
      readdirSync(join(old.data, "transfer")).filter((n) =>
        n.startsWith("export-"),
      ),
    ).toEqual([]);
  });

  test("書き出しの途中はもう 1 つ書き出せない", async () => {
    use(old);
    const first = await transfer.exportArchive();
    expect(transfer.busy()).toBe(true);
    await expect(transfer.exportArchive()).rejects.toThrow("書き出しの途中");
    await first.stream.cancel();
    expect(transfer.busy()).toBe(false);
  });
});

describe("取り込む", () => {
  test("使っている denpa には取り込めない", () => {
    use(old);
    expect(() =>
      transfer.beginUpload({ name: "a", size: 10, lastModified: 1 }),
    ).toThrow("まだ使っていない denpa だけ");
  });

  test("録画のフォルダを写していなければ止め、2 回押したときだけ進める", async () => {
    const fresh = machine(`fresh-${counter}`);
    use(fresh);
    await upload(exported);
    const result = await transfer.check();
    expect(result.counts.rules).toBe(1);
    expect(result.files.missing).toBe(1);
    expect(result.files.list).toEqual([
      { name: "移す録画", path: "シリーズ/第1話.mkv" },
    ]);
    expect(result.blocked).toBe(true);
    expect(() => transfer.apply(false)).toThrow("置き場に無い録画があります");

    // 写したら「もう一度確かめる」で通る (送り直さない)
    mkdirSync(join(fresh.encoded, "シリーズ"), { recursive: true });
    writeFileSync(join(fresh.encoded, "シリーズ", "第1話.mkv"), "video");
    const again = await transfer.check();
    expect(again.blocked).toBe(false);
    expect(again.files.present).toBe(1);
    transfer.cancel();
    expect(transfer.busy()).toBe(false);

    // 写さないまま 2 回押しで進めることもできる
    const other = machine(`fresh-force-${counter}`);
    use(other);
    await upload(exported);
    expect((await transfer.check()).blocked).toBe(true);
    transfer.apply(true);
    expect(existsSync(join(other.data, "transfer", "ready", "denpa.db"))).toBe(
      true,
    );
    transfer.cancel();
  });

  test("取り込むと、次の起動で入れ替わる", async () => {
    const fresh = machine(`fresh-${counter}`);
    // 写し終えた置き場
    mkdirSync(join(fresh.encoded, "シリーズ"), { recursive: true });
    writeFileSync(join(fresh.encoded, "シリーズ", "第1話.mkv"), "video");
    use(fresh);
    // 新しい機械が自分で集めたロゴ (入れ替えで退ける)
    mkdirSync(join(fresh.data, "logos"), { recursive: true });
    writeFileSync(join(fresh.data, "logos", "9.png"), "own");
    await upload(exported);
    expect((await transfer.check()).blocked).toBe(false);
    transfer.apply(false);
    expect(transfer.status().ready).toBe(true);
    // 入れ替えを待っている間は送り直せない
    expect(() =>
      transfer.beginUpload({ name: "b", size: 10, lastModified: 1 }),
    ).toThrow("再起動を待っています");

    expect(transfer.swapAtBoot()).toBe(true);
    expect(orm().select().from(schema.rules).all()[0]?.name).toBe("移すルール");
    const [rec] = orm().select().from(schema.recordings).all();
    // 置き場からの相対で持っているので、この機械の置き場で引ける
    expect(rec?.library_path).toBe(
      join(fresh.encoded, "シリーズ", "第1話.mkv"),
    );
    expect(
      orm().select({ n: count() }).from(schema.settings).get()?.n,
    ).toBeGreaterThan(0);
    expect(readFileSync(join(fresh.data, "logos", "1024.png"), "utf8")).toBe(
      "png",
    );
    expect(existsSync(join(fresh.data, "logos", "9.png"))).toBe(false);
    const aside = readdirSync(fresh.data).filter((n) =>
      n.includes(".before-import-"),
    );
    expect(aside.some((n) => n.startsWith("denpa.db.before-import-"))).toBe(
      true,
    );
    expect(aside.some((n) => n.startsWith("logos.before-import-"))).toBe(true);
    expect(existsSync(join(fresh.data, "transfer", "ready"))).toBe(false);
    // 2 度目の起動では何もしない
    expect(transfer.swapAtBoot()).toBe(false);
  });

  test("入れ替えの途中で落ちても、次の起動で続きから入れ替わる", async () => {
    const fresh = machine(`fresh-${counter}`);
    mkdirSync(join(fresh.encoded, "シリーズ"), { recursive: true });
    writeFileSync(join(fresh.encoded, "シリーズ", "第1話.mkv"), "video");
    use(fresh);
    mkdirSync(join(fresh.data, "logos"), { recursive: true });
    writeFileSync(join(fresh.data, "logos", "9.png"), "own");
    await upload(exported);
    await transfer.check();
    transfer.apply(false);

    // ロゴを退けて新しいロゴを置いたところで落ちた (DB はまだ前のまま)
    const at = readFileSync(
      join(fresh.data, "transfer", "ready", "stamp"),
      "utf8",
    );
    renameSync(
      join(fresh.data, "logos"),
      join(fresh.data, `logos.before-import-${at}`),
    );
    renameSync(
      join(fresh.data, "transfer", "ready", "logos"),
      join(fresh.data, "logos"),
    );

    expect(transfer.swapAtBoot()).toBe(true);
    expect(orm().select().from(schema.rules).all()[0]?.name).toBe("移すルール");
    // 新しいロゴを退け直さない。前のロゴは退けた先に残る
    expect(readFileSync(join(fresh.data, "logos", "1024.png"), "utf8")).toBe(
      "png",
    );
    expect(
      readFileSync(
        join(fresh.data, `logos.before-import-${at}`, "9.png"),
        "utf8",
      ),
    ).toBe("own");
    expect(existsSync(join(fresh.data, "transfer", "ready"))).toBe(false);
  });

  test("更新時刻が読めないファイルは送り始めない", () => {
    use(machine(`fresh-${counter}`));
    expect(() =>
      transfer.beginUpload({ name: "a", size: 10, lastModified: Number.NaN }),
    ).toThrow("更新時刻が読めません");
  });

  test("途中で切れても、送った位置から続けられる", async () => {
    const fresh = machine(`fresh-${counter}`);
    use(fresh);
    const meta = { name: "x.tar.zst", size: exported.length, lastModified: 5 };
    transfer.beginUpload(meta);
    transfer.appendUpload(0, exported.subarray(0, 100));
    // 同じ位置をもう一度送ると、今の位置が返る
    try {
      transfer.appendUpload(0, exported.subarray(0, 100));
      throw new Error("断られるはず");
    } catch (error) {
      expect(error).toBeInstanceOf(transfer.OffsetMismatch);
      expect(
        (error as InstanceType<typeof transfer.OffsetMismatch>).offset,
      ).toBe(100);
    }
    // 開き直して同じファイルを選ぶと、続きの位置から
    expect(transfer.beginUpload(meta).offset).toBe(100);
    // 違うファイルなら頭から
    expect(transfer.beginUpload({ ...meta, lastModified: 6 }).offset).toBe(0);
    transfer.cancel();
  });

  test("新しいバージョンで書き出したものは断る", async () => {
    const path = join(work, `newer-${counter}.db`);
    writeFileSync(path, exportedDb);
    const db = new Database(path);
    db.query(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', ?)",
    ).run(now + 365 * 24 * 3_600_000);
    db.close();
    const bytes = await pack({
      "denpa-export.json": JSON.stringify({ version: "v9.9.9" }),
      "denpa.db": readFileSync(path),
    });
    use(machine(`fresh-${counter}`));
    await upload(bytes);
    await expect(transfer.check()).rejects.toThrow(
      "denpa v9.9.9 以上に上げてから取り込んでください",
    );
    // 使えないものは消す
    expect(transfer.busy()).toBe(false);
  });

  test("denpa の作らないトリガーがある DB は断る", async () => {
    const path = join(work, `trigger-${counter}.db`);
    writeFileSync(path, exportedDb);
    const db = new Database(path);
    db.exec(
      "CREATE TRIGGER sneaky AFTER INSERT ON rules BEGIN DELETE FROM rules; END",
    );
    db.close();
    use(machine(`fresh-${counter}`));
    await upload(await pack({ "denpa.db": readFileSync(path) }));
    await expect(transfer.check()).rejects.toThrow("トリガーかビュー");
  });

  test("壊れたファイル・違うファイルは断る", async () => {
    use(machine(`fresh-${counter}`));
    const cases: [Uint8Array, string][] = [
      [
        new TextEncoder().encode("これは denpa のファイルではない"),
        "読めません",
      ],
      [exported.subarray(0, Math.floor(exported.length / 2)), "読めません"],
      [await pack({ "../evil": "x" }), "思っていない名前"],
      [await pack({ "logos/../../x.png": "x" }), "思っていない名前"],
      [await pack({ "denpa-export.json": "{}" }), "DB が入っていません"],
      [
        await pack({ "denpa.db": "SQLite? いいえ" }),
        "SQLite のファイルではありません",
      ],
    ];
    for (const [bytes, message] of cases) {
      await upload(bytes);
      await expect(transfer.check()).rejects.toThrow(message);
      expect(transfer.busy()).toBe(false);
    }
  });

  test("送り終える前には確かめない", async () => {
    use(machine(`fresh-${counter}`));
    transfer.beginUpload({ name: "a", size: 1000, lastModified: 1 });
    await expect(transfer.check()).rejects.toThrow("まだ送り終えていません");
    expect(() => transfer.apply(false)).toThrow("先に確かめてください");
    transfer.cancel();
  });
});
