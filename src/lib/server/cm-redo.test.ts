import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

/**
 * **CM 検出だけやり直す** ジョブ (`encoder.runCmJob`)。偽 ffmpeg (`tests/fake/ffmpeg.sh`) で通す。
 * 偽 ffmpeg は 300 秒と 360 秒に 1 秒の無音を返す (尺 600 秒)。ffprobe は無い。
 * 元のTSは持たせず、エンコードしたもの (mkv) から読ませる
 */
const root = mkdtempSync(join(tmpdir(), "denpa-cmredo-"));
const { config } = await import("./config");
config.dbPath = join(root, "denpa.db");
config.cmLogoDir = join(root, "logos");
config.encodedDir = join(root, "encoded");
config.ffmpeg = "tests/fake/ffmpeg.sh";
config.ffprobe = join(root, "no-ffprobe");
mkdirSync(config.encodedDir, { recursive: true });

const { orm } = await import("./db");
const { encodeJobs, recordings } = await import("./schema");
const { CM_CUT_ALREADY, enqueue, pump } = await import("./encoder");

const now = Date.now();
const mkv = join(config.encodedDir, "a.mkv");
writeFileSync(mkv, "mkv");

function seed(kept: { start: number; end: number }[] | null): void {
  orm().delete(recordings).run();
  orm().delete(encodeJobs).run();
  orm()
    .insert(recordings)
    .values({
      id: 1,
      service_id: 1,
      name: "番組",
      start_at: now,
      end_at: now + 600_000,
      library_path: mkv,
      cm_kept: kept,
      encode_skip: 0.5,
      created_at: now,
      updated_at: now,
    })
    .run();
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

test("エンコードしたものから読み直し、入れ物の頭からの秒で覚える (エンコードしたときに捨てた頭を足す)", async () => {
  seed(null);
  const jobId = enqueue(1, "cm");
  pump();
  const job = await finished(jobId);
  expect(job.state).toBe("done");
  const rec = orm()
    .select()
    .from(recordings)
    .where(eq(recordings.id, 1))
    .get()!;
  expect(rec.cm_ranges).toEqual([{ start: 300.5, end: 360.5 }]);
  // エンコードしたものの置き場所は変わらない (再エンコードしていない)
  expect(rec.library_path).toBe(mkv);
});

test("CM を切ってエンコードしたものは受けない", async () => {
  seed([{ start: 0, end: 300 }]);
  const jobId = enqueue(1, "cm");
  pump();
  const job = await finished(jobId);
  expect(job.state).toBe("failed");
  expect(job.error).toBe(CM_CUT_ALREADY);
});

test("同じ録画に2つは積まない (エンコードするジョブがあればそれを返す)", () => {
  seed(null);
  const encode = enqueue(1);
  expect(enqueue(1, "cm")).toBe(encode);
});

test("材料の控えがあれば読み直さずに決める (控えの物差しに頭を足す)", async () => {
  seed(null);
  const { cmMaterials } = await import("./schema");
  const { saveMaterial } = await import("./cm-material-store");
  // 控え: 尺 600 秒、100〜160 秒にロゴが無い (CM 60 秒)。継ぎ目は無音と切れ目。エンコードしたときに頭を 0.5 秒捨てた
  const fps = 10;
  const times = Float64Array.from({ length: 6000 }, (_, i) => i / fps);
  const cuts = new Float32Array(6000);
  const joints = [100, 115, 130, 145, 160];
  for (const t of joints) cuts[t * fps] = 30;
  saveMaterial(1, {
    offset: 0.5,
    duration: 600,
    fps,
    silences: joints.map((t) => ({ start: t - 0.5, end: t + 0.5 })),
    times,
    cuts,
    logo: {
      spans: [
        { start: 0, end: 999 },
        { start: 1600, end: 5999 },
      ],
      scores: new Float32Array(6000),
    },
    why: "",
  });
  const jobId = enqueue(1, "cm");
  pump();
  const job = await finished(jobId);
  expect(job.state).toBe("done");
  const rec = orm()
    .select()
    .from(recordings)
    .where(eq(recordings.id, 1))
    .get()!;
  // 偽 ffmpeg の無音 (300・360) ではなく、控えから決めたもの
  expect(rec.cm_ranges).toEqual([{ start: 100.5, end: 160.5 }]);
  orm().delete(cmMaterials).run();
});

test("コマを1つも読めなかったものは控えない (次も読み直す)", async () => {
  seed(null);
  const { loadMaterial } = await import("./cm-material-store");
  const jobId = enqueue(1, "cm");
  pump();
  expect((await finished(jobId)).state).toBe("done");
  // 偽 ffmpeg は無音しか返さない
  expect(loadMaterial(1)).toBeNull();
});
