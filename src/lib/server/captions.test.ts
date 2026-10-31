import { describe, expect, test } from "bun:test";

import {
  captionDescriptors,
  packetize,
  patSection,
  programMap,
  stream,
} from "@danything/arib/synth";
import {
  captionMkv as mkv,
  encodeAribText,
  management,
  text,
} from "@danything/arib/synth-caption";

import { CHANNEL } from "#lib/live.js";

import {
  appFrame,
  CAPTION_FEED_BACKLOG,
  CAPTION_FEED_HOLD,
  CaptionCount,
  captionFeed,
  type CaptionOut,
  captionOutput,
  captionStreams,
  CaptionText,
  NO_SUBTITLE,
  pagesFromMkv,
  peekCaptions,
  rawCaptionArgs,
  textFrame,
  TrackList,
  worthLogging,
} from "./captions";

describe("字幕の取り出し方", () => {
  /** 字幕はデコードせずに写す (`S_ARIBSUB`)。デコードするのは denpa なので、ffmpeg に字幕のデコーダは要らない */
  test("デコードせずに写す", () => {
    const args = captionOutput("0:p:1024", 0);
    expect(args.join(" ")).toContain("-map 0:p:1024:s:0 -c:s copy");
    expect(args).not.toContain("-sub_type");
    expect(args).not.toContain("-filter_complex");
  });

  /*
   * **時刻を運べるコンテナで受ける。** 別の出力 (`showinfo`) に喋らせて来た順に組にすると数が合わずにずれる
   */
  test("時刻はコマと一緒に運ばせる", () => {
    const args = captionOutput("0:p:1024", 0);
    expect(args[args.indexOf("-f") + 1]).toBe("matroska");
    expect(args).not.toContain("showinfo");
  });

  /** **映像とは別の出口へ出す。** 同じ ffmpeg なので、出口を分けるしかない */
  test("映像とは別の出口へ出す", () => {
    expect(captionOutput("0:p:1024", 0)).toContain("pipe:3");
  });

  /** 溜められるとそのぶん遅れる。塊の上限を最小にして1枚ずつ書かせる */
  test("溜めさせない", () => {
    const args = captionOutput("0:p:1024", 0);
    expect(args[args.indexOf("-cluster_time_limit") + 1]).toBe("1");
    expect(args[args.indexOf("-flush_packets") + 1]).toBe("1");
  });

  /** 局を名指しする。1本の物理チャンネルに複数の局が入っている (映像と同じ)。言語が複数ある放送では2本目も選べる */
  test("選んだ局の何本目かを採る", () => {
    expect(captionOutput("0:p:1032", 1).join(" ")).toContain(
      "-map 0:p:1032:s:1",
    );
    expect(captionOutput("0", 0).join(" ")).toContain("-map 0:s:0");
  });
});

/*
 * **放送そのままの経路の字幕は、放送の時刻のまま出させる** (docs/stream.md#放送そのままmpeg-2を送る)。受け側の時計は
 * 放送の PTS そのもの (自分で PES から読む) なので、ffmpeg に 0 へ寄せさせると合わない
 */
describe("放送そのままの経路の字幕", () => {
  test("放送の時刻を持ち込む (-copyts)。映像はエンコードしない", () => {
    const args = rawCaptionArgs(1024, 0);
    expect(args).toContain("-copyts");
    expect(args.indexOf("-copyts")).toBeLessThan(args.indexOf("-i"));
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("-vf");
    // 出口はエンコードの経路と同じ (Matroska を 3 番目の出口へ)
    expect(args.slice(-2)).toEqual(["matroska", "pipe:3"]);
    // 字幕はデコードせずに写す (デコードするのは denpa)。字幕を描く指定は要らない
    expect(args.join(" ")).toContain("-map 0:p:1024:s:0 -c:s copy");
    expect(args).not.toContain("-sub_type");
  });

  test("何本目の字幕かを選べる", () => {
    expect(rawCaptionArgs(1024, 1).join(" ")).toContain("-map 0:p:1024:s:1");
  });
});

/**
 * **字幕を持たない放送は普通にある** (ショッピングやサブチャンネル)。
 *
 * そこに字幕を要求すると ffmpeg は組み立ての時点で降りる — **映像も出ない**。
 * そうと分かったら字幕なしで再エンコードするので、その言い分を見分けられること
 */
