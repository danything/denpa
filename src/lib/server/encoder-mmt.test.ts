import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concatBytes } from "@danything/arib/bytes";
import type { CaptionPages } from "@danything/arib/caption-text";
import { MmtServiceFilter } from "@danything/arib/mmt-service-filter";
import { SynthMmtAv } from "@danything/arib/synth-mmt-av";
import { eq } from "drizzle-orm";

/**
 * **4K の局の録画 (`.mmts`) をエンコードするジョブ** (`encoder.runJob`)。偽 ffmpeg (`tests/fake/ffmpeg.sh`) で通す。
 * 元の録画は偽の放送と同じ素材 (HEVC と AAC と字幕。`synth-mmt-av`) を 1 局に絞って書いたもの。
 * denpa が MP4 に詰め替えてから ffmpeg に渡し、字幕は文字の配置にしてエンコードしたものの隣に置く
 */
const root = mkdtempSync(join(tmpdir(), "denpa-encmmt-"));
const { config } = await import("./config");
config.dbPath = join(root, "denpa.db");
config.cmLogoDir = join(root, "logos");
config.rawDir = join(root, "raw");
config.encodedDir = join(root, "encoded");
config.ffmpeg = "tests/fake/ffmpeg.sh";
config.ffprobe = join(root, "no-ffprobe");
mkdirSync(config.rawDir, { recursive: true });

const { orm } = await import("./db");
const { encodeJobs, recordings, services } = await import("./schema");
const { enqueue, pump } = await import("./encoder");

const now = Date.now();
const SERVICE = 6_554_700_301;

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

test("MP4 に詰め替えてからエンコードし、字幕を隣に置いて、詰め替えたものと元の録画を消す", async () => {
  orm()
    .insert(services)
    .values({
      id: SERVICE,
      service_id: 301,
      network_id: 0x000b,
      name: "4K テスト",
      type: "CATV",
      service_type: 1,
      transport: "tlv",
      updated_at: now,
    })
    .run();
  const av = new SynthMmtAv({
    serviceId: 301,
    mptPacketId: 0x9000,
    startMs: now,
    caption: "4K の字幕",
  });
  const filter = new MmtServiceFilter(301);
  const mmts = join(config.rawDir, "番組-20261111-1.mmts");
  writeFileSync(
    mmts,
    concatBytes(Array.from({ length: 40 }, () => filter.filter(av.next()))),
  );
  orm()
    .insert(recordings)
    .values({
      id: 1,
      service_id: SERVICE,
      name: "4K の番組",
      series: "番組",
      start_at: now,
      end_at: now + 600_000,
      finished_at: now + 600_000,
      ts_path: mmts,
      created_at: now,
      updated_at: now,
    })
    .run();

  const jobId = enqueue(1);
  pump();
  const job = await finished(jobId);
  expect(job.error).toBeNull();
  expect(job.state).toBe("done");

  const rec = orm()
    .select()
    .from(recordings)
    .where(eq(recordings.id, 1))
    .get()!;
  expect(rec.library_path!.endsWith(".mkv")).toBe(true);
  // 詰め替えた MP4 (ffmpeg が読んだもの。TLV は読めない) は終われば消す
  expect(existsSync(`${mmts}.remux.mp4`)).toBe(false);
  // 元の録画は今までどおり消す (「元の TS も残す」でなければ)
  expect(rec.ts_path).toBeNull();
  expect(existsSync(mmts)).toBe(false);
  // 字幕は Matroska に入れられないので、文字の配置にして隣に置く
  const captions = JSON.parse(
    readFileSync(rec.library_path!.replace(/\.mkv$/, ".captions.json"), "utf8"),
  ) as CaptionPages;
  expect(
    captions.pages.some(
      (p) => p.page.runs.map((r) => r.text).join("") === "4K の字幕",
    ),
  ).toBe(true);
});
