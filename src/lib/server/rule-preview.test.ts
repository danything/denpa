import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

/**
 * **ルールの下見** (`rule-preview.ts`) と、書く欄の読み取り (`rule-form.ts`)。
 * 検索の結果の行に出す「録る / 録らない (理由) / 予約済み」は、予約を立てるときと同じ判定から出す
 */
const { config } = await import("./config");
config.dbPath = join(
  mkdtempSync(join(tmpdir(), "denpa-rule-preview-")),
  "denpa.db",
);
// エージェントには繋がない (チューナーの台数は空 = 競合は出さない)
const realAgent = config.agentUrl;
config.agentUrl = "http://127.0.0.1:9";

const { now, orm } = await import("./db");
const { clockOf, jstOf } = await import("../rule-time");
const { previewFor } = await import("./rule-preview");
const {
  conditionsOf,
  draftRule,
  HALF_TIME,
  originOf,
  rulePriority,
  SAME_TIME,
} = await import("./rule-form");
const {
  programs,
  recordings,
  reservations,
  rules: ruleTable,
  services,
} = await import("./schema");

const MX = 3239123608;
const BS11 = 400211;
const HOUR = 60 * 60 * 1000;

function clear(): void {
  orm().delete(recordings).run();
  orm().delete(reservations).run();
  orm().delete(programs).run();
  orm().delete(ruleTable).run();
  orm().delete(services).run();
}
afterAll(() => {
  clear();
  config.agentUrl = realAgent;
});

let base = now();

beforeEach(() => {
  base = now();
  clear();
  orm()
    .insert(services)
    .values([
      {
        id: MX,
        service_id: 23608,
        network_id: 32391,
        name: "TOKYO MX1",
        type: "GR",
        service_type: 1,
        channel: "T16",
        updated_at: now(),
      },
      {
        id: BS11,
        service_id: 211,
        network_id: 4,
        name: "BS11",
        type: "BS",
        service_type: 1,
        channel: "BS09_0",
        updated_at: now(),
      },
    ])
    .run();
});

function program(
  id: number,
  name: string,
  startsIn: number,
  serviceId = MX,
): void {
  const start = base + startsIn;
  orm()
    .insert(programs)
    .values({
      id,
      service_id: serviceId,
      network_id: 32391,
      event_id: id,
      start_at: start,
      end_at: start + HOUR,
      name,
      updated_at: now(),
    })
    .run();
}

/** 書く欄の値 (URLSearchParams も FormData も `get` / `getAll` を持つ) */
function form(values: Record<string, string | string[]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const v of Array.isArray(value) ? value : [value])
      params.append(key, v);
  }
  return params;
}

