import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { fakeAgentTls, fakeAgentUrl } from "./fake-agent";
import { trustFakeAgent } from "./fake-agent-trust";

/*
 * **人の取り消し・手動予約とルールは後勝ち** (`rules.applyRules`、#3239)。
 * 画面の操作と同じ入口 (`reservations.ts` の取り消し・手動予約、`rule-actions.ts` のルールの保存・削除) から通して、
 * 予約の行がどうなるかを見る。地上波のチューナーが 2 台のエージェントにつなぐ (取り合いは起きない)
 */
const agent = Bun.serve({
  port: 0,
  tls: fakeAgentTls(),
  fetch: () =>
    Response.json({
      tuners: [0, 1].map((index) => ({
        index,
        name: `T${index}`,
        types: ["GR"],
        disabled: false,
        rank: 0,
        device: null,
        lnb: null,
        channel: null,
        users: [],
      })),
    }),
});
afterAll(() => agent.stop(true));

const { config } = await import("./config");
const testDir = mkdtempSync(join(tmpdir(), "denpa-rule-decisions-"));
config.dbPath = join(testDir, "denpa.db");
config.dataDir = testDir;
config.agentUrl = fakeAgentUrl(agent.port!);
trustFakeAgent();

const { orm } = await import("./db");
const { placeServices } = await import("./fake-channels");
const {
  programs,
  reservations,
  rules: ruleTable,
  services,
} = await import("./schema");
const { applyRules } = await import("./rules");
const { cancelProgram, reserve, restore } = await import("./reservations");
const { createRule, deleteRule, toggleRule, updateRule } =
  await import("./rule-actions");

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const MX = 3239123608;
/** MX1 の枝番。分割していない間は、同じ放送が MX と両方に載る */
const MX_SUB = 3239123609;
const HOUR = 3_600_000;
/** 番組の開始時刻の基準。枝番の組に同じ放送を載せるので、テストの中で動かさない */
const BASE = Date.now();

beforeEach(() => {
  orm().delete(reservations).run();
  orm().delete(programs).run();
  orm().delete(ruleTable).run();
  orm().delete(services).run();
  orm()
    .insert(services)
    .values(
      [MX, MX_SUB].map((id) => ({
        id,
        service_id: id % 100_000,
        network_id: 32391,
        name: "TOKYO MX1",
        type: "GR" as const,
        service_type: 1,
        updated_at: 0,
      })),
    )
    .run();
  placeServices([
    { id: MX, channel: "T16" },
    { id: MX_SUB, channel: "T16" },
  ]);
});

/** 3 時間後から (猶予の外) の番組を置く */
function program(
  id: number,
  name: string,
  startsIn = 3 * HOUR,
  service = MX,
): void {
  const start = BASE + startsIn;
  orm()
    .insert(programs)
    .values({
      id,
      service_id: service,
      network_id: 32391,
      event_id: id,
      start_at: start,
      end_at: start + HOUR,
      name,
      updated_at: 0,
    })
    .run();
}

/** 人の操作の時刻を比べるので、続けて押した操作が同じミリ秒にならないよう間を置く */
const later = () => Bun.sleep(2);

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

async function saveRule(
  keyword: string,
  serviceIds: number[] = [],
): Promise<number> {
  const fields = form({ keyword, dedupe: "0" });
  for (const id of serviceIds) fields.append("serviceIds", String(id));
  const saved = await createRule(fields);
  if ("error" in saved) throw new Error(saved.error);
  return saved.id;
}

const rowOf = (programId: number) =>
  orm()
    .select({
      rule_id: reservations.rule_id,
      manual: reservations.manual,
      state: reservations.state,
      canceled_by: reservations.canceled_by,
      claimed_from: reservations.claimed_from,
      priority: reservations.priority,
    })
    .from(reservations)
    .where(eq(reservations.program_id, programId))
    .get();

