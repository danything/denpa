import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  eitSection,
  packetize,
  patSection,
  pcrPacket,
  programMap,
  sdtSection,
  stream,
  type SynthEvent,
  tdtPacket,
} from "@danything/arib/synth";
import { eq } from "drizzle-orm";

/**
 * ほかのソフトで録った TS の取り込み (`ts-import.ts`・`ts-import-read.ts`)。偽の TS を一時フォルダに置いて、本物の取り込みを通しで回す。
 * 設定は環境変数ではなく設定そのものを書き換える (files.test.ts と同じ理由)
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "denpa-ts-import-")));
const { config } = await import("./config");
config.dbPath = join(root, "denpa.db");
config.dataDir = join(root, "data");
config.rawDir = join(root, "raw");
config.encodedDir = join(root, "encoded");
const importDir = join(root, "import");
config.importDirs = importDir;

const { orm } = await import("./db");
const { encodeJobs, recordings, services } = await import("./schema");
const tsImport = await import("./ts-import");
const { readTsFacts } = await import("./ts-import-read");
const { deleteRecordingFiles } = await import("./files");
const { nextQueuedJob } = await import("./encoder");
const { scratchBase } = await import("./fsx");

const ONID = 0x7fe0;
const TSID = 0x7fe0;
const SID = 1024;
const PMT_PID = 0x1f0;
const VIDEO = 0x100;
const AUDIO = 0x110;
/** 録り始め (先頭の TDT) */
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const MIN = 60_000;

/** 前の番組 (先頭の「いま」。録り始めのマージンにだけ掛かる) と、録った番組 (先頭の「次」) */
const before: SynthEvent = {
  eventId: 10,
  startAt: T0 - 30 * MIN,
  duration: 31 * MIN,
  name: "前の番組",
};
const target: SynthEvent = {
  eventId: 11,
  startAt: T0 + MIN,
  duration: 30 * MIN,
  name: "テストアニメ #3「決戦」",
  description: "あらすじ",
  genres: [[7, 0]],
  audios: [{ type: 3 }],
};

/** 映像の ES のパケット (中身は詰め物)。`scrambled` ならスクランブルの印を立てる */
function esPacket(pid: number, scrambled = false): Uint8Array {
  const packet = new Uint8Array(188).fill(0xff);
  packet[0] = 0x47;
  packet[1] = pid >> 8;
  packet[2] = pid & 0xff;
  packet[3] = (scrambled ? 0xc0 : 0x00) | 0x10;
  return packet;
}

/** 偽の録画。先頭に表と TDT、間に ES、末尾に TDT。`eit: false` なら番組表を載せない */
function tsBytes({
  eit = true,
  scrambled = false,
}: { eit?: boolean; scrambled?: boolean } = {}): Uint8Array {
  const tables = [
    packetize(0, patSection([[SID, PMT_PID]], TSID)),
    packetize(
      PMT_PID,
      programMap(SID, VIDEO, [
        [0x02, VIDEO],
        [0x0f, AUDIO],
      ]),
    ),
    packetize(0x11, sdtSection(TSID, ONID, [[SID, 1, "でんぱテレビ"]])),
  ];
  const pf = eit
    ? [
        packetize(
          0x12,
          eitSection({
            tableId: 0x4e,
            serviceId: SID,
            transportStreamId: TSID,
            originalNetworkId: ONID,
            sectionNumber: 0,
            lastSectionNumber: 1,
            events: [before],
          }),
        ),
        packetize(
          0x12,
          eitSection({
            tableId: 0x4e,
            serviceId: SID,
            transportStreamId: TSID,
            originalNetworkId: ONID,
            sectionNumber: 1,
            lastSectionNumber: 1,
            events: [target],
          }),
        ),
      ]
    : [];
  const body = Array.from({ length: 1200 }, (_, i) =>
    esPacket(i % 2 === 0 ? VIDEO : AUDIO, scrambled),
  );
  return stream(
    pcrPacket(VIDEO, 100),
    ...tables,
    ...pf,
    tdtPacket(T0),
    ...body,
    pcrPacket(VIDEO, 100 + 31.5 * 60),
    tdtPacket(T0 + 31.5 * 60_000),
  );
}

/** 置いて、更新時刻を 1 時間前にする (書き込み中とみなさないように) */
function place(path: string, bytes: Uint8Array | string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  const old = new Date(Date.now() - 60 * MIN);
  utimesSync(path, old, old);
  return path;
}

async function runImport(apply: boolean, folder = importDir) {
  const started = await tsImport.start(folder, { apply });
  expect(started.started).toBe(true);
  while (tsImport.running()) await Bun.sleep(5);
  return tsImport.status();
}

beforeEach(() => {
  rmSync(importDir, { recursive: true, force: true });
  mkdirSync(importDir, { recursive: true });
  orm().delete(recordings).run();
  orm().delete(encodeJobs).run();
  orm().delete(services).run();
  config.importDirs = importDir;
});

