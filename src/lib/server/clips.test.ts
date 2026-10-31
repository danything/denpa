import { beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import type { Clip } from "../clips";

/**
 * 切り抜き (`clips.ts`)。DB と置き場は一時ファイルへ向ける。ffmpeg は偽物 (受けた画像を写すだけ) で、
 * 本物が入っていれば本物でも AVIF にできるかを見る (合成の映像だけを使う)
 */
const { config } = await import("./config");
const root = mkdtempSync(join(tmpdir(), "denpa-clips-"));
config.dbPath = join(root, "denpa.db");
config.encodedDir = join(root, "encoded");
config.startMargin = 0;

const { orm } = await import("./db");
const { clips, programs, recordings, services } = await import("./schema");
const {
  avifArgs,
  checkImage,
  checkParts,
  clipImage,
  clipSrcDir,
  ClipError,
  clipCountsByRecording,
  clipFacets,
  countClips,
  clipFile,
  clipPath,
  clipsDir,
  deleteClips,
  findClips,
  imageInfo,
  liveScene,
  readClipForm,
  recordingScene,
  saveClip,
  sceneTime,
  setClipLayers,
} = await import("./clips");
const { deleteRecordingFiles } = await import("./files");
const { CLIP_BYTES_MOST, CLIP_PAGE } = await import("../clips");

/**
 * 偽 ffmpeg。`-f avif` の次の名前へ、最初の入力 (映像) を写す (`tests/fake/ffmpeg.sh` と同じ振る舞い)。
 * 入力 (`-i`) は1回ぶんずつ `inputs` に残す (重ねを渡したかを見る)。どれかの入力に BROKEN があれば落ちる
 */
const fake = join(root, "ffmpeg.sh");
const inputsLog = join(root, "inputs");
writeFileSync(
  fake,
  `#!/bin/sh
input=""; prev=""; all=""
for a in "$@"; do
  if [ "$prev" = "-i" ]; then
    [ -z "$input" ] && input="$a"
    all="$all $(basename "$a")"
    grep -q BROKEN "$a" && exit 1
  fi
  [ "$prev" = "avif" ] && cp "$input" "$a"
  prev="$a"
done
echo "$all" >> "${inputsLog}"
exit 0
`,
);
chmodSync(fake, 0o755);
config.ffmpeg = fake;

/** 合成の PNG の頭 (縦横だけ読めればよい) */
function png(
  width: number,
  height: number,
  tail = "",
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33 + tail.length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set(new TextEncoder().encode(tail), 33);
  return bytes;
}

const SERVICE = 3273601024; // serviceKey(32736, 1024)
const NETWORK = Math.floor(SERVICE / 100000);
const SID = SERVICE % 100000;
const START = new Date(2026, 9, 30, 21, 0).getTime();

function seed(): void {
  orm().delete(clips).run();
  orm().delete(programs).run();
  orm().delete(recordings).run();
  orm().delete(services).run();
  orm()
    .insert(services)
    .values({
      id: SERVICE,
      service_id: SID,
      network_id: NETWORK,
      name: "でんぱテレビ",
      type: "GR",
      channel: "T20",
      updated_at: 0,
    })
    .run();
  orm()
    .insert(programs)
    .values({
      id: SERVICE * 100000 + 77,
      service_id: SERVICE,
      network_id: NETWORK,
      event_id: 77,
      start_at: START,
      end_at: START + 3600_000,
      name: "夜のニュース",
      updated_at: 0,
    })
    .run();
}

beforeEach(seed);

describe("画像の形式と縦横を中身から読む", () => {
  test("PNG", () => {
    expect(imageInfo(png(1920, 1080))).toEqual({
      type: "png",
      width: 1920,
      height: 1080,
    });
  });

  test("JPEG は SOF まで区切りを辿る", () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(imageInfo(bytes)).toEqual({
      type: "jpeg",
      width: 1920,
      height: 1080,
    });
  });

  test("WebP (VP8・VP8L・VP8X)", () => {
    const riff = (chunk: string, body: number[]) => {
      const bytes = new Uint8Array(40);
      bytes.set(new TextEncoder().encode(`RIFF\0\0\0\0WEBP${chunk}`), 0);
      bytes.set(body, 16);
      return bytes;
    };
    // VP8: 26 バイト目から 14 ビットずつ
    expect(
      imageInfo(riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80, 7, 0x38, 4])),
    ).toEqual({ type: "webp", width: 1920, height: 1080 });
    // VP8L: 0x2f の次に 14 ビットずつ (1 を引いた値)
    const w = 1919;
    const h = 1079;
    expect(
      imageInfo(
        riff("VP8L", [
          0,
          0,
          0,
          0,
          0x2f,
          w & 0xff,
          ((w >> 8) & 0x3f) | ((h & 3) << 6),
          (h >> 2) & 0xff,
          (h >> 10) & 0x0f,
        ]),
      ),
    ).toEqual({ type: "webp", width: 1920, height: 1080 });
    // VP8X: 24 バイト目から 24 ビットずつ (1 を引いた値)
    expect(
      imageInfo(
        riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0x7f, 0x07, 0, 0x37, 0x04, 0]),
      ),
    ).toEqual({ type: "webp", width: 1920, height: 1080 });
  });

  test("ほかの形式は読まない", () => {
    expect(imageInfo(new TextEncoder().encode("GIF89a........"))).toBeNull();
    expect(imageInfo(new Uint8Array())).toBeNull();
  });
});

