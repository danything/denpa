import { describe, expect, test } from "bun:test";

import type { ResponseMessage } from "@danything/arib/bml-protocol";
import {
  BML_TS,
  bmlHead,
  ddbSection,
  diiSection,
  multipartModule,
  packetize,
  pcrPacket,
  stream,
  tdtPacket as tdt,
} from "@danything/arib/synth";

import { DataBroadcastCapture } from "./data-capture";
import {
  feedFor,
  type PlacedMessage,
  playbackMsAt,
  replayAt,
  type TimedMessage,
  toPlaybackTimeline,
} from "./data-timeline";

/*
 * 録画のデータ放送。**ライブ (carousel.ts) と違って時間変化を持つ。**
 *
 * エンコードのついでに元の TS をデコードして、配られた変化を実時刻つきで並べ (captureDataBroadcast)、
 * 再生位置に当たる時刻までを積み直して画面を作る (replayAt)。ここはその中核。
 */

const { bmlPid: BML_PID, downloadId: DOWNLOAD_ID } = BML_TS;

/** TS を一気に食べさせて、並んだ変化を返す */
function captureDataBroadcast(chunks: Uint8Array[]): TimedMessage[] {
  const capture = new DataBroadcastCapture();
  for (const chunk of chunks) capture.feed(chunk);
  return capture.result();
}

/** モジュール1つぶんの multipart (ファイル1枚の形式) */
const multipart = (body: string) =>
  multipartModule([["/startup.bml", "text/X-arib-bml", body]]);

/** DII と DDB を並べて、1つのモジュールを配りきる。バージョンごとに回 (transaction) を変える */
function carousel(module: Uint8Array, version: number): Uint8Array[] {
  const spec = {
    moduleId: 1,
    moduleSize: module.length,
    moduleVersion: version,
    contentType: "multipart/mixed",
  };
  return [
    packetize(BML_PID, diiSection(DOWNLOAD_ID, 4066, spec, version)),
    packetize(BML_PID, ddbSection(DOWNLOAD_ID, 1, version, 0, module)),
  ];
}

const head = bmlHead();

function bmlBody(message: ResponseMessage): string | null {
  if (message.type !== "moduleDownloaded") return null;
  return Buffer.from(message.files[0]!.dataBase64, "base64").toString();
}

const T1 = Date.UTC(2026, 7, 9, 12, 0, 0);
const T2 = Date.UTC(2026, 7, 9, 12, 5, 0);

describe("captureDataBroadcast", () => {
  test("配られたモジュールに、そのとき見えていた放送時刻が付く", () => {
    const timeline = captureDataBroadcast([
      stream(...head, tdt(T1), ...carousel(multipart("<bml>1</bml>"), 1)),
    ]);
    const done = timeline.filter(
      (item) => item.message.type === "moduleDownloaded",
    );
    expect(done).toHaveLength(1);
    expect(done[0]!.at).toBe(T1);
    expect(bmlBody(done[0]!.message)).toContain("<bml>1</bml>");
  });

  test("時計を見る前に配られたものは at = null", () => {
    // TDT より前にモジュールが揃う。**準備として常に含めたい**ので時刻は付けない
    const timeline = captureDataBroadcast([
      stream(...head, ...carousel(multipart("<bml/>"), 1), tdt(T1)),
    ]);
    const done = timeline.find(
      (item) => item.message.type === "moduleDownloaded",
    );
    expect(done?.at).toBeNull();
  });

  test("同じバージョンは配り直さない = ログにも1つだけ", () => {
    const module = multipart("<bml/>");
    const timeline = captureDataBroadcast([
      stream(...head, tdt(T1), ...carousel(module, 1), ...carousel(module, 1)),
    ]);
    expect(
      timeline.filter((item) => item.message.type === "moduleDownloaded"),
    ).toHaveLength(1);
  });
});

describe("replayAt", () => {
  // バージョン 1 を T1 に、バージョン 2 を T2 に配る。**途中で中身が差し替わる録画**
  const timeline = captureDataBroadcast([
    stream(
      ...head,
      tdt(T1),
      ...carousel(multipart("<bml>ver1</bml>"), 1),
      tdt(T2),
      ...carousel(multipart("<bml>ver2</bml>"), 2),
    ),
  ]);

  function shownBml(at: number): string | null {
    const module = replayAt(timeline, at).find(
      (m) => m.type === "moduleDownloaded",
    );
    return module ? bmlBody(module) : null;
  }

  test("差し替え前の位置では、古いほうの画面が出る", () => {
    expect(shownBml(T1 + 60_000)).toContain("ver1");
  });

  test("差し替え後の位置では、新しいほうの画面が出る", () => {
    expect(shownBml(T2 + 60_000)).toContain("ver2");
  });

  test("差し替えのちょうど時刻では、新しいほうまで含む", () => {
    expect(shownBml(T2)).toContain("ver2");
  });

  test("pmt が先に来る = 置き場所が決まってからモジュールを出す", () => {
    const out = replayAt(timeline, T2);
    const pmtAt = out.findIndex((m) => m.type === "pmt");
    const moduleAt = out.findIndex((m) => m.type === "moduleDownloaded");
    expect(pmtAt).toBeGreaterThanOrEqual(0);
    expect(pmtAt).toBeLessThan(moduleAt);
  });
});

