import { describe, expect, test } from "bun:test";

import {
  aheadOf,
  AUDIO_TYPE,
  autoPick,
  canvasChoices,
  canvasTranscodes,
  codecChoices,
  covers,
  type MediaAbility,
  pickCanvas,
  pickOffer,
  playableAbility,
  type PlaybackInfo,
  streamForAudio,
  switchPoint,
  transcodes,
  typeOfCodec,
} from "./playback";

/** 答えを表で持つブラウザ。載っていない形式は読めない */
function browser(play: string[], mse: string[]): MediaAbility {
  return {
    play: (type) => play.includes(type),
    mse: (type) => mse.includes(type),
  };
}

const H264_MP4 = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
const H264_LIVE = 'video/mp4; codecs="avc1.640029,mp4a.40.2"';
const AV1_MP4 = 'video/mp4; codecs="av01.0.08M.08,Opus"';

/** H.264 だけエンコードした録画 (サーバの `playbackPlan` が返す形式) */
const h264Only: PlaybackInfo = {
  duration: 1800,
  axis: "encoded",
  audios: [{ id: "0", label: "主音声" }],
  offers: [
    {
      codec: "h264",
      way: "file",
      source: "encoded",
      codecs: "avc1.640028,opus",
    },
    { codec: "h264", way: "stream", codecs: "avc1.640028,mp4a.40.2" },
    { codec: "av1", way: "stream", codecs: "av01.0.08M.08,Opus" },
  ],
};

/** AV1 だけエンコードした録画 */
const av1Only: PlaybackInfo = {
  ...h264Only,
  offers: [
    {
      codec: "av1",
      way: "file",
      source: "encoded",
      codecs: "av01.0.08M.08,opus",
    },
    { codec: "h264", way: "stream", codecs: "avc1.640029,mp4a.40.2" },
    { codec: "av1", way: "stream", codecs: "av01.0.08M.08,Opus" },
  ],
};

/** 元の TS だけ */
const tsOnly: PlaybackInfo = {
  duration: 1800,
  axis: "ts",
  audios: [{ id: "0:both", label: "音声" }],
  offers: [
    { codec: "h264", way: "stream", codecs: "avc1.640029,mp4a.40.2" },
    { codec: "av1", way: "stream", codecs: "av01.0.08M.08,Opus" },
    { codec: "mpeg2", way: "raw" },
  ],
};

const chrome = browser(
  [
    'video/x-matroska; codecs="avc1.640028,opus"',
    'video/x-matroska; codecs="av01.0.08M.08,opus"',
  ],
  [H264_MP4, H264_LIVE, AV1_MP4],
);
/** iPhone の Safari (iOS 17.1+)。Matroska は WebM としてしか読まず、WebM の H.264 は断る */
const iphone = browser(
  ['video/webm; codecs="av01.0.08M.08,opus"'],
  [H264_MP4, H264_LIVE],
);

