import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concatBytes } from "@danything/arib/bytes";
import { CLOCK, MmtMediaReader } from "@danything/arib/mmt-media";
import {
  compressedIp,
  mfuPackets,
  mptTable,
  mpuExtendedTimestampDescriptor,
  mpuTimestampDescriptor,
  paMessage,
  signalingPackets,
} from "@danything/arib/synth-mmt";

import { readFragment, readInit } from "../ts/fmp4";
import { nalType, parseSps } from "./hevc";
import { type Fmp4Segment, MmtFmp4 } from "./mmt";

/**
 * 本物の ffmpeg が作った HEVC と AAC を MMT で包み (`synth-mmt.ts`)、取り出して fMP4 にする。
 *
 * - 映像: `testsrc2` の 64x64・59.94 コマ・16 コマを libx265 で HEVC Main10 にしたもの
 *   (keyint 8・B ピクチャ 3・閉じた GOP・AUD と VPS/SPS/PPS をキーフレームごとに)。`-f hevc` の Annex B
 * - 音声: 440 Hz の正弦波を AAC LC (48 kHz・2 チャンネル) にした 13 フレームを `-f latm` (LOAS) で書いたもの
 *
 * どちらも 1 つの mp4 から書き出した。そのときの映像の PTS と DTS (180000 の単位、デコードの順) が `VIDEO_TIMES`
 */
const HEVC =
  "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" +
  "4MItf9xhrMpA";
const LOAS =
  "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" +
  "JEAAAAAAAAAAAAAA4AA=";

/** ffprobe が読んだ映像の [PTS, DTS] (180000 の単位、デコードの順) */
const VIDEO_TIMES: [number, number][] = [
  [0, -6006],
  [9009, -3003],
  [6006, 0],
  [3003, 3003],
  [21021, 6006],
  [15015, 9009],
  [12012, 12012],
  [18018, 15015],
  [24024, 18018],
  [33033, 21021],
  [30030, 24024],
  [27027, 27027],
  [45045, 30030],
  [39039, 33033],
  [36036, 36036],
  [42042, 39039],
];
const GOP = 8;
const AUDIO_FRAMES = 13;
const AUDIO_PER_MPU = 4;

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, "base64"));

/** Annex B を NAL ユニットに切り、AUD (35) ごとにコマにまとめる */
function pictures(annexB: Uint8Array): Uint8Array[][] {
  const starts: number[] = [];
  for (let i = 0; i + 3 <= annexB.length; i++)
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1)
      starts.push(i + 3);
  const nals = starts.map((start, k) => {
    let end = k + 1 < starts.length ? starts[k + 1]! - 3 : annexB.length;
    while (end > start && annexB[end - 1] === 0) end--;
    return annexB.subarray(start, end);
  });
  const out: Uint8Array[][] = [];
  for (const nal of nals) {
    if (nalType(nal) === 35 || out.length === 0) out.push([]);
    out.at(-1)!.push(nal);
  }
  return out;
}

/** LOAS の同期のヘッダー (11 ビットの 0x2B7 と 13 ビットの長さ) を外し、AudioMuxElement を並べる */
function audioMuxElements(loas: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at + 3 <= loas.length;) {
    expect((loas[at]! << 3) | (loas[at + 1]! >> 5)).toBe(0x2b7);
    const length = ((loas[at + 1]! & 0x1f) << 8) | loas[at + 2]!;
    out.push(loas.subarray(at + 3, at + 3 + length));
    at += 3 + length;
  }
  return out;
}

const be32 = (n: number) => [
  n >>> 24,
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
];
const SERVICE = 0xa1;
const VIDEO = 0xf100;
const AUDIO = 0xf110;
/** 映像の最初の MPU の、最初の提示時刻 (NTP の秒) */
const SECONDS = 0xee9e4b21;