describe("読み方", () => {
  test("局・番組・先頭と末尾の時刻を読む", async () => {
    const path = place(join(importDir, "a.m2ts"), tsBytes());
    const facts = await readTsFacts(path, tsBytes().length);
    expect(facts).not.toBeNull();
    expect(facts!.program).toBe(SID);
    expect(facts!.networkId).toBe(ONID);
    expect(facts!.serviceName).toBe("でんぱテレビ");
    expect(facts!.video).toBe(true);
    expect(facts!.scrambled).toBe(false);
    expect(facts!.headAt).toBe(T0);
    expect(facts!.tailAt).toBe(T0 + 31.5 * 60_000);
    expect(facts!.events.map((event) => event.eventId).sort()).toEqual([
      10, 11,
    ]);
  });

  test("大きいファイルは先頭と末尾だけ読む", async () => {
    const whole = tsBytes();
    // 先頭 (表と最初の TDT) と末尾 (最後の PCR と TDT) の間に 40 MB ほどの詰め物を挟む
    const tail = 188 * 2;
    const filler = new Uint8Array(188 * 220_000);
    for (let at = 0; at < filler.length; at += 188) {
      filler[at] = 0x47;
      filler[at + 1] = 0x1f;
      filler[at + 2] = 0xff;
      filler[at + 3] = 0x10;
    }
    const bytes = stream(
      whole.subarray(0, whole.length - tail),
      filler,
      whole.subarray(whole.length - tail),
    );
    const path = place(join(importDir, "big.m2ts"), bytes);
    const facts = await readTsFacts(path, bytes.length);
    expect(facts!.headAt).toBe(T0);
    expect(facts!.tailAt).toBe(T0 + 31.5 * 60_000);
    expect(facts!.pcrSpan).toBeCloseTo(31.5 * 60, 3);
  });

  test("TS でないものは null", async () => {
    const path = place(join(importDir, "app.ts"), "export const a = 1;\n");
    expect(await readTsFacts(path, 20)).toBeNull();
  });

  test("いちばん長く重なる番組を選ぶ (先頭のいまは前の番組)", () => {
    const events = [
      { ...before, startAt: before.startAt, duration: before.duration },
      { ...target, startAt: target.startAt, duration: target.duration },
    ] as never[];
    expect(tsImport.pickEvent(events, T0, T0 + 31.5 * 60_000)?.eventId).toBe(
      11,
    );
  });
});

describe("フォルダの確かめ", () => {
  test("IMPORT_DIRS が空なら使えない", async () => {
    config.importDirs = "";
    const result = await tsImport.resolveFolder(importDir);
    expect(result.ok).toBe(false);
  });

  test("IMPORT_DIRS の外・相対パス・置き場と重なるものは断る", async () => {
    mkdirSync(config.rawDir, { recursive: true });
    expect((await tsImport.resolveFolder(root)).ok).toBe(false);
    expect((await tsImport.resolveFolder("import")).ok).toBe(false);
    config.importDirs = root;
    expect((await tsImport.resolveFolder(config.rawDir)).ok).toBe(false);
    // 置き場を中に含むフォルダも断る
    expect((await tsImport.resolveFolder(root)).ok).toBe(false);
  });

  test("リンクで外へ出られない", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const link = join(importDir, "link");
    symlinkSync(outside, link);
    expect((await tsImport.resolveFolder(link)).ok).toBe(false);
    // 指したフォルダの中のリンクも辿らない
    place(join(outside, "x.m2ts"), tsBytes());
    const status = await runImport(false);
    expect(status.total).toBe(0);
  });

  test("下のフォルダは指せる", async () => {
    mkdirSync(join(importDir, "sub"), { recursive: true });
    const result = await tsImport.resolveFolder(join(importDir, "sub"));
    expect(result.ok).toBe(true);
  });
});