describe("DataBroadcastCapture.head", () => {
  const { videoPid } = BML_TS;

  test("最初の TDT から、ファイルの頭からそこまでに PCR が進んだぶんを引く", () => {
    // 頭の PCR は 1000秒。12秒進んだところで初めて TDT (T1) が来る → 頭は T1 の 12秒前
    const capture = new DataBroadcastCapture();
    capture.feed(
      stream(
        pcrPacket(videoPid, 1000),
        ...head,
        pcrPacket(videoPid, 1006),
        pcrPacket(videoPid, 1012),
        tdt(T1),
        pcrPacket(videoPid, 1017),
        tdt(T1 + 5_000),
      ),
    );
    expect(capture.head).toBe(T1 - 12_000);
  });

  test("頭と最初の TDT の間で PCR が一周しても、進んだぶんで数える", () => {
    const wrap = 2 ** 33 / 90_000;
    const capture = new DataBroadcastCapture();
    capture.feed(
      stream(
        pcrPacket(videoPid, wrap - 4),
        ...head,
        pcrPacket(videoPid, 3),
        tdt(T1),
      ),
    );
    expect(capture.head).toBe(T1 - 7_000);
  });

  test("TDT が来なければ null", () => {
    const capture = new DataBroadcastCapture();
    capture.feed(stream(pcrPacket(videoPid, 1000), ...head));
    expect(capture.head).toBeNull();
  });
});

describe("playbackMsAt", () => {
  const plain = { kept: null, skip: 0 };

  test("切っていない録画は、頭からの経過そのまま", () => {
    expect(playbackMsAt(60_000, 0, plain)).toBe(60_000);
  });

  test("頭より前は 0 に寄せる", () => {
    expect(playbackMsAt(-5_000, 0, plain)).toBe(0);
  });

  test("エンコードで頭から捨てたぶんを引く (`encode_skip`)", () => {
    expect(playbackMsAt(60_000, 0, { kept: null, skip: 1.5 })).toBe(58_500);
  });

  // 0〜60秒 と 120〜180秒 を残す (60〜120秒の CM を切った録画)
  const kept = {
    kept: [
      { start: 0, end: 60 },
      { start: 120, end: 180 },
    ],
    skip: 0,
  };

  test("CM を切った録画は、残した尺だけ積む", () => {
    // ts 150秒 = 2つ目の残り区間の途中。残ったのは 60 + (150-120) = 90秒
    expect(playbackMsAt(150_000, 0, kept)).toBe(90_000);
    // 両区間とも通り過ぎた ts 200秒 = 60 + 60 = 120秒
    expect(playbackMsAt(200_000, 0, kept)).toBe(120_000);
  });

  test("CM の穴に落ちた時刻は、その後の本編の頭に寄る", () => {
    // ts 90秒 = 切った 60〜120秒の中。残した尺では 60秒 (= 2つ目の残り区間の頭)
    expect(playbackMsAt(90_000, 0, kept)).toBe(60_000);
  });
});

describe("toPlaybackTimeline", () => {
  test("頭の準備 (at=null) は 0、あとは再生位置に写る", () => {
    const placed = toPlaybackTimeline(
      [
        {
          at: null,
          message: { type: "pmt", components: [] } as ResponseMessage,
        },
        {
          at: 30_000,
          message: { type: "pmt", components: [] } as ResponseMessage,
        },
      ],
      0,
      { kept: null, skip: 0 },
    );
    expect(placed.map((p) => p.at)).toEqual([0, 30_000]);
  });
});

describe("feedFor", () => {
  const mod = (version: number): ResponseMessage =>
    ({
      type: "moduleDownloaded",
      componentId: 1,
      moduleId: 1,
      version,
      dataEventId: 0,
      files: [],
    }) as ResponseMessage;
  const tl: PlacedMessage[] = [
    { at: 0, message: { type: "pmt", components: [] } as ResponseMessage },
    { at: 10_000, message: mod(1) },
    { at: 60_000, message: mod(2) },
  ];

  test("頭から進む = そこまでの変化を順に流す", () => {
    expect(feedFor(tl, -1, 5_000)).toEqual({
      reset: false,
      messages: [tl[0]!.message],
    });
    expect(feedFor(tl, -1, 20_000)).toEqual({
      reset: false,
      messages: [tl[0]!.message, tl[1]!.message],
    });
  });

  test("進んだぶんだけ足す (入れ物はそのまま)", () => {
    expect(feedFor(tl, 20_000, 70_000)).toEqual({
      reset: false,
      messages: [tl[2]!.message],
    });
  });

  test("戻ったら作り直して積み直す", () => {
    const feed = feedFor(tl, 70_000, 5_000);
    expect(feed.reset).toBe(true);
    // 5秒の時点ではバージョン 1 (10秒) はまだ来ていない。pmt だけ
    expect(feed.messages.some((m) => m.type === "moduleDownloaded")).toBe(
      false,
    );
    expect(feed.messages.some((m) => m.type === "pmt")).toBe(true);
  });
});
