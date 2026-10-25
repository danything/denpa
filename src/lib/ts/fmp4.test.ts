import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AdtsSplitter } from "@danything/arib/pes";

import {
  adtsHeader,
  Fmp4Splitter,
  opusHead,
  readFragment,
  readInit,
} from "./fmp4";

/** 箱を1つ組み立てる。中身は大きさが分かればよいので詰め物 */
function box(type: string, fill = 0, size = 4): Uint8Array {
  const out = new Uint8Array(8 + size);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.fill(fill, 8);
  return out;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("fMP4 を割る", () => {
  /*
   * MSE は init セグメント (`ftyp` + `moov`) を先に渡さないと、そのあとの
   * 中身を1バイトも受け取らない。ffmpeg は1本のストリームで出してくる
   */
  test("頭の ftyp + moov が init になる", () => {
    const splitter = new Fmp4Splitter();
    const out = splitter.feed(
      join(box("ftyp"), box("moov"), box("moof"), box("mdat")),
    );
    expect(out.map((s) => s.kind)).toEqual(["init", "media"]);
    expect(out[0]!.data).toEqual(join(box("ftyp"), box("moov")));
    expect(out[1]!.data).toEqual(join(box("moof"), box("mdat")));
  });

  test("moof + mdat の組が1枚ずつ出る", () => {
    const splitter = new Fmp4Splitter();
    splitter.feed(join(box("ftyp"), box("moov")));
    const out = splitter.feed(
      join(box("moof", 1), box("mdat", 1), box("moof", 2), box("mdat", 2)),
    );
    expect(out.map((s) => s.kind)).toEqual(["init", "media", "media"]);
    expect(out[1]!.data).toEqual(join(box("moof", 1), box("mdat", 1)));
    expect(out[2]!.data).toEqual(join(box("moof", 2), box("mdat", 2)));
  });

  /*
   * **パイプは箱の切れ目で届かない。** 半端なところで切って MSE に渡すと
   * その場で投げる。1バイトずつ食わせても同じ答えになること
   */
  test("どこで切って食わせても同じ", () => {
    const whole = join(
      box("ftyp"),
      box("moov"),
      box("moof", 1),
      box("mdat", 1),
    );
    const splitter = new Fmp4Splitter();
    const out = [];
    for (const byte of whole) out.push(...splitter.feed(Uint8Array.of(byte)));
    expect(out.map((s) => s.kind)).toEqual(["init", "media"]);
    expect(out[0]!.data).toEqual(join(box("ftyp"), box("moov")));
    expect(out[1]!.data).toEqual(join(box("moof", 1), box("mdat", 1)));
  });

  /*
   * **数で区切らない。** 「2つ溜まったら出す」にしていると `moof` + `sidx` を
   * 1枚として出してしまい、中身の無いものを MSE に渡すことになる
   */
  test("moof と mdat の間に別の箱が挟まっても、1枚として出す", () => {
    const splitter = new Fmp4Splitter();
    const out = splitter.feed(
      join(box("ftyp"), box("moov"), box("moof"), box("sidx"), box("mdat")),
    );
    expect(out.map((s) => s.kind)).toEqual(["init", "media"]);
    expect(out[1]!.data).toEqual(join(box("moof"), box("sidx"), box("mdat")));
  });

  /*
   * **init は `moof` が見えた時点で出す。** そこで頭が終わったと分かるので、
   * `mdat` まで待つ理由が無い。繋いできた人を1枚ぶん待たせないで済む
   */
  test("init は moof が見えた時点で出す。媒体は mdat まで待つ", () => {
    const splitter = new Fmp4Splitter();
    expect(splitter.feed(join(box("ftyp"), box("moov")))).toEqual([]);
    expect(splitter.feed(box("moof")).map((s) => s.kind)).toEqual(["init"]);
    expect(splitter.feed(box("mdat")).map((s) => s.kind)).toEqual(["media"]);
  });
});

/*
 * ---- 中身を読む (画面の canvas で描く経路) ----
 *
 * 箱は手で組む。並びは ISO/IEC 14496-12 と、denpa の ffmpeg が出す形式
 * (`+empty_moov+default_base_moof`) に合わせる
 */

/** 中身付きの箱 */
function boxOf(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = join(...parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

/** 大きい桁が先の数を並べる (`[値, バイト数]`) */
function be(...fields: [number, number][]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(fields.reduce((n, [, size]) => n + size, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [value, size] of fields) {
    if (size === 1) view.setUint8(at, value);
    else if (size === 2) view.setUint16(at, value);
    else if (size === 4) view.setUint32(at, value >>> 0);
    else if (size === 8) view.setBigUint64(at, BigInt(value));
    at += size;
  }
  return out;
}

function trak(id: number, timescale: number, entry: Uint8Array): Uint8Array {
  // tkhd バージョン 0: version+flags(4) 作った時刻(4) 変えた時刻(4) track_ID(4) ...
  const tkhd = boxOf(
    "tkhd",
    be([0, 4], [0, 4], [0, 4], [id, 4]),
    new Uint8Array(68),
  );
  // mdhd バージョン 0: version+flags(4) 作った時刻(4) 変えた時刻(4) timescale(4) duration(4) 言語(4)
  const mdhd = boxOf(
    "mdhd",
    be([0, 4], [0, 4], [0, 4], [timescale, 4], [0, 4], [0, 4]),
  );
  const stsd = boxOf("stsd", be([0, 4], [1, 4]), entry);
  return boxOf(
    "trak",
    tkhd,
    boxOf("mdia", mdhd, boxOf("minf", boxOf("stbl", stsd))),
  );
}

/** VisualSampleEntry (78 バイトの決まった並び + 中身の箱) */
function visual(
  type: string,
  width: number,
  height: number,
  inner: Uint8Array,
): Uint8Array {
  const fixed = new Uint8Array(78);
  const view = new DataView(fixed.buffer);
  view.setUint16(24, width);
  view.setUint16(26, height);
  return boxOf(type, fixed, inner);
}

/** AudioSampleEntry (28 バイトの決まった並び + 中身の箱) */
function sound(
  type: string,
  channels: number,
  rate: number,
  inner: Uint8Array,
): Uint8Array {
  const fixed = new Uint8Array(28);
  const view = new DataView(fixed.buffer);
  view.setUint16(16, channels);
  view.setUint32(24, rate * 65536);
  return boxOf(type, fixed, inner);
}

/** esds。ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo (AudioSpecificConfig) */
function esds(asc: Uint8Array): Uint8Array {
  const info = join(Uint8Array.of(0x05, asc.length), asc);
  const config = join(
    Uint8Array.of(0x04, 13 + info.length, 0x40, 0x15),
    new Uint8Array(11),
    info,
  );
  const es = join(Uint8Array.of(0x03, 3 + config.length, 0, 1, 0), config);
  return boxOf("esds", be([0, 4]), es);
}

function trex(
  id: number,
  duration: number,
  size: number,
  flags: number,
): Uint8Array {
  return boxOf(
    "trex",
    be([0, 4], [id, 4], [1, 4], [duration, 4], [size, 4], [flags, 4]),
  );
}

/** H.264 High 4.1 (avcC の頭4バイト。中身の SPS/PPS は読まないので省く) */
const AVCC = Uint8Array.of(1, 0x64, 0x00, 0x29, 0xff, 0xe0);
/** AAC LC 48kHz 2ch */
const ASC = Uint8Array.of(0x11, 0x90);
/** dOps: バージョン 0 / 2ch / 頭で捨てる 312 / 48000 / 補正 0 / 並べ方 0 */
const DOPS = be([0, 1], [2, 1], [312, 2], [48000, 4], [0, 2], [0, 1]);

function init(): Uint8Array {
  return join(
    boxOf("ftyp", new Uint8Array(8)),
    boxOf(
      "moov",
      trak(1, 90000, visual("avc1", 1920, 1080, boxOf("avcC", AVCC))),
      trak(2, 48000, sound("mp4a", 2, 48000, esds(ASC))),
      // 字幕など知らないトラックは飛ばす
      trak(3, 1000, boxOf("tx3g", new Uint8Array(16))),
      boxOf("mvex", trex(1, 1500, 0, 0x10000), trex(2, 1024, 0, 0)),
    ),
  );
}

describe("fMP4 の中身を読む", () => {
  test("moov から映像と音声の形式を読む。知らないトラックは飛ばす", () => {
    const tracks = readInit(init());
    expect(tracks.map((t) => [t.id, t.kind, t.codec, t.timescale])).toEqual([
      [1, "video", "avc1.640029", 90000],
      [2, "audio", "mp4a.40.2", 48000],
    ]);
    expect([tracks[0]!.width, tracks[0]!.height]).toEqual([1920, 1080]);
    expect(tracks[0]!.config).toEqual(AVCC);
    expect(tracks[1]!.config).toEqual(ASC);
    expect([tracks[1]!.channels, tracks[1]!.sampleRate]).toEqual([2, 48000]);
    // trex の既定
    expect(tracks[0]!.defaults).toEqual({
      duration: 1500,
      size: 0,
      flags: 0x10000,
    });
  });

  test("AV1 は av1C から codec を起こし、Opus は dOps を持つ", () => {
    // av1C: 印+バージョン / profile 0・level 8 / tier M・8bit・4:2:0 / ...
    const av1C = Uint8Array.of(0x81, 0x08, 0x0c, 0x00);
    const tracks = readInit(
      boxOf(
        "moov",
        trak(1, 90000, visual("av01", 1920, 1080, boxOf("av1C", av1C))),
        trak(2, 48000, sound("Opus", 2, 48000, boxOf("dOps", DOPS))),
      ),
    );
    expect(tracks.map((t) => t.codec)).toEqual(["av01.0.08M.08", "opus"]);
    expect(tracks[0]!.config).toEqual(av1C);
    expect(tracks[1]!.config).toEqual(DOPS);
  });

  test("moof の tfdt と trun から1コマずつの時刻と中身を読む", () => {
    const tracks = readInit(init());
    const video = [Uint8Array.of(1, 1, 1), Uint8Array.of(2, 2)];
    const audio = [Uint8Array.of(9, 9, 9, 9)];
    /*
     * 映像の trun: data_offset + first_sample_flags + 1コマごとの大きさと合成時刻のずれ (バージョン 1、符号あり)。
     * 長さは trex の既定 (1500)、2コマ目の印も trex の既定 (sync でない)
     */
    const vtrun = (offset: number) =>
      boxOf(
        "trun",
        be(
          [0x01000a05, 4],
          [2, 4],
          [offset, 4],
          [0, 4],
          [3, 4],
          [3000, 4],
          [2, 4],
          [-1500, 4],
        ),
      );
    // 音声の trun: data_offset + 1コマごとの長さと大きさ。tfhd に既定の印 (sync)
    const atrun = (offset: number) =>
      boxOf("trun", be([0x000301, 4], [1, 4], [offset, 4], [1024, 4], [4, 4]));
    const moof = (voff: number, aoff: number) =>
      boxOf(
        "moof",
        boxOf("mfhd", be([0, 4], [7, 4])),
        boxOf(
          "traf",
          boxOf("tfhd", be([0x020000, 4], [1, 4])),
          boxOf("tfdt", be([0x01000000, 4], [2 ** 33 + 9000, 8])),
          vtrun(voff),
        ),
        boxOf(
          "traf",
          boxOf("tfhd", be([0x020020, 4], [2, 4], [0, 4])),
          boxOf("tfdt", be([0, 4], [4800, 4])),
          atrun(aoff),
        ),
      );
    // 在りかは moof の頭から数える。moof の大きさが決まってから組み直す
    const size = moof(0, 0).length;
    const mdat = boxOf("mdat", ...video, ...audio);
    const fragment = join(moof(size + 8, size + 8 + 5), mdat);
    const samples = readFragment(fragment, tracks);
    expect(
      samples.map((s) => [
        s.track,
        s.dts,
        s.pts,
        s.duration,
        s.key,
        [...s.data],
      ]),
    ).toEqual([
      [1, 2 ** 33 + 9000, 2 ** 33 + 12000, 1500, true, [1, 1, 1]],
      [1, 2 ** 33 + 10500, 2 ** 33 + 9000, 1500, false, [2, 2]],
      [2, 4800, 4800, 1024, true, [9, 9, 9, 9]],
    ]);
  });

  test("壊れた媒体は、読めたところまで返して投げない", () => {
    const tracks = readInit(init());
    // 中身の在りかが mdat の外を指している
    const broken = join(
      boxOf(
        "moof",
        boxOf(
          "traf",
          boxOf("tfhd", be([0x020000, 4], [2, 4])),
          boxOf("trun", be([0x000201, 4], [1, 4], [4096, 4], [10, 4])),
        ),
      ),
      boxOf("mdat", new Uint8Array(4)),
    );
    expect(readFragment(broken, tracks)).toEqual([]);
    expect(readFragment(Uint8Array.of(0, 0, 0, 1), tracks)).toEqual([]);
    expect(readInit(Uint8Array.of(1, 2, 3))).toEqual([]);
  });
});

describe("ADTS の頭を組む", () => {
  /*
   * 放送の ADTS と同じものになること。48kHz・2ch・LC で中身 371 バイトの1コマは、
   * 頭込みで 378 バイト (ffmpeg が `-f adts` で書いたものと同じ7バイト)
   */
  test("AudioSpecificConfig から 7 バイトの頭を起こす", () => {
    expect([...(adtsHeader(ASC, 371) ?? [])]).toEqual([
      0xff, 0xf1, 0x4c, 0x80, 0x2f, 0x5f, 0xfc,
    ]);
  });

  test("付けた頭は pes.ts の AdtsSplitter がそのまま読める", () => {
    const payload = new Uint8Array(100).fill(7);
    const frame = join(adtsHeader(ASC, payload.length)!, payload);
    const [read] = new AdtsSplitter().feed(frame, 0);
    expect(read?.sampleRate).toBe(48000);
    expect(read?.channels).toBe(2);
    expect(read?.data.length).toBe(107);
  });

  test("ADTS に書けない形式は null", () => {
    // HE-AAC (種類 5)
    expect(adtsHeader(Uint8Array.of(0x2b, 0x10), 10)).toBeNull();
    // 標本化周波数を値で書いたもの (番号 15)
    expect(adtsHeader(Uint8Array.of(0x17, 0x90), 10)).toBeNull();
    expect(adtsHeader(Uint8Array.of(0x11), 10)).toBeNull();
  });
});

describe("dOps を OpusHead にする", () => {
  test("数の並べ方を入れ替え、頭に OpusHead を付ける", () => {
    const head = opusHead(DOPS)!;
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe("OpusHead");
    const view = new DataView(head.buffer);
    expect(head[8]).toBe(1);
    expect(head[9]).toBe(2);
    expect(view.getUint16(10, true)).toBe(312);
    expect(view.getUint32(12, true)).toBe(48000);
    expect(view.getInt16(16, true)).toBe(0);
    expect(head[18]).toBe(0);
    expect(head.length).toBe(19);
  });

  test("並べ方が 0 でなければ、並びの表も写す", () => {
    const dOps = join(
      be([0, 1], [6, 1], [312, 2], [48000, 4], [0, 2], [1, 1]),
      Uint8Array.of(4, 2, 0, 4, 1, 2, 3, 5),
    );
    const head = opusHead(dOps)!;
    expect(head.length).toBe(27);
    expect([...head.subarray(18)]).toEqual([1, 4, 2, 0, 4, 1, 2, 3, 5]);
    expect(opusHead(Uint8Array.of(0, 2))).toBeNull();
  });
});

/*
 * **本物の ffmpeg が書いたもの** (E2E の偽 ffmpeg が流す作り置き。`tests/fake/fmp4-loop.ts` に作り方)。
 * 形式はライブと同じ (`+empty_moov+default_base_moof`)。手で組んだ箱と読み方が食い違っていないかを見る
 */
describe("ffmpeg が書いた fMP4 を読む", () => {
  const fixture = (name: string) =>
    new Uint8Array(
      readFileSync(new URL(`../../../tests/fake/${name}`, import.meta.url)),
    );

  for (const [name, video, audio] of [
    ["live-h264.mp4", /^avc1\.[0-9a-f]{6}$/, "mp4a.40.2"],
    ["live-av1.mp4", /^av01\.0\.\d\dM\.08$/, "opus"],
  ] as const) {
    test(name, () => {
      const file = fixture(name);
      const tracks = readInit(file);
      expect(tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
      expect(tracks[0]!.codec).toMatch(video);
      expect(tracks[1]!.codec).toBe(audio);
      expect(tracks[0]!.width).toBeGreaterThanOrEqual(320);
      if (audio === "opus")
        expect(opusHead(tracks[1]!.config)?.length).toBe(19);
      else expect(adtsHeader(tracks[1]!.config, 100)).not.toBeNull();

      // 媒体を全部読む: 2秒ぶんのコマが時刻の順に並び、頭はキーフレーム
      const samples = new Fmp4Splitter()
        .feed(file)
        .filter((s) => s.kind === "media")
        .flatMap((s) => readFragment(s.data, tracks));
      const pictures = samples.filter((s) => s.track === tracks[0]!.id);
      const sounds = samples.filter((s) => s.track === tracks[1]!.id);
      expect(pictures.length).toBe(60);
      expect(pictures[0]!.key).toBe(true);
      expect(pictures.filter((s) => s.key).length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < pictures.length; i++) {
        expect(pictures[i]!.dts).toBe(
          pictures[i - 1]!.dts + pictures[i - 1]!.duration,
        );
      }
      const seconds = (s: { dts: number; duration: number }, scale: number) =>
        (s.dts + s.duration) / scale;
      expect(seconds(pictures.at(-1)!, tracks[0]!.timescale)).toBeCloseTo(2, 1);
      expect(seconds(sounds.at(-1)!, tracks[1]!.timescale)).toBeCloseTo(2, 1);
      expect(sounds.every((s) => s.data.length > 0)).toBe(true);
    });
  }
});
