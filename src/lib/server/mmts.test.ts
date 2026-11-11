import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concatBytes } from "@danything/arib/bytes";
import { MmtServiceFilter } from "@danything/arib/mmt-service-filter";
import { MPU_MS, SynthMmtAv } from "@danything/arib/synth-mmt-av";

import { readFragment, readInit } from "#lib/ts/fmp4.js";

import {
  mmtsCaptions,
  mmtsFmp4,
  mmtsOffset,
  probeMmts,
  remuxMmts,
} from "./mmts";
import { mmtsTranscodeArgs } from "./playback";

const SERVICE = 301;
const START = Date.UTC(2026, 10, 11, 12, 0, 0);
/** 1 MPU (8 コマ) の長さ (90 kHz) */
const MPU = 12012;

const dir = mkdtempSync(join(tmpdir(), "denpa-mmts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * 4K の局の録画を作る。偽の放送と同じ素材 (`tests/fake/broadcast.ts` の `broadcastTlv`) を `count` MPU ぶん流し、
 * 録画と同じく 1 局に絞って (`MmtServiceFilter`) 書く (`recorder.ts`)
 */
function record(name: string, count: number, caption?: string): string {
  const av = new SynthMmtAv({
    serviceId: SERVICE,
    mptPacketId: 0x9000,
    startMs: START,
    ...(caption === undefined ? {} : { caption }),
  });
  const filter = new MmtServiceFilter(SERVICE);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) parts.push(filter.filter(av.next()));
  const path = join(dir, name);
  writeFileSync(path, concatBytes(parts));
  return path;
}

async function probe(path: string) {
  const { size, mtimeMs } = statSync(path);
  return (await probeMmts(path, size, `${size}:${mtimeMs}`, SERVICE))!;
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: Uint8Array[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/** fMP4 の media のうち、映像のトラックの最初の DTS (90 kHz) */
function videoDts(init: Uint8Array, media: Uint8Array): number | undefined {
  return readFragment(media, readInit(init)).find((s) => s.track === 1)?.dts;
}

/**
 * **4K の局の録画 (`.mmts`) を読む** (`mmts.ts`)。偽の放送と同じ本物の HEVC と AAC を MMT/TLV に包んだもの
 * (`@danything/arib/synth-mmt-av`) を録画と同じく 1 局に絞って書き、物差し・詰め替え・字幕を確かめる
 */
describe("4K の局の録画", () => {
  test("先頭と尺を測る。先頭は最初の頭出しできるコマの DTS で、尺は最後の映像のコマまで", async () => {
    const file = await probe(record("span.mmts", 60));
    expect(file.head).toBeGreaterThan(0);
    // 60 MPU (約 8 秒) のうち、最後のコマまで
    expect(file.duration).toBeGreaterThan((59 * MPU_MS) / 1000 - 0.2);
    expect(file.duration).toBeLessThan((60 * MPU_MS) / 1000 + 0.2);
  });

  test("先頭から詰め替えると、init のあと時刻 0 から MPU ごとの断片が続く", async () => {
    const path = record("head.mmts", 20);
    const file = await probe(path);
    const [init, ...media] = await collect(mmtsFmp4(file, SERVICE, 0));
    expect(readInit(init!).map((t) => t.kind)).toEqual(["video", "audio"]);
    expect(videoDts(init!, media[0]!)).toBe(0);
    expect(videoDts(init!, media[1]!)).toBe(MPU);
    // 終わりまで読んだら、溜めていたぶんも出して閉じる
    expect(media.length).toBeGreaterThanOrEqual(19);
  });

  test("途中から読んでも、時刻は録画の物差しのまま (バイト比例で当たりを付ける)", async () => {
    const path = record("seek.mmts", 60);
    const file = await probe(path);
    const offset = mmtsOffset(file, 5);
    expect(offset).toBeGreaterThan(0);
    const [init, first] = await collect(mmtsFmp4(file, SERVICE, offset));
    const dts = videoDts(init!, first!)!;
    // 求めた 5 秒の手前 (1 秒) から読むので、4 秒の近くの頭出しできるコマから始まる。MPU の境目に乗る
    expect(dts % MPU).toBe(0);
    expect(dts / 90_000).toBeGreaterThan(3);
    expect(dts / 90_000).toBeLessThan(5);
  });

  test("字幕は物差しの秒で全部読む", async () => {
    const file = await probe(record("caption.mmts", 40, "録画の字幕"));
    const { pages } = await mmtsCaptions(file, SERVICE);
    const shown = pages.filter((p) => p.page.runs.length > 0);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0]!.page.runs.map((r) => r.text).join("")).toBe("録画の字幕");
    // 最初の文書は映像の最初の MPU と同じ時刻 (先頭のコマの DTS より、B ピクチャのずれぶん後ろ)
    expect(shown[0]!.at).toBeGreaterThan(0);
    expect(shown[0]!.at).toBeLessThan(0.1);
  });

  test("エンコードの前に MP4 に詰め替え、字幕を返す。読めるものが無ければ書かない", async () => {
    const target = join(dir, "remux.mp4");
    const done = await remuxMmts(
      record("remux.mmts", 40, "字幕"),
      SERVICE,
      target,
    );
    expect(done.wrote).toBe(true);
    expect(done.scrambled).toBe(0);
    expect(statSync(target).size).toBeGreaterThan(0);
    expect(done.captions.some((c) => c.page.runs.length > 0)).toBe(true);

    const empty = join(dir, "empty.mmts");
    writeFileSync(empty, new Uint8Array(0));
    expect((await remuxMmts(empty, SERVICE, join(dir, "none.mp4"))).wrote).toBe(
      false,
    );
  });
});

/** 本物の ffprobe で、詰め替えた MP4 を読めるか (エンコードは ffmpeg がこれを読む)。入っていない所 (CI の単体) では飛ばす */
const ffprobe = Bun.which("ffprobe");
test.skipIf(ffprobe === null)(
  "本物の ffprobe: 詰め替えた MP4 の映像・音声と尺を読む",
  async () => {
    const target = join(dir, "probe.mp4");
    await remuxMmts(record("probe.mmts", 60), SERVICE, target);
    const done = Bun.spawnSync([
      ffprobe!,
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name:format=duration",
      "-of",
      "json",
      target,
    ]);
    expect(done.exitCode).toBe(0);
    const json = JSON.parse(done.stdout.toString()) as {
      streams: { codec_name: string }[];
      format: { duration: string };
    };
    expect(json.streams.map((s) => s.codec_name)).toEqual(["hevc", "aac"]);
    expect(Number(json.format.duration)).toBeGreaterThan(7);
  },
);

/** 本物の ffmpeg で、途中から詰め替えたものを変換しても、時刻が録画の物差しのまま運ばれるか (`playback.mmtsTranscodeArgs`) */
const ffmpeg = Bun.which("ffmpeg");
test.skipIf(ffmpeg === null || ffprobe === null)(
  "本物の ffmpeg: 途中から変換しても、出したものの時刻は録画の物差しのまま",
  async () => {
    const file = await probe(record("transcode.mmts", 60));
    const offset = mmtsOffset(file, 5);
    const input = concatBytes(await collect(mmtsFmp4(file, SERVICE, offset)));
    const first = videoDtsOf(input) / 90_000;
    const output = join(dir, "transcode.mp4");
    const proc = Bun.spawn(
      [ffmpeg!, ...mmtsTranscodeArgs("h264", null, 0).slice(0, -1), output],
      { stdin: "pipe", stderr: "pipe" },
    );
    proc.stdin.write(input);
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    const done = Bun.spawnSync([
      ffprobe!,
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=start_time,height",
      "-of",
      "json",
      output,
    ]);
    const stream = (
      JSON.parse(done.stdout.toString()) as {
        streams: { start_time: string; height: number }[];
      }
    ).streams[0]!;
    // 縮めて SDR にした 1080p。始まりは詰め替えた fMP4 の最初のコマ (B ピクチャのずれぶんの差まで)
    expect(stream.height).toBe(1080);
    expect(Math.abs(Number(stream.start_time) - first)).toBeLessThan(0.1);
  },
  60_000,
);

/** 詰め替えた fMP4 (init のあとに media が並んだもの) の最初の映像の DTS (90 kHz) */
function videoDtsOf(data: Uint8Array): number {
  const tracks = readInit(data);
  return readFragment(data, tracks).find((s) => s.track === 1)!.dts;
}
