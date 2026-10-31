import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";

import {
  KNOWN_CHANNEL,
  startFakeEpgstation,
  VIDEO_FILES,
  videoContent,
} from "../../../tests/fake/epgstation";

/**
 * EPGStation からの引き継ぎを、偽の EPGStation (`tests/fake/epgstation.ts`) に向けて通しで回す。
 *
 * - 写し方 (ルール・予約・録画・履歴)、v2 と v3、ページ送り、形の違う応答
 * - ファイル: 続きから取る・最初から取り直す・長さが違う・止まる・中断・空きが足りない
 * - 途中で止まっても「ファイルの無い行」を残さない。DB が途中で失敗するところは SQLite のトリガで
 *   RAISE させて作る (本物の取り込みをそのまま動かすため、試験用の差し替えの仕組みは持たない)
 *
 * 設定は環境変数ではなく設定そのものを書き換える (files.test.ts と同じ理由)。
 */
const root = mkdtempSync(join(tmpdir(), "denpa-migrate-"));
const { config } = await import("./config");
config.dbPath = join(root, "denpa.db");
config.rawDir = join(root, "raw");
config.encodedDir = join(root, "encoded");

const { orm } = await import("./db");
const { programs, recordedHistory, recordings, rules, services } =
  await import("./schema");
const api = await import("./epgstation-api");
const migrate = await import("./migrate");
const { record, runEpgstation, start, status, sweepTemporaries } = migrate;

// 待つ長さを縮める (本物は 10 秒・60 秒・2 秒から)
api.timing.header = 400;
api.timing.idle = 400;
api.timing.backoff = 10;

const fake = startFakeEpgstation(0);
afterAll(() => fake.stop());

const apply = { apply: true };
const preview = { apply: false };

/** 偽 EPGStation に向けて1回走らせ、終わるまで待つ */
async function run(
  options = apply,
  signal?: AbortSignal,
  url = fake.url,
): Promise<void> {
  const client = new api.EpgstationClient(api.parseSource(url), record, record);
  const version = await client.version();
  if (version === "v1") throw new Error("v1");
  await runEpgstation(client, version, options, signal);
}

function imported(id: number) {
  return orm()
    .select()
    .from(recordings)
    .where(eq(recordings.program_id, -id))
    .get();
}

function content(path: string | null | undefined): Uint8Array {
  return new Uint8Array(readFileSync(path!));
}

/** 置き場に並んでいるもの (書きかけも含む)。保存先はシリーズのフォルダの中まで */
function placed(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else out.push(entry.name);
    }
  };
  walk(config.rawDir);
  walk(config.encodedDir);
  return out.sort();
}

const temporaries = () =>
  placed().filter((name) => name.endsWith(".migrating"));

/** 録画 2 (元のTS) の書きかけ。元のTSの置き場の直下 */
const rawTemporary = () => join(config.rawDir, ".epgstation-2.m2ts.migrating");

/** 次の INSERT / UPDATE を失敗させる。プロセスが途中で死んだのと同じく、そこで止まる */
function failOn(event: "INSERT" | "UPDATE"): void {
  orm().run(
    sql.raw(
      `CREATE TRIGGER fail_${event} BEFORE ${event} ON recordings BEGIN SELECT RAISE(ABORT, '落ちた'); END`,
    ),
  );
}

beforeEach(() => {
  orm().delete(recordings).run();
  orm().delete(recordedHistory).run();
  orm().delete(rules).run();
  orm().delete(services).run();
  orm()
    .insert(services)
    .values({
      id: KNOWN_CHANNEL,
      service_id: 23608,
      network_id: 32391,
      name: "TOKYO MX1",
      type: "GR",
      channel: "T16",
      updated_at: 0,
    })
    .run();
  rmSync(config.rawDir, { recursive: true, force: true });
  rmSync(config.encodedDir, { recursive: true, force: true });
  config.diskLowThreshold = 0;
  fake.setMode({});
  fake.videoRequests.length = 0;
  fake.listRequests.length = 0;
  fake.authorizations.length = 0;
});

