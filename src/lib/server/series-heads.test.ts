import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 番組表から控えに足し、シリーズの先頭を学び直して当てるところ (`series-heads.ts`)。
 * 学ぶ決まりそのものは series.test.ts で見る
 */
const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-series-")), "denpa.db");

const { now, orm } = await import("./db");
const { programs, recordings, seriesHeads, seriesTitles, services } =
  await import("./schema");
const {
  SERIES_HOLD_DAYS,
  SERIES_KEEP_DAYS,
  forgetForTest,
  relearn,
  seriesName,
  seriesParts,
} = await import("./series-heads");
const { keyOf } = await import("./series");

const DAY = 24 * 60 * 60_000;
let nextId = 1;

function service(id: number, name: string): void {
  orm()
    .insert(services)
    .values({
      id,
      service_id: id,
      network_id: 4,
      name,
      type: "BS",
      updated_at: now(),
    })
    .run();
}

function program(serviceId: number, name: string): void {
  const id = nextId++;
  orm()
    .insert(programs)
    .values({
      id,
      service_id: serviceId,
      network_id: 4,
      event_id: id,
      start_at: now() + id * 60_000,
      end_at: now() + id * 60_000 + 30 * 60_000,
      name,
      updated_at: now() + id,
    })
    .run();
}

beforeEach(() => {
  for (const table of [
    programs,
    services,
    recordings,
    seriesTitles,
    seriesHeads,
  ])
    orm().delete(table).run();
  forgetForTest();
  service(1, "ＢＳテレ東");
  service(2, "");
});

describe("relearn", () => {
  test("番組表を控えに足して学び、番組名を学んだ先頭で切る。残りは副題の前に回す", async () => {
    program(1, "おんがく交差点【民族楽器×歌うヴァイオリン名曲集】🈑");
    program(1, "おんがく交差点【『攻殻機動隊』を歌う民謡の達人？】🈑");
    expect(seriesName("おんがく交差点【新しい回】")).toBe(
      "おんがく交差点【新しい回】",
    );
    expect(await relearn()).toBe(true);
    expect(seriesName("おんがく交差点【新しい回】")).toBe("おんがく交差点");
    expect(seriesParts("おんがく交差点【新しい回】", "")).toEqual({
      series: "おんがく交差点",
      subtitle: "【新しい回】",
    });
    expect(orm().select().from(seriesTitles).all()).toHaveLength(2);
  });

  test("控えも録画も変わっていなければ学ばない", async () => {
    program(1, "おんがく交差点【A】");
    program(1, "おんがく交差点【B】");
    expect(await relearn()).toBe(true);
    expect(await relearn()).toBe(false);
    program(1, "おんがく交差点【C】");
    expect(await relearn()).toBe(true);
  });

  test("局名が空の局は学ばない", async () => {
    program(2, "おんがく交差点【A】");
    program(2, "おんがく交差点【B】");
    await relearn();
    expect(orm().select().from(seriesTitles).all()).toHaveLength(0);
    expect(seriesName("おんがく交差点【A】")).toBe("おんがく交差点【A】");
  });

  test("採らなくなった先頭は残す日数のあいだ残す。枠と分かった先頭と、期限を過ぎた控えは消す", async () => {
    const at = now();
    orm()
      .insert(seriesHeads)
      .values([
        { key: keyOf("最近の番組"), last_adopted: at - DAY },
        {
          key: keyOf("昔の番組"),
          last_adopted: at - (SERIES_HOLD_DAYS + 1) * DAY,
        },
        { key: keyOf("韓国ドラマ"), last_adopted: at - DAY },
      ])
      .run();
    orm()
      .insert(seriesTitles)
      .values([
        // 枠: 続いている子が 2 つ
        ...["韓国ドラマ　X", "韓国ドラマ　Y"].map((series) => ({
          station: "a",
          series,
          title: series,
          titles: 2,
          last_seen: at,
        })),
        {
          station: "a",
          series: "とうに終わった番組",
          title: "x",
          titles: 1,
          last_seen: at - (SERIES_KEEP_DAYS + 1) * DAY,
        },
      ])
      .run();
    await relearn();
    const keys = orm()
      .select({ key: seriesHeads.key })
      .from(seriesHeads)
      .all()
      .map(({ key }) => key);
    expect(keys).toContain(keyOf("最近の番組"));
    expect(keys).not.toContain(keyOf("昔の番組"));
    expect(keys).not.toContain(keyOf("韓国ドラマ"));
    expect(
      orm()
        .select()
        .from(seriesTitles)
        .all()
        .map(({ series }) => series),
    ).not.toContain("とうに終わった番組");
  });

  test("録画からも学ぶ (番組表から消えた回も数える)", async () => {
    program(1, "ダークサイドミステリー　連続怪死！妻たちが死神になった村🈑");
    orm()
      .insert(recordings)
      .values({
        service_id: 1,
        service_name: "ＢＳテレ東",
        name: "ダークサイドミステリー　歴史の闇！ヒトラーは生きている？🈑",
        series: "ダークサイドミステリー　歴史の闇！ヒトラーは生きている？",
        start_at: now() - DAY,
        end_at: now() - DAY + 60 * 60_000,
        finished_at: now() - DAY,
        created_at: now() - DAY,
        updated_at: now() - DAY,
      })
      .run();
    await relearn();
    expect(seriesName("ダークサイドミステリー　次の回")).toBe(
      "ダークサイドミステリー",
    );
  });
});

describe("relearn (失敗したとき)", () => {
  test("学び終える前に失敗したら、入力が変わらなくても次に学び直す", async () => {
    const { sql } = await import("drizzle-orm");
    program(1, "おんがく交差点【A】");
    program(1, "おんがく交差点【B】");
    orm().run(sql`ALTER TABLE series_heads RENAME TO series_heads_away`);
    try {
      await expect(relearn()).rejects.toThrow();
    } finally {
      orm().run(sql`ALTER TABLE series_heads_away RENAME TO series_heads`);
    }
    expect(await relearn()).toBe(true);
    expect(seriesName("おんがく交差点【C】")).toBe("おんがく交差点");
  });
});

describe("relearn (控えを書いたあとに失敗したとき)", () => {
  test("前に学び終えていても、控えの変わったぶんを次に学ぶ", async () => {
    const { sql } = await import("drizzle-orm");
    program(1, "おんがく交差点【A】");
    expect(await relearn()).toBe(true);
    program(1, "おんがく交差点【B】");
    orm().run(sql`ALTER TABLE series_heads RENAME TO series_heads_away`);
    try {
      await expect(relearn()).rejects.toThrow();
    } finally {
      orm().run(sql`ALTER TABLE series_heads_away RENAME TO series_heads`);
    }
    expect(await relearn()).toBe(true);
    expect(seriesName("おんがく交差点【C】")).toBe("おんがく交差点");
  });
});