describe("書く欄を読む", () => {
  test("空なら下見を組まない", () => {
    expect(draftRule(form({ keyword: "  " }))).toBeNull();
    expect(conditionsOf(form({})).empty).toBe(true);
  });

  test("局だけでも条件になる", () => {
    const rule = draftRule(form({ serviceIds: String(BS11) }));
    expect(rule?.service_ids).toEqual([BS11]);
    expect(rule?.keyword).toBe("");
  });

  test("「同じ回は最初の放送だけ」は送られてこなければ入れる。外したら外れる", () => {
    expect(draftRule(form({ keyword: "a" }))?.dedupe).toBe(true);
    expect(draftRule(form({ keyword: "a", dedupe: "0" }))?.dedupe).toBe(false);
    expect(draftRule(form({ keyword: "a", dedupe: ["0", "1"] }))?.dedupe).toBe(
      true,
    );
    expect(conditionsOf(form({ keyword: "a" })).dedupe).toBeNull();
  });

  test("「前の回は録らない」は送られてこなければ切る。入れたら入る", () => {
    expect(draftRule(form({ keyword: "a" }))?.skip_earlier).toBe(false);
    expect(
      draftRule(form({ keyword: "a", skipEarlier: ["0", "1"] }))?.skip_earlier,
    ).toBe(true);
    expect(
      draftRule(form({ keyword: "a", skipEarlier: "0" }))?.skip_earlier,
    ).toBe(false);
    expect(conditionsOf(form({ keyword: "a" })).skipEarlier).toBeNull();
  });

  test("優先度は空なら 1、0 はそのまま", () => {
    expect(rulePriority(form({ priority: "" }))).toBe(1);
    expect(rulePriority(form({ priority: "0" }))).toBe(0);
    expect(rulePriority(form({ priority: "3" }))).toBe(3);
    expect(rulePriority(form({ priority: "-1" }))).toBe(1);
  });

  test("時間帯は HH:MM を分に、曜日は 0〜6 を並べ直す", () => {
    const read = conditionsOf(
      form({
        keyword: "a",
        timeFrom: "23:00",
        timeTo: "02:30",
        weekdays: ["5", "1", "5", "9"],
      }),
    );
    expect([read.timeFrom, read.timeTo]).toEqual([23 * 60, 2 * 60 + 30]);
    expect(read.weekdays).toEqual([1, 5]);
    expect(read.invalid).toBeNull();
    // 空ならいつでも。7日とも選んだものも毎日
    const none = conditionsOf(
      form({
        keyword: "a",
        timeFrom: "",
        timeTo: "",
        weekdays: ["0", "1", "2", "3", "4", "5", "6"],
      }),
    );
    expect([none.timeFrom, none.timeTo, none.weekdays]).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("始まりと終わりが同じ時間帯・片方だけの時間帯は断る", () => {
    const same = conditionsOf(
      form({ keyword: "a", timeFrom: "19:00", timeTo: "19:00" }),
    );
    expect(same.invalid).toBe(SAME_TIME);
    expect(same.timeFrom).toBeNull();
    expect(
      draftRule(form({ keyword: "a", timeFrom: "19:00", timeTo: "19:00" })),
    ).toBeNull();
    expect(
      conditionsOf(form({ keyword: "a", timeFrom: "19:00" })).invalid,
    ).toBe(HALF_TIME);
  });

  test("時間帯や曜日だけでは条件にならない。局などと組めば入る", () => {
    expect(conditionsOf(form({ weekdays: "6" })).empty).toBe(true);
    expect(draftRule(form({ timeFrom: "19:00", timeTo: "20:00" }))).toBeNull();
    const rule = draftRule(
      form({ serviceTypes: "GR", timeFrom: "19:00", timeTo: "20:00" }),
    );
    expect([rule?.time_from, rule?.time_to, rule?.weekdays]).toEqual([
      19 * 60,
      20 * 60,
      null,
    ]);
  });
});

describe("検索の行ごとの「録るか」", () => {
  test("録る・除外・局・同じ回・予約済み・放送中を見分ける", async () => {
    program(1, "テスト魔法 #1「始まり」", 2 * HOUR);
    // 同じ回を BS11 で後から流す (同じ回は最初の放送だけ)
    program(2, "テスト魔法 #1「始まり」", 5 * HOUR, BS11);
    program(3, "テスト魔法 #2「続き」(再放送)", 8 * HOUR);
    program(4, "テスト魔法 #3「三つめ」", 26 * HOUR);
    program(5, "テスト魔法 #4「四つめ」", 50 * HOUR);
    // いま放送している (ルールはこれから始まる放送にだけ立てる)
    program(6, "テスト魔法 #0「前の回」", -10 * 60 * 1000);
    orm()
      .insert(reservations)
      .values({
        program_id: 5,
        rule_id: null,
        service_id: MX,
        name: "テスト魔法 #4「四つめ」",
        description: "",
        start_at: base + 50 * HOUR,
        end_at: base + 51 * HOUR,
        priority: 2,
        manual: true,
        state: "scheduled",
        created_at: now(),
        updated_at: now(),
      })
      .run();

    const rule = draftRule(
      form({
        keyword: "テスト魔法",
        ignoreKeyword: "再放送",
        dedupe: ["0", "1"],
      }),
    );
    expect(rule).not.toBeNull();
    const preview = await previewFor(rule!, { ids: [1, 2, 3, 4, 5, 6] });
    expect(preview.failed).toBeNull();
    expect(preview.verdicts).toEqual({
      1: { kind: "record" },
      2: { kind: "skip", reason: "repeat" },
      3: { kind: "skip", reason: "ignore" },
      4: { kind: "record" },
      5: { kind: "reserved", state: "scheduled" },
      6: { kind: "skip", reason: "airing" },
    });
    // 当たったのは 1・2・4・5 (3 は除外、6 は始まっている)。同じ回の 2 は録らない
    expect(preview.total).toBe(4);
    expect(preview.skipped).toBe(1);

    // 局を BS11 だけにすると、MX の行は「局」で外れる
    const bs = draftRule(
      form({
        keyword: "テスト魔法",
        serviceIds: String(BS11),
        dedupe: ["0", "1"],
      }),
    );
    const onBs = await previewFor(bs!, { ids: [1, 2, 4] });
    expect(onBs.verdicts).toEqual({
      1: { kind: "skip", reason: "service" },
      2: { kind: "record" },
      4: { kind: "skip", reason: "service" },
    });
  });

  test("時間帯と曜日から外れる行は「時間帯の外」「曜日の外」", async () => {
    program(1, "テスト魔法 #1", 2 * HOUR);
    program(2, "テスト魔法 #2", 5 * HOUR);
    const first = jstOf(base + 2 * HOUR);
    // 1 の始まりから 1 時間だけ。5 時間後の 2 は外
    const slot = {
      keyword: "テスト魔法",
      timeFrom: clockOf(first.minutes),
      timeTo: clockOf((first.minutes + 60) % (24 * 60)),
    };
    const timed = await previewFor(draftRule(form(slot))!, { ids: [1, 2] });
    expect(timed.verdicts).toEqual({
      1: { kind: "record" },
      2: { kind: "skip", reason: "time" },
    });
    // 1 の曜日の次の日だけにすると、1 は曜日で外れる
    const other = await previewFor(
      draftRule(form({ ...slot, weekdays: String((first.weekday + 1) % 7) }))!,
      { ids: [1] },
    );
    expect(other.verdicts).toEqual({ 1: { kind: "skip", reason: "weekday" } });
  });

  test("編集中のルールが立てた予約は、条件から外れると「録らない」になる", async () => {
    program(1, "テスト魔法 #1", 5 * HOUR);
    orm()
      .insert(ruleTable)
      .values({
        id: 7,
        name: "テスト魔法",
        keyword: "テスト魔法",
        enabled: true,
        created_at: now(),
      })
      .run();
    orm()
      .insert(reservations)
      .values({
        program_id: 1,
        rule_id: 7,
        service_id: MX,
        name: "テスト魔法 #1",
        description: "",
        start_at: base + 5 * HOUR,
        end_at: base + 6 * HOUR,
        priority: 1,
        manual: false,
        state: "scheduled",
        created_at: now(),
        updated_at: now(),
      })
      .run();
    const editing = orm()
      .select()
      .from(ruleTable)
      .where(eq(ruleTable.id, 7))
      .get()!;

    const same = await previewFor(draftRule(form({ keyword: "テスト魔法" }))!, {
      editing,
      ids: [1],
    });
    expect(same.verdicts[1]).toEqual({ kind: "reserved", state: "scheduled" });

    const narrowed = await previewFor(
      draftRule(form({ keyword: "テスト魔法", ignoreKeyword: "#1" }))!,
      {
        editing,
        ids: [1],
      },
    );
    expect(narrowed.verdicts[1]).toEqual({ kind: "skip", reason: "ignore" });
    // 行には「条件外」で残る (保存すると引っ込む予約)
    expect(narrowed.programs.map((row) => [row.id, row.matched])).toEqual([
      [1, false],
    ]);
  });
});

describe("録画・番組から作るときの元", () => {
  test("from=program:<ID> はシリーズ名の下書きと、録っているルール", () => {
    program(1, "テスト魔法 #1「始まり」", 2 * HOUR);
    expect(originOf("program:1")).toMatchObject({
      kind: "program",
      id: 1,
      found: true,
      prefill: { keyword: "テスト魔法" },
      rule: null,
    });
    orm()
      .insert(ruleTable)
      .values({
        id: 3,
        name: "テスト魔法",
        keyword: "テスト魔法",
        enabled: true,
        created_at: now(),
      })
      .run();
    expect(originOf("program:1")?.rule?.id).toBe(3);
  });

  test("無い番組は見つからない、形の違うものは元にしない", () => {
    expect(originOf("program:999")).toMatchObject({
      found: false,
      prefill: null,
    });
    expect(originOf("recording:999")).toMatchObject({
      kind: "recording",
      found: false,
    });
    expect(originOf("program:abc")).toBeNull();
    expect(originOf("channel:1")).toBeNull();
    expect(originOf(null)).toBeNull();
  });
});

describe("人が取り消した放送", () => {
  test("ルールは立て直さないので、下見でも「録らない」(取り消し済み)", async () => {
    program(1, "テスト魔法 #1", 5 * HOUR);
    program(2, "テスト魔法 #2", 8 * HOUR);
    orm()
      .insert(reservations)
      .values({
        program_id: 1,
        rule_id: null,
        service_id: MX,
        name: "テスト魔法 #1",
        description: "",
        start_at: base + 5 * HOUR,
        end_at: base + 6 * HOUR,
        priority: 2,
        manual: true,
        state: "canceled",
        created_at: now(),
        updated_at: now(),
      })
      .run();
    const preview = await previewFor(
      draftRule(form({ keyword: "テスト魔法", dedupe: "0" }))!,
      {
        ids: [1, 2],
      },
    );
    expect(preview.verdicts).toEqual({
      1: { kind: "skip", reason: "declined" },
      2: { kind: "record" },
    });
  });
});