describe("受ける画像の確かめ", () => {
  const status = (bytes: Uint8Array): number => {
    try {
      checkImage(bytes);
      return 200;
    } catch (error) {
      return error instanceof ClipError ? error.status : 500;
    }
  };

  test("上限を超えると 413、読めない形式は 415", () => {
    const big = png(1920, 1080, "x".repeat(CLIP_BYTES_MOST));
    expect(status(big)).toBe(413);
    expect(status(new TextEncoder().encode("<svg></svg>"))).toBe(415);
    expect(status(png(1920, 1080))).toBe(200);
  });

  test("縦横が小さすぎるものは 415、大きすぎるものは 413", () => {
    expect(status(png(32, 32))).toBe(415);
    expect(status(png(10000, 1080))).toBe(413);
  });
});

test("AVIF の引数: SVT-AV1 の静止画を2枚、メタデータは書かない", () => {
  const args = avifArgs("in.webp", [], "full.avif", "small.avif");
  expect(args).toContain("libsvtav1");
  expect(args.join(" ")).toContain("-map_metadata -1");
  expect(args.filter((arg) => arg === "avif")).toHaveLength(2);
  expect(args.join(" ")).toContain("min(480,trunc(iw/2)*2)");
  expect(args.at(-1)).toBe("small.avif");
});