/** ffmpeg の素材を、1 局の TLV のバイト列にする */
function tlv(): Uint8Array {
  const video = pictures(bytes(HEVC));
  const audio = audioMuxElements(bytes(LOAS));
  expect(video).toHaveLength(VIDEO_TIMES.length);
  expect(audio).toHaveLength(AUDIO_FRAMES);

  // 180000 の単位で、映像の PTS 0 が NTP の SECONDS ちょうど
  const ntp = (ticks: number): [number, number] => {
    const whole = Math.floor(ticks / 180000);
    return [
      SECONDS + whole,
      Math.round(((ticks - whole * 180000) / 180000) * 2 ** 32),
    ];
  };
  const videoMpus = [0, 1].map((m) => {
    const times = VIDEO_TIMES.slice(m * GOP, (m + 1) * GOP);
    const first = Math.min(...times.map(([pts]) => pts));
    return {
      sequence: 100 + m,
      presentation: ntp(first),
      decodingOffset: first - times[0]![1],
      dtsPtsOffsets: times.map(([pts, dts]) => pts - dts),
    };
  });
  // 音声は映像の PTS 0 から 1024 サンプルずつ (180000 の単位で 3840)
  const audioMpus = Array.from(
    { length: Math.ceil(AUDIO_FRAMES / AUDIO_PER_MPU) },
    (_, m) => ({
      sequence: 200 + m,
      presentation: ntp(m * AUDIO_PER_MPU * 3840),
      decodingOffset: 0,
      dtsPtsOffsets: new Array(
        Math.min(AUDIO_PER_MPU, AUDIO_FRAMES - m * AUDIO_PER_MPU),
      ).fill(0),
    }),
  );
  const mpt = mptTable({
    packageId: SERVICE,
    assets: [
      {
        type: "hev1",
        packetId: VIDEO,
        descriptors: [
          ...mpuTimestampDescriptor(
            videoMpus.map((m) => [m.sequence, m.presentation]),
          ),
          ...mpuExtendedTimestampDescriptor(180000, videoMpus, 3003),
        ],
      },
      {
        type: "mp4a",
        packetId: AUDIO,
        descriptors: [
          ...mpuTimestampDescriptor(
            audioMpus.map((m) => [m.sequence, m.presentation]),
          ),
          ...mpuExtendedTimestampDescriptor(180000, audioMpus, 3840),
        ],
      },
    ],
  });

  const packets: Uint8Array[] = [...signalingPackets(0xff01, [paMessage(mpt)])];
  const sequence = { [VIDEO]: 0, [AUDIO]: 0 };
  const send = (made: Uint8Array[], packetId: typeof VIDEO | typeof AUDIO) => {
    packets.push(...made);
    sequence[packetId] += made.length;
  };
  // 音声は映像の 1 コマごとに 1 フレームほどを挟む (実機と同じく、届く順は混ざる)
  let nextAudio = 0;
  video.forEach((nals, i) => {
    const mpu = 100 + Math.floor(i / GOP);
    const sample = i % GOP;
    // スライスの手前の小さな NAL ユニットは集約、スライスは分割して送る
    const slices = nals.filter((n) => nalType(n) < 32);
    const small = nals.filter((n) => nalType(n) >= 32);
    const unit = (nal: Uint8Array) => ({
      sample,
      data: [...be32(nal.length), ...nal],
    });
    send(
      mfuPackets(VIDEO, mpu, small.map(unit), {
        aggregate: true,
        rap: sample === 0,
        sequenceNumber: sequence[VIDEO],
      }),
      VIDEO,
    );
    send(
      mfuPackets(VIDEO, mpu, slices.map(unit), {
        fragment: 100,
        sequenceNumber: sequence[VIDEO],
      }),
      VIDEO,
    );
    if (nextAudio < AUDIO_FRAMES) {
      const a = nextAudio++;
      send(
        mfuPackets(
          AUDIO,
          200 + Math.floor(a / AUDIO_PER_MPU),
          [{ sample: a % AUDIO_PER_MPU, data: audio[a]! }],
          {
            sequenceNumber: sequence[AUDIO],
          },
        ),
        AUDIO,
      );
    }
  });
  return concatBytes(packets.map((p) => compressedIp(1, p)));
}

/**
 * 映像の [PTS, DTS] (90 kHz) が、ffmpeg の付けた時刻 (180000 の単位) を半分にしたものと合う。最初の DTS (-6006) が 0。
 * 180000 の奇数は 90 kHz の端数になるので、0.5 までの違いは許す
 */