describe("字幕が無いと分かる", () => {
  /** 実機で出させたものそのまま */
  test("ffmpeg の言い分から見分ける", () => {
    expect(
      NO_SUBTITLE.test(
        "[out#0/matroska @ 0x1] Stream map '' matches no streams.",
      ),
    ).toBe(true);
    expect(
      NO_SUBTITLE.test(
        "[fc#0 @ 0x1] No program with ID 1024 exists, stream specifier can never match",
      ),
    ).toBe(false);
  });

  test("よくある行では立たない", () => {
    expect(
      NO_SUBTITLE.test("[mpeg2video @ 0x1] Invalid frame dimensions 0x0."),
    ).toBe(false);
    expect(
      NO_SUBTITLE.test("  Stream #0:2[0x130]: Subtitle: arib_caption"),
    ).toBe(false);
  });

  /*
   * 記録に残るのはそのあとの `Failed to set value …` の行で、見分ける行そのものは残らない。
   * 本番の記録に「matches no streams」が見えなくても、字幕なしに戻ったのはこれのため
   */
  test("見分ける行は記録に残さない", () => {
    expect(
      worthLogging(
        "[out#0/matroska @ 0x1] Stream map '0:p:55:s:0' matches no streams.",
      ),
    ).toBe(false);
    expect(
      worthLogging(
        "Failed to set value '0:p:55:s:0' for option 'map': Invalid argument",
      ),
    ).toBe(true);
  });
});

/** 作り物の局。映像・音声・字幕の PID */
const SERVICE = 55;
const PMT_PID = 0x1f0;
const VIDEO_PID = 0x111;

/** PAT と、`streams` を並べた PMT */
function head(
  streams: ([number, number] | [number, number, number[]])[],
): Uint8Array {
  return stream(
    packetize(0x0000, patSection([[SERVICE, PMT_PID]])),
    packetize(
      PMT_PID,
      programMap(SERVICE, VIDEO_PID, [
        [0x02, VIDEO_PID],
        [0x0f, 0x112],
        ...streams,
      ]),
    ),
  );
}

/** 塊を順に出すストリーム。尽きたら `then` を待つ (来ないままにもできる) */
async function* chunksOf(
  parts: Uint8Array[],
  then: Promise<void> = Promise.resolve(),
): AsyncGenerator<Uint8Array> {
  yield* parts;
  await then;
}

/** 全部読む */
async function readAll(
  source: AsyncGenerator<Uint8Array>,
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of source) out.push(chunk);
  return out;
}

/**
 * **字幕があるかは ffmpeg を起こす前に PMT で分かる** (`peekCaptions`)。無い放送に字幕の出口を頼むと
 * ffmpeg は入口を探り終えてから降り、起こし直すぶん映像が遅れる
 */