describe("撮った場所から番組を引く", () => {
  test("ライブ: 局と放送時刻から番組表を引き、始めからの位置を出す", () => {
    const scene = liveScene(SERVICE, START + 600_000);
    expect(scene).toMatchObject({
      place: "live",
      recording_id: null,
      service_name: "でんぱテレビ",
      event_id: 77,
      program_name: "夜のニュース",
      program_start_at: START,
      offset_ms: 600_000,
    });
  });

  test("ライブ: 同じ番組を録っていれば、その録画を付ける", () => {
    const id = orm()
      .insert(recordings)
      .values({
        program_id: SERVICE * 100000 + 77,
        service_id: SERVICE,
        name: "夜のニュース",
        start_at: START,
        end_at: START + 3600_000,
        created_at: 0,
        updated_at: 0,
      })
      .returning()
      .get().id;
    expect(liveScene(SERVICE, START + 1000).recording_id).toBe(id);
  });

  test("ライブ: 番組表に無い時刻なら番組の情報は空", () => {
    expect(liveScene(SERVICE, START - 1000)).toMatchObject({
      event_id: null,
      program_name: "",
      offset_ms: null,
      service_name: "でんぱテレビ",
    });
  });

  test("録画: 観ているものの物差しから、番組の始めからの位置にする (CM を切ったもの)", () => {
    const recording = orm()
      .insert(recordings)
      .values({
        program_id: SERVICE * 100000 + 77,
        service_id: SERVICE,
        service_name: "でんぱテレビ",
        name: "夜のニュース",
        start_at: START,
        end_at: START + 3600_000,
        // TS の頭は番組の 5 秒前。100〜160 秒の CM を切ってエンコードした
        ts_head: START - 5000,
        library_path: join(config.encodedDir, "x.mkv"),
        cm_kept: [
          { start: 0, end: 100 },
          { start: 160, end: 3605 },
        ],
        created_at: 0,
        updated_at: 0,
      })
      .returning()
      .get();
    // エンコードしたものの 120 秒 = TS の 180 秒 = 番組の 175 秒
    const scene = recordingScene(recording, "watch", 120, "encoded");
    expect(scene).toMatchObject({
      place: "watch",
      recording_id: recording.id,
      event_id: 77,
      offset_ms: 175_000,
    });
    // 戻すと同じ場面
    expect(sceneTime(recording, 175_000)).toBeCloseTo(120);
    // 元の TS で観ていたなら物差しはそのまま
    expect(recordingScene(recording, "chase", 180, "ts").offset_ms).toBe(
      175_000,
    );
  });
});

/** 1枚置く (偽 ffmpeg) */
async function put(
  name: string,
  captions = "",
  service = SERVICE,
): Promise<number> {
  return (
    await saveClip(
      { frame: png(1920, 1080) },
      {
        ...liveScene(SERVICE, START + 1000),
        program_name: name,
        service_id: service,
      },
      captions,
    )
  ).id;
}

