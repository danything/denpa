import { describe, expect, test } from "bun:test";

import {
  autoCodec,
  autoOrder,
  broadcastCodec,
  broadcastFormat,
  formatLabel,
  hiddenCodecs,
  keptChoice,
  readChoice,
  shownCodec,
} from "./live-choice";

const all = { rawOk: true, av1: true, hevc: true, h264: true };
const where = { indoor: false, compat: false };

/** **「自動」の順** (`autoOrder`)。ライブ・追っかけ・録画の観る画面で同じ関数から出す */
describe("自動の順", () => {
  test("その場でエンコードする家の中は MPEG-2 → H.264 → AV1 → H.265 (開くまでの速さ)", () => {
    expect(autoOrder({ indoor: true, compat: false })).toEqual([
      "raw",
      "h264",
      "av1",
      "hevc",
    ]);
  });

  test("外は AV1 → H.265 → H.264 (回線)", () => {
    expect(autoOrder(where)).toEqual(["av1", "hevc", "h264"]);
  });

  test("互換モードは家の中でも外でも AV1 → H.264 → MPEG-2", () => {
    for (const indoor of [true, false])
      expect(autoOrder({ indoor, compat: true })).toEqual([
        "av1",
        "h264",
        "raw",
      ]);
  });

  test("エンコード済み (録画の観る画面) は小さい順 AV1 → H.265 → H.264", () => {
    expect(autoOrder("encoded")).toEqual(["av1", "hevc", "h264"]);
  });
});

/** **ライブと追っかけの「自動」の形式** (`autoCodec`)。`autoOrder` の順で、使えるものの先頭 */
describe("自動の形式", () => {
  test("家の中は MPEG-2、使えなければ H.264 → AV1 → H.265", () => {
    const indoor = { ...where, indoor: true };
    expect(autoCodec({ ...all, ...indoor })).toBe("raw");
    expect(autoCodec({ ...all, ...indoor, rawOk: false })).toBe("h264");
    expect(autoCodec({ ...all, ...indoor, rawOk: false, h264: false })).toBe(
      "av1",
    );
    expect(
      autoCodec({ ...all, ...indoor, rawOk: false, h264: false, av1: false }),
    ).toBe("hevc");
  });

  test("外は AV1 → H.265 → H.264。MPEG-2 は使えても選ばない", () => {
    expect(autoCodec({ ...all, ...where })).toBe("av1");
    expect(autoCodec({ ...all, ...where, av1: false })).toBe("hevc");
    expect(autoCodec({ ...all, ...where, av1: false, hevc: false })).toBe(
      "h264",
    );
    expect(
      autoCodec({ ...all, ...where, av1: false, hevc: false, h264: false }),
    ).toBe(null);
  });

  test("互換モードは AV1 → H.264 → MPEG-2。H.265 は使えても選ばない", () => {
    for (const indoor of [true, false]) {
      const compat = { indoor, compat: true };
      expect(autoCodec({ ...all, ...compat })).toBe("av1");
      expect(autoCodec({ ...all, ...compat, av1: false })).toBe("h264");
      expect(autoCodec({ ...all, ...compat, av1: false, h264: false })).toBe(
        "raw",
      );
      expect(
        autoCodec({
          rawOk: false,
          av1: false,
          hevc: true,
          h264: false,
          ...compat,
        }),
      ).toBe(null);
    }
  });

  test("追っかけは H.265 を外すだけ (家の中なら MPEG-2 → H.264 → AV1)", () => {
    const chase = { ...all, hevc: false, indoor: true, compat: false };
    expect(autoCodec(chase)).toBe("raw");
    expect(autoCodec({ ...chase, rawOk: false })).toBe("h264");
    expect(autoCodec({ ...chase, rawOk: false, h264: false })).toBe("av1");
    expect(autoCodec({ ...chase, rawOk: false, h264: false, av1: false })).toBe(
      null,
    );
  });
});

describe("覚えていた選択の読み方", () => {
  test("自動・AV1・H.265・H.264・MPEG-2 はそのまま", () => {
    for (const choice of ["auto", "av1", "hevc", "h264", "raw"] as const)
      expect(readChoice(choice)).toBe(choice);
  });

  test("知らない値・前の形式 (選択が無い) は自動", () => {
    expect(readChoice(undefined)).toBe("auto");
    expect(readChoice("vp9")).toBe("auto");
    expect(readChoice(3)).toBe("auto");
  });

  test("エンコードするものは、いまメニューに並んでいるものと同じときだけ使い、違えば自動", () => {
    expect(keptChoice("hevc", "hevc")).toBe("hevc");
    expect(keptChoice("h264", "hevc")).toBe("auto");
    expect(keptChoice("av1", "h264")).toBe("auto");
    expect(keptChoice("av1", null)).toBe("auto");
    // 自動と MPEG-2 は並びに関わらずそのまま
    expect(keptChoice("auto", "h264")).toBe("auto");
    expect(keptChoice("raw", null)).toBe("raw");
  });
});

