import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { eq } from "drizzle-orm";

import { fakeAgentTls, fakeAgentUrl, trustFakeAgent } from "./fake-agent";

/**
 * **外から使う番組表と予約** (`GET /api/programs`・`POST`/`DELETE /api/programs/<id>/record`。docs/api.md)。
 *
 * 番組表は画面のマスと同じ `programsOf`・`stationsOf` から組む。ここでは組み方 (局・範囲・予約の中身) を押さえ、
 * 実際の画面のマス (`/api/guide`) と同じ状態か・アクセストークンで通るかは E2E (`63-programs-api`) が押さえる。
 *
 * チューナーの API は手元に立てた偽物 (`tuners` を返すだけ)。取り消しのあとの数え直し (`resolveConflicts`) がこれを読む
 */
const agent = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  fetch: () =>
    Response.json({
      tuners: [
        {
          index: 0,
          name: "T0",
          types: ["GR"],
          disabled: false,
          rank: 0,
          device: null,
          lnb: null,
          channel: null,
          users: [],
          pid: null,
        },
      ],
    }),
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
config.dbPath = join(
  mkdtempSync(join(tmpdir(), "denpa-guide-api-")),
  "denpa.db",
);
config.dataDir = dirname(config.dbPath);
config.agentUrl = fakeAgentUrl(agent.port!);
trustFakeAgent();

const { orm } = await import("./db");
const { programs, recordings, reservations, services } =
  await import("./schema");
const { broadcastDayStart, guideOf, HOUR, programRange, programsOf } =
  await import("./guide");
const { cancelProgram, recordedBody, recordProgram } =
  await import("./reservations");
const { COPY_NEVER_REASON, NOT_CANCELABLE_REASON } = await import("../format");

const MINUTE = 60_000;
const NOW = Date.now();
const FROM = NOW - 2 * HOUR;
const TO = NOW + 2 * HOUR;
/** 本チャンネル (NHK総合1)・同じチャンネルのサブチャンネル (NHK総合2)・別のチャンネル */
const MAIN = 3_273_701_032;
const SUB = 3_273_701_033;
const OTHER = 3_273_601_024;

orm()
  .insert(services)
  .values([
    {
      id: MAIN,
      service_id: 1032,
      network_id: 32_736,
      name: "NHK総合1",
      type: "GR",
      channel: "27",
      remote_control_key: 1,
      has_logo: true,
      updated_at: 0,
    },
    {
      id: SUB,
      service_id: 1033,
      network_id: 32_736,
      name: "NHK総合2",
      type: "GR",
      channel: "27",
      remote_control_key: 1,
      updated_at: 0,
    },
    {
      id: OTHER,
      service_id: 1024,
      network_id: 32_736,
      name: "NHK Eテレ1",
      type: "GR",
      channel: "26",
      remote_control_key: 2,
      updated_at: 0,
    },
  ])
  .run();

function program(
  id: number,
  serviceId: number,
  startAt: number,
  endAt: number,
  extra: { genres?: number[]; copy_never?: boolean; name?: string } = {},
): void {
  orm()
    .insert(programs)
    .values({
      id,
      service_id: serviceId,
      network_id: 32_736,
      event_id: id,
      start_at: startAt,
      end_at: endAt,
      name: `番組${id}`,
      updated_at: 0,
      ...extra,
    })
    .run();
}

function reservation(
  programId: number,
  values: Partial<typeof reservations.$inferInsert> = {},
): number {
  const p = orm()
    .select()
    .from(programs)
    .where(eq(programs.id, programId))
    .get()!;
  orm()
    .insert(reservations)
    .values({
      program_id: programId,
      service_id: p.service_id,
      name: p.name,
      start_at: p.start_at,
      end_at: p.end_at,
      created_at: 0,
      updated_at: 0,
      ...values,
    })
    .run();
  return orm()
    .select()
    .from(reservations)
    .where(eq(reservations.program_id, programId))
    .get()!.id;
}

