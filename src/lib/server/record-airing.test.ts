import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

/**
 * **いま流れている番組を録る** (`recordAiring`) と、番組ごとの予約の状態 (`reservationStates`)。
 *
 * 画面のライブの録画ボタンとアプリの `POST /api/services/<id>/record` が同じものを使う。
 * `GET /api/services` の `now.reserved` / `now.recording` も `reservationStates` を読む。
 *
 * チューナーの API は手元に立てた偽物 (`tuners` を返すだけ)。予約のあとの数え直し
 * (`resolveConflicts`) がこれを読む。地上波1台にしておけば「予約はできたが録らない」(競合) も作れる
 */
const tuners = [{ types: ["GR"] }];
const agent = Bun.serve({
  port: 0,
  fetch: () =>
    Response.json({
      tuners: tuners.map((tuner, index) => ({
        index,
        name: `T${index}`,
        types: tuner.types,
        disabled: false,
        rank: index,
        device: null,
        lnb: null,
        channel: null,
        users: [],
        pid: null,
      })),
    }),
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
config.dbPath = join(
  mkdtempSync(join(tmpdir(), "denpa-record-airing-")),
  "denpa.db",
);
config.agentUrl = `http://127.0.0.1:${agent.port}`;

const { orm } = await import("./db");
const { programs, recordings, reservations, services } =
  await import("./schema");
const { cancel, recordAiring, reservationStates, reserveFromForm, restore } =
  await import("./reservations");
const { resolveConflicts, tick } = await import("./scheduler");
const { COPY_NEVER_REASON } = await import("../format");

const MINUTE = 60_000;
const NOW = Date.now();
const SERVICE = 3_273_701_032;
const OTHER = 3_273_601_024;

orm()
  .insert(services)
  .values([
    {
      id: SERVICE,
      service_id: 1032,
      network_id: 32_736,
      name: "NHK総合",
      type: "GR",
      channel: "27",
      updated_at: 0,
    },
    {
      id: OTHER,
      service_id: 1024,
      network_id: 32_736,
      name: "NHK Eテレ",
      type: "GR",
      channel: "26",
      updated_at: 0,
    },
  ])
  .run();

function program(
  id: number,
  startAt: number,
  endAt: number,
  name = `番組${id}`,
  copyNever = false,
): void {
  orm()
    .insert(programs)
    .values({
      id,
      service_id: SERVICE,
      network_id: 32_736,
      event_id: id,
      start_at: startAt,
      end_at: endAt,
      name,
      copy_never: copyNever,
      updated_at: 0,
    })
    .run();
}

function reset(): void {
  orm().delete(reservations).run();
  orm().delete(recordings).run();
  orm().delete(programs).run();
}

describe("いま流れている番組を録る", () => {
  test("いまを跨ぐ番組を予約する。前後の番組は選ばない", async () => {
    reset();
    program(1, NOW - 60 * MINUTE, NOW - 10 * MINUTE);
    program(2, NOW - 10 * MINUTE, NOW + 20 * MINUTE, "ニュース");
    program(3, NOW + 20 * MINUTE, NOW + 60 * MINUTE);

    const result = await recordAiring(SERVICE, NOW);
    expect(result).toEqual({
      ok: true,
      programId: 2,
      name: "ニュース",
      state: "scheduled",
    });
    const rows = orm().select().from(reservations).all();
    expect(rows.map((row) => row.program_id)).toEqual([2]);
    expect(rows[0]?.manual).toBe(true);
  });

  test("2度押しても予約は1本のまま", async () => {
    reset();
    program(2, NOW - 10 * MINUTE, NOW + 20 * MINUTE);
    await recordAiring(SERVICE, NOW);
    await recordAiring(SERVICE, NOW);
    expect(orm().select().from(reservations).all()).toHaveLength(1);
  });

  test("番組表にいまの番組が無ければ 404", async () => {
    reset();
    program(3, NOW + 20 * MINUTE, NOW + 60 * MINUTE);
    expect(await recordAiring(SERVICE, NOW)).toEqual({
      ok: false,
      status: 404,
      message: "いま流れている番組が番組表に見つかりません",
    });
    expect(orm().select().from(reservations).all()).toHaveLength(0);
  });

  test("予約できない番組は 400 と理由", async () => {
    reset();
    // 「いま」を過去に置いて引かせ、予約の側 (いまの時計) では終わっている番組にする
    program(4, NOW - 60 * MINUTE, NOW - 30 * MINUTE);
    expect(await recordAiring(SERVICE, NOW - 45 * MINUTE)).toEqual({
      ok: false,
      status: 400,
      message: "この番組は放送が終わっています",
    });
  });

  test("画面の「予約」(番組表・検索) は断った理由をそのまま返す", async () => {
    reset();
    program(5, NOW + 20 * MINUTE, NOW + 60 * MINUTE);
    program(6, NOW - 60 * MINUTE, NOW - 30 * MINUTE);
    const form = (programId: string) => {
      const out = new FormData();
      out.set("programId", programId);
      return out;
    };
    expect(await reserveFromForm(form("5"))).toBeNull();
    // `Error: ` を付けずに画面へ出せる文
    expect(await reserveFromForm(form("6"))).toBe(
      "この番組は放送が終わっています",
    );
    expect(await reserveFromForm(form("x"))).toBe("番組IDが不正です");
  });

  test("チューナーが足りなければ競合として返す (予約は残る)", async () => {
    reset();
    // 地上波1台を、先に始まった別の物理チャンネルの予約が使っている
    orm()
      .insert(reservations)
      .values({
        program_id: 99,
        service_id: OTHER,
        name: "先の予約",
        start_at: NOW - 20 * MINUTE,
        end_at: NOW + 40 * MINUTE,
        created_at: 0,
        updated_at: 0,
      })
      .run();
    program(2, NOW - 10 * MINUTE, NOW + 20 * MINUTE);
    expect(await recordAiring(SERVICE, NOW)).toMatchObject({
      ok: true,
      programId: 2,
      state: "conflict",
    });
    expect(orm().select().from(reservations).all()).toHaveLength(2);
  });
});

/*
 * **途中で止めた番組を、もう一度録れる。** 止めても予約に録り始めた時刻が残り、
 * 録画ボタンを押し直しても予約が「録り始めたもの」のままで録られなかった
 */
describe("途中で止めた番組を録り直す", () => {
  /** 録り始めた予約と、その録画の行 (`done` なら録り終えた行、そうでなければ録画中) */
  function started(programId: number, done: boolean): number {
    program(programId, NOW - 10 * MINUTE, NOW + 20 * MINUTE);
    orm()
      .insert(reservations)
      .values({
        program_id: programId,
        service_id: SERVICE,
        name: `番組${programId}`,
        start_at: NOW - 10 * MINUTE,
        end_at: NOW + 20 * MINUTE,
        manual: true,
        priority: 2,
        started_at: NOW - 5 * MINUTE,
        created_at: 0,
        updated_at: 0,
      })
      .run();
    const id = orm()
      .select()
      .from(reservations)
      .where(eq(reservations.program_id, programId))
      .get()!.id;
    orm()
      .insert(recordings)
      .values({
        reservation_id: id,
        program_id: programId,
        service_id: SERVICE,
        name: `番組${programId}`,
        start_at: NOW - 10 * MINUTE,
        end_at: NOW + 20 * MINUTE,
        ts_path: `/recorded/${programId}.m2ts`,
        finished_at: done ? NOW - MINUTE : null,
        created_at: 0,
        updated_at: 0,
      })
      .run();
    return id;
  }
  const startedAt = (programId: number) =>
    orm()
      .select({ started_at: reservations.started_at })
      .from(reservations)
      .where(eq(reservations.program_id, programId))
      .get()?.started_at;

  test("取り消して止めたあと、録画ボタンでもう一度録り始める", async () => {
    reset();
    const id = started(2, false);
    await cancel(id);
    // 止まった録画の行 (止めると録り終えた時刻が入る)
    orm().update(recordings).set({ finished_at: NOW }).run();

    expect(await recordAiring(SERVICE, NOW)).toMatchObject({
      ok: true,
      programId: 2,
      state: "scheduled",
    });
    expect(startedAt(2)).toBeNull();
  });

  test("取り消したものを戻しても、もう一度録り始める", async () => {
    reset();
    const id = started(3, true);
    await cancel(id);
    await restore(id);
    expect(startedAt(3)).toBeNull();
  });

  test("録画が途中で止まったもの (録画中の行が無い) も録り直す", async () => {
    reset();
    started(4, true);
    await recordAiring(SERVICE, NOW);
    expect(startedAt(4)).toBeNull();
  });

  test("録っている最中に押しても、録り始めた時刻はそのまま (二重に録らない)", async () => {
    reset();
    started(5, false);
    expect(await recordAiring(SERVICE, NOW)).toMatchObject({
      ok: true,
      state: "recording",
    });
    expect(startedAt(5)).toBe(NOW - 5 * MINUTE);
  });
});

describe("番組ごとの予約の状態", () => {
  function reservation(
    programId: number,
    state: "scheduled" | "canceled",
    startedAt: number | null = null,
  ) {
    orm()
      .insert(reservations)
      .values({
        program_id: programId,
        service_id: SERVICE,
        name: `番組${programId}`,
        start_at: NOW - 10 * MINUTE,
        end_at: NOW + 20 * MINUTE,
        state,
        started_at: startedAt,
        created_at: 0,
        updated_at: 0,
      })
      .run();
    return orm()
      .select()
      .from(reservations)
      .where(eq(reservations.program_id, programId))
      .get()!.id;
  }

  test("予約だけ・録画中・取り消し・予約無しを見分ける", () => {
    reset();
    reservation(1, "scheduled");
    const started = reservation(2, "scheduled", NOW - 5 * MINUTE);
    reservation(3, "canceled");
    // 録画中 = 終わった時刻も理由も無い行 (state は生成列)
    orm()
      .insert(recordings)
      .values({
        reservation_id: started,
        program_id: 2,
        service_id: SERVICE,
        name: "番組2",
        start_at: NOW - 10 * MINUTE,
        end_at: NOW + 20 * MINUTE,
        ts_path: "/recorded/2.m2ts",
        created_at: 0,
        updated_at: 0,
      })
      .run();

    const states = reservationStates([1, 2, 3, 4]);
    expect(states.get(1)).toBe("scheduled");
    expect(states.get(2)).toBe("recording");
    expect(states.has(3)).toBe(false);
    expect(states.has(4)).toBe(false);
    expect(reservationStates([]).size).toBe(0);
  });
});

/*
 * **コピー禁止の番組は録らない** (docs/data.md「コピー禁止の番組」)。市販のレコーダーと同じ。
 * 手で押したものは断り、ルールが立てた予約は「録画しない」(`skipped`) にして理由を残す
 */
describe("コピー禁止の番組", () => {
  /** ルールが立てたのと同じ形の予約 (手動ではない) */
  function ruleReservation(
    programId: number,
    serviceId: number,
    startAt: number,
    endAt: number,
  ): void {
    orm()
      .insert(reservations)
      .values({
        program_id: programId,
        rule_id: 1,
        service_id: serviceId,
        name: `番組${programId}`,
        start_at: startAt,
        end_at: endAt,
        priority: 1,
        created_at: 0,
        updated_at: 0,
      })
      .run();
  }
  const stateOf = (programId: number) =>
    orm()
      .select({
        state: reservations.state,
        reason: reservations.conflict_reason,
      })
      .from(reservations)
      .where(eq(reservations.program_id, programId))
      .get();

  test("ライブの録画ボタン (手動) は断って理由を返す。予約は立てない", async () => {
    reset();
    program(2, NOW - 10 * MINUTE, NOW + 20 * MINUTE, "コピー禁止の番組", true);
    expect(await recordAiring(SERVICE, NOW)).toEqual({
      ok: false,
      status: 400,
      message: COPY_NEVER_REASON,
    });
    expect(orm().select().from(reservations).all()).toHaveLength(0);
  });

  test("ルールが立てた予約は「録画しない」にして理由を残す。チューナーは取り合わない", async () => {
    reset();
    // 地上波1台。コピー禁止の番組と同じ時間に、別の物理チャンネルの予約がある
    program(2, NOW + 10 * MINUTE, NOW + 40 * MINUTE, "コピー禁止の番組", true);
    ruleReservation(2, SERVICE, NOW + 10 * MINUTE, NOW + 40 * MINUTE);
    ruleReservation(99, OTHER, NOW + 10 * MINUTE, NOW + 40 * MINUTE);

    await resolveConflicts();
    expect(stateOf(2)).toEqual({ state: "skipped", reason: COPY_NEVER_REASON });
    // 録らない番組がチューナーを取らないので、裏の予約は録れる
    expect(stateOf(99)).toEqual({ state: "scheduled", reason: null });
  });

  test("番組表で禁止でなくなれば、割り振りに戻る", async () => {
    reset();
    program(2, NOW + 10 * MINUTE, NOW + 40 * MINUTE, "コピー禁止の番組", true);
    ruleReservation(2, SERVICE, NOW + 10 * MINUTE, NOW + 40 * MINUTE);
    await resolveConflicts();
    expect(stateOf(2)?.state).toBe("skipped");

    orm()
      .update(programs)
      .set({ copy_never: false })
      .where(eq(programs.id, 2))
      .run();
    await resolveConflicts();
    expect(stateOf(2)).toEqual({ state: "scheduled", reason: null });
  });

  /*
   * **放送が終わっても録り逃しにしない。** 意図して録らなかったものが失敗に見えないよう、
   * 「録画しない」のまま理由ごと残す (録り逃しの一覧・件数は `missed` だけを数える)
   */
  test("放送が終わっても「録画しない」のまま理由を残す。始まらなかった予約だけが録り逃しになる", async () => {
    reset();
    program(2, NOW + 10 * MINUTE, NOW + 40 * MINUTE, "コピー禁止の番組", true);
    ruleReservation(2, SERVICE, NOW + 10 * MINUTE, NOW + 40 * MINUTE);
    await resolveConflicts();
    expect(stateOf(2)?.state).toBe("skipped");

    // 放送が終わったことにする。比べる相手として、録り始めないまま終わった予約も置く
    orm()
      .update(reservations)
      .set({ start_at: NOW - 60 * MINUTE, end_at: NOW - 30 * MINUTE })
      .where(eq(reservations.program_id, 2))
      .run();
    ruleReservation(98, OTHER, NOW - 60 * MINUTE, NOW - 30 * MINUTE);

    await tick();
    expect(stateOf(2)).toEqual({ state: "skipped", reason: COPY_NEVER_REASON });
    expect(stateOf(98)?.state).toBe("missed");
    expect(orm().select().from(recordings).all()).toHaveLength(0);
  });
});
