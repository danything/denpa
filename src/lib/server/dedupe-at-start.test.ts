import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelType } from "../types";

/**
 * **録り始めに「同じ回は最初の放送だけ」を見直す** (`rules.duplicateAtStart`)。
 *
 * 局によっては話数を放送の直前の EIT[p/f] にしか載せない (実機の BS日テレ。数日前の番組表では
 * タイトルにも概要にも話数が無い)。予約の時点では同じ回と分からず両方の予約が立つので、録画が p/f で
 * 書き直した情報 (`recorder.refreshFromPf`) で見直す。ここでは書き直したあとの録画の行を置いて見る
 */
const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-dedupe-")), "denpa.db");

const { now, orm } = await import("./db");
const { placeServices } = await import("./fake-channels");
const { duplicateAtStart } = await import("./rules");
const {
  programs,
  recordedHistory,
  recordings,
  reservations,
  rules: ruleTable,
  services,
} = await import("./schema");

const MX = 3239123608;
const BS = 400141;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function clear(): void {
  orm().delete(recordings).run();
  orm().delete(recordedHistory).run();
  orm().delete(reservations).run();
  orm().delete(programs).run();
  orm().delete(ruleTable).run();
  orm().delete(services).run();
}
afterAll(clear);

let base = now();
beforeEach(() => {
  base = now();
  clear();
  service(MX, "TOKYO MX1", "GR", "T16");
  service(BS, "BS日テレ", "BS", "BS13_0");
  rule(1, "テスト令嬢", true);
});