/**
 * **メニューに並べるエンコードするもの** (`shownCodec`)。サーバがその場でエンコードできる並びの先頭から、端末で再生できるもの 1 つ。
 * テレビのアプリに外させるもの (`hiddenCodecs`) は、並びの先頭以外
 */
describe("メニューに並べるコーデック", () => {
  const plays =
    (...ok: string[]) =>
    (codec: string) =>
      ok.includes(codec);

  test("GPU が無ければ H.264", () => {
    expect(shownCodec(["h264"], plays("av1", "hevc", "h264"))).toBe("h264");
  });

  test("GPU で H.264 と H.265 をエンコードできれば、H.265 を再生できる端末は H.265、できない端末は H.264", () => {
    expect(shownCodec(["hevc", "h264"], plays("av1", "hevc", "h264"))).toBe(
      "hevc",
    );
    expect(shownCodec(["hevc", "h264"], plays("av1", "h264"))).toBe("h264");
  });

  test("GPU で AV1 をエンコードできれば、AV1 を再生できる端末は AV1", () => {
    expect(
      shownCodec(["av1", "hevc", "h264"], plays("av1", "hevc", "h264")),
    ).toBe("av1");
    expect(shownCodec(["av1", "h264"], plays("h264"))).toBe("h264");
  });

  test("どれも再生できなければ並びの先頭、並びが空なら null", () => {
    expect(shownCodec(["hevc", "h264"], plays())).toBe("hevc");
    expect(shownCodec([], plays("h264"))).toBeNull();
  });

  test("テレビのアプリには、並びの先頭以外を外させる", () => {
    expect(hiddenCodecs(["h264"])).toEqual(["av1", "hevc"]);
    expect(hiddenCodecs(["hevc", "h264"])).toEqual(["av1", "h264"]);
    expect(hiddenCodecs(["av1", "hevc", "h264"])).toEqual(["hevc", "h264"]);
  });
});

/** **4K の局** (`broadcast` が `hevc`)。放送のまま (MPEG-2) の場所に HEVC の詰め替えが入り、H.265 にはエンコードしない */
describe("4K の局の自動", () => {
  const uhd = { broadcast: "hevc" as const };

  test("家の中は HEVC → H.264 → AV1、外は AV1 → H.264、互換モードは AV1 → H.264 (canvas は HEVC を描かない)", () => {
    expect(autoOrder({ indoor: true, compat: false, ...uhd })).toEqual([
      "hevc",
      "h264",
      "av1",
    ]);
    expect(autoOrder({ indoor: false, compat: false, ...uhd })).toEqual([
      "av1",
      "h264",
    ]);
    expect(autoOrder({ indoor: true, compat: true, ...uhd })).toEqual([
      "av1",
      "h264",
    ]);
  });

  test("hevc は放送の HEVC を再生できるか。MPEG-2 をデコードできても使わない", () => {
    const indoor = { ...where, indoor: true, ...uhd };
    expect(autoCodec({ ...all, ...indoor })).toBe("hevc");
    expect(autoCodec({ ...all, ...indoor, hevc: false })).toBe("h264");
    // 外では放送のままを選ばない
    expect(autoCodec({ ...all, ...where, ...uhd })).toBe("av1");
    expect(autoCodec({ ...all, ...where, ...uhd, av1: false })).toBe("h264");
    expect(
      autoCodec({ ...all, ...where, ...uhd, av1: false, h264: false }),
    ).toBe(null);
  });

  test("伝送の形式から放送のコーデック、放送のままでリクエストする形式と名前", () => {
    expect(broadcastCodec("tlv")).toBe("hevc");
    expect(broadcastCodec("ts")).toBe("mpeg2");
    expect(broadcastFormat("hevc")).toBe("hevc");
    expect(broadcastFormat("mpeg2")).toBe("raw");
    expect(formatLabel("raw", "hevc")).toBe("H.265");
    expect(formatLabel("raw")).toBe("MPEG-2");
  });
});