afterEach(() => {
  orm().run(sql.raw("DROP TRIGGER IF EXISTS fail_INSERT"));
  orm().run(sql.raw("DROP TRIGGER IF EXISTS fail_UPDATE"));
});

const SIZE_1 = VIDEO_FILES[11].size;
const SIZE_2 = VIDEO_FILES[21].size;

describe("取り込み (v3)", () => {
  test("ルール・予約・履歴・録画を入れ、録画はエンコード済みを保存先へ、元のTSを作業領域へ", async () => {
    await run();
    const s = status();
    expect(s.state).toBe("done");
    expect(s.error).toBeNull();
    // 録画中のものは対象に入れない。ファイルの無いものと 404 は「ファイル無し」
    expect(s).toMatchObject({
      total: 4,
      imported: 2,
      skipped: 0,
      missing: 2,
      failed: 0,
      bytesDone: SIZE_1 + SIZE_2,
      bytesTotal: SIZE_1 + SIZE_2,
    });
    expect(s.rules).toEqual({ imported: 2, skipped: 2 });
    // 番組表に無い手動予約は入らない。ルールの予約と除外の印は数えない
    expect(s.reservations).toEqual({ imported: 0, skipped: 1 });
    expect(s.history).toEqual({ imported: 2, skipped: 0 });

    const first = imported(1)!;
    expect(first.ts_path).toBeNull();
    expect(first.library_path).toEndWith(".mp4");
    expect(content(first.library_path)).toEqual(videoContent(11, SIZE_1));
    expect(first.service_name).toBe("TOKYO MX1");
    expect(first.service_id).toBe(KNOWN_CHANNEL);
    expect(first.description).toBe("1話の説明");
    expect(first.extended).toEqual({ 出演者: "作り物の人" });
    expect(first.ts_size).toBe(SIZE_1);

    const second = imported(2)!;
    expect(second.library_path).toBeNull();
    expect(second.ts_path!.startsWith(config.rawDir)).toBe(true);
    expect(content(second.ts_path)).toEqual(videoContent(21, SIZE_2));
    // denpa の知らない局は EPGStation の名前を写す
    expect(second.service_name).toBe("どこかのテレビ");
    expect(second.service_id).toBe(0);

    // 選んだファイルだけ取る (エンコード済みがあるものは元のTSを取得しない)
    expect(fake.videoRequests.map((item) => item.id).sort()).toEqual([
      11, 21, 51,
    ]);
    expect(temporaries()).toEqual([]);

    const history = orm()
      .select({
        source: recordedHistory.source,
        service: recordedHistory.service_name,
      })
      .from(recordedHistory)
      .orderBy(recordedHistory.source)
      .all();
    expect(history).toEqual([
      { source: "epgstation:recorded:1", service: "TOKYO MX1" },
      { source: "epgstation:recorded:3", service: "TOKYO MX1" },
    ]);

    const rule = orm()
      .select()
      .from(rules)
      .where(eq(rules.source, "epgstation:1"))
      .get()!;
    expect(rule).toMatchObject({
      name: "引き継ぎテスト",
      ignore_keyword: "再放送",
      search_fields: "name,description",
      service_ids: [KNOWN_CHANNEL],
      service_types: ["GR"],
      genres: ["7", "7-0"],
      time_from: 19 * 60,
      time_to: 21 * 60,
      weekdays: [5],
      enabled: false,
      dedupe: true,
      priority: 1,
    });
    expect(s.log).toContain("  BS4K は denpa に無いので種別から外しました: #4");
    expect(s.log).toContain("  denpa に無い局を 1 件外しました: #1");
    expect(s.log).toContain("正規表現のルールは取り込めません: #2");
    expect(s.log).toContain("時刻指定のルールは取り込めません: #3");
    expect(s.log).toContain(
      "EPGStation にファイルが無い (404): 消えたファイルテスト",
    );
  });

  test("予約できない手動予約 (コピー禁止) は記録に残して飛ばし、録画の取り込みへ進む", async () => {
    const at = Date.now();
    orm()
      .insert(programs)
      .values({
        id: 323912360800001,
        service_id: 23608,
        network_id: 32391,
        event_id: 1,
        start_at: at + 3600_000,
        end_at: at + 5400_000,
        name: "手で入れた予約テスト",
        copy_never: true,
        updated_at: at,
      })
      .run();
    try {
      await run();
      const s = status();
      expect(s.state).toBe("done");
      expect(s.reservations).toEqual({ imported: 0, skipped: 1 });
      expect(s.log.join("\n")).toContain(
        "予約できません: 手で入れた予約テスト",
      );
      expect(s.imported).toBe(2);
    } finally {
      orm().delete(programs).run();
    }
  });

  test("二度目は何も増えず、ファイルも取得しない", async () => {
    await run();
    fake.videoRequests.length = 0;
    await run();
    const s = status();
    expect(s).toMatchObject({ imported: 0, skipped: 2, missing: 2, failed: 0 });
    expect(s.rules).toEqual({ imported: 0, skipped: 4 });
    expect(s.history).toEqual({ imported: 0, skipped: 2 });
    // 404 だったものだけもう一度訊く
    expect(fake.videoRequests.map((item) => item.id)).toEqual([51]);
    expect(orm().select().from(recordings).all()).toHaveLength(2);
    expect(orm().select().from(rules).all()).toHaveLength(2);
  });

  test("下見では何も書かず、ファイルも取得しない。取ってくる大きさと空きを出す", async () => {
    await run(preview);
    const s = status();
    expect(s).toMatchObject({ state: "done", imported: 3, missing: 1 });
    expect(orm().select().from(recordings).all()).toEqual([]);
    expect(orm().select().from(rules).all()).toEqual([]);
    expect(orm().select().from(recordedHistory).all()).toEqual([]);
    expect(fake.videoRequests).toEqual([]);
    expect(
      s.log.some((line) => line.startsWith("対象 4 件 (取り込む 3 件")),
    ).toBe(true);
    expect(s.log.some((line) => line.includes("空き"))).toBe(true);
  });

  test("offset を無視する相手でも、同じページを積み続けない", async () => {
    fake.setMode({ extraRules: 150, ignoreOffset: true });
    await run(preview);
    // 頭のページ (100 件) だけ。2ページ目は全部受けたものなので止める
    expect(status().rules.imported + status().rules.skipped).toBe(100);
    expect(
      fake.listRequests.filter((path) => path.startsWith("/api/rules")),
    ).toHaveLength(2);
  });

  test("一覧はページ送りで全部取る", async () => {
    fake.setMode({ extraRules: 150 });
    await run(preview);
    expect(status().rules).toEqual({ imported: 152, skipped: 2 });
    const pages = fake.listRequests.filter((path) =>
      path.startsWith("/api/rules"),
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("offset=0&limit=100");
    expect(pages[1]).toContain("offset=100&limit=100");
    // 録画は古い順
    expect(
      fake.listRequests.find((path) => path.startsWith("/api/recorded")),
    ).toContain("isReverse=true");
  });
});

describe("バージョン", () => {
  test("v2 は BS4K を持たないので、そのまま入る", async () => {
    fake.setMode({ version: "2.10.0" });
    await run();
    const s = status();
    expect(s.log[0]).toStartWith("EPGStation 2.10.0");
    expect(s.log.some((line) => line.includes("BS4K"))).toBe(false);
    expect(s.rules).toEqual({ imported: 2, skipped: 2 });
    expect(s.imported).toBe(2);
  });

  test("分からないバージョンは v3 として続ける", async () => {
    fake.setMode({ version: "4.0.0" });
    await run(preview);
    expect(status().log[1]).toContain("v3 として続けます");
    expect(status().state).toBe("done");
  });

  test("v1 は始めずに理由を返す。繋がらない URL も", async () => {
    fake.setMode({ version: "1.7.6" });
    expect(await start(fake.url, preview)).toEqual({
      started: false,
      message:
        "EPGStation v1 には対応していません。v2 か v3 にしてから実行してください",
    });
    const refused = await start("http://127.0.0.1:1", preview);
    expect(refused.started).toBe(false);
    expect(refused.message).toContain(
      "EPGStation (http://127.0.0.1:1) に繋がりません",
    );
    expect(migrate.epgstationUrl()).toBe("http://127.0.0.1:1");
  });
});

describe("Basic 認証", () => {
  test("URL の資格情報を Authorization に直して送り、記録には出さない", async () => {
    fake.setMode({ basic: "user:pa ss" });
    const url = fake.url.replace("http://", "http://user:pa%20ss@");
    await run(apply, undefined, url);
    expect(status().imported).toBe(2);
    expect(new Set(fake.authorizations)).toEqual(
      new Set([`Basic ${btoa("user:pa ss")}`]),
    );
    expect(status().log.join("\n")).not.toContain("pa ss");
    expect(status().log[0]).toBe(`EPGStation 3.0.0-beta4 (${fake.url})`);
  });

  test("資格情報が無ければ断られた理由を返す", async () => {
    fake.setMode({ basic: "user:pass" });
    const result = await start(fake.url, preview);
    expect(result.started).toBe(false);
    expect(result.message).toContain("HTTP 401");
  });
});

describe("形の違う応答", () => {
  test("警告して続け、id の無い1件だけ飛ばす", async () => {
    fake.setMode({ drift: true });
    await run(preview);
    const s = status();
    expect(s.state).toBe("done");
    // 4 件 + 形違い 2 件 (id の無い1件は数えない)。真偽が 0/1 の形違いは入り、searchOption の無いものは条件が空
    expect(s.rules).toEqual({ imported: 3, skipped: 3 });
    expect(s.log).toContain("ルール(予定): 形違いテスト");
    expect(
      s.log.some((line) => line.includes("/api/rulesの形式が違います")),
    ).toBe(true);
    expect(
      s.log.some((line) =>
        line.includes("/api/rulesの1件に id が無いので飛ばします"),
      ),
    ).toBe(true);
  });
});

describe("ファイルの取り方", () => {
  test("途中で切れたら、続きから取り直す", async () => {
    fake.setMode({ cutAt: 40_000, cutTimes: 1 });
    await run();
    expect(status()).toMatchObject({ imported: 2, failed: 0 });
    expect(content(imported(1)!.library_path)).toEqual(
      videoContent(11, SIZE_1),
    );
    const requests = fake.videoRequests.filter((item) => item.id === 11);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.range).toBeNull();
    expect(requests[1]!.range).toMatch(/^bytes=\d+-$/);
  });

  test("前の実行の書きかけがあれば、続きから取る", async () => {
    mkdirSync(config.rawDir, { recursive: true });
    writeFileSync(rawTemporary(), videoContent(21, SIZE_2).subarray(0, 1000));
    await run();
    expect(content(imported(2)!.ts_path)).toEqual(videoContent(21, SIZE_2));
    expect(fake.videoRequests.find((item) => item.id === 21)!.range).toBe(
      "bytes=1000-",
    );
    // 書きかけにあったぶんも取ったぶんに数える
    expect(status().bytesDone).toBe(SIZE_1 + SIZE_2);
  });

  test("書きかけが全部あれば取得しない", async () => {
    mkdirSync(config.rawDir, { recursive: true });
    writeFileSync(rawTemporary(), videoContent(21, SIZE_2));
    await run();
    expect(content(imported(2)!.ts_path)).toEqual(videoContent(21, SIZE_2));
    expect(fake.videoRequests.some((item) => item.id === 21)).toBe(false);
  });

  test("Range を無視されたら、頭から書き直す", async () => {
    fake.setMode({ ignoreRange: true });
    mkdirSync(config.rawDir, { recursive: true });
    writeFileSync(rawTemporary(), videoContent(21, SIZE_2).subarray(0, 1000));
    await run();
    expect(content(imported(2)!.ts_path)).toEqual(videoContent(21, SIZE_2));
  });

  test("長さが違えば失敗に数え、書きかけを消して次の録画へ進む", async () => {
    fake.setMode({ shortBy: 100 });
    await run();
    const s = status();
    expect(s).toMatchObject({ state: "done", imported: 0, failed: 2 });
    expect(s.log.some((line) => line.includes("長さが合いません"))).toBe(true);
    expect(orm().select().from(recordings).all()).toEqual([]);
    expect(temporaries()).toEqual([]);
    // 取り直さない (長さが違うのは取り直しても変わらない)
    expect(fake.videoRequests.filter((item) => item.id === 11)).toHaveLength(1);
  });

  test("応答が止まったら取り直す", async () => {
    fake.setMode({ stallMs: 1000, stallTimes: 1 });
    await run();
    expect(status()).toMatchObject({ imported: 2, failed: 0 });
    expect(fake.videoRequests.filter((item) => item.id === 11)).toHaveLength(2);
  }, 15_000);

  test("取り直しても取れなければ失敗に数える", async () => {
    fake.setMode({ stallMs: 1000, stallTimes: 100 });
    await run();
    const s = status();
    expect(s).toMatchObject({ state: "done", imported: 0, failed: 2 });
    expect(
      s.log.some((line) => line.includes("3 回取り直しても取れませんでした")),
    ).toBe(true);
    // 4 回 (最初と取り直し 3 回)
    expect(fake.videoRequests.filter((item) => item.id === 11)).toHaveLength(4);
  }, 15_000);

  test("中断すると書きかけを残して止まり、次の実行で続きから入る", async () => {
    fake.setMode({ cutAt: 30_000, cutTimes: 1, stallMs: 2000, stallTimes: 2 });
    api.timing.header = 5000;
    const controller = new AbortController();
    try {
      const running = run(apply, controller.signal);
      // 1回目は切れ、取り直しの2回目で黙っている間に止める
      while (fake.videoRequests.length < 2) await Bun.sleep(10);
      controller.abort(new Error("中断しました"));
      await running;
    } finally {
      api.timing.header = 400;
    }
    const s = status();
    expect(s.state).toBe("canceled");
    expect(s.log.at(-1)).toContain("中断しました");
    // ルールは入ったまま
    expect(orm().select().from(rules).all()).toHaveLength(2);
    expect(orm().select().from(recordings).all()).toEqual([]);
    expect(temporaries()).toHaveLength(1);

    fake.setMode({});
    await run();
    expect(status()).toMatchObject({ state: "done", imported: 2 });
    expect(content(imported(1)!.library_path)).toEqual(
      videoContent(11, SIZE_1),
    );
    expect(fake.videoRequests.at(-3)!.range).toMatch(/^bytes=[1-9]\d*-$/);
  }, 15_000);
});