describe("置く・探す・消す", () => {
  test("AVIF にして置き場の年月の下へ。行に縦横と大きさ", async () => {
    const clip = await saveClip(
      { frame: png(1920, 1080) },
      liveScene(SERVICE, START + 1000),
      "  こんばんは\n７時の  ニュースです ",
    );
    expect(clip).toMatchObject({
      programName: "夜のニュース",
      serviceName: "でんぱテレビ",
      captions: "こんばんは ７時の ニュースです",
      width: 1920,
      height: 1080,
    });
    const row = orm().select().from(clips).get()!;
    expect(row.file).toMatch(/^\d{4}-\d{2}\/\d+\.avif$/);
    expect(existsSync(clipPath(row.file))).toBe(true);
    expect(existsSync(clipPath(row.file, true))).toBe(true);
    expect(row.bytes).toBe(33 * 2);
    // 作業ファイルは残さない
    expect(readdirSync(join(clipsDir(), ".work"))).toEqual([]);
  });

  test("ffmpeg が読めなければ 415 で、行も画像も残さない", async () => {
    const promise = saveClip(
      { frame: png(1920, 1080, "BROKEN") },
      liveScene(SERVICE, START),
      "",
    );
    expect(promise).rejects.toMatchObject({ status: 415 });
    await promise.catch(() => undefined);
    expect(orm().select().from(clips).all()).toEqual([]);
    expect(readdirSync(join(clipsDir(), ".work"))).toEqual([]);
  });

  test("言葉は空白で区切った語をすべて含むもの (番組名・局名・字幕。全角半角を揃える)", async () => {
    const a = await put("夜のニュース", "台風が近づいています");
    const b = await put("朝のニュース", "晴れるでしょう");
    await put("ドラマ", "");
    const ids = (q: string) => findClips({ q }).clips.map((clip) => clip.id);
    expect(ids("ニュース")).toEqual([b, a]);
    expect(ids("ニュース 台風")).toEqual([a]);
    expect(ids("でんぱ ドラマ").length).toBe(1);
    expect(ids("ＮＥＷＳ")).toEqual([]);
    expect(ids("台風　夜")).toEqual([a]);
  });

  test("局・ライブか録画か・日付で絞る", async () => {
    const live = await put("A");
    const other = await put("B", "", SERVICE + 1);
    orm().update(clips).set({ place: "watch" }).run();
    orm().update(clips).set({ place: "live" }).where(eq(clips.id, live)).run();
    expect(findClips({ kind: "live" }).clips.map((c) => c.id)).toEqual([live]);
    expect(findClips({ kind: "recorded" }).clips.map((c) => c.id)).toEqual([
      other,
    ]);
    expect(findClips({ service: SERVICE + 1 }).clips.map((c) => c.id)).toEqual([
      other,
    ]);
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(findClips({ day }).clips).toHaveLength(2);
    expect(findClips({ day: "2000-01-01" }).clips).toHaveLength(0);
    expect(clipFacets()).toMatchObject({
      count: 2,
      days: [{ day, count: 2 }],
    });
  });

  test(`${CLIP_PAGE} 件ずつ。続きは前のページの最後の ID より古いもの`, async () => {
    for (let i = 0; i < CLIP_PAGE + 5; i++) await put(`番組${i}`);
    const first = findClips({});
    expect(first.clips).toHaveLength(CLIP_PAGE);
    expect(first.next).toBe(first.clips.at(-1)!.id);
    const second = findClips({ before: first.next! });
    expect(second.clips).toHaveLength(5);
    expect(second.next).toBeNull();
    expect(second.clips[0]!.id).toBeLessThan(first.next!);
  });

  test("置き場へ移せなければ、行を残さない", async () => {
    rmSync(clipsDir(), { recursive: true, force: true });
    // 年月のフォルダの名前にファイルを置いて、移せないようにする
    const month = join(clipsDir(), clipFile(1, Date.now()).split("/")[0]!);
    mkdirSync(clipsDir(), { recursive: true });
    writeFileSync(month, "");
    try {
      const promise = saveClip(
        { frame: png(1920, 1080) },
        liveScene(SERVICE, START),
        "",
      );
      expect(promise).rejects.toThrow();
      await promise.catch(() => undefined);
      expect(orm().select().from(clips).all()).toEqual([]);
    } finally {
      rmSync(month, { force: true });
    }
  });

  test("落ちて残った古い作業ファイルは、次に置くときに片付ける", async () => {
    const work = join(clipsDir(), ".work");
    mkdirSync(work, { recursive: true });
    const left = join(work, "left.webp");
    writeFileSync(left, "x");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(left, old, old);
    await put("A");
    expect(existsSync(left)).toBe(false);
  });

  test("当たる枚数と、録画ごとの枚数 (検索の結果・録画の詳細)", async () => {
    await put("夜のニュース");
    await put("朝のニュース");
    await put("ドラマ");
    orm().update(clips).set({ recording_id: 7 }).run();
    expect(countClips({ q: "ニュース" })).toBe(2);
    expect(countClips({ q: "どこにも無い" })).toBe(0);
    expect(clipCountsByRecording()).toEqual({ 7: 3 });
  });

  test("消すと画像も消える。もう無いものは数えない", async () => {
    const id = await put("A");
    const file = orm().select().from(clips).get()!.file;
    expect(deleteClips([id, 9999])).toBe(1);
    expect(existsSync(clipPath(file))).toBe(false);
    expect(existsSync(clipPath(file, true))).toBe(false);
    expect(deleteClips([id])).toBe(0);
  });

  test("録画を消しても切り抜きは残り、録画への行き先だけ外れる", async () => {
    const recording = orm()
      .insert(recordings)
      .values({
        program_id: SERVICE * 100000 + 77,
        service_id: SERVICE,
        name: "夜のニュース",
        start_at: START,
        end_at: START + 3600_000,
        finished_at: START + 3600_000,
        created_at: 0,
        updated_at: 0,
      })
      .returning()
      .get();
    await saveClip(
      { frame: png(1920, 1080) },
      recordingScene(recording, "watch", 10, "ts"),
      "",
    );
    expect(findClips({}).clips[0]!.recordingId).toBe(recording.id);
    deleteRecordingFiles(recording, "手動削除");
    const [clip] = findClips({}).clips;
    expect(clip).toMatchObject({
      recordingId: null,
      programName: "夜のニュース",
    });
  });
});

