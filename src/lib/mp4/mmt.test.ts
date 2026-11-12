import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concatBytes } from "@danything/arib/bytes";
import {
  type AudioUnit,
  CLOCK,
  type MediaAsset,
  MmtMediaReader,
  type VideoUnit,
} from "@danything/arib/mmt-media";
import {
  compressedIp,
  mfuPackets,
  mptTable,
  mpuExtendedTimestampDescriptor,
  mpuTimestampDescriptor,
  paMessage,
  signalingPackets,
} from "@danything/arib/synth-mmt";
import {
  AUDIO_FRAMES,
  base64Bytes,
  GOP,
  HEVC,
  hevcPictures,
  latmElements,
  LOAS,
  VIDEO_TIMES,
} from "@danything/arib/synth-mmt-av";

import { readFragment, readInit } from "../ts/fmp4";
import { nalType, parseSps } from "./hevc";
import { type Fmp4Segment, MmtFmp4 } from "./mmt";

/**
 * 本物の ffmpeg が作った HEVC と AAC (`@danything/arib/synth-mmt-av` の素材) を MMT で包み (`synth-mmt.ts`)、取り出して fMP4 にする。
 * 素材の映像の PTS と DTS (180000 の単位、デコードの順) が `VIDEO_TIMES`
 */
const AUDIO_PER_MPU = 4;

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
  const video = hevcPictures(base64Bytes(HEVC));
  const audio = latmElements(base64Bytes(LOAS));
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
      ["video", "hvc1.2.4.L30.90", 64, 64],
      ["audio", "mp4a.40.2", 0, 0],
    ]);
    expect(tracks.every((t) => t.timescale === CLOCK)).toBe(true);
    expect([...tracks[1]!.config]).toEqual([0x11, 0x90]);
  });

  /*
   * `hvc1` はパラメータセットを `hvcC` にだけ置く。放送はコマの中にも送ってくるので、同じものはサンプルから外す
   */
  test("VPS・SPS・PPS は hvcC にだけ置き、サンプルから外す", () => {
    const sets = hevcPictures(base64Bytes(HEVC))[0]!.filter((n) =>
      [32, 33, 34].includes(nalType(n)),
    );
    expect(sets.length).toBeGreaterThanOrEqual(3);
    const contains = (data: Uint8Array, part: Uint8Array) =>
      Buffer.from(data).indexOf(Buffer.from(part)) >= 0;
    for (const set of sets) {
      expect(contains(segments[0]!.data, set)).toBe(true);
      for (const media of segments.slice(1))
        expect(contains(media.data, set)).toBe(false);
    }
    expect(muxer.parametersChanged).toBe(false);
  });

  test("SPS から 10 ビットと大きさを読む", () => {
    const sps = hevcPictures(base64Bytes(HEVC))[0]!.find(
      (n) => nalType(n) === 33,
    )!;
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

  test("音声の設定より先に映像の MPU が終わったら、次の頭出しできるコマから始め直し、そこを時刻 0 にする", () => {
    const reader = new MmtMediaReader(SERVICE);
    const units: (VideoUnit | AudioUnit)[] = [];
    let assets: MediaAsset[] = [];
    for (const event of [...reader.feed(tlv()), ...reader.end()]) {
      if (event.kind === "assets") assets = event.assets;
      else if (event.kind !== "caption") units.push(event);
    }
    // 最初の MPU の映像と、次の MPU の最初のコマを、音声より前に渡す
    const first = units.filter(
      (u) => u.kind === "video" && u.mpuSequenceNumber === 100,
    );
    first.push(
      units.find((u) => u.kind === "video" && u.mpuSequenceNumber === 101)!,
    );
    const muxer = new MmtFmp4(assets);
    const out = [...first, ...units.filter((u) => !first.includes(u))].flatMap(
      (u) => muxer.push(u),
    );
    out.push(...muxer.flush());
    expect(out.map((s) => s.kind)).toEqual(["init", "media"]);
    const tracks = readInit(out[0]!.data);
    const samples = readFragment(out[1]!.data, tracks);
    const video = samples.filter((s) => s.track === 1);
    expect(video).toHaveLength(GOP);
    expect(video[0]!.dts).toBe(0);
    expect(video[0]!.key).toBe(true);
    // 2 つ目の MPU の最初の DTS (18018 / 180000 秒)
    expect(muxer.origin).toBe(SECONDS * CLOCK - 3003 + (18018 + 6006) / 2);
    expect(samples.filter((s) => s.track === 2).every((s) => s.dts >= 0)).toBe(
      true,
    );
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