describe("どれで観るか (pickOffer)", () => {
  test("そのまま読めるファイルがあれば、それ", () => {
    expect(pickOffer(h264Only, chrome)).toEqual({
      way: "file",
      codec: "h264",
      source: "encoded",
    });
  });

  test("iPhone の H.264 は詰め替え (サーバは軽い) を変換より先に", () => {
    expect(pickOffer(h264Only, iphone)).toEqual({
      way: "stream",
      codec: "h264",
      type: H264_MP4,
    });
  });

  test("元の TS だけの録画は、ライブ・追っかけと同じ「その場でエンコード」の順。外なら AV1 → H.264", () => {
    expect(pickOffer(tsOnly, chrome)).toEqual({
      way: "stream",
      codec: "av1",
      type: AV1_MP4,
    });
    // MPEG-2 をデコードできても、外では選ばない
    expect(pickOffer(tsOnly, { ...chrome, mpeg2: true })).toEqual({
      way: "stream",
      codec: "av1",
      type: AV1_MP4,
    });
    // AV1 を受け取れない端末は H.264
    expect(pickOffer(tsOnly, browser([], [H264_LIVE]))).toEqual({
      way: "stream",
      codec: "h264",
      type: H264_LIVE,
    });
  });

  test("元の TS だけの録画は、家の中なら MPEG-2 → H.264 → AV1", () => {
    expect(pickOffer(tsOnly, { ...chrome, mpeg2: true }, "auto", true)).toEqual(
      { way: "raw", codec: "mpeg2" },
    );
    expect(pickOffer(tsOnly, chrome, "auto", true)).toEqual({
      way: "stream",
      codec: "h264",
      type: H264_LIVE,
    });
    expect(pickOffer(tsOnly, browser([], [AV1_MP4]), "auto", true)).toEqual({
      way: "stream",
      codec: "av1",
      type: AV1_MP4,
    });
  });

  test("エンコード済みがある録画の自動は、家の中でも MPEG-2 を選ばない。選べば元の TS で観る", () => {
    const kept: PlaybackInfo = {
      ...av1Only,
      offers: [...av1Only.offers, { codec: "mpeg2", way: "raw" }],
    };
    const can = { ...chrome, mpeg2: true };
    expect(pickOffer(kept, can, "auto", true)).toEqual({
      way: "file",
      codec: "av1",
      source: "encoded",
    });
    expect(pickOffer(kept, can, "mpeg2")).toEqual({
      way: "raw",
      codec: "mpeg2",
    });
    // デコードできない端末で MPEG-2 を選んでいたら自動と同じ。元の TS が無い録画も同じ
    expect(pickOffer(kept, chrome, "mpeg2")).toEqual({
      way: "file",
      codec: "av1",
      source: "encoded",
    });
    expect(pickOffer(av1Only, can, "mpeg2")).toEqual({
      way: "file",
      codec: "av1",
      source: "encoded",
    });
  });

  test("選んだコーデックがあれば、それを観られる方法で。AV1 の録画で H.264 を選ぶと変換", () => {
    expect(pickOffer(av1Only, chrome, "h264")).toEqual({
      way: "stream",
      codec: "h264",
      type: H264_LIVE,
    });
    expect(
      transcodes(av1Only, { way: "stream", codec: "h264", type: H264_LIVE }),
    ).toBe(true);
    expect(
      transcodes(h264Only, { way: "stream", codec: "h264", type: H264_MP4 }),
    ).toBe(false);
    // 選んだものを観られなければ自動と同じ
    expect(pickOffer(av1Only, iphone, "av1")).toEqual({
      way: "file",
      codec: "av1",
      source: "encoded",
    });
    expect(
      pickOffer(
        h264Only,
        browser(['video/x-matroska; codecs="avc1.640028,opus"'], []),
        "av1",
      ),
    ).toEqual({
      way: "file",
      codec: "h264",
      source: "encoded",
    });
  });

  test("中身が分からないファイルは、ほかが無ければそのまま渡す。何も無ければ null", () => {
    const unknown: PlaybackInfo = {
      ...h264Only,
      offers: [{ codec: "av1", way: "file", source: "encoded" }],
    };
    expect(pickOffer(unknown, chrome)).toEqual({
      way: "file",
      codec: "av1",
      source: "encoded",
    });
    expect(pickOffer(tsOnly, browser([], []))).toBeNull();
  });
});

describe("音声を選ぶために流すほうへ移る (streamForAudio)", () => {
  test("同じコーデックの詰め替えを先に", () => {
    expect(streamForAudio(av1Only, chrome, "av1")).toEqual({
      way: "stream",
      codec: "av1",
      type: AV1_MP4,
    });
    expect(streamForAudio(h264Only, chrome, "h264")).toEqual({
      way: "stream",
      codec: "h264",
      type: H264_MP4,
    });
  });

  test("同じコーデックを MSE が受け取れなければ、受け取れる変換", () => {
    expect(streamForAudio(av1Only, browser([], [H264_LIVE]), "av1")).toEqual({
      way: "stream",
      codec: "h264",
      type: H264_LIVE,
    });
  });

  test("MSE が何も受け取れなければ null", () => {
    expect(streamForAudio(av1Only, browser([], []), "av1")).toBeNull();
  });
});

