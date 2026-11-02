import { describe, expect, test } from "bun:test";

import { captionLanguage } from "@danything/arib/caption-text";

import { liveCodecs, subtitles } from "./settings";

const JPN = captionLanguage(1, "jpn");
const ENG = captionLanguage(2, "eng");
const icon = (() => null) as never;

function choice(over: Partial<Parameters<typeof subtitles>[0]> = {}) {
  const calls: string[] = [];
  const made = subtitles({
    icon,
    on: true,
    languages: [JPN, ENG],
    language: 1,
    onoff: (on) => calls.push(on ? "on" : "off"),
    ontrack: (index) => calls.push(`track ${index}`),
    onlanguage: (index) => calls.push(`language ${index}`),
    ...over,
  });
  return { made, calls };
}

describe("⚙ の字幕の行", () => {
  test("オフと言語を並べ、いまの言語を値に出す", () => {
    const { made } = choice();
    expect(made.options.map((o) => o.label)).toEqual([
      "オフ",
      "日本語",
      "英語",
    ]);
    expect(made.value).toBe("日本語");
    expect(made.options.find((o) => o.active)?.label).toBe("日本語");
  });

  test("消していればオフが選ばれている", () => {
    const { made } = choice({ on: false });
    expect(made.value).toBe("オフ");
    expect(made.options.filter((o) => o.active).map((o) => o.key)).toEqual([
      "off",
    ]);
  });

  test("言語を選ぶと出して、言語だけを替える", () => {
    const { made, calls } = choice({ on: false });
    made.pick("0:2");
    expect(calls).toEqual(["on", "language 2"]);
  });

  test("オフを選ぶと消すだけ", () => {
    const { made, calls } = choice();
    made.pick("off");
    expect(calls).toEqual(["off"]);
  });

  test("言語が1つなら、オフとオンだけ (名前が分かればその名前)", () => {
    expect(
      choice({ languages: [JPN] }).made.options.map((o) => o.label),
    ).toEqual(["オフ", "日本語"]);
    expect(choice({ languages: [] }).made.options.map((o) => o.label)).toEqual([
      "オフ",
      "オン",
    ]);
  });

  test("字幕のストリームが複数なら、いまのストリームだけ言語に開く。別のストリームは再エンコード", () => {
    const tracks = [
      { index: 0, label: "字幕 (日本語)" },
      { index: 1, label: "字幕 (英語)" },
    ];
    const { made, calls } = choice({ tracks, track: 0 });
    expect(made.options.map((o) => o.label)).toEqual([
      "オフ",
      "字幕 (日本語) 日本語",
      "字幕 (日本語) 英語",
      "字幕 (英語)",
    ]);
    made.pick("1:0");
    expect(calls).toEqual(["on", "track 1"]);
  });
});

describe("⚙ のコーデックの行 (ライブ・追っかけ)", () => {
  function codecs(over: Partial<Parameters<typeof liveCodecs>[0]> = {}) {
    const picked: string[] = [];
    const made = liveCodecs({
      icon,
      choice: "auto",
      format: "raw",
      raw: true,
      unavailable: [],
      onselect: (next) => picked.push(next),
      ...over,
    });
    return { made, picked };
  }

  test("自動を先頭に、AV1・H.264・MPEG-2 と並べ、自動の値にいまの形式を添える", () => {
    const { made } = codecs();
    expect(made.options.map((o) => o.label)).toEqual([
      "自動",
      "AV1",
      "H.264",
      "MPEG-2",
    ]);
    expect(made.value).toBe("自動 (MPEG-2)");
    expect(made.options.find((o) => o.active)?.key).toBe("auto");
    expect(codecs({ format: "h264" }).made.value).toBe("自動 (H.264)");
  });

  test("選んだものはその名前だけを値に出す", () => {
    const { made } = codecs({ choice: "av1", format: "av1" });
    expect(made.value).toBe("AV1");
    expect(made.options.find((o) => o.active)?.key).toBe("av1");
    expect(codecs({ choice: "raw" }).made.value).toBe("MPEG-2");
  });

  test("押したものを選択として渡す (MPEG-2 は raw)", () => {
    const { made, picked } = codecs();
    made.pick("mpeg2");
    made.pick("auto");
    made.pick("h264");
    expect(picked).toEqual(["raw", "auto", "h264"]);
  });

  test("追っかけには MPEG-2 が無い", () => {
    const { made } = codecs({ raw: false, format: "av1" });
    expect(made.options.map((o) => o.key)).toEqual(["auto", "av1", "h264"]);
  });

  test("H.264 を出さない設定では H.264 を並べない。自動で H.264 になっていれば値には出す", () => {
    const { made } = codecs({ hidden: true, format: "h264" });
    expect(made.options.map((o) => o.key)).toEqual(["auto", "av1", "mpeg2"]);
    expect(made.value).toBe("自動 (H.264)");
  });

  test("互換モードで描けない形式は、並べるが押せない", () => {
    const { made } = codecs({ unavailable: ["av1"] });
    const av1 = made.options.find((o) => o.key === "av1");
    expect(av1?.disabled).toBe(true);
    expect(av1?.label).toBe("AV1 (再生できません)");
  });
});