function service(
  id: number,
  name: string,
  type: ChannelType,
  channel: string,
): void {
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

function rule(id: number, keyword: string, dedupe: boolean): void {
  orm()
    .insert(ruleTable)
    .values({
      id,
      name: keyword,
      keyword,
      search_fields: "name",
      enabled: true,
      priority: 1,
      dedupe,
      created_at: now(),
    })
    .run();
}

interface Aired {
  id: number;
  serviceId: number;
  name: string;
  description?: string;
  startsIn: number;
  /** 予約を立てたルール。null は手動 */
  rule?: number | null;
  /** 録画の行の様子 */
  finished?: boolean;
  error?: string;
}

/** 番組・予約・録画の行を 1 組置く。録画の id は番組の id と同じにする (置いた順に小さい) */
function aired(a: Aired): void {
  const start = base + a.startsIn;
  const service = orm()
    .select()
    .from(services)
    .all()
    .find((s) => s.id === a.serviceId)!;
  orm()
    .insert(programs)
    .values({
      id: a.id,
      service_id: a.serviceId,
      network_id: service.network_id,
      event_id: a.id,
      start_at: start,
      end_at: start + HOUR / 2,
      name: a.name,
      description: a.description ?? "",
      updated_at: now(),
    })
    .run();
  const rule = a.rule === undefined ? 1 : a.rule;
  orm()
    .insert(reservations)
    .values({
      id: a.id,
      program_id: a.id,
      rule_id: rule,
      service_id: a.serviceId,
      name: a.name,
      start_at: start,
      end_at: start + HOUR / 2,
      manual: rule === null,
      state: "scheduled",
      started_at: start - 10_000,
      created_at: now(),
      updated_at: now(),
    })
    .run();
  orm()
    .insert(recordings)
    .values({
      id: a.id,
      reservation_id: a.id,
      program_id: a.id,
      service_id: a.serviceId,
      service_name: service.name,
      name: a.name,
      description: a.description ?? "",
      start_at: start,
      end_at: start + HOUR / 2,
      ...(a.finished === true ? { finished_at: start + HOUR / 2 } : {}),
      ...(a.error === undefined ? {} : { error: a.error }),
      created_at: now(),
      updated_at: now(),
    })
    .run();
}

/** MX の 6 話 (タイトルに話数) を前の日に録ってある */
const mx6 = (over: Partial<Aired> = {}): void =>
  aired({
    id: 1,
    serviceId: MX,
    name: "テスト令嬢ミア・リストン　＃６",
    startsIn: -DAY,
    finished: true,
    ...over,
  });

/** BS日テレの同じ回。番組表ではタイトルにも概要にも話数が無く、p/f の概要に「第 6 話　副題」 */
const bs = (description: string, over: Partial<Aired> = {}): void =>
  aired({
    id: 2,
    serviceId: BS,
    name: "アニメ　テスト令嬢ミア・リストン",
    description,
    startsIn: 10_000,
    ...over,
  });

describe("録り始めに同じ回を見直す", () => {
  test("p/f の概要で 6 話と分かれば、MX で録った 6 話と同じ回なのでやめる", () => {
    mx6();
    bs("第6話　魔法映像普及活動会議");
    expect(duplicateAtStart(2)).toBe(
      "同じ回を TOKYO MX1 で録画済みなので録画しません",
    );
  });

  test("話数が読めなければ録る (番組表のままの概要)", () => {
    mx6();
    bs("");
    expect(duplicateAtStart(2)).toBeNull();
  });

  test("違う回なら録る", () => {
    mx6();
    bs("第7話　次の副題");
    expect(duplicateAtStart(2)).toBeNull();
  });

  test("録画中の同じ回も相手になる (先に録り始めたもの)", () => {
    mx6({ startsIn: -5 * 60_000, finished: false });
    bs("第6話　魔法映像普及活動会議");
    expect(duplicateAtStart(2)).not.toBeNull();
  });

  test("あとから録り始めたものは相手にしない (同時に始まった同じ回が、互いにやめないように)", () => {
    mx6({ finished: false, startsIn: 10_000 });
    bs("第6話　魔法映像普及活動会議");
    // 先に録り始めた MX (id 1) から見ると、BS (id 2) はあと
    expect(duplicateAtStart(1)).toBeNull();
    expect(duplicateAtStart(2)).not.toBeNull();
  });

  test("失敗した録画は録ってある回に数えない (再放送は録り直す好機)", () => {
    mx6({ error: "ストリームから 1 バイトも受信できませんでした" });
    bs("第6話　魔法映像普及活動会議");
    expect(duplicateAtStart(2)).toBeNull();
  });

  test("引き継いだ履歴の回も相手になる", () => {
    orm()
      .insert(recordedHistory)
      .values({
        name: "テスト令嬢ミア・リストン　＃６",
        service_name: "",
        end_at: base - DAY,
        source: "epgstation:recorded:1",
      })
      .run();
    bs("第6話　魔法映像普及活動会議");
    expect(duplicateAtStart(2)).toBe("同じ回を録画済みなので録画しません");
  });

  test("手動の予約は見ない", () => {
    mx6();
    bs("第6話　魔法映像普及活動会議", { rule: null });
    expect(duplicateAtStart(2)).toBeNull();
  });

  test("「同じ回は…」を入れていないルールの予約は見ない", () => {
    rule(2, "テスト令嬢", false);
    mx6();
    bs("第6話　魔法映像普及活動会議", { rule: 2 });
    expect(duplicateAtStart(2)).toBeNull();
  });

  test("入れていないルールも当たるなら、そちらが受け持って録る", () => {
    rule(2, "ミア", false);
    mx6();
    bs("第6話　魔法映像普及活動会議");
    expect(duplicateAtStart(2)).toBeNull();
  });

  test("BS が先なら BS は録り、書き直した概要で MX の 6 話がやめる", () => {
    // BS (id 1) が先に録り終えている。録画の行は p/f で書き直した概要を持つ
    aired({
      id: 1,
      serviceId: BS,
      name: "アニメ　テスト令嬢ミア・リストン",
      description: "第6話　魔法映像普及活動会議",
      startsIn: -DAY,
      finished: true,
    });
    expect(duplicateAtStart(1)).toBeNull();
    aired({
      id: 2,
      serviceId: MX,
      name: "テスト令嬢ミア・リストン　＃６",
      startsIn: 10_000,
    });
    expect(duplicateAtStart(2)).toBe(
      "同じ回を BS日テレ で録画済みなので録画しません",
    );
  });
});