describe("コーデックのメニュー (codecChoices)", () => {
  test("この端末で観られる方法があるものだけ", () => {
    expect(codecChoices(av1Only, chrome)).toEqual(["av1", "h264"]);
    expect(codecChoices(av1Only, iphone)).toEqual(["av1", "h264"]);
    expect(codecChoices(tsOnly, browser([], [AV1_MP4]))).toEqual(["av1"]);
  });

  test("MPEG-2 は元の TS が残っていて、この端末でデコードできるときだけ末尾に", () => {
    expect(codecChoices(tsOnly, { ...chrome, mpeg2: true })).toEqual([
      "av1",
      "h264",
      "mpeg2",
    ]);
    expect(codecChoices(tsOnly, chrome)).toEqual(["av1", "h264"]);
    expect(codecChoices(av1Only, { ...chrome, mpeg2: true })).toEqual([
      "av1",
      "h264",
    ]);
  });

  test("外すと決めたもの (メニューでは H.264・H.265) は並べない", () => {
    expect(codecChoices(av1Only, chrome, ["h264", "hevc"])).toEqual(["av1"]);
    expect(codecChoices(av1Only, chrome, [])).toEqual(["av1", "h264"]);
  });
});

describe("溜まり方 (aheadOf / covers)", () => {
  const ranges = [[100, 160]] as const;

  test("区間の中なら先に溜まっている長さ、外なら 0", () => {
    expect(aheadOf(ranges, 120)).toBe(40);
    expect(aheadOf(ranges, 170)).toBe(0);
    expect(aheadOf(ranges, 50)).toBe(0);
  });

  test("区間の先頭のわずかな手前 (音声と映像の先頭のずれ) は中と見る", () => {
    expect(aheadOf(ranges, 99.8)).toBeCloseTo(60.2);
  });

  test("読んでいるストリームの少し先までは待つ。外れたらリクエストし直す", () => {
    // 100 秒からリクエストして 160 秒まで来ている。10 秒送りの 170 秒は待てば届く
    expect(covers(ranges, 170, 100, 15)).toBe(true);
    expect(covers(ranges, 200, 100, 15)).toBe(false);
    // 戻った先は届かない
    expect(covers(ranges, 50, 100, 15)).toBe(false);
    // 読み終えたあと (読んでいない) は溜まっているぶんだけ
    expect(covers(ranges, 170, null, 15)).toBe(false);
  });

  test("リクエストした直後でまだ何も無くても、リクエストした位置なら待つ", () => {
    expect(covers([], 300, 300, 15)).toBe(true);
    expect(covers([], 400, 300, 15)).toBe(false);
  });
});

describe("段の切り替え (switchPoint / typeOfCodec)", () => {
  test("新しい段は、いまの位置を含む区間の末尾から始める。いまの位置が溜まっていなければ、いまの位置から", () => {
    const ranges = [
      [100, 160],
      [300, 320],
    ] as const;
    expect(switchPoint(ranges, 120)).toBe(160);
    // 区間の先頭のわずかな手前も中と見る (`aheadOf` と同じ)
    expect(switchPoint(ranges, 99.8)).toBe(160);
    expect(switchPoint(ranges, 200)).toBe(200);
    expect(switchPoint([], 50)).toBe(50);
  });

  test("応答の X-Denpa-Codec から MSE の型を決める。読めない値は null", () => {
    expect(typeOfCodec("h264")).toBe(H264_LIVE);
    expect(typeOfCodec("av1")).toBe(AV1_MP4);
    expect(typeOfCodec("audio")).toBe(AUDIO_TYPE);
    expect(typeOfCodec("mpeg2")).toBeNull();
    expect(typeOfCodec(null)).toBeNull();
  });
});