describe("PMT で字幕の本数を見る", () => {
  test("字幕の部品タグを持つ ES を数える", () => {
    const pmt = (streams: ([number, number] | [number, number, number[]])[]) =>
      programMap(SERVICE, VIDEO_PID, [[0x02, VIDEO_PID], ...streams]);
    expect(captionStreams(pmt([]))).toBe(0);
    expect(captionStreams(pmt([[0x06, 0x130, captionDescriptors()]]))).toBe(1);
    // 言語が複数ある放送は ES が2本
    expect(
      captionStreams(
        pmt([
          [0x06, 0x130, captionDescriptors(0x30)],
          [0x06, 0x131, captionDescriptors(0x31)],
        ]),
      ),
    ).toBe(2);
    // ワンセグの字幕
    expect(captionStreams(pmt([[0x06, 0x130, [0x52, 0x01, 0x87]]]))).toBe(1);
  });

  test("文字スーパーやデータ放送は数えない", () => {
    const pmt = programMap(SERVICE, VIDEO_PID, [
      [0x02, VIDEO_PID],
      // 文字スーパー (ffmpeg は字幕とみなさない)
      [0x06, 0x138, captionDescriptors(0x38)],
      // 部品タグの無い private_data
      [0x06, 0x139],
      // データ放送 (同じタグでも stream_type が違う)
      [0x0d, 0x140, [0x52, 0x01, 0x30]],
    ]);
    expect(captionStreams(pmt)).toBe(0);
  });

  test("TS を少しずつ食わせて、その局の PMT を読めたら本数を返す", () => {
    const ts = head([[0x06, 0x130, captionDescriptors()]]);
    const counter = new CaptionCount(SERVICE);
    // パケットの切れ目と関係なく割って届く
    expect(counter.feed(ts.subarray(0, 100))).toBeNull();
    expect(counter.feed(ts.subarray(100, 300))).toBeNull();
    expect(counter.feed(ts.subarray(300))).toBe(1);
  });

  test("ほかの局の PMT では決めない", () => {
    expect(new CaptionCount(SERVICE + 1).feed(head([]))).toBeNull();
  });

  test("字幕が無い PMT なら 0、読んだ塊はそのまま出てくる", async () => {
    const video = packetize(VIDEO_PID, new Uint8Array(10));
    const ts = head([]);
    const parts = [video, ts.subarray(0, 200), ts.subarray(200), video];
    const peeked = await peekCaptions(chunksOf(parts), SERVICE, 1_000);
    expect(peeked.count).toBe(0);
    expect(await readAll(peeked.stream)).toEqual(parts);
  });

  test("字幕があれば本数", async () => {
    const parts = [head([[0x06, 0x130, captionDescriptors()]])];
    const peeked = await peekCaptions(chunksOf(parts), SERVICE, 1_000);
    expect(peeked.count).toBe(1);
    expect(await readAll(peeked.stream)).toEqual(parts);
  });

  test("PMT が来なければ待ちきって null、読みかけも捨てない", async () => {
    const video = packetize(VIDEO_PID, new Uint8Array(10));
    let late!: () => void;
    const then = new Promise<void>((resolve) => (late = resolve));
    const source = (async function* () {
      yield video;
      await then;
      // 待ちきったあとに届く1つ目。返すストリームから出てこないといけない
      yield video;
    })();
    const peeked = await peekCaptions(source, SERVICE, 50);
    expect(peeked.count).toBeNull();
    late();
    expect(await readAll(peeked.stream)).toEqual([video, video]);
  });

  test("先に尽きたら null", async () => {
    const parts = [packetize(VIDEO_PID, new Uint8Array(10))];
    const peeked = await peekCaptions(chunksOf(parts), SERVICE, 1_000);
    expect(peeked.count).toBeNull();
    expect(await readAll(peeked.stream)).toEqual(parts);
  });

  test("転んだら、返すストリームを読んだ側に届く", async () => {
    const source = (async function* (): AsyncGenerator<Uint8Array> {
      yield packetize(VIDEO_PID, new Uint8Array(10));
      throw new Error("切れた");
    })();
    const peeked = await peekCaptions(source, SERVICE, 1_000);
    expect(peeked.count).toBeNull();
    await expect(readAll(peeked.stream)).rejects.toThrow("切れた");
  });

  test("塊が届くたびに知らせる", async () => {
    let seen = 0;
    const parts = [packetize(VIDEO_PID, new Uint8Array(10)), head([])];
    await peekCaptions(chunksOf(parts), SERVICE, 1_000, () => seen++);
    expect(seen).toBe(2);
  });
});

/**
 * **放送が字幕を持っているかは、1枚も来ていなくても分かる。**
 *
 * ffmpeg が入口で読んだストリーム一覧に出ている。届いてから画面に切り替えを
 * 出していた頃は、間隔の空く番組を開くとボタンが出なかった (実機の
 * 「みんなの手話」。番組表には [字] と出ているのに)。
 */
