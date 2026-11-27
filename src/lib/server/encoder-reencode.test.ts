import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { eq } from "drizzle-orm";

/**
 * **再エンコードは出来上がってから前のものと置き換える** (`encoder.runJob`、#3238)。偽 ffmpeg (`tests/fake/ffmpeg.sh`) で通す。
 * 失敗・元の TS が見つからないときは、前のエンコード済みと録画の行をそのまま残す
 */
const root = mkdtempSync(join(tmpdir(), "denpa-reencode-"));
const failFile = join(root, "fail");
/*
 * 偽 ffmpeg に失敗の目印 (`FAKE_FFMPEG_FAIL_FILE`) を渡す包み。Bun.spawn は、テストの中で足した `process.env` を子に渡さない
 */
const ffmpeg = join(root, "ffmpeg.sh");
writeFileSync(
  ffmpeg,
  `#!/bin/sh\nFAKE_FFMPEG_FAIL_FILE='${failFile}' exec '${join(process.cwd(), "tests/fake/ffmpeg.sh")}' "$@"\n`,
  { mode: 0o755 },
);
const { config } = await import("./config");
config.dbPath = join(root, "denpa.db");
config.cmLogoDir = join(root, "logos");
config.rawDir = join(root, "raw");
config.encodedDir = join(root, "encoded");
config.ffmpeg = ffmpeg;
config.ffprobe = join(root, "no-ffprobe");
mkdirSync(config.rawDir, { recursive: true });

const { orm } = await import("./db");
const { encodeJobs, recordings } = await import("./schema");
const { enqueue, pump } = await import("./encoder");
const { encodedPath } = await import("./library");
const { saveSettings } = await import("./settings");

const now = Date.now();
const ts = join(config.rawDir, "番組-1.m2ts");
const name = {
  id: 1,
  series: "番組",
  subtitle: "",
  start_at: now,
};
const av1 = encodedPath(name, "av1");
const h264 = encodedPath(name, "h264");
const PREVIOUS = "前のエンコード済み";

/** TS の null パケット (中身は読まない。偽 ffmpeg が読んだことにする) */
function writeTs(): void {
  const packet = new Uint8Array(188);
  packet[0] = 0x47;
  packet[1] = 0x1f;
  packet[2] = 0xff;
  packet[3] = 0x10;
  writeFileSync(
    ts,
    Buffer.concat(Array.from({ length: 64 }, () => Buffer.from(packet))),
  );
}

/** 前にエンコードし終えた録画。置き場に前のものを置いて、行がそれを指す */
function seed(previous: { alt?: boolean } = {}): void {
  orm().delete(recordings).run();
  orm().delete(encodeJobs).run();
  writeTs();
  mkdirSync(dirname(av1), { recursive: true });
  writeFileSync(av1, PREVIOUS);
  if (previous.alt === true) writeFileSync(h264, PREVIOUS);
  orm()
    .insert(recordings)
    .values({
      id: 1,
      service_id: 1,
      name: "番組",
      series: "番組",
      start_at: now,
      end_at: now + 600_000,
      finished_at: now + 600_000,
      ts_path: ts,
      library_path: av1,
      alt_path: previous.alt === true ? h264 : null,
      created_at: now,
      updated_at: now,
    })
    .run();
}

function row() {
  return orm().select().from(recordings).where(eq(recordings.id, 1)).get()!;
}

async function finished(jobId: number) {
  for (;;) {
    const job = orm()
      .select()
      .from(encodeJobs)
      .where(eq(encodeJobs.id, jobId))
      .get()!;
    if (job.state !== "queued" && job.state !== "running") return job;
    await Bun.sleep(50);
  }
}

async function reencode() {
  const jobId = enqueue(1);
  pump();
  return finished(jobId);
}

afterEach(() => {
  rmSync(failFile, { force: true });
  saveSettings({ codecs: ["av1"], keepOriginal: true });
}, 60_000);
saveSettings({ codecs: ["av1"], keepOriginal: true });

test("出来上がったら同じ名前の前のものを置き換える", async () => {
  seed();
  const job = await reencode();
  expect(job.error).toBeNull();
  expect(job.state).toBe("done");
  expect(row().library_path).toBe(av1);
  // 偽 ffmpeg が書いたものに入れ替わっている
  expect(readFileSync(av1, "utf8")).not.toBe(PREVIOUS);
  // 作業ファイルは残らない
  expect(existsSync(`${av1}.${job.id}.av1.encoding`)).toBe(false);
}, 60_000);

test("エンコードが失敗したら、前のものと行をそのまま残す", async () => {
  seed();
  writeFileSync(failFile, "1");
  const job = await reencode();
  expect(job.state).toBe("failed");
  // エンコードする ffmpeg まで進んでから落ちた (前のものを消していた所より後ろ)
  expect(job.error).toContain("Error initializing the encoder");
  expect(readFileSync(av1, "utf8")).toBe(PREVIOUS);
  expect(row().library_path).toBe(av1);
}, 60_000);

test("元の TS が見つからなければ始めず、前のものを残す", async () => {
  seed();
  rmSync(ts);
  const job = await reencode();
  expect(job.state).toBe("failed");
  expect(job.error).toBe("元の TS が見つかりません");
  expect(readFileSync(av1, "utf8")).toBe(PREVIOUS);
  expect(row().library_path).toBe(av1);
  expect(row().ts_path).toBe(ts);
}, 60_000);

test("選ぶコーデックを減らしたら、置き換わらなかった前のものは行を書き換えてから消す", async () => {
  seed({ alt: true });
  const job = await reencode();
  expect(job.state).toBe("done");
  const rec = row();
  expect(rec.library_path).toBe(av1);
  expect(rec.alt_path).toBeNull();
  expect(existsSync(h264)).toBe(false);
  expect(readFileSync(av1, "utf8")).not.toBe(PREVIOUS);
}, 60_000);
