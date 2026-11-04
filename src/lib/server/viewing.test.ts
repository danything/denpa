import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * **どの形式で観るかの決まり** (`viewing.ts`)。家の中かはリクエストの名前で決め、開いたときの局と
 * 先回りする形式 (`live.warm`) は選択と家の中かから決める。DB は一時ファイルへ
 */
const dir = mkdtempSync(join(tmpdir(), "denpa-viewing-"));
const { config } = await import("./config");
const before = config.dbPath;
config.dbPath = join(dir, "denpa.db");
afterAll(() => {
  config.dbPath = before;
  rmSync(dir, { recursive: true, force: true });
});

const { saveSettings } = await import("./settings");
const { audioArgs } = await import("./live");
const {
  askedFormat,
  autoFormat,
  liveAudioOnly,
  liveStart,
  parseFormats,
  readKept,
  viewingOptions,
  warmFormat,
} = await import("./viewing");

describe("観るときの決まり (画面の load と GET /api/playback/options)", () => {
  test("設定が無ければ、外の名前は外・家の中のアドレスは家の中。外すコーデックは無い", () => {
    expect(
      viewingOptions(new URL("https://dp.example.com/live"), false),
    ).toEqual({
      indoor: false,
      hidden: [],
      hevc: false,
    });
    expect(viewingOptions(new URL("http://192.168.1.20:3000/"), false)).toEqual(
      {
        indoor: true,
        hidden: [],
        hevc: false,
      },
    );
  });

  test("家の中の名前に載せた名前は家の中。H.264 と H.265 を出さない設定なら両方を返す", () => {
    saveSettings({ indoorHosts: ["dp.l.example.com"], hideH264Hevc: true });
    expect(
      viewingOptions(new URL("https://dp.l.example.com/live"), false),
    ).toEqual({
      indoor: true,
      hidden: ["h264", "hevc"],
      hevc: false,
    });
    // 同じ家でも、外の名前で開けば外
    expect(viewingOptions(new URL("https://dp.example.com/live")).indoor).toBe(
      false,
    );
    saveSettings({ indoorHosts: [], hideH264Hevc: false });
  });

  test("ライブで H.265 を出せるか (ライブのエンコーダが GPU か) をそのまま返す", () => {
    expect(
      viewingOptions(new URL("https://dp.example.com/live"), true).hevc,
    ).toBe(true);
  });
});

describe("前回の局と選択の控え (cookie)", () => {
  const cookie = (value: unknown) => JSON.stringify(value);

  test("局・音声・選択を読む", () => {
    expect(
      readKept(
        cookie({
          channelType: "GR",
          channel: "27",
          serviceId: 1,
          audio: "1:main",
          choice: "raw",
        }),
        false,
      ),
    ).toEqual({
      channelType: "GR",
      channel: "27",
      audio: "1:main",
      choice: "raw",
    });
  });

  test("前の形式 (codec・raw だけ) は選択を読まずに自動。壊れていても自動", () => {
    expect(
      readKept(
        cookie({ channelType: "GR", channel: "27", codec: "av1", raw: true }),
        false,
      ),
    ).toEqual({ channelType: "GR", channel: "27", choice: "auto" });
    expect(readKept("{", false)).toEqual({ choice: "auto" });
    expect(readKept(undefined, false)).toEqual({ choice: "auto" });
  });

  test("H.264 を出さない設定では、H.264 の選択は自動", () => {
    expect(readKept(cookie({ choice: "h264" }), true).choice).toBe("auto");
    expect(readKept(cookie({ choice: "h264" }), false).choice).toBe("h264");
  });
});

describe("開いたときに先回りする形式と局", () => {
  const channels = [
    { id: 10, type: "GR", channel: "27" },
    { id: 20, type: "BS", channel: "BS01_0" },
  ];

  test("自動なら家の中は MPEG-2、外は AV1。選んだものは場所によらずそれ", () => {
    expect(warmFormat("auto", true)).toBe("raw");
    expect(warmFormat("auto", false)).toBe("av1");
    expect(warmFormat("h264", true)).toBe("h264");
    expect(warmFormat("raw", false)).toBe("raw");
  });

  test("前回の局を音声ごと開き、形式は選択と場所から", () => {
    const kept = {
      channelType: "BS",
      channel: "BS01_0",
      audio: "1:sub",
      choice: "auto" as const,
    };
    expect(liveStart(channels, NaN, kept, true)).toEqual({
      channelType: "BS",
      channel: "BS01_0",
      serviceId: 20,
      audio: "1:sub",
      raw: true,
    });
    expect(liveStart(channels, NaN, kept, false)).toEqual({
      channelType: "BS",
      channel: "BS01_0",
      serviceId: 20,
      audio: "1:sub",
      codec: "av1",
    });
  });

  test("名指しの局が先。音声の控えは前回の局のときだけ。無い局なら一覧の先頭", () => {
    const kept = {
      channelType: "BS",
      channel: "BS01_0",
      audio: "1:sub",
      choice: "h264" as const,
    };
    expect(liveStart(channels, 10, kept, true)).toEqual({
      channelType: "GR",
      channel: "27",
      serviceId: 10,
      codec: "h264",
    });
    expect(
      liveStart(channels, NaN, { choice: "auto", channel: "99" }, false),
    ).toEqual({
      channelType: "GR",
      channel: "27",
      serviceId: 10,
      codec: "av1",
    });
    expect(liveStart([], NaN, { choice: "auto" }, true)).toBeNull();
  });
});