describe("互換モード (canvasChoices / pickCanvas)", () => {
  /** 元の TS も残っている AV1 の録画 */
  const withTs: PlaybackInfo = {
    ...av1Only,
    offers: [...av1Only.offers, { codec: "mpeg2", way: "raw" }],
  };
  const all = { h264: true, av1: true, mpeg2: true };

  test("流せるものを並べ、描けないものは押せなくする。ファイルそのままは使わない", () => {
    expect(canvasChoices(withTs, { ...all, h264: false })).toEqual([
      { codec: "h264", drawable: false },
      { codec: "av1", drawable: true },
      { codec: "mpeg2", drawable: true },
    ]);
    expect(canvasChoices(av1Only, all).map((item) => item.codec)).toEqual([
      "h264",
      "av1",
    ]);
  });

  test("自動は、エンコード済みと同じ形式 (詰め替え) → 変換 (ライブの互換モードと同じ AV1 → H.264) → MPEG-2", () => {
    expect(pickCanvas(withTs, all)).toBe("av1");
    expect(pickCanvas(h264Only, all)).toBe("h264");
    // H.264 だけの録画で H.264 を描けなければ、AV1 に変換する
    expect(pickCanvas(h264Only, { ...all, h264: false })).toBe("av1");
    // エンコード済みが無ければ、変換は AV1 を先にする
    expect(pickCanvas(tsOnly, all)).toBe("av1");
    expect(pickCanvas(withTs, { ...all, av1: false })).toBe("h264");
    expect(pickCanvas(withTs, { h264: false, av1: false, mpeg2: true })).toBe(
      "mpeg2",
    );
    expect(
      pickCanvas(av1Only, { h264: false, av1: false, mpeg2: true }),
    ).toBeNull();
  });

  test("選んだものが描ければそれ。描けなければ自動と同じ。打ち切った形式は避ける", () => {
    expect(pickCanvas(withTs, all, "mpeg2")).toBe("mpeg2");
    expect(pickCanvas(withTs, all, "h264")).toBe("h264");
    expect(pickCanvas(withTs, { ...all, h264: false }, "h264")).toBe("av1");
    expect(pickCanvas(withTs, all, "auto", ["av1"])).toBe("h264");
  });

  test("変換させるか (混んでいると断られる)", () => {
    expect(canvasTranscodes(withTs, "av1")).toBe(false);
    expect(canvasTranscodes(withTs, "h264")).toBe(true);
    expect(canvasTranscodes(withTs, "mpeg2")).toBe(false);
  });
});

describe("H.265 もある録画 (AV1 → H.265 → H.264)", () => {
  const MKV = (codecs: string) => `video/x-matroska; codecs="${codecs}"`;
  const HEVC_MP4 = 'video/mp4; codecs="hvc1.1.6.L123.90,mp4a.40.2"';
  /** 3 つともエンコードした録画。サーバの並びに意味は無いので、わざと H.264 を先に置く */
  const three: PlaybackInfo = {
    ...h264Only,
    offers: [
      { codec: "h264", way: "file", source: "alt", codecs: "avc1.640028,opus" },
      {
        codec: "hevc",
        way: "file",
        source: "hevc",
        codecs: "hvc1.1.6.L123.90,opus",
      },
      {
        codec: "av1",
        way: "file",
        source: "encoded",
        codecs: "av01.0.08M.08,opus",
      },
      { codec: "h264", way: "stream", codecs: "avc1.640028,mp4a.40.2" },
      { codec: "hevc", way: "stream", codecs: "hvc1.1.6.L123.90,mp4a.40.2" },
      { codec: "av1", way: "stream", codecs: "av01.0.08M.08,Opus" },
    ],
  };

  test("そのまま読めるファイルは小さいほうから", () => {
    const all = browser(
      [
        MKV("avc1.640028,opus"),
        MKV("hvc1.1.6.L123.90,opus"),
        MKV("av01.0.08M.08,opus"),
      ],
      [],
    );
    expect(pickOffer(three, all)).toEqual({
      way: "file",
      codec: "av1",
      source: "encoded",
    });
    // AV1 をデコードできなければ H.265
    const noAv1 = browser(
      [MKV("avc1.640028,opus"), MKV("hvc1.1.6.L123.90,opus")],
      [],
    );
    expect(pickOffer(three, noAv1)).toEqual({
      way: "file",
      codec: "hevc",
      source: "hevc",
    });
  });

  test("Matroska を読めない端末 (Safari) は、詰め替えも H.265 を H.264 より先に", () => {
    const safari = browser([], [H264_MP4, HEVC_MP4]);
    expect(pickOffer(three, safari)).toEqual({
      way: "stream",
      codec: "hevc",
      type: HEVC_MP4,
    });
  });

  test("H.265 は選べるコーデックに並ぶが、エンコード済みが無ければ並ばない", () => {
    const can = browser([], [H264_MP4, H264_LIVE, HEVC_MP4, AV1_MP4]);
    expect(codecChoices(three, can)).toEqual(["av1", "hevc", "h264"]);
    expect(codecChoices(av1Only, can)).toEqual(["av1", "h264"]);
    expect(pickOffer(three, can, "hevc")).toEqual({
      way: "stream",
      codec: "hevc",
      type: HEVC_MP4,
    });
  });

  test("互換モードには H.265 を並べない (描けない)", () => {
    const all = { h264: true, av1: true, mpeg2: true };
    expect(canvasChoices(three, all).map((item) => item.codec)).toEqual([
      "h264",
      "av1",
    ]);
    expect(pickCanvas(three, all, "hevc")).toBe("h264");
  });
});