describe("取り消しのあとに保存したルール", () => {
  test("取り消した回を、そのルールの予約として作り直す", async () => {
    program(10, "テスト魔法 #1");
    await reserve(10);
    await cancelProgram(10);
    await later();
    const rule = await saveRule("テスト魔法");
    expect(rowOf(10)).toEqual({
      rule_id: rule,
      manual: false,
      state: "scheduled",
      canceled_by: null,
      claimed_from: "canceled",
      priority: 1,
    });
  });

  test("ルールのあとに取り消した回は作り直さない。直して保存すると作り直す", async () => {
    program(10, "テスト魔法 #1");
    const rule = await saveRule("テスト魔法");
    await later();
    await cancelProgram(10);
    applyRules();
    expect(rowOf(10)).toMatchObject({ state: "canceled", rule_id: rule });

    // 止めて有効に戻すだけでは保存した時刻は変わらない (一覧のスイッチには下見が無い)
    await toggleRule(rule);
    await toggleRule(rule);
    expect(rowOf(10)).toMatchObject({ state: "canceled" });

    await later();
    await updateRule(rule, form({ keyword: "テスト魔法", dedupe: "0" }));
    expect(rowOf(10)).toMatchObject({
      state: "scheduled",
      rule_id: rule,
      claimed_from: "canceled",
    });
  });

  test("引き取ったルールを消すと取り消しに戻り、取り消しより前のルールは拾わない", async () => {
    program(10, "テスト魔法 #1");
    const older = await saveRule("テスト");
    await later();
    await cancelProgram(10);
    await later();
    const newer = await saveRule("テスト魔法");
    expect(rowOf(10)).toMatchObject({ rule_id: newer, state: "scheduled" });

    // 録らなくなった数に入る
    expect(await deleteRule(newer)).toBe(1);
    expect(rowOf(10)).toEqual({
      rule_id: null,
      manual: true,
      state: "canceled",
      canceled_by: "user",
      claimed_from: null,
      priority: 2,
    });
    applyRules();
    expect(rowOf(10)).toMatchObject({ state: "canceled" });
    expect(older).toBeGreaterThan(0);
  });

  test("引き取ったルールを止めても取り消しに戻る", async () => {
    program(10, "テスト魔法 #1");
    await reserve(10);
    await cancelProgram(10);
    await later();
    const rule = await saveRule("テスト魔法");
    await toggleRule(rule);
    expect(rowOf(10)).toMatchObject({ state: "canceled", manual: true });
  });

  test("引き取った予約を人が取り消したら、そのルールは作り直さない", async () => {
    program(10, "テスト魔法 #1");
    await reserve(10);
    await cancelProgram(10);
    await later();
    const rule = await saveRule("テスト魔法");
    await later();
    await cancelProgram(10);
    applyRules();
    expect(rowOf(10)).toMatchObject({
      state: "canceled",
      rule_id: rule,
      claimed_from: null,
    });
  });
});

describe("ルールを消したときの人の取り消し", () => {
  test("取り消しの記録は手動予約の取り消しとして残り、前のルールは拾わない", async () => {
    program(10, "テスト魔法 #1");
    const older = await saveRule("テスト");
    await later();
    const newer = await saveRule("テスト魔法");
    // 先勝ちで older の予約。人が取り消す
    await cancelProgram(10);
    expect(rowOf(10)).toMatchObject({ rule_id: older, state: "canceled" });

    await deleteRule(older);
    expect(rowOf(10)).toMatchObject({
      rule_id: null,
      manual: true,
      state: "canceled",
    });
    // newer も取り消しより前に保存したので拾わない
    applyRules();
    expect(rowOf(10)).toMatchObject({ state: "canceled" });
    expect(newer).toBeGreaterThan(0);

    // 「戻す」と手動予約として録る
    const id = orm()
      .select({ id: reservations.id })
      .from(reservations)
      .where(eq(reservations.program_id, 10))
      .get()!.id;
    await restore(id);
    applyRules();
    expect(rowOf(10)).toMatchObject({ state: "scheduled", manual: true });
  });
});

describe("手動予約のあとに保存したルール", () => {
  test("手動予約をルールの予約に切り替える。消すと手動予約に戻る", async () => {
    program(10, "テスト魔法 #1");
    await reserve(10);
    await later();
    const rule = await saveRule("テスト魔法");
    expect(rowOf(10)).toEqual({
      rule_id: rule,
      manual: false,
      state: "scheduled",
      canceled_by: null,
      claimed_from: "manual",
      priority: 1,
    });

    // 消すと、録らなくなった数には入らない (手動予約として録る)
    expect(await deleteRule(rule)).toBe(0);
    expect(rowOf(10)).toMatchObject({
      rule_id: null,
      manual: true,
      state: "scheduled",
      claimed_from: null,
      priority: 2,
    });
  });

  test("ルールのあとの手動予約はそのまま", async () => {
    program(10, "テスト魔法 #1");
    const rule = await saveRule("テスト魔法");
    await later();
    await reserve(10);
    applyRules();
    expect(rowOf(10)).toMatchObject({ manual: true, rule_id: rule });
  });

  test("手動予約に押し直すと、引き取ったルールから手動予約に戻る", async () => {
    program(10, "テスト魔法 #1");
    await reserve(10);
    await later();
    await saveRule("テスト魔法");
    await later();
    await reserve(10);
    expect(rowOf(10)).toMatchObject({ manual: true, claimed_from: null });
    applyRules();
    expect(rowOf(10)).toMatchObject({ manual: true });
  });

  test("引き取ったあと、手動予約より前のルールには付け替えない", async () => {
    program(10, "テスト魔法 #1");
    const older = await saveRule("テスト");
    await later();
    await reserve(10);
    await later();
    const newer = await saveRule("テスト魔法");
    expect(rowOf(10)).toMatchObject({ rule_id: newer, manual: false });

    await toggleRule(newer);
    expect(rowOf(10)).toMatchObject({ rule_id: null, manual: true });
    expect(older).toBeGreaterThan(0);
  });
});