describe("形式をサーバに選ばせる (codec=auto)", () => {
  /** GPU が無い (段を下げるならソフトウェアの H.264) */
  const noGpu = () => null;
  /** どれも GPU でエンコードできる */
  const gpu = () => ({ kind: "test" }) as never;

  test("playable を省けば H.264 だけ。知らない値は捨て、何も残らなければ null", () => {
    expect(parseFormats(null)).toEqual(["h264"]);
    expect(parseFormats("raw,av1,vp9,av1")).toEqual(["raw", "av1"]);
    expect(parseFormats("")).toBeNull();
    expect(parseFormats("vp9,mpeg2")).toBeNull();
  });

  test("家の中は MPEG-2 → H.264 → AV1 → H.265、外は AV1 → H.265 → H.264", () => {
    const all = ["raw", "av1", "hevc", "h264"] as const;
    const base = { scene: "live" as const, rung: 0 as const, hevc: true };
    expect(autoFormat({ ...base, formats: all, indoor: true })).toBe("raw");
    expect(autoFormat({ ...base, formats: all, indoor: false })).toBe("av1");
    expect(
      autoFormat({ ...base, formats: ["hevc", "h264"], indoor: false }),
    ).toBe("hevc");
    expect(autoFormat({ ...base, formats: ["raw", "av1"], indoor: true })).toBe(
      "raw",
    );
    // 外の並びに放送のままは無い
    expect(autoFormat({ ...base, formats: ["raw"], indoor: false })).toBeNull();
  });

  test("H.265 はライブで GPU のときだけ。追っかけでは出さない", () => {
    const formats = ["hevc", "h264"] as const;
    expect(
      autoFormat({
        scene: "live",
        formats,
        indoor: false,
        rung: 0,
        hevc: false,
      }),
    ).toBe("h264");
    expect(
      autoFormat({
        scene: "chase",
        formats,
        indoor: false,
        rung: 0,
        hevc: true,
      }),
    ).toBe("h264");
    expect(
      autoFormat({
        scene: "chase",
        formats: ["hevc"],
        indoor: false,
        rung: 0,
        hevc: true,
      }),
    ).toBeNull();
  });

  test("段を下げるなら rungCodec。放送のままは外し、H.264 を再生できない端末には選ばない", () => {
    const base = { scene: "live" as const, indoor: true, rung: 2 as const };
    expect(
      autoFormat({ ...base, formats: ["raw", "av1", "h264"], pick: gpu }),
    ).toBe("av1");
    expect(autoFormat({ ...base, formats: ["raw", "h264"], pick: noGpu })).toBe(
      "h264",
    );
    expect(autoFormat({ ...base, formats: ["raw", "av1"], pick: noGpu })).toBe(
      null,
    );
  });

  test("HTTP の live・chase の codec と段 (askedFormat)", () => {
    const at = (query: string) => new URL(`http://192.168.1.20/x?${query}`);
    const outside = (query: string) =>
      new URL(`https://dp.example.com/x?${query}`);
    expect(askedFormat(at("codec=auto&playable=raw,h264"), "live")).toEqual({
      codec: "raw",
      rung: 0,
    });
    expect(
      askedFormat(outside("codec=auto&playable=raw,h264,av1"), "chase"),
    ).toEqual({ codec: "av1", rung: 0 });
    expect(askedFormat(at("codec=auto"), "live")).toEqual({
      codec: "h264",
      rung: 0,
    });
    expect(askedFormat(at("codec=auto&playable="), "live")).toBeNull();
    expect(
      askedFormat(at("codec=auto&playable=raw,h264&rung=1"), "live", {
        pick: noGpu,
      }),
    ).toEqual({ codec: "h264", rung: 1 });
    // 明示の codec は今までどおり。ライブの H.265 は出せなければ H.264
    expect(askedFormat(at("codec=raw&rung=2"), "live")).toEqual({
      codec: "raw",
      rung: 0,
    });
    expect(askedFormat(at("codec=hevc"), "live", { hevc: true })).toEqual({
      codec: "hevc",
      rung: 0,
    });
    expect(askedFormat(at("codec=hevc"), "live", { hevc: false })).toEqual({
      codec: "h264",
      rung: 0,
    });
    expect(askedFormat(at("codec=hevc"), "chase", { hevc: true })).toEqual({
      codec: "h264",
      rung: 0,
    });
    expect(askedFormat(at(""), "chase")).toEqual({ codec: "h264", rung: 0 });
  });

  test("HTTP のライブの音声だけは段を保つ (liveAudioOnly)。WebSocket の codec: audio と同じく音声だけを 96k に下げる", () => {
    const at = (query: string) => new URL(`http://192.168.1.20/x?${query}`);
    expect(liveAudioOnly(at("audio=only&rung=2&codec=av1"))).toEqual({
      codec: "audio",
      rung: 2,
    });
    expect(liveAudioOnly(at("audio=only"))).toEqual({
      codec: "audio",
      rung: 0,
    });
    expect(liveAudioOnly(at("audio=0:sub&rung=2"))).toBeNull();
    expect(audioArgs("audio", 2).join(" ")).toContain("-b:a 96k");
    expect(audioArgs("audio", 0).join(" ")).toContain("-b:a 256k");
  });
});