describe("エンコード済みがあるときの変換の順 (pickOffer)", () => {
  /** Matroska を読めず、MSE は H.264 と AV1 を受け取る端末。H.265 の録画は変換するしかない */
  const hevcOnly: PlaybackInfo = {
    ...h264Only,
    offers: [
      {
        codec: "hevc",
        way: "file",
        source: "encoded",
        codecs: "hvc1.1.6.L123.90,opus",
      },
      { codec: "hevc", way: "stream", codecs: "hvc1.1.6.L123.90,mp4a.40.2" },
      { codec: "h264", way: "stream", codecs: "avc1.640029,mp4a.40.2" },
      { codec: "av1", way: "stream", codecs: "av01.0.08M.08,Opus" },
    ],
  };
  const mseOnly = browser([], [H264_LIVE, AV1_MP4]);

  test("ライブと同じ「その場でエンコード」の順。家の中なら H.264 → AV1、外なら AV1 → H.264", () => {
    expect(pickOffer(hevcOnly, mseOnly, "auto", true)?.codec).toBe("h264");
    expect(pickOffer(hevcOnly, mseOnly, "auto", false)?.codec).toBe("av1");
  });
});

describe("サーバが選ぶ観方 (autoPick。playback?playable=)", () => {
  const withTs: PlaybackInfo = {
    ...av1Only,
    offers: [...av1Only.offers, { codec: "mpeg2", way: "raw" }],
  };

  test("再生できる形式の codecs だけを読めるとみなす。raw は元の TS", () => {
    const can = playableAbility(["av1", "raw"]);
    expect(can.play('video/x-matroska; codecs="av01.0.08M.08,opus"')).toBe(
      true,
    );
    expect(can.mse(H264_LIVE)).toBe(false);
    expect(can.mpeg2).toBe(true);
    expect(playableAbility(["hevc"]).mse('video/mp4; codecs="hev1.1"')).toBe(
      true,
    );
  });

  test("エンコード済みのファイルを、再生できればそのまま。家の中でも MPEG-2 は選ばない", () => {
    expect(autoPick(withTs, ["raw", "av1", "h264"], true)).toEqual({
      way: "file",
      codec: "av1",
      source: "encoded",
    });
  });

  test("ファイルのコーデックを再生できなければ変換", () => {
    expect(autoPick(av1Only, ["h264"], false)).toEqual({
      way: "stream",
      codec: "h264",
    });
  });

  test("元の TS だけなら、家の中は MPEG-2 から。外は AV1 → H.264", () => {
    expect(autoPick(tsOnly, ["raw", "h264", "av1"], true)).toEqual({
      way: "raw",
      codec: "mpeg2",
    });
    expect(autoPick(tsOnly, ["raw", "h264", "av1"], false)).toEqual({
      way: "stream",
      codec: "av1",
    });
    expect(autoPick(tsOnly, ["raw"], false)).toBeNull();
  });

  test("中身が分からないファイルは、コーデックが並びにあるときだけ渡す", () => {
    const unknown: PlaybackInfo = {
      ...h264Only,
      offers: [{ codec: "av1", way: "file", source: "encoded" }],
    };
    expect(autoPick(unknown, ["av1"], false)).toEqual({
      way: "file",
      codec: "av1",
      source: "encoded",
    });
    expect(autoPick(unknown, ["h264"], false)).toBeNull();
  });
});
