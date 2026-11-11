import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SynthMmtAv } from "@danything/arib/synth-mmt-av";
import { eq } from "drizzle-orm";

/**
 * **4K の局 (TLV) の録画** (`recorder.ts` の `pump`)。チューナーを差し替えて、偽の放送と同じ素材 (HEVC と AAC を MMT/TLV に
 * 包んだもの。`@danything/arib/synth-mmt-av`) を流す。録画は 1 局に絞った TLV のまま `.mmts` で置き、読み直すと映像が出る
 */
mock.module("./webhook", () => ({ notify: () => undefined }));

const SERVICE_ID = 0x65;
const actualTuner = await import("./tuner");
mock.module("./tuner", () => ({
  ...actualTuner,
  openChannelStream: async (
    _type: string,
    _channel: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> => {
    const av = new SynthMmtAv({
      serviceId: SERVICE_ID,
      mptPacketId: 0x9000,
      startMs: Date.now(),
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => controller.enqueue(av.next()), 10);
        signal.addEventListener("abort", () => {
          clearInterval(timer);
          controller.close();
        });
      },
      cancel() {
        clearInterval(timer);
      },
    });
  },
}));

const { config } = await import("./config");
const dir = mkdtempSync(join(tmpdir(), "denpa-rec-mmt-"));
config.dbPath = join(dir, "denpa.db");
config.rawDir = join(dir, "raw");
config.encodedDir = join(dir, "encoded");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { now, orm } = await import("./db");
const { startRecording, stopRecording } = await import("./recorder");
const { recordings, reservations, services } = await import("./schema");
const { probeMmts } = await import("./mmts");

/** ケーブルで受けた 4K の局 (`types.serviceKey`。network_id 0x000B) */
const SERVICE = (0x10000 + 0x000b) * 100000 + SERVICE_ID;

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("待ちきれませんでした");
    await Bun.sleep(20);
  }
}

const recordingOf = (id: number) =>
  orm().select().from(recordings).where(eq(recordings.id, id)).get()!;

describe("4K の局の録画", () => {
  test("1 局に絞った TLV のまま .mmts で録り、エンコードしなければそのまま置き場へ移す", async () => {
    orm()
      .insert(services)
      .values({
        id: SERVICE,
        service_id: SERVICE_ID,
        network_id: 0x000b,
        name: "4K テスト",
        type: "CATV",
        service_type: 1,
        channel: "QC28",
        transport: "tlv",
        updated_at: now(),
      })
      .run();
    const start = now();
    const reservation = orm()
      .insert(reservations)
      .values({
        // 番組表の行は無い (p/f を待つあいだも書く。`PfEvent`)
        program_id: SERVICE * 100000 + 1,
        rule_id: null,
        service_id: SERVICE,
        name: "4K の番組",
        start_at: start,
        end_at: start + 60_000,
        manual: true,
        encode: false,
        state: "scheduled",
        started_at: now(),
        created_at: now(),
        updated_at: now(),
      })
      .returning()
      .get();
    const rec = await startRecording(reservation);
    expect(rec.ts_path!.endsWith(".mmts")).toBe(true);
    // MPT を読んでから書き始める。映像の MPU が何十か溜まるまで待つ
    await until(
      () =>
        (statSync(rec.ts_path!, { throwIfNoEntry: false })?.size ?? 0) > 50_000,
    );
    stopRecording(rec.id);
    await until(() => recordingOf(rec.id).library_path !== null);

    const done = recordingOf(rec.id);
    expect(done.error).toBeNull();
    expect(done.ts_path).toBeNull();
    expect(done.library_path!.endsWith(".mmts")).toBe(true);
    // 中身は TLV のまま (TS の同期バイトではない)。読み直すと映像の先頭と尺が分かる
    const bytes = readFileSync(done.library_path!);
    expect(bytes[0]).toBe(0x7f);
    const stat = statSync(done.library_path!);
    const file = await probeMmts(
      done.library_path!,
      stat.size,
      "key",
      SERVICE_ID,
    );
    expect(file).not.toBeNull();
    expect(file!.duration).toBeGreaterThan(0);
  });
});