/** 予約で録った録画の行。`finished` を渡せば録り終えたもの、渡さなければ録画中 */
function recording(
  reservationId: number,
  programId: number,
  values: Partial<typeof recordings.$inferInsert> = {},
): number {
  orm()
    .insert(recordings)
    .values({
      reservation_id: reservationId,
      program_id: programId,
      service_id: MAIN,
      name: `番組${programId}`,
      start_at: NOW - HOUR,
      end_at: NOW + HOUR,
      ts_path: `/recorded/${programId}.m2ts`,
      created_at: 0,
      updated_at: 0,
      ...values,
    })
    .run();
  return orm()
    .select()
    .from(recordings)
    .where(eq(recordings.program_id, programId))
    .get()!.id;
}

function reset(): void {
  orm().delete(reservations).run();
  orm().delete(recordings).run();
  orm().delete(programs).run();
}

describe("範囲 (from・to)", () => {
  test("省けば今日の放送日 (4:00 から 24 時間)", () => {
    const at = new Date(2026, 10, 7, 2, 30).getTime();
    const start = new Date(2026, 10, 6, 4, 0).getTime();
    expect(broadcastDayStart(at)).toBe(start);
    expect(programRange(null, null, at)).toEqual({
      from: start,
      to: start + 24 * HOUR,
    });
  });

  test("24 時間を超えたら from から 24 時間で切る。to だけ省けば 24 時間", () => {
    expect(programRange("1000", String(1000 + 48 * HOUR))).toEqual({
      from: 1000,
      to: 1000 + 24 * HOUR,
    });
    expect(programRange("1000", null)).toEqual({
      from: 1000,
      to: 1000 + 24 * HOUR,
    });
    expect(programRange("1000", "2000")).toEqual({ from: 1000, to: 2000 });
  });

  test("読めない値と、to が from 以前なら null (400)", () => {
    expect(programRange("x", null)).toBeNull();
    expect(programRange("", null)).toBeNull();
    expect(programRange("1000", "1.5")).toBeNull();
    expect(programRange("1000", "1000")).toBeNull();
    expect(programRange("1000", "500")).toBeNull();
  });
});