describe("TrackList", () => {
  /** 実機の T26 (Eテレ) がそのまま出したもの */
  const etv = [
    "  Program 1032 ",
    "  Stream #0:0[0x100]: Video: mpeg2video (Main), 1440x1080, 29.97 fps",
    "  Stream #0:1[0x110]: Audio: aac (LC), 48000 Hz, stereo",
    "  Stream #0:2[0x130]: Subtitle: arib_caption (Profile A), 1920x1080",
    "  Stream #0:3[0x138]: Data: bin_data",
    "  Program 1033 ",
    "  Stream #0:4[0x101]: Video: mpeg2video (Main), 1440x1080, 29.97 fps",
    "  Stream #0:5[0x131]: Subtitle: arib_caption (Profile A), 1920x1080",
  ];

  test("選んだ局の字幕だけ数える", () => {
    const list = new TrackList(1032);
    for (const line of etv) list.feed(line);
    expect(list.tracks).toHaveLength(1);
    expect(list.tracks[0]).toMatchObject({ index: 0, label: "字幕" });
  });

  /** ほかの局の字幕を数えると、選べないものが一覧に並ぶ */
  test("別の局の字幕は数えない", () => {
    const list = new TrackList(1033);
    for (const line of etv) list.feed(line);
    expect(list.tracks).toHaveLength(1);
  });

  /** **言語が複数ある放送はたまにある。** そのときは2本以上になる */
  test("言語が複数あれば、その数だけ出す", () => {
    const list = new TrackList(1024);
    for (const line of [
      "  Program 1024 ",
      "  Stream #0:1[0x110](jpn): Audio: aac (LC), 48000 Hz, stereo",
      "  Stream #0:2[0x130](jpn): Subtitle: arib_caption (Profile A), 1920x1080",
      "  Stream #0:3[0x131](eng): Subtitle: arib_caption (Profile A), 1920x1080",
    ]) {
      list.feed(line);
    }
    expect(list.tracks.map((t) => t.label)).toEqual([
      "字幕 (日本語)",
      "字幕2 (英語)",
    ]);
    expect(list.tracks.map((t) => t.index)).toEqual([0, 1]);
  });

  test("字幕を持たない局では空", () => {
    const list = new TrackList(1416);
    for (const line of etv) list.feed(line);
    expect(list.tracks).toHaveLength(0);
  });

  /** 増えたときだけ true。毎行で知らせると画面が無駄に描き直される */
  test("増えたときだけ知らせる", () => {
    const list = new TrackList(1032);
    expect(list.feed("  Program 1032 ")).toBe(false);
    expect(list.feed("  Stream #0:0[0x100]: Video: mpeg2video (Main)")).toBe(
      false,
    );
    expect(
      list.feed("  Stream #0:2[0x130]: Subtitle: arib_caption (Profile A)"),
    ).toBe(true);
  });
});

/**
 * **放送の欠けにいちいち言われるぶんは残さない。**
 *
 * 選べる字幕を入口の見出しから読み取るために `-loglevel` を info まで開けたので、
 * デコーダの「直した」「捨てた」がそのまま流れてくるようになった。実機の弱い局
 * では毎秒何行も出て、**本当の失敗がその中に埋もれる**。
 */
describe("worthLogging", () => {
  /** 実機の T15 / T26 がそのまま出したもの */
  test("放送の欠けは残さない", () => {
    for (const line of [
      "[live] [mpeg2video @ 0x1] concealing 3150 DC, 3150 AC, 3150 MV errors in I frame",
      "[aist#0:2/aac @ 0x1] [dec:aac @ 0x2] Error submitting packet to decoder: Invalid data found when processing input",
      "[vist#0:1/mpeg2video @ 0x1] [dec:mpeg2video @ 0x2] Decode error rate 1 exceeds maximum 0.666667",
      "    Last message repeated 13 times",
    ]) {
      expect(worthLogging(line), line).toBe(false);
    }
  });

  /** 本当にエンコードできないときは残す。ここが消えると「映像が出ない」としか分からない */
  test("組み立てやエンコーダの失敗は残す", () => {
    for (const line of [
      "Failed to set value '0:p:24632:v:0' for option 'map': Invalid argument",
      "Error binding filtergraph inputs/outputs: Invalid argument",
      "[libsvtav1 @ 0x1] Error initializing the encoder",
      "Error opening output files: Invalid argument",
    ]) {
      expect(worthLogging(line), line).toBe(true);
    }
  });

  /** 入口の見出しはただの説明。全部残すと選局のたびに数十行積まれる */
  test("入口の説明は残さない", () => {
    expect(worthLogging("  Stream #0:2[0x130]: Subtitle: arib_caption")).toBe(
      false,
    );
    expect(worthLogging("Input #0, mpegts, from 'pipe:0':")).toBe(false);
  });
});

