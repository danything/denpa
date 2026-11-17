import { describe, expect, test } from "bun:test";

import { fixMoof, SyncMarks, videoTrackId } from "./fmp4-marks";

function u32(value: number): number[] {
  return [
    value >>> 24,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function box(type: string, ...body: number[][]): number[] {
  const inner = body.flat();
  return [
    ...u32(8 + inner.length),
    ...[...type].map((c) => c.charCodeAt(0)),
    ...inner,
  ];
}

/** 長さ 4 バイトの NAL 1 つのコマ */
function frame(...nal: number[]): number[] {
  return [...u32(nal.length), ...nal];
}

const IDR = frame(0x65, 0x88, 0x84);
/** P のスライス (slice_type 5) */
const P = frame(0x41, 0x9a, 0x00);
/** sync の flags (sample_depends_on 2 = ほかを参照しない) と、ほかを参照する sync でない flags */
const SYNC = 0x02000000;
const NON_SYNC = 0x01010000;

/** 映像 (トラック 1) と音声 (トラック 2) の moov */
const moov = box(
  "moov",
  box(
    "trak",
    box("tkhd", [0, 0, 0, 3], u32(0), u32(0), u32(1), u32(0)),
    box(
      "mdia",
      box(
        "hdlr",
        u32(0),
        u32(0),
        [..."vide"].map((c) => c.charCodeAt(0)),
      ),
    ),
  ),
  box(
    "trak",
    box("tkhd", [0, 0, 0, 3], u32(0), u32(0), u32(2), u32(0)),
    box(
      "mdia",
      box(
        "hdlr",
        u32(0),
        u32(0),
        [..."soun"].map((c) => c.charCodeAt(0)),
      ),
    ),
  ),
);

/**
 * moof (映像のトラックに IDR・P・P の 3 つ。どれも sync の印) と mdat。trun はデータの位置・大きさ・サンプルごとの flags を持つ
 */
function fragment(track = 1): number[] {
  const samples = [IDR, P, P];
  const trun = (offset: number) =>
    box(
      "trun",
      [0, 0, 0x06, 0x01],
      u32(samples.length),
      u32(offset),
      ...samples.map((s) => [...u32(s.length), ...u32(SYNC)]),
    );
  const tfhd = box("tfhd", [0, 0x02, 0, 0], u32(track));
  const moofSize = box("moof", box("traf", tfhd, trun(0))).length;
  const moof = box("moof", box("traf", tfhd, trun(moofSize + 8)));
  return [...moof, ...box("mdat", ...samples)];
}

/** fMP4 の中の、映像のサンプルの flags を順に読む */
function flagsOf(bytes: Uint8Array): number[] {
  const out: number[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.length; at++) {
    if (String.fromCharCode(...bytes.subarray(at, at + 4)) !== "trun") continue;
    const count = view.getUint32(at + 8);
    for (let i = 0; i < count; i++)
      out.push(view.getUint32(at + 16 + i * 8 + 4));
  }
  return out;
}

describe("videoTrackId", () => {
  test("hdlr が vide の trak の track_ID", () => {
    expect(videoTrackId(Uint8Array.from(moov))).toBe(1);
    expect(videoTrackId(Uint8Array.from(box("moov")))).toBeNull();
  });
});

describe("fixMoof", () => {
  test("P のコマの sync の印を外し、IDR の印は残す", () => {
    const bytes = Uint8Array.from(fragment());
    expect(fixMoof(bytes, 0, 1, "h264", 4)).toBe(2);
    expect(flagsOf(bytes)).toEqual([SYNC, NON_SYNC, NON_SYNC]);
  });

  test("ほかのトラックは触らない", () => {
    const bytes = Uint8Array.from(fragment(2));
    expect(fixMoof(bytes, 0, 1, "h264", 4)).toBe(0);
    expect(flagsOf(bytes)).toEqual([SYNC, SYNC, SYNC]);
  });
});

describe("SyncMarks", () => {
  const whole = Uint8Array.from([
    ...box("ftyp", u32(0)),
    ...moov,
    ...fragment(),
    ...fragment(),
  ]);

  test("どこで切れて届いても、同じものを返す", () => {
    for (const step of [1, 7, 64, whole.length]) {
      const marks = new SyncMarks("h264", 4);
      const parts: Uint8Array[] = [];
      for (let at = 0; at < whole.length; at += step)
        parts.push(...marks.push(whole.slice(at, at + step)));
      parts.push(...marks.end());
      const out = Uint8Array.from(parts.flatMap((p) => [...p]));
      expect(out.length).toBe(whole.length);
      expect(flagsOf(out)).toEqual([
        SYNC,
        NON_SYNC,
        NON_SYNC,
        SYNC,
        NON_SYNC,
        NON_SYNC,
      ]);
      expect(marks.cleared).toBe(4);
    }
  });

  test("moov が無ければ (映像のトラックが分からなければ) 何も変えない", () => {
    const marks = new SyncMarks("h264", 4);
    const bytes = Uint8Array.from(fragment());
    const out = [...marks.push(bytes), ...marks.end()];
    expect(flagsOf(Uint8Array.from(out.flatMap((p) => [...p])))).toEqual([
      SYNC,
      SYNC,
      SYNC,
    ]);
  });

  test("途中で切れた箱は、終わりにそのまま返す", () => {
    const marks = new SyncMarks("h264", 4);
    const cut = whole.slice(0, whole.length - 3);
    const out = [...marks.push(cut), ...marks.end()];
    expect(out.reduce((sum, p) => sum + p.length, 0)).toBe(cut.length);
  });
});
