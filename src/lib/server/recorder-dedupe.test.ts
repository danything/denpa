import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  eitSection,
  packetize,
  stream,
  type SynthEvent,
} from "@danything/arib/synth";
import { eq } from "drizzle-orm";

/**
 * **録り始めに EIT[p/f] を読み、同じ回をもう録ってあればやめる** (`recorder.ts` の `pump`)。
 *
 * チューナーは差し替えて、p/f だけを流す TS を返す (PAT・PMT が無いので保存はしない)。
 * 実機の BS日テレのように、番組表では話数が無く p/f の概要にだけ「第 6 話　副題」がある番組で見る
 */
const notified: { event: string }[] = [];
mock.module("./webhook", () => ({
  notify: (payload: { event: string }) => notified.push(payload),
}));

/** 流す p/f の「次」の番組 (録る番組)。テストごとに差し替える */
let following: SynthEvent;
const actualTuner = await import("./tuner");
mock.module("./tuner", () => ({
  ...actualTuner,
  openChannel: async (_type: string, _channel: string, signal: AbortSignal) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = () => controller.enqueue(pfPackets(following));
        push();
        timer = setInterval(push, 50);
        signal.addEventListener("abort", () => {
          clearInterval(timer);
          controller.close();
        });
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return {
      stream,
      tsmfStreams: 1,
      transport: "ts" as const,
      place: { agent: 1, channel: "T16" },
    };
  },
}));

const { config } = await import("./config");
const dir = mkdtempSync(join(tmpdir(), "denpa-rec-dedupe-"));
config.dbPath = join(dir, "denpa.db");
config.rawDir = dir;

const { now, orm } = await import("./db");
const { placeServices } = await import("./fake-channels");
const { startRecording, stopRecording } = await import("./recorder");
const { reservationStates } = await import("./reservations");
const { programs, recordings, reservations, rules, services } =
  await import("./schema");

const BS = 400141;
const MX = 3239123608;
const EVENT = 101;
const PROGRAM = BS * 100000 + EVENT;
const MINUTE = 60_000;

/** p/f の 2 節。いま (前の番組) と次 (録る番組) */
function pfPackets(next: SynthEvent): Uint8Array {
  const section = (sectionNumber: number, event: SynthEvent) =>
    packetize(
      0x0012,
      eitSection({
        tableId: 0x4e,
        serviceId: BS % 100000,
        transportStreamId: 1,
        originalNetworkId: 4,
        sectionNumber,
        lastSectionNumber: 1,
        events: [event],
      }),
    );
  return stream(
    section(0, {
      eventId: 100,
      startAt: next.startAt - 30 * MINUTE,
      duration: 30 * MINUTE,
      name: "前の番組",
      runningStatus: 4,
    }),
    section(1, next),
  );
}

function clear(): void {
  orm().delete(recordings).run();
  orm().delete(reservations).run();
  orm().delete(programs).run();
  orm().delete(rules).run();
  orm().delete(services).run();
}
afterAll(clear);

const NAME = "アニメ　テスト令嬢ミア・リストン";
let start = 0;

beforeEach(() => {
  clear();
  notified.length = 0;
  start = now() + 10_000;
  for (const [id, name, type, channel] of [
    [BS, "BS日テレ", "BS", "BS13_0"],
    [MX, "TOKYO MX1", "GR", "T16"],
  ] as const) {
    orm()
      .insert(services)
      .values({
        id,
        service_id: id % 100000,
        network_id: Math.floor(id / 100000),
        name,
        type,
        service_type: 1,
        updated_at: now(),
      })
      .run();
    placeServices([{ id, channel }]);
  }
  orm()
    .insert(rules)
    .values({
      id: 1,
      name: "テスト令嬢",
      keyword: "テスト令嬢",
      search_fields: "name",
      enabled: true,
      priority: 1,
      dedupe: true,
      created_at: now(),
    })
    .run();
  // MX の 6 話を前の日に録ってある
  orm()
    .insert(recordings)
    .values({
      service_id: MX,
      service_name: "TOKYO MX1",
      name: "テスト令嬢ミア・リストン　＃６",
      start_at: start - 24 * 60 * MINUTE,
      end_at: start - 24 * 60 * MINUTE + 30 * MINUTE,
      finished_at: start - 23 * 60 * MINUTE,
      created_at: now(),
      updated_at: now(),
    })
    .run();
  // BS日テレの番組表。タイトルにも概要にも話数が無い
  orm()
    .insert(programs)
    .values({
      id: PROGRAM,
      service_id: BS,
      network_id: 4,
      event_id: EVENT,
      start_at: start,
      end_at: start + 30 * MINUTE,
      name: NAME,
      description: "",
      updated_at: now(),
    })
    .run();
});