describe("アプリ向けの字幕 API", () => {
  const json = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));

  /** WebSocket の1フレームの頭に、後ろの長さを足しただけ (受け側の読み方を1つにする) */
  test("フレームは [4:長さ][1:種別][8:時刻][中身]", () => {
    const out = appFrame(
      CHANNEL.captionText,
      0x1_2345_6789n,
      new Uint8Array([1, 2, 3]),
    );
    const view = new DataView(out.buffer);
    expect(out.length).toBe(4 + 1 + 8 + 3);
    expect(view.getUint32(0)).toBe(1 + 8 + 3);
    expect(view.getUint8(4)).toBe(0x22);
    expect(view.getBigUint64(5)).toBe(0x1_2345_6789n);
    expect([...out.subarray(13)]).toEqual([1, 2, 3]);
  });

  test("字幕と、選べる字幕の通知だけを通す", async () => {
    const stream = captionFeed((out) => {
      out.send(CHANNEL.rawTs, 0n, new Uint8Array(188));
      out.send(
        CHANNEL.control,
        0n,
        json({ type: "clock", at: 1, unixMs: 2, now: 3 }),
      );
      out.send(
        CHANNEL.control,
        0n,
        json({ type: "captions", tracks: [], track: 0 }),
      );
      out.send(CHANNEL.captionText, 90_000n, new Uint8Array([9]));
      out.send(CHANNEL.data, 0n, json({}));
      out.close();
      return () => {};
    });
    const body = new Uint8Array(await new Response(stream).arrayBuffer());
    const kinds: number[] = [];
    for (
      let at = 0;
      at < body.length;
      at += 4 + new DataView(body.buffer).getUint32(at)
    )
      kinds.push(body[at + 4]!);
    expect(kinds).toEqual([CHANNEL.control, CHANNEL.captionText]);
  });

  // 映像が終わった (セッションが畳まれた・エンコードできなくなった) ら、字幕 API も閉じる
  test("ended / error の通知で閉じて後始末する", async () => {
    for (const type of ["ended", "error"]) {
      let left = 0;
      let send:
        ((kind: number, pts: bigint, payload: Uint8Array) => void) | null =
        null;
      const stream = captionFeed((out) => {
        send = out.send;
        return () => left++;
      });
      send!(CHANNEL.control, 0n, json({ type, message: "" }));
      expect(await new Response(stream).arrayBuffer()).toBeDefined();
      expect(left, type).toBe(1);
    }
  });

  test("受け側が閉じたら後始末する", async () => {
    let left = 0;
    const stream = captionFeed(() => () => left++);
    await stream.cancel();
    expect(left).toBe(1);
  });

  // 共有したそばから閉じた (共有する相手がもう畳まれていた) ときも、後始末を取りこぼさない
  test("作っている最中に閉じても後始末する", () => {
    let left = 0;
    captionFeed((out) => {
      out.close();
      return () => left++;
    });
    expect(left).toBe(1);
  });

  test("待ってもらう量は閉じる量より小さい", () => {
    expect(CAPTION_FEED_HOLD).toBeLessThan(CAPTION_FEED_BACKLOG);
  });

  // 録画の字幕は、受け側が読まなくなったら録画を読むのも止める (`recordingCaptions`)
  test("読まれずに溜まったら待ってほしいと言う", () => {
    let out: CaptionOut | null = null;
    const stream = captionFeed((given) => {
      out = given;
      return () => {};
    });
    expect(out!.backedUp()).toBe(false);
    const page = new Uint8Array(512 * 1024);
    for (let i = 0; i < CAPTION_FEED_HOLD / page.length + 2; i++)
      out!.send(CHANNEL.captionText, 0n, page);
    expect(out!.backedUp()).toBe(true);
    void stream.cancel();
  });

  test("読まないまま溜まったら閉じる", () => {
    let left = 0;
    let send:
      ((kind: number, pts: bigint, payload: Uint8Array) => void) | null = null;
    captionFeed((out) => {
      send = out.send;
      return () => left++;
    });
    const page = new Uint8Array(1024 * 1024);
    for (let i = 0; i < CAPTION_FEED_BACKLOG / page.length + 2; i++)
      send!(CHANNEL.captionText, 0n, page);
    expect(left).toBe(1);
  });
});

/**
 * **録画の字幕を文字の配置で渡す** (`captions.json`)。新しくエンコードした録画には放送の字幕が
 * そのまま (`S_ARIBSUB`) 入っている。ずっと前にエンコードした録画は画像 (PGS) のことがあり、それは読まない (null。字幕なし)
 */
describe("pagesFromMkv", () => {
  test("S_ARIBSUB をデコードして、時刻 (秒) と1枚ずつに", () => {
    const pages = pagesFromMkv(
      mkv([
        [0, management()],
        [1500, text(encodeAribText("字幕"))],
        [4000, text([0x0c])],
      ]),
    );
    expect(pages?.v).toBe(1);
    expect(
      pages?.pages.map((p) => [p.at, p.page.runs.map((r) => r.text).join("")]),
    ).toEqual([
      [1.5, "字幕"],
      [4, ""],
    ]);
  });

  test("画像の字幕 (PGS) なら null", () => {
    expect(
      pagesFromMkv(mkv([[0, Uint8Array.of(0x50, 0x47)]], "S_HDMV/PGS")),
    ).toBeNull();
  });
});

