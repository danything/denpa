import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResponseMessage } from "@danything/arib/bml-protocol";
import {
  BML_TS,
  bmlHead,
  ddbSection,
  diiSection,
  multipartModule,
  packetize,
  patSection,
  pcrPacket,
  programMap,
  stream,
  tdtPacket as tdt,
} from "@danything/arib/synth";
import { eq } from "drizzle-orm";

import { replayAt } from "#lib/ts/data-timeline.js";

import type { Recording } from "../types";

// DB は一時ファイルへ (番組の名乗りを組むのに services を引く。files.test.ts と同じ手)
const { config } = await import("./config");
config.dbPath = join(mkdtempSync(join(tmpdir(), "denpa-bml-db-")), "denpa.db");
const { orm } = await import("./db");
const { recordings, services } = await import("./schema");
const { loadRecordedBml, saveRecordedBml, withProgramInfo } =
  await import("./recorded-bml");

/*
 * 録画のデータ放送。**TS から取り出してサイドカーに置き、再生時に読み直す。**
 * デコード方法は ts/data-timeline.ts が持つので、ここはファイルの出し入れと、
 * 書いた時刻がエンコードしたものの再生位置に合っているかを確かめる。
 */

/** モジュール1つぶんの multipart (ファイル1枚の形式) */
const multipart = (body: string) =>
  multipartModule([["/startup.bml", "text/X-arib-bml", body]]);

/** DII と DDB を並べて、1つのモジュールを配りきる。バージョンごとに回 (transaction) を変える */
function carousel(body: string, version: number): Uint8Array[] {
  const module = multipart(body);
  const spec = {
    moduleId: 1,
    moduleSize: module.length,
    moduleVersion: version,
    contentType: "multipart/mixed",
  };
  return [
    packetize(
      BML_TS.bmlPid,
      diiSection(BML_TS.downloadId, 4066, spec, version),
    ),
    packetize(
      BML_TS.bmlPid,
      ddbSection(BML_TS.downloadId, 1, version, 0, module),
    ),
  ];
}