/** スケジューラが録り始める予約 (録り始めた時刻を立ててから渡す。`scheduler.tick`) */
function reservation(manual = false) {
  return orm()
    .insert(reservations)
    .values({
      program_id: PROGRAM,
      rule_id: manual ? null : 1,
      service_id: BS,
      name: NAME,
      start_at: start,
      end_at: start + 30 * MINUTE,
      manual,
      encode: false,
      state: "scheduled",
      started_at: now(),
      created_at: now(),
      updated_at: now(),
    })
    .returning()
    .get();
}

const target = (description: string): SynthEvent => ({
  eventId: EVENT,
  startAt: start,
  duration: 30 * MINUTE,
  name: NAME,
  description,
  runningStatus: 1,
});

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("待ちきれませんでした");
    await Bun.sleep(20);
  }
}

const recordingOf = (id: number) =>
  orm().select().from(recordings).where(eq(recordings.id, id)).get();

describe("録り始めの見直し", () => {
  test("p/f で 6 話と分かれば、録画の行もファイルも消し、予約を「録画しない」にする", async () => {
    following = target("第6話　魔法映像普及活動会議");
    const held = reservation();
    const rec = await startRecording(held);
    await until(() => recordingOf(rec.id) === undefined);

    const after = orm()
      .select()
      .from(reservations)
      .where(eq(reservations.id, held.id))
      .get()!;
    expect(after.state).toBe("skipped");
    expect(after.conflict_reason).toBe(
      "同じ回を TOKYO MX1 で録画済みなので録画しません",
    );
    // もう一度録り始めないよう、録り始めた時刻は残す
    expect(after.started_at).not.toBeNull();
    // 画面 (番組表・一覧) も「録画しない」と読む。録画の行が無いので「完了」にしない
    expect(reservationStates([PROGRAM]).get(PROGRAM)).toBe("skipped");
    expect(existsSync(rec.ts_path!)).toBe(false);
    // 番組表の行は p/f の概要に書き直す
    const program = orm()
      .select()
      .from(programs)
      .where(eq(programs.id, PROGRAM))
      .get()!;
    expect(program.description).toBe("第6話　魔法映像普及活動会議");
    // やめたものに「録画を開始しました」は送らない
    expect(notified.map((n) => n.event)).not.toContain("recording.started");
  });

  test("違う回なら録り続け、録画の行の概要を p/f のものに書き直す", async () => {
    following = target("第7話　次の副題");
    const rec = await startRecording(reservation());
    await until(() => recordingOf(rec.id)?.description === "第7話　次の副題");
    await until(() => notified.some((n) => n.event === "recording.started"));
    expect(recordingOf(rec.id)!.state).toBe("recording");
    stopRecording(rec.id);
    await until(() => recordingOf(rec.id)!.state !== "recording");
  });

  test("手動の予約はやめない (情報の書き直しはする)", async () => {
    following = target("第6話　魔法映像普及活動会議");
    const rec = await startRecording(reservation(true));
    await until(
      () => recordingOf(rec.id)?.description === "第6話　魔法映像普及活動会議",
    );
    // 手動は見直さないので、開始はすぐ知らせる
    expect(notified.map((n) => n.event)).toContain("recording.started");
    expect(recordingOf(rec.id)!.state).toBe("recording");
    stopRecording(rec.id);
    await until(() => recordingOf(rec.id)!.state !== "recording");
  });
});