describe("番組表", () => {
  test("既定は本チャンネルの局だけを、画面と同じ並びで返す", () => {
    reset();
    program(1, MAIN, NOW - 30 * MINUTE, NOW + 30 * MINUTE);
    // 分割放送をしているサブチャンネル (subchannels を付けなければ入れない)
    program(2, SUB, NOW - 30 * MINUTE, NOW + 30 * MINUTE);
    program(3, OTHER, NOW - 30 * MINUTE, NOW + 30 * MINUTE);

    const guide = guideOf("GR", FROM, TO);
    expect(guide.services.map((s) => s.id)).toEqual([MAIN, OTHER]);
    expect(guide.services[0]).toMatchObject({
      name: "NHK総合1",
      remoteControlKey: 1,
      logo: `api/services/${MAIN}/logo`,
    });
    expect(guide.services[1]?.logo).toBeNull();
    expect(guide.services.map((s) => s.mainId)).toEqual([null, null]);
  });

  test("subchannels なら、分割放送のあるサブの列を本チャンネルのすぐ右に足す。番組は分割放送のものだけ", () => {
    reset();
    program(1, MAIN, NOW - HOUR, NOW);
    program(2, MAIN, NOW, NOW + HOUR);
    // 本チャンネルと同じ名前 (同じ番組を流している) と、別の番組 (分割放送)
    program(11, SUB, NOW - HOUR, NOW, { name: "番組1" });
    program(12, SUB, NOW, NOW + HOUR, { name: "サブの番組" });
    program(3, OTHER, NOW - HOUR, NOW + HOUR);

    const guide = guideOf("GR", FROM, TO, true);
    expect(guide.services.map((s) => [s.id, s.mainId])).toEqual([
      [MAIN, null],
      [SUB, MAIN],
      [OTHER, null],
    ]);
    expect(guide.services[0]?.programs.map((p) => p.id)).toEqual([1, 2]);
    expect(guide.services[1]?.programs.map((p) => p.id)).toEqual([12]);
  });

  test("subchannels でも、範囲の中に分割放送が無いサブは列を立てない", () => {
    reset();
    program(1, MAIN, NOW - HOUR, NOW + HOUR);
    // 名前の無い枠は本チャンネルと同じ番組
    program(11, SUB, NOW - HOUR, NOW + HOUR, { name: "" });

    expect(guideOf("GR", FROM, TO, true).services.map((s) => s.id)).toEqual([
      MAIN,
    ]);
  });

  test("範囲に掛かる番組だけ。境目に接するだけのものは入らない。until はいちばん遅い終わり", () => {
    reset();
    program(1, MAIN, FROM - HOUR, FROM);
    program(2, MAIN, FROM - HOUR, FROM + MINUTE);
    program(3, MAIN, TO - MINUTE, TO + HOUR);
    program(4, MAIN, TO, TO + 5 * HOUR);

    const guide = guideOf("GR", FROM, TO);
    expect(guide).toMatchObject({ type: "GR", from: FROM, to: TO });
    expect(guide.services[0]?.programs.map((p) => p.id)).toEqual([2, 3]);
    expect(guide.until).toBe(TO + 5 * HOUR);
    expect(guideOf("BS", FROM, TO)).toMatchObject({
      services: [],
      until: null,
    });
  });

  test("予約の状態はマス (programsOf) と同じ。理由・ルール・観られる録画を添える", () => {
    reset();
    // 録り終えた番組 (観られる)
    program(1, MAIN, NOW - 90 * MINUTE, NOW - 60 * MINUTE, { genres: [7, 2] });
    const done = reservation(1, { started_at: NOW - 90 * MINUTE });
    const doneRecording = recording(done, 1, { finished_at: NOW - HOUR });
    // 録画に失敗した番組 (観られない)
    program(2, MAIN, NOW - 60 * MINUTE, NOW - 30 * MINUTE);
    const failed = reservation(2, { started_at: NOW - 60 * MINUTE });
    recording(failed, 2, { finished_at: NOW - 30 * MINUTE, error: "失敗" });
    // 録画中
    program(3, MAIN, NOW - 30 * MINUTE, NOW + 30 * MINUTE);
    const live = reservation(3, { started_at: NOW - 30 * MINUTE });
    const liveRecording = recording(live, 3);
    // ルールが立てて、チューナーが足りずに録らない
    program(4, MAIN, NOW + 30 * MINUTE, NOW + 60 * MINUTE);
    reservation(4, {
      rule_id: 7,
      state: "conflict",
      conflict_reason: "チューナーが足りません",
    });
    // 取り消した予約と、予約の無い番組
    program(5, MAIN, NOW + 60 * MINUTE, NOW + 90 * MINUTE, {
      copy_never: true,
    });
    reservation(5, { state: "canceled" });
    program(6, MAIN, NOW + 90 * MINUTE, NOW + 120 * MINUTE);

    const listed = guideOf("GR", FROM, TO).services[0]!.programs;
    const grid = new Map(
      programsOf("GR", FROM, TO).map((p) => [p.id, p.reservation_state]),
    );
    for (const p of listed)
      expect(p.reservation?.state ?? null).toBe(grid.get(p.id) ?? null);

    const byId = new Map(listed.map((p) => [p.id, p]));
    expect(byId.get(1)).toEqual({
      id: 1,
      name: "番組1",
      startAt: NOW - 90 * MINUTE,
      endAt: NOW - 60 * MINUTE,
      description: "",
      genre: 7,
      copyNever: false,
      reservation: { state: "done", reason: null, ruleId: null },
      recordingId: doneRecording,
    });
    expect(byId.get(2)).toMatchObject({
      genre: null,
      reservation: { state: "failed" },
      recordingId: null,
    });
    expect(byId.get(3)).toMatchObject({
      reservation: { state: "recording" },
      recordingId: liveRecording,
    });
    expect(byId.get(4)?.reservation).toEqual({
      state: "conflict",
      reason: "チューナーが足りません",
      ruleId: 7,
    });
    expect(byId.get(5)).toMatchObject({ copyNever: true, reservation: null });
    expect(byId.get(6)).toMatchObject({ reservation: null, recordingId: null });
  });
});

