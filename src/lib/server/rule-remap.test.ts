import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

/**
 * 選局できなくなった局を指すルールの付け替え。サービス ID が変わった局 (BS釣りビジョン 251 → 新しいチャンネル 252)
 * を作り、候補が出ること・人が選んだ局にだけ付け替えることを見る
 */
const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-remap-")), "denpa.db");

const { orm } = await import("./db");
const { rules, services } = await import("./schema");
const { orphanedRules, remapRule } = await import("./rule-remap");

/** 局の行。`updated_at` が最新のものが、いまの局の一覧 (`epg.currentServices`) */
function station(
  id: number,
  name: string,
  channel: string,
  updatedAt: number,
  type: "BS" | "CS" = "BS",
) {
  orm()
    .insert(services)
    .values({
      id,
      service_id: id % 100000,
      network_id: Math.floor(id / 100000),
      name,
      type,
      service_type: 1,
      channel,
      updated_at: updatedAt,
    })
    .run();
}

const NOW = 2_000;
const OLD = 1_000;
station(400251, "ＢＳ釣りビジョン", "BS03:17970", OLD);
station(400252, "ＢＳ１２　２", "BS03:17970", NOW);
station(400222, "ＢＳ１２", "BS09:16530", NOW);
station(400101, "ＮＨＫ　ＢＳ", "BS15:16625", NOW);
station(600296, "ＣＳの局", "CS02:24608", NOW, "CS");

const ruleId = Number(
  orm()
    .insert(rules)
    .values({
      name: "釣り",
      keyword: "釣り",
      service_ids: [400251, 400101],
      created_at: 0,
    })
    .returning({ id: rules.id })
    .get().id,
);

describe("選局できなくなった局を指すルール", () => {
  test("同じチャンネルの局を候補に出す (同じ種別だけ。ルールが指している局は出さない)", () => {
    expect(orphanedRules()).toEqual([
      {
        ruleId,
        ruleName: "釣り",
        serviceId: 400251,
        serviceName: "ＢＳ釣りビジョン",
        candidates: [{ id: 400252, name: "ＢＳ１２　２" }],
      },
    ]);
  });

  test("候補に無い局には付け替えない", async () => {
    expect(await remapRule(ruleId, 400251, 400222)).toBe(
      "付け替える局が候補にありません",
    );
    expect(await remapRule(ruleId, 400101, 400252)).toBe(
      "このルールは、選局できなくなった局を指していません",
    );
  });

  test("選んだ局に付け替えると、候補から消える", async () => {
    expect(await remapRule(ruleId, 400251, 400252)).toBeNull();
    const rule = orm()
      .select({ service_ids: rules.service_ids })
      .from(rules)
      .where(eq(rules.id, ruleId))
      .get();
    expect(rule?.service_ids).toEqual([400252, 400101]);
    expect(orphanedRules()).toEqual([]);
  });
});

describe("候補の出し方", () => {
  test("ルールがもう指している局は出さず、同じ名前の局も候補にする。止めているルールは出さない", () => {
    station(400291, "ＷＯＷＯＷ", "BS03:16432", OLD);
    station(400292, "ＷＯＷＯＷ２", "BS03:16432", NOW);
    station(400293, "ＷＯＷＯＷ", "BS05:17488", NOW);
    const make = (name: string, ids: number[], enabled = true) =>
      Number(
        orm()
          .insert(rules)
          .values({ name, service_ids: ids, enabled, created_at: 0 })
          .returning({ id: rules.id })
          .get().id,
      );
    const id = make("WOWOW", [400291, 400292]);
    make("止めたルール", [400291], false);
    expect(orphanedRules().filter((o) => o.ruleId === id)).toEqual([
      {
        ruleId: id,
        ruleName: "WOWOW",
        serviceId: 400291,
        serviceName: "ＷＯＷＯＷ",
        // 同じチャンネルの 400292 はルールが指しているので出さない。同じ名前の 400293 を出す
        candidates: [{ id: 400293, name: "ＷＯＷＯＷ" }],
      },
    ]);
    expect(orphanedRules().some((o) => o.ruleName === "止めたルール")).toBe(
      false,
    );
  });
});