describe("textFrame", () => {
  test("時刻は 90kHz、中身は JSON", () => {
    const page = {
      v: 1 as const,
      plane: [960, 540] as [number, number],
      duration: null,
      runs: [],
    };
    const { kind, pts, data } = textFrame({ at: 1500, page });
    expect(kind).toBe(CHANNEL.captionText);
    expect(pts).toBe(135_000n);
    expect(JSON.parse(new TextDecoder().decode(data))).toEqual(page);
  });

  /*
   * **いつ出すかを添える。** 映像と同じ ffmpeg が付けた mp4 の物差しなので、
   * 受け側は再生位置と直に比べられる。
   *
   * 添えずに「届いた時点の再生位置」に置いていた頃は、エンコードする手間のぶん字幕の
   * ほうが先に届くぶんだけ早く出ていた。その量を測って足し引きしようとして
   * 3回外している (docs/stream.md#時刻同期) — 別々の ffmpeg では測れなかった
   */
  test("時刻は丸めて添える", () => {
    const page = {
      v: 1 as const,
      plane: [960, 540] as [number, number],
      duration: null,
      runs: [],
    };
    expect(textFrame({ at: 0, page }).pts).toBe(0n);
    expect(textFrame({ at: 1500.4, page }).pts).toBe(135_036n);
  });
});

/**
 * **字幕1本に言語が複数ある放送。** 全部の言語をデコードして、言語の番号を付けて出す。どれを誰に出すかは
 * 使う側が決める (ライブは視聴者ごと、録画は `others`)
 */
describe("字幕の言語", () => {
  const words = (page: { runs: { text: string }[] }) =>
    page.runs.map((r) => r.text).join("");
  const frame = (at: number, data: Uint8Array) => ({ at, data });

  test("載っている言語を全部デコードし、言語の番号を付けて出す", () => {
    const text = new CaptionText();
    text.feed(frame(0, management({ languages: ["jpn", "eng"] })));
    expect(text.languagesChanged).toBe(true);
    expect(text.languages.map((l) => l.label)).toEqual(["日本語", "英語"]);
    expect(
      text
        .feed(frame(1000, text_(1, "にほんご")))
        .map((s) => [s.language, words(s.page)]),
    ).toEqual([[1, "にほんご"]]);
    expect(
      text
        .feed(frame(1000, text_(2, "えいご")))
        .map((s) => [s.language, words(s.page)]),
    ).toEqual([[2, "えいご"]]);
    expect(text.languagesChanged).toBe(false);
  });

  test("言語が1つなら今までどおり第1言語だけ", () => {
    const text = new CaptionText();
    text.feed(frame(0, management()));
    expect(text.languages.map((l) => l.index)).toEqual([1]);
    expect(
      text.feed(frame(1000, text_(1, "じまく"))).map((s) => s.language),
    ).toEqual([1]);
  });

  test("録画は第1言語を pages に、第2言語から後ろを others に", () => {
    const pages = pagesFromMkv(
      mkv([
        [0, management({ languages: ["jpn", "eng"] })],
        [1500, text_(1, "にほんご")],
        [1500, text_(2, "えいご")],
      ]),
    );
    expect(pages?.language).toEqual({ index: 1, code: "jpn", label: "日本語" });
    expect(pages?.pages.map((p) => words(p.page))).toEqual(["にほんご"]);
    expect(
      pages?.others?.map((o) => [
        o.index,
        o.label,
        o.pages.map((p) => words(p.page)).at(-1),
      ]),
    ).toEqual([[2, "英語", "えいご"]]);
  });

  test("言語が1つの録画には others を付けない (今までと同じ形)", () => {
    const pages = pagesFromMkv(
      mkv([
        [0, management()],
        [1500, text_(1, "じまく")],
      ]),
    );
    expect(pages?.others).toBeUndefined();
  });
});

/** 第 `language` 言語の本文1つ */
function text_(language: number, body: string): Uint8Array {
  return text(encodeAribText(body), language);
}
