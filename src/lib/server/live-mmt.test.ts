import { describe, expect, test } from "bun:test";

import { MPU_MS, SynthMmtAv } from "@danything/arib/synth-mmt-av";

import { readFragment, readInit } from "#lib/ts/fmp4.js";

import { MmtLive, type MmtOut } from "./live-mmt";

const SERVICE = 301;
const START = Date.UTC(2026, 10, 11, 12, 0, 0);

/** 偽の放送と同じ組み立て (`tests/fake/broadcast.ts` の `broadcastTlv`)。字幕つき */
const synth = (caption?: string) =>
  new SynthMmtAv({
    serviceId: SERVICE,
    mptPacketId: 0x9000,
    startMs: START,
    ...(caption === undefined ? {} : { caption }),
  });

/** 映像の MPU を `count` 個流して、出てきたものを全部まとめる */
function play(live: MmtLive, av: SynthMmtAv, count: number): MmtOut[] {
  const out: MmtOut[] = [];
  for (let i = 0; i < count; i++) out.push(live.feed(av.next()));
  return out;
}

/**
 * **4K の局のライブの入口** (`live-mmt.ts`)。偽の放送と同じ、本物の HEVC と AAC を MMT/TLV に包んだもの
 * (`@danything/arib/synth-mmt-av`) を流して、詰め替えた fMP4・字幕・時計の組を確かめる
 */
describe("MmtLive", () => {
  const live = new MmtLive(SERVICE);
  const av = synth("字幕です");
  // 字幕の文書は次の文書が始まったときに閉じる (15 MPU おき)。2 つ目の文書が来るまで流す
  const out = play(live, av, 17);
  const segments = out.flatMap((o) => o.segments);

  test("1 局に絞った TLV をそのまま返す (HTTP の raw)", () => {
    expect(out.every((o) => o.tlv.length > 0)).toBe(true);
    expect(out[0]!.tlv[0]).toBe(0x7f);
  });

  test("init を 1 つ出してから、映像の MPU ごとに media を出す", () => {
    expect(segments[0]!.kind).toBe("init");
    expect(segments.filter((s) => s.kind === "init")).toHaveLength(1);
    expect(segments.filter((s) => s.kind === "media").length).toBeGreaterThan(
      10,
    );
    const tracks = readInit(segments[0]!.data);
    expect(tracks.map((t) => [t.kind, t.codec])).toEqual([
      ["video", "hvc1.2.4.L30.90"],
      ["audio", "mp4a.40.2"],
    ]);
  });

  test("時刻 0 は最初の頭出しできるコマの DTS で、断片は続いて並ぶ", () => {
    const media = segments.filter((s) => s.kind === "media");
    const tracks = readInit(segments[0]!.data);
    const firstDts = media.map(
      (s) => readFragment(s.data, tracks).find((t) => t.track === 1)?.dts,
    );
    expect(firstDts[0]).toBe(0);
    // 1 MPU は 8 コマ (90 kHz で 12012)
    expect(firstDts[1]).toBe(12012);
  });

  test("字幕は TTML を文字の配置にして、fMP4 の時刻 (ミリ秒) で返す", () => {
    const captions = out.flatMap((o) => o.captions);
    const shown = captions.filter((c) => c.page.runs.length > 0);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0]!.page.runs.map((r) => r.text).join("")).toBe("字幕です");
    expect(live.hasCaptions).toBe(true);
    // 最初の文書は映像の最初の MPU と同じ時刻に始まる。時刻 0 (最初のコマの DTS) より、B ピクチャのずれぶん後ろ
    expect(shown[0]!.at).toBeGreaterThan(0);
    expect(shown[0]!.at).toBeLessThan(100);
  });

  test("時計の組は、fMP4 の時刻と放送がそのコマを出す時刻 (NTP)", () => {
    const anchor = out.filter((o) => o.anchor !== null).at(-1)!.anchor!;
    // 映像の最初の MPU の提示時刻が START。fMP4 の時刻 0 はそれより B ピクチャのずれぶん前
    const lead = 3003 / 90;
    expect(
      Math.abs(anchor.unixMs - (START + anchor.media * 1000) + lead),
    ).toBeLessThan(1);
  });

  test("番組が替わってアセットの並びが変わったら、作り直す印を返す", () => {
    // 字幕の無い MPT を流す
    const changed = live.feed(synth().next());
    expect(changed.changed).toBe(true);
  });

  test("映像の 1 MPU は約 0.13 秒 (偽の放送はこの間隔で流す)", () => {
    expect(MPU_MS).toBeCloseTo((8 * 1001) / 60, 5);
  });
});