describe("番組を録る・取り消す", () => {
  test("番組 ID で予約する。答えに状態と理由が入る", async () => {
    reset();
    program(1, MAIN, NOW + 30 * MINUTE, NOW + 60 * MINUTE);
    const result = await recordProgram(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(recordedBody(result)).toEqual({
      recorded: "番組1",
      programId: 1,
      reserved: true,
      state: "scheduled",
      reason: null,
    });
    // 何度呼んでも 1 本
    await recordProgram(1);
    expect(orm().select().from(reservations).all()).toHaveLength(1);
  });

  test("番組が無ければ 404、放送が終わっている・コピー禁止なら 400。どれも理由を返す", async () => {
    reset();
    program(1, MAIN, NOW - 60 * MINUTE, NOW - 30 * MINUTE);
    program(2, MAIN, NOW + 30 * MINUTE, NOW + 60 * MINUTE, {
      copy_never: true,
    });
    expect(await recordProgram(99)).toEqual({
      ok: false,
      status: 404,
      message: "番組が見つかりません",
    });
    expect(await recordProgram(1)).toEqual({
      ok: false,
      status: 400,
      message: "この番組は放送が終わっています",
    });
    expect(await recordProgram(2)).toEqual({
      ok: false,
      status: 400,
      message: COPY_NEVER_REASON,
    });
    expect(orm().select().from(reservations).all()).toHaveLength(0);
  });

  test("取り消す。録画中なら stopped で、録画の行は残す。予約が無ければ null (404)", async () => {
    reset();
    program(1, MAIN, NOW + 30 * MINUTE, NOW + 60 * MINUTE);
    program(2, MAIN, NOW - 30 * MINUTE, NOW + 30 * MINUTE);
    reservation(1);
    const live = reservation(2, { started_at: NOW - 30 * MINUTE });
    recording(live, 2);

    expect(await cancelProgram(1)).toEqual({ ok: true, stopped: false });
    expect(await cancelProgram(2)).toEqual({ ok: true, stopped: true });
    expect(orm().select().from(recordings).all()).toHaveLength(1);
    // 取り消したものは番組表で予約無しに戻る
    const listed = guideOf("GR", FROM, TO).services[0]!.programs;
    expect(listed.map((p) => p.reservation)).toEqual([null, null]);
    // 2 度目は予約が無い
    const missing = {
      ok: false,
      status: 404,
      message: "予約が見つかりません",
    } as const;
    expect(await cancelProgram(1)).toEqual(missing);
    expect(await cancelProgram(99)).toEqual(missing);
  });

  test("録り逃したもの・放送が終わった「録画しない」は取り消さない (409)", async () => {
    reset();
    program(1, MAIN, NOW - 60 * MINUTE, NOW - 30 * MINUTE);
    program(2, MAIN, NOW - 30 * MINUTE, NOW - MINUTE);
    program(3, MAIN, NOW - 30 * MINUTE, NOW + 30 * MINUTE);
    reservation(1, { state: "missed" });
    reservation(2, { state: "skipped" });
    reservation(3, { state: "skipped" });

    const refused = {
      ok: false,
      status: 409,
      message: NOT_CANCELABLE_REASON,
    } as const;
    expect(await cancelProgram(1)).toEqual(refused);
    expect(await cancelProgram(2)).toEqual(refused);
    // 放送中の「録画しない」は取り消せる
    expect(await cancelProgram(3)).toEqual({ ok: true, stopped: false });
    const states = orm()
      .select({ state: reservations.state })
      .from(reservations)
      .orderBy(reservations.program_id)
      .all();
    expect(states.map((r) => r.state)).toEqual([
      "missed",
      "skipped",
      "canceled",
    ]);
  });
});