const dir = mkdtempSync(join(tmpdir(), "denpa-bml-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 番組の始まり */
const T = Date.UTC(2026, 7, 12, 0, 0, 30);
/** 頭の PCR (秒)。中身に意味は無い */
const PCR = 500;

/**
 * **合成の録画。番組の始まり (`T`) の 10秒前から録っている** (前のマージン)。
 * 時計 (PCR・TDT) は実時間どおりに進み、データ放送は番組の始まりで ver1、1分後に ver2 に変わる。
 * 元の TS の物差しでは ver1 が 10秒、ver2 が 70秒
 */
function recorded(): Uint8Array {
  const at = (seconds: number) => [
    pcrPacket(BML_TS.videoPid, PCR + seconds),
    tdt(T - 10_000 + seconds * 1000),
  ];
  return stream(
    pcrPacket(BML_TS.videoPid, PCR),
    ...bmlHead(),
    ...at(0),
    ...at(5),
    ...at(10),
    ...carousel("<bml>ver1</bml>", 1),
    ...at(40),
    ...at(70),
    ...carousel("<bml>ver2</bml>", 2),
    ...at(90),
  );
}

/** 録画の行の要るところだけ。局は services に 1 つ入れておく (network 4, service 1024) */
function recording(startAt: number): Recording {
  orm().delete(services).run();
  orm()
    .insert(services)
    .values({
      id: 7,
      service_id: 1024,
      network_id: 4,
      name: "テスト局",
      type: "GR",
      channel: "T27",
      updated_at: 0,
    })
    .run();
  return {
    id: 1,
    service_id: 7,
    program_id: 999,
    name: "録画のテスト",
    start_at: startAt,
    end_at: startAt + 60_000,
  } as unknown as Recording;
}

function bmlBody(message: ResponseMessage): string | null {
  if (message.type !== "moduleDownloaded") return null;
  return Buffer.from(message.files[0]!.dataBase64, "base64").toString();
}

/** サイドカーを読み直して、再生位置 `ms` で出ている画面 */
function shownAt(sidecar: string, ms: number): string | null {
  const module = replayAt(loadRecordedBml(sidecar), ms).find(
    (m) => m.type === "moduleDownloaded",
  );
  return module === undefined ? null : bmlBody(module);
}

/** 書いた変化のうち、モジュールが揃った再生位置 (ms) */
function switchesAt(sidecar: string): number[] {
  return loadRecordedBml(sidecar)
    .filter((item) => item.message.type === "moduleDownloaded")
    .map((item) => item.at);
}

describe("saveRecordedBml / loadRecordedBml", () => {
  test("TS から取り出して書き、読み直すと同じ変化が並ぶ", async () => {
    const ts = join(dir, "rec.ts");
    const sidecar = join(dir, "rec.bml.jsonl");
    writeFileSync(ts, recorded());

    const changes = await saveRecordedBml(ts, sidecar, recording(T), {
      kept: null,
      skip: 0,
    });
    expect(changes).toBeGreaterThan(0);

    const loaded = loadRecordedBml(sidecar);
    const done = loaded.find(
      (item) => item.message.type === "moduleDownloaded",
    );
    if (done === undefined) throw new Error("moduleDownloaded が無い");
    expect(bmlBody(done.message)).toContain("ver1");
    // **番組の名乗りが頭に入っている。** 描く側はこれが来るまで入口を開かない
    const info = loaded[0]!.message;
    if (info.type !== "programInfo") throw new Error("programInfo が頭に無い");
    expect(info.serviceId).toBe(1024);
    expect(info.eventName).toBe("録画のテスト");
    // 読む側でも足すが、既に在れば重ねない
    expect(
      withProgramInfo(loaded, recording(T)).filter(
        (i) => i.message.type === "programInfo",
      ),
    ).toHaveLength(1);
  });

  /*
   * **時刻の基準は録画の頭で、番組の始まりではない。** 番組の始まり (`start_at`) を基準にしていた頃は、
   * 前のマージン (10秒) のぶん切り替わりが映像より早く出ていた
   */
  test("切っていない録画は、録画の頭から数えて、頭から捨てたぶんを引いた位置で切り替わる", async () => {
    const ts = join(dir, "plain-cut.ts");
    const sidecar = join(dir, "plain-cut.bml.jsonl");
    writeFileSync(ts, recorded());

    await saveRecordedBml(ts, sidecar, recording(T), { kept: null, skip: 1 });
    // 元の TS の 10秒・70秒 → エンコードしたものの 9秒・69秒
    expect(switchesAt(sidecar)).toEqual([9_000, 69_000]);
    expect(shownAt(sidecar, 8_999)).toBeNull();
    expect(shownAt(sidecar, 9_000)).toContain("ver1");
    expect(shownAt(sidecar, 68_999)).toContain("ver1");
    expect(shownAt(sidecar, 69_000)).toContain("ver2");
  });

  test("CM を切った録画は、残した区間をつないだ位置で切り替わる", async () => {
    const ts = join(dir, "kept.ts");
    const sidecar = join(dir, "kept.bml.jsonl");
    writeFileSync(ts, recorded());

    // 元の TS の 1〜30秒 と 50〜200秒 を残した (30〜50秒の CM を切った)
    const kept = [
      { start: 1, end: 30 },
      { start: 50, end: 200 },
    ];
    await saveRecordedBml(ts, sidecar, recording(T), { kept, skip: 1 });
    // ver1 は 10 − 1 = 9秒、ver2 は 29 + (70 − 50) = 49秒
    expect(switchesAt(sidecar)).toEqual([9_000, 49_000]);
    expect(shownAt(sidecar, 48_999)).toContain("ver1");
    expect(shownAt(sidecar, 49_000)).toContain("ver2");
  });

  test("名乗りを書いていなかった頃のサイドカーには、読むときに足す", () => {
    const old = [{ at: 0, message: { type: "pmt" as const, components: [] } }];
    const fixed = withProgramInfo(old, recording(T));
    expect(fixed[0]!.message.type).toBe("programInfo");
    expect(fixed).toHaveLength(2);
    // 空 (データ放送を持たない録画) には足さない — 「出せない」のままにする
    expect(withProgramInfo([], recording(T))).toEqual([]);
  });

  test("データ放送を持たない TS では書かない・読めば空", async () => {
    const ts = join(dir, "plain.ts");
    const sidecar = join(dir, "plain.bml.jsonl");
    // BML の ES が無い PMT (映像だけ)
    const { service, pmtPid, videoPid } = BML_TS;
    writeFileSync(
      ts,
      stream(
        packetize(0x0000, patSection([[service, pmtPid]])),
        packetize(
          pmtPid,
          programMap(service, videoPid, [[0x02, videoPid, [0x52, 0x01, 0x00]]]),
        ),
      ),
    );

    expect(
      await saveRecordedBml(ts, sidecar, recording(T), {
        kept: null,
        skip: 0,
      }),
    ).toBe(0);
    expect(loadRecordedBml(sidecar)).toEqual([]);
  });
});

describe("saveRecordedBml と録画の頭の放送時刻", () => {
  /** 録画の行を 1 つ入れる (`ts_head` を見るため) */
  function row(tsHead: number | null): void {
    orm().delete(recordings).run();
    orm()
      .insert(recordings)
      .values({
        id: 1,
        service_id: 7,
        name: "録画のテスト",
        start_at: T,
        end_at: T + 60_000,
        ts_head: tsHead,
        created_at: 0,
        updated_at: 0,
      })
      .run();
  }
  const tsHeadOf = () =>
    orm()
      .select({ ts_head: recordings.ts_head })
      .from(recordings)
      .where(eq(recordings.id, 1))
      .get()?.ts_head;

  test("空なら、TS の頭の放送時刻を書く (データ放送の有る無しに関わらず)", async () => {
    const ts = join(dir, "head.ts");
    writeFileSync(ts, recorded());
    row(null);
    await saveRecordedBml(ts, join(dir, "head.bml.jsonl"), recording(T), {
      kept: null,
      skip: 0,
    });
    // 最初の TDT は録画の頭 (番組の始まりの 10秒前) と同じ PCR に来ている
    expect(tsHeadOf()).toBe(T - 10_000);
  });

  test("録っている間に測れていれば上書きしない", async () => {
    const ts = join(dir, "head2.ts");
    writeFileSync(ts, recorded());
    row(T - 9_500);
    await saveRecordedBml(ts, join(dir, "head2.bml.jsonl"), recording(T), {
      kept: null,
      skip: 0,
    });
    expect(tsHeadOf()).toBe(T - 9_500);
  });
});