describe("取り込み", () => {
  test("下見は DB に書かない", async () => {
    place(join(importDir, "a.m2ts"), tsBytes());
    const status = await runImport(false);
    expect(status.state).toBe("done");
    expect(status.imported).toBe(1);
    expect(orm().select().from(recordings).all()).toHaveLength(0);
  });

  test("番組の情報で入れ、置いたまま指す。2 回目は飛ばす", async () => {
    const path = place(join(importDir, "sub", "a.m2ts"), tsBytes());
    const status = await runImport(true);
    expect(status.imported).toBe(1);
    const [row] = orm().select().from(recordings).all();
    expect(row!.name).toBe(target.name);
    expect(row!.description).toBe("あらすじ");
    expect(row!.start_at).toBe(target.startAt);
    expect(row!.end_at).toBe(target.startAt + target.duration);
    expect(row!.service_id).toBe(0);
    expect(row!.service_name).toBe("でんぱテレビ");
    expect(row!.ts_path).toBe(path);
    expect(row!.imported_ts).toBe(path);
    expect(row!.ts_head).toBe(T0);
    expect(row!.duration_ms).toBe(31.5 * 60_000);
    expect(row!.watched_at).not.toBeNull();
    expect(row!.state).toBe("recorded");
    // 映像があるので、エンコードの待ち行列に入る (既定はエンコードする)
    expect(
      orm()
        .select()
        .from(encodeJobs)
        .where(eq(encodeJobs.recording_id, row!.id))
        .all(),
    ).toHaveLength(1);

    const again = await runImport(true);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(1);
  });

  test("denpa の局があればその局で入れ、番組表のマスと結ぶ", async () => {
    orm()
      .insert(services)
      .values({
        id: ONID * 100000 + SID,
        service_id: SID,
        network_id: ONID,
        name: "でんぱ 1",
        type: "GR",
        updated_at: Date.now(),
      })
      .run();
    place(join(importDir, "a.m2ts"), tsBytes());
    await runImport(true);
    const [row] = orm().select().from(recordings).all();
    expect(row!.service_id).toBe(ONID * 100000 + SID);
    expect(row!.service_name).toBe("でんぱ 1");
    expect(row!.program_id).toBe((ONID * 100000 + SID) * 100000 + 11);
  });

  test("同じ番組の録画があれば飛ばす (同じ実行の 2 本目も)", async () => {
    place(join(importDir, "a.m2ts"), tsBytes());
    place(join(importDir, "b.ts"), tsBytes());
    const status = await runImport(true);
    expect(status.imported).toBe(1);
    expect(status.overlap).toBe(1);
  });

  test("番組を読めなければファイルの名前と時刻で入れる", async () => {
    place(join(importDir, "2026-10-19 録画.m2ts"), tsBytes({ eit: false }));
    await runImport(true);
    const [row] = orm().select().from(recordings).all();
    expect(row!.name).toBe("2026-10-19 録画");
    expect(row!.start_at).toBe(T0);
    expect(row!.end_at).toBe(T0 + 31.5 * 60_000);
  });

  test("TS でないもの・スクランブル・書き込み中は入れない", async () => {
    place(join(importDir, "app.ts"), "export const a = 1;\n");
    place(join(importDir, "s.m2ts"), tsBytes({ scrambled: true }));
    writeFileSync(join(importDir, "new.m2ts"), tsBytes());
    const status = await runImport(true);
    expect(status.unreadable).toBe(3);
    expect(orm().select().from(recordings).all()).toHaveLength(0);
  });

  test("削除しても元の TS は消さない。消したあとは入れ直さない", async () => {
    const path = place(join(importDir, "a.m2ts"), tsBytes());
    await runImport(true);
    const [row] = orm().select().from(recordings).all();
    deleteRecordingFiles(row!, "削除");
    expect(existsSync(path)).toBe(true);
    const [after] = orm().select().from(recordings).all();
    expect(after!.ts_path).toBeNull();
    expect(after!.deleted_at).not.toBeNull();
    const again = await runImport(true);
    expect(again.skipped).toBe(1);
  });
});

describe("エンコード", () => {
  test("取り込んだ録画の最初のジョブは、denpa が録ったものより後ろ", () => {
    const at = Date.now();
    const base = {
      service_id: 0,
      name: "x",
      start_at: at,
      end_at: at,
      finished_at: at,
      created_at: at,
      updated_at: at,
    };
    const imported = orm()
      .insert(recordings)
      .values({ ...base, imported_ts: "/x/a.m2ts", ts_path: "/x/a.m2ts" })
      .returning()
      .get();
    const own = orm().insert(recordings).values(base).returning().get();
    const first = orm()
      .insert(encodeJobs)
      .values({ recording_id: imported.id, created_at: at })
      .returning()
      .get();
    const mine = orm()
      .insert(encodeJobs)
      .values({ recording_id: own.id, created_at: at })
      .returning()
      .get();
    expect(nextQueuedJob()?.id).toBe(mine.id);
    // 取り込んだ録画でも、前のジョブがある (人が押した再エンコード) なら id 順
    orm()
      .update(encodeJobs)
      .set({ state: "done" })
      .where(eq(encodeJobs.id, first.id))
      .run();
    orm()
      .update(encodeJobs)
      .set({ state: "done" })
      .where(eq(encodeJobs.id, mine.id))
      .run();
    const again = orm()
      .insert(encodeJobs)
      .values({ recording_id: imported.id, created_at: at })
      .returning()
      .get();
    const later = orm()
      .insert(encodeJobs)
      .values({ recording_id: own.id, created_at: at })
      .returning()
      .get();
    expect(nextQueuedJob()?.id).toBe(again.id);
    expect(later.id).toBeGreaterThan(again.id);
  });

  test("置き場の外の TS の作業ファイルは RAW_DIR の下に作る", () => {
    const outside = join(importDir, "a.m2ts");
    const base = scratchBase(outside);
    expect(base.startsWith(join(config.rawDir, ".import"))).toBe(true);
    const inside = join(config.rawDir, "a.m2ts");
    expect(scratchBase(inside)).toBe(inside);
  });
});