describe("空き容量", () => {
  test("足りなければ録画に入らずに失敗にする。ルール・予約・履歴は入ったまま", async () => {
    config.diskLowThreshold = Number.MAX_SAFE_INTEGER;
    await run();
    const s = status();
    expect(s.state).toBe("failed");
    expect(s.error).toContain("空きが足りません");
    expect(orm().select().from(rules).all()).toHaveLength(2);
    expect(orm().select().from(recordedHistory).all()).toHaveLength(2);
    expect(orm().select().from(recordings).all()).toEqual([]);
    expect(fake.videoRequests).toEqual([]);
  });

  test("下見では止めずに記録に残す", async () => {
    config.diskLowThreshold = Number.MAX_SAFE_INTEGER;
    await run(preview);
    expect(status().state).toBe("done");
    expect(status().log.some((line) => line.includes("空きが足りません"))).toBe(
      true,
    );
  });
});

describe("ファイルの無い行を残さない", () => {
  test("取ったあとで DB が失敗すると行は残らず、次の実行は取り直さずに入れる", async () => {
    failOn("INSERT");
    await run();
    expect(status()).toMatchObject({ imported: 0, failed: 2 });
    expect(status().log.some((line) => line.includes("落ちた"))).toBe(true);
    expect(orm().select().from(recordings).all()).toEqual([]);
    expect(temporaries()).toHaveLength(2);

    orm().run(sql.raw("DROP TRIGGER fail_INSERT"));
    fake.videoRequests.length = 0;
    await run();
    expect(status()).toMatchObject({ imported: 2, failed: 0 });
    expect(fake.videoRequests.map((item) => item.id)).toEqual([51]);
    expect(content(imported(2)!.ts_path)).toEqual(videoContent(21, SIZE_2));
  });

  test("rename したあとで DB が失敗すると、置いたファイルは書きかけに戻る", async () => {
    failOn("UPDATE");
    await run();
    expect(status()).toMatchObject({ imported: 0, failed: 2 });
    // INSERT ごとトランザクションが戻る
    expect(orm().select().from(recordings).all()).toEqual([]);
    expect(placed().every((name) => name.endsWith(".migrating"))).toBe(true);

    orm().run(sql.raw("DROP TRIGGER fail_UPDATE"));
    await run();
    expect(status().imported).toBe(2);
    expect(temporaries()).toEqual([]);
  });

  test("前のバージョンが残した「ファイルの無い行」は、同じ行のまま置き直す", async () => {
    const { id } = orm()
      .insert(recordings)
      .values({
        reservation_id: null,
        program_id: -2,
        service_id: 0,
        name: "引き継ぎテスト #2",
        series: "引き継ぎテスト",
        start_at: 0,
        end_at: 1,
        finished_at: 0,
        created_at: 0,
        updated_at: 0,
      })
      .returning({ id: recordings.id })
      .get();
    await run();
    const row = imported(2)!;
    expect(row.id).toBe(id);
    expect(content(row.ts_path)).toEqual(videoContent(21, SIZE_2));
  });

  test("denpa 側で消したものは戻さない", async () => {
    orm()
      .insert(recordings)
      .values({
        reservation_id: null,
        program_id: -2,
        service_id: 0,
        name: "引き継ぎテスト #2",
        start_at: 0,
        end_at: 1,
        finished_at: 0,
        deleted_at: 0,
        created_at: 0,
        updated_at: 0,
      })
      .run();
    await run();
    expect(status().skipped).toBe(1);
    expect(fake.videoRequests.some((item) => item.id === 21)).toBe(false);
  });

  test("もう対象に無い書きかけだけ片付け、ほかのものには触らない", () => {
    const series = join(config.encodedDir, "番組");
    mkdirSync(config.rawDir, { recursive: true });
    mkdirSync(series, { recursive: true });
    const keep = join(config.rawDir, ".epgstation-2.m2ts.migrating");
    writeFileSync(keep, "続き");
    writeFileSync(join(config.rawDir, ".epgstation-6.m2ts.migrating"), "古い");
    writeFileSync(join(series, ".epgstation-7.mkv.migrating"), "古い");
    writeFileSync(join(config.rawDir, "番組-20260907-120000-1.m2ts"), "録画");
    writeFileSync(
      join(series, "番組 - 2026-09-07 - 1200.mkv.1.av1.encoding"),
      "録画",
    );

    expect(sweepTemporaries(new Set([keep]))).toBe(2);
    expect(readdirSync(config.rawDir).sort()).toEqual(
      [".epgstation-2.m2ts.migrating", "番組-20260907-120000-1.m2ts"].sort(),
    );
    expect(readdirSync(series)).toEqual([
      "番組 - 2026-09-07 - 1200.mkv.1.av1.encoding",
    ]);
  });
});