describe("録り始めたもの", () => {
  test("取り消した録画中の回は引き取らない", async () => {
    // 始まっている番組 (ルールは始まる前の番組しか見ない)
    program(10, "テスト魔法 #1", -10 * 60_000);
    await reserve(10);
    orm()
      .update(reservations)
      .set({ started_at: Date.now() })
      .where(eq(reservations.program_id, 10))
      .run();
    await cancelProgram(10);
    await later();
    await saveRule("テスト魔法");
    expect(rowOf(10)).toMatchObject({ state: "canceled", manual: true });
  });
});

describe("番組表だけが動いたとき", () => {
  test("event_id が変わった取り消しも、あとに保存したルールが新しい番組で立てる", async () => {
    program(10, "テスト魔法 #1");
    await reserve(10);
    await cancelProgram(10);
    await later();
    const rule = await saveRule("テスト魔法");
    expect(rowOf(10)).toMatchObject({ rule_id: rule, state: "scheduled" });

    // 番組表の取り込みが同じ番組を別の id で入れ直した。引き取った行は番組表から消えた番組を指したまま残る
    orm().delete(programs).where(eq(programs.id, 10)).run();
    program(12, "テスト魔法 #1");
    applyRules();
    expect(rowOf(12)).toMatchObject({ rule_id: rule, state: "scheduled" });
  });

  test("取り消しのほうが新しければ、載り直しても立てない", async () => {
    program(10, "テスト魔法 #1");
    await saveRule("テスト魔法");
    await later();
    await cancelProgram(10);
    orm().delete(programs).where(eq(programs.id, 10)).run();
    program(12, "テスト魔法 #1");
    applyRules();
    expect(rowOf(12)).toBeUndefined();
  });
});

/*
 * **同じ放送が枝番の局 (23608 / 23609) の両方に載るとき。** ルールは小さいほうだけを録る (`rules.oneBroadcast`)。
 * 人が大きいほうに手動予約を入れていると、ルールが小さいほうに別の予約を立て、同じ放送を 2 本録っていた
 */
describe("枝番の局に載った同じ放送の手動予約", () => {
  const rows = () =>
    orm()
      .select({
        program_id: reservations.program_id,
        manual: reservations.manual,
        state: reservations.state,
      })
      .from(reservations)
      .orderBy(reservations.program_id)
      .all();

  test("手動予約のほうが新しければ、ルールはもう片方の局に立てない", async () => {
    await saveRule("テスト魔法");
    await later();
    program(10, "テスト魔法 #1");
    program(11, "テスト魔法 #1", 3 * HOUR, MX_SUB);
    await reserve(11);
    applyRules();
    expect(rows()).toEqual([
      { program_id: 11, manual: true, state: "scheduled" },
    ]);
  });

  test("手動予約より後に保存したルールは、その手動予約を引き取る", async () => {
    program(10, "テスト魔法 #1");
    program(11, "テスト魔法 #1", 3 * HOUR, MX_SUB);
    await reserve(11);
    await later();
    const rule = await saveRule("テスト魔法");
    expect(rowOf(10)).toBeUndefined();
    expect(rowOf(11)).toMatchObject({
      rule_id: rule,
      manual: false,
      claimed_from: "manual",
    });
  });

  test("もう片方の局だけを選んだルールも、手動予約と同じ放送には立てない", async () => {
    program(10, "テスト魔法 #1");
    program(11, "テスト魔法 #1", 3 * HOUR, MX_SUB);
    await reserve(11);
    await later();
    await saveRule("テスト魔法", [MX]);
    expect(rows()).toEqual([
      { program_id: 11, manual: true, state: "scheduled" },
    ]);
  });
});