function expectVideoTimes(times: (number | undefined)[][]): void {
  expect(times).toHaveLength(VIDEO_TIMES.length);
  times.forEach(([pts = NaN, dts = NaN], i) => {
    const [wantPts, wantDts] = VIDEO_TIMES[i]!;
    expect(Math.abs(pts - (wantPts + 6006) / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(dts - (wantDts + 6006) / 2)).toBeLessThanOrEqual(0.5);
  });
}

/** TLV を読んで fMP4 にする。最後に溜まっているぶんも出す */
function remux(data: Uint8Array): { segments: Fmp4Segment[]; muxer: MmtFmp4 } {
  const reader = new MmtMediaReader(SERVICE);
  let muxer: MmtFmp4 | null = null;
  const segments: Fmp4Segment[] = [];
  // 細かく切って渡す (TLV のパケットの途中で切れる)
  for (let at = 0; at < data.length; at += 1000)
    for (const event of reader.feed(data.subarray(at, at + 1000))) {
      if (event.kind === "assets") muxer = new MmtFmp4(event.assets);
      else if (event.kind !== "caption") segments.push(...muxer!.push(event));
    }
  for (const unit of reader.end())
    if (unit.kind !== "caption") segments.push(...muxer!.push(unit));
  expect(reader.dropped + reader.untimed + reader.scrambled).toBe(0);
  segments.push(...muxer!.flush());
  return { segments, muxer: muxer! };
}

describe("MmtFmp4 (ffmpeg の HEVC と AAC)", () => {
  const { segments, muxer } = remux(tlv());

  test("init を 1 つ出し、映像の MPU ごとに media を出す", () => {
    expect(segments.map((s) => s.kind)).toEqual(["init", "media", "media"]);
  });

  test("init の映像と音声の設定", () => {
    const tracks = readInit(segments[0]!.data);
    expect(tracks.map((t) => [t.kind, t.codec, t.width, t.height])).toEqual([
      ["video", "hev1.2.4.L30.90", 64, 64],
      ["audio", "mp4a.40.2", 0, 0],
    ]);
    expect(tracks.every((t) => t.timescale === CLOCK)).toBe(true);
    expect([...tracks[1]!.config]).toEqual([0x11, 0x90]);
  });

  test("SPS から 10 ビットと大きさを読む", () => {
    const sps = pictures(bytes(HEVC))[0]!.find((n) => nalType(n) === 33)!;
    expect(parseSps(sps)).toMatchObject({
      width: 64,
      height: 64,
      chromaFormat: 1,
      bitDepthLuma: 10,
      bitDepthChroma: 10,
    });
  });

  test("時刻 0 は最初のキーフレームの DTS で、映像の PTS・DTS は ffmpeg が付けたものと同じ", () => {
    const tracks = readInit(segments[0]!.data);
    const samples = segments
      .slice(1)
      .flatMap((s) => readFragment(s.data, tracks));
    const video = samples.filter((s) => s.track === 1);
    // 180000 の単位から 90 kHz へ。最初の DTS (-6006) が 0
    expectVideoTimes(video.map((s) => [s.pts, s.dts]));
    expect(video.map((s) => s.key)).toEqual(
      VIDEO_TIMES.map((_, i) => i % GOP === 0),
    );
    expect(muxer.origin).toBe(SECONDS * CLOCK - 3003);
    const audio = samples.filter((s) => s.track === 2);
    expect(audio.map((s) => s.dts)).toEqual(
      Array.from({ length: AUDIO_FRAMES }, (_, i) => 3003 + i * 1920),
    );
    expect(audio.every((s) => s.duration === 1920)).toBe(true);
  });
});

/** 本物の ffprobe で、組んだ fMP4 を読めるか。入っていない所 (CI の単体) では飛ばす */
const ffprobe = Bun.which("ffprobe");
test.skipIf(ffprobe === null)(
  "本物の ffprobe: 組んだ fMP4 を読み、映像と音声の時刻が合う",
  () => {
    const { segments } = remux(tlv());
    const dir = mkdtempSync(join(tmpdir(), "mmt-fmp4-"));
    try {
      const file = join(dir, "out.mp4");
      writeFileSync(file, concatBytes(segments.map((s) => s.data)));
      const run = (...args: string[]) => {
        const done = Bun.spawnSync([ffprobe!, "-v", "error", ...args, file]);
        expect(done.stderr.toString()).toBe("");
        return done.stdout.toString().trim();
      };
      expect(
        run(
          "-show_entries",
          "stream=codec_name,width,height,pix_fmt,sample_rate,channels",
          "-of",
          "csv=p=0",
        ),
      ).toBe("hevc,64,64,yuv420p10le\naac,48000,2");
      const packets = run(
        "-show_entries",
        "packet=stream_index,pts,dts",
        "-of",
        "csv=p=0",
      )
        .split("\n")
        .map((line) => line.split(",").map(Number));
      const video = packets
        .filter(([index]) => index === 0)
        .map(([, pts, dts]) => [pts, dts]);
      expectVideoTimes(video);
      const audio = packets
        .filter(([index]) => index === 1)
        .map(([, pts]) => pts);
      expect(audio).toEqual(
        Array.from({ length: AUDIO_FRAMES }, (_, i) => 3003 + i * 1920),
      );
      // 標準入力 (パイプ) で渡しても、ffmpeg が読んで最後までデコードできる (ライブと録画のエンコードはこの形で渡す)
      const ffmpeg = Bun.which("ffmpeg");
      if (ffmpeg !== null) {
        const decoded = Bun.spawnSync({
          cmd: [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "mp4",
            "-i",
            "pipe:0",
            "-f",
            "framecrc",
            "-",
          ],
          stdin: Bun.file(file),
        });
        expect(decoded.stderr.toString()).toBe("");
        expect(decoded.exitCode).toBe(0);
        const frames = decoded.stdout
          .toString()
          .split("\n")
          .filter((l) => /^\d/.test(l));
        expect(frames.filter((l) => l.startsWith("0,"))).toHaveLength(
          VIDEO_TIMES.length,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