describe("字幕・コメントを分けて受ける", () => {
  const status = (run: () => unknown): number => {
    try {
      run();
      return 200;
    } catch (error) {
      return error instanceof ClipError ? error.status : 500;
    }
  };
  /** 合成の JPEG の頭 (SOF0 まで) */
  const jpeg = (width: number, height: number): Uint8Array =>
    new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xc0,
      0,
      17,
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      ...Array<number>(12).fill(0),
    ]);
  /** 最後の ffmpeg に渡した入力の名前 */
  const lastInputs = (): string[] =>
    readFileSync(inputsLog, "utf8")
      .trim()
      .split("\n")
      .at(-1)!
      .trim()
      .split(" ");

  test("重ねは映像と同じ縦横の PNG だけ", () => {
    const frame = jpeg(1920, 1080);
    expect(status(() => checkParts({ frame, captions: png(1920, 1080) }))).toBe(
      200,
    );
    expect(
      status(() => checkParts({ frame, comments: jpeg(1920, 1080) })),
    ).toBe(415);
    expect(status(() => checkParts({ frame, captions: png(1280, 720) }))).toBe(
      400,
    );
    const big = png(1920, 1080, "x".repeat(CLIP_BYTES_MOST));
    expect(status(() => checkParts({ frame, captions: big }))).toBe(413);
  });

  test("multipart から読む。映像が無い・文字の部分は 400、知らない名前は読み捨てる", async () => {
    const form = new FormData();
    form.append("frame", new Blob([png(1920, 1080)]), "frame.png");
    form.append("comments", new Blob([png(1920, 1080, "c")]), "comments.png");
    form.append("other", "x");
    const parts = await readClipForm(form);
    expect(parts.frame.length).toBe(33);
    expect(parts.comments?.length).toBe(34);
    expect(parts.captions).toBeUndefined();

    const empty = new FormData();
    empty.append("captions", new Blob([png(1920, 1080)]));
    expect(readClipForm(empty)).rejects.toMatchObject({ status: 400 });
    const text = new FormData();
    text.append("frame", "画像ではない");
    expect(readClipForm(text)).rejects.toMatchObject({ status: 400 });
  });

  test("AVIF の引数: 重ねは下から順に RGB で重ねてから2枚に分ける", () => {
    const graphOf = (args: string[]) =>
      args[args.indexOf("-filter_complex") + 1]!;
    const args = avifArgs(
      "frame.webp",
      ["comments.png", "captions.png"],
      "full.avif",
      "small.avif",
    );
    const inputs = args.flatMap((arg, i) =>
      args[i - 1] === "-i" ? [arg] : [],
    );
    expect(inputs).toEqual(["frame.webp", "comments.png", "captions.png"]);
    expect(graphOf(args)).toStartWith(
      "[0:v:0][1:v:0]overlay=format=rgb[l1];[l1][2:v:0]overlay=format=rgb[l2];[l2]split[a][b];",
    );
    // 重ねなければ今までどおり
    expect(graphOf(avifArgs("in.webp", [], "f.avif", "s.avif"))).toStartWith(
      "[0:v:0]split[a][b];",
    );
  });

  test("元の画像を残し、受けた重ねをすべて重ねる。重ねの無いものは元を残さない", async () => {
    const clip = await saveClip(
      {
        frame: png(1920, 1080),
        captions: png(1920, 1080, "captions"),
        comments: png(1920, 1080, "comments"),
      },
      liveScene(SERVICE, START),
      "",
    );
    expect(clip.layers).toEqual({ comments: true, captions: true });
    // 重ねる順は映像 → コメント → 字幕
    expect(lastInputs()).toEqual(["frame.png", "comments.png", "captions.png"]);
    const row = orm().select().from(clips).get()!;
    const src = clipSrcDir(row.file);
    expect(src).toEndWith(`${row.id}.src`);
    expect(readdirSync(src).sort()).toEqual([
      "captions.png",
      "comments.png",
      "frame.png",
    ]);
    // 大きさは AVIF の2枚と元の3枚
    expect(row.bytes).toBe(33 * 2 + 33 + 41 + 41);
    expect(readdirSync(join(clipsDir(), ".work"))).toEqual([]);

    const plain = await saveClip(
      { frame: png(1920, 1080) },
      liveScene(SERVICE, START),
      "",
    );
    expect(plain.layers).toEqual({});
    const plainRow = orm()
      .select()
      .from(clips)
      .where(eq(clips.id, plain.id))
      .get()!;
    expect(existsSync(clipSrcDir(plainRow.file))).toBe(false);
  });

  test("出し入れは元から重ね直し、行と大きさを書き換える。変わらなければ作り直さない", async () => {
    const saved = await saveClip(
      {
        frame: jpeg(1920, 1080),
        captions: png(1920, 1080, "captions"),
        comments: png(1920, 1080, "comments"),
      },
      liveScene(SERVICE, START),
      "",
    );
    const off = await setClipLayers(saved.id, { captions: false });
    expect(off.layers).toEqual({ comments: true, captions: false });
    expect(lastInputs()).toEqual(["frame.jpeg", "comments.png"]);
    // AVIF の2枚 (偽物は映像を写す) と元の3枚
    expect(off.bytes).toBe(23 * 2 + 23 + 41 + 41);

    const runs = readFileSync(inputsLog, "utf8").split("\n").length;
    expect((await setClipLayers(saved.id, { captions: false })).layers).toEqual(
      { comments: true, captions: false },
    );
    expect(readFileSync(inputsLog, "utf8").split("\n").length).toBe(runs);

    const both = await setClipLayers(saved.id, {
      captions: true,
      comments: false,
    });
    expect(both.layers).toEqual({ comments: false, captions: true });
    expect(lastInputs()).toEqual(["frame.jpeg", "captions.png"]);
    expect(findClips({}).clips[0]!.layers).toEqual({
      comments: false,
      captions: true,
    });
  });

  test("持っていない重ねは 400、作れなければ 500 で前のまま、消したものは 404", async () => {
    const old = await saveClip(
      { frame: png(1920, 1080) },
      liveScene(SERVICE, START),
      "",
    );
    expect(setClipLayers(old.id, { captions: false })).rejects.toMatchObject({
      status: 400,
    });
    const onlyCaptions = await saveClip(
      { frame: png(1920, 1080), captions: png(1920, 1080, "c") },
      liveScene(SERVICE, START),
      "",
    );
    expect(
      setClipLayers(onlyCaptions.id, { comments: true }),
    ).rejects.toMatchObject({ status: 400 });

    // 元の映像が壊れていて重ね直せない (偽 ffmpeg は BROKEN で落ちる)
    const file = orm()
      .select()
      .from(clips)
      .where(eq(clips.id, onlyCaptions.id))
      .get()!.file;
    writeFileSync(
      join(clipSrcDir(file), "frame.png"),
      png(1920, 1080, "BROKEN"),
    );
    const failed = setClipLayers(onlyCaptions.id, { captions: false });
    expect(failed).rejects.toMatchObject({ status: 500 });
    await failed.catch(() => undefined);
    expect(
      findClips({}).clips.find((c) => c.id === onlyCaptions.id)!.layers,
    ).toEqual({ captions: true });

    deleteClips([onlyCaptions.id]);
    expect(existsSync(clipSrcDir(file))).toBe(false);
    expect(
      setClipLayers(onlyCaptions.id, { captions: false }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("画像を端末に持たせるのは、中身が替わらないときだけ", async () => {
    const layered = await saveClip(
      { frame: png(1920, 1080), captions: png(1920, 1080, "c") },
      liveScene(SERVICE, START),
      "",
    );
    const plain = await saveClip(
      { frame: png(1920, 1080) },
      liveScene(SERVICE, START),
      "",
    );
    const rows = orm().select().from(clips).all();
    const cache = (clip: Clip, version: string | null) =>
      clipImage(
        { ...clip, file: rows.find((row) => row.id === clip.id)!.file },
        false,
        version,
      ).headers.get("cache-control");
    expect(cache(layered, "-1")).toBe("private, max-age=86400");
    expect(cache(layered, null)).toBe("private, no-cache");
    expect(cache(layered, "-0")).toBe("private, no-cache");
    expect(cache(plain, null)).toBe("private, max-age=86400");
  });
});

/** 本物の ffmpeg (合成の映像) で AVIF にできるか。入っていない所 (CI の単体) では飛ばす */
const real = Bun.which("ffmpeg");
test.skipIf(real === null)(
  "本物の ffmpeg: 合成の1コマを AVIF と一覧用 (幅 480) にする",
  async () => {
    config.ffmpeg = real!;
    try {
      const input = join(root, "frame.png");
      const made = Bun.spawnSync([
        real!,
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=1280x720",
        "-frames:v",
        "1",
        "-y",
        input,
      ]);
      expect(made.exitCode).toBe(0);
      const image = new Uint8Array(readFileSync(input));
      if (image.length > CLIP_BYTES_MOST) return;
      const clip = await saveClip(
        { frame: image },
        liveScene(SERVICE, START),
        "",
      );
      const file = orm().select().from(clips).get()!.file;
      const head = readFileSync(clipPath(file)).subarray(4, 12).toString();
      expect(head).toBe("ftypavif");
      expect(clip.width).toBe(1280);
      const probe = Bun.spawnSync([
        Bun.which("ffprobe") ?? "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=width",
        "-of",
        "csv=p=0",
        clipPath(file, true),
      ]);
      expect(probe.stdout.toString().trim()).toBe("480");
    } finally {
      config.ffmpeg = fake;
    }
  },
  60_000,
);

/** 本物の ffmpeg で重ね、出し入れで重ね直せるか。重ねは半分透けた赤の1枚 (合成)。真ん中の1画素の赤みで見る */
test.skipIf(real === null)(
  "本物の ffmpeg: 透明な PNG を重ね、外すと元の映像に戻る",
  async () => {
    config.ffmpeg = real!;
    const make = (source: string, out: string): Uint8Array => {
      const made = Bun.spawnSync([
        real!,
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        source,
        "-frames:v",
        "1",
        "-y",
        join(root, out),
      ]);
      expect(made.exitCode).toBe(0);
      return new Uint8Array(readFileSync(join(root, out)));
    };
    /** 真ん中の1画素 (RGB) */
    const center = (path: string): number[] => {
      const out = Bun.spawnSync([
        real!,
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        "crop=2:2,scale=1:1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ]);
      return [...out.stdout];
    };
    try {
      const frame = make("color=c=0x2060a0:s=640x360", "gray.png");
      const layer = make("color=c=red@0.5:s=640x360,format=rgba", "layer.png");
      const clip = await saveClip(
        { frame, captions: layer },
        liveScene(SERVICE, START),
        "",
      );
      const file = orm().select().from(clips).get()!.file;
      const [onRed, , onBlue] = center(clipPath(file));
      await setClipLayers(clip.id, { captions: false });
      const [offRed, , offBlue] = center(clipPath(file));
      expect(onRed! - offRed!).toBeGreaterThan(60);
      expect(offBlue! - onBlue!).toBeGreaterThan(40);
      // 外したものは元の色 (0x20, 0x60, 0xa0) のまま
      expect(Math.abs(offRed! - 0x20)).toBeLessThan(12);
      expect(Math.abs(offBlue! - 0xa0)).toBeLessThan(12);
    } finally {
      config.ffmpeg = fake;
    }
  },
  60_000,
);
