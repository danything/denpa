/**
 * **本物の HEVC と AAC を MMT/TLV に包んで、4K の局の放送を作る** (試験用。`synth-av.ts` の 4K 版)。
 *
 * 素材は ffmpeg で作り、ここに base64 で持つ (E2E のイメージには本物の ffmpeg が無い)。
 *
 * - 映像: `testsrc2` の 64x64・59.94 コマ・16 コマを libx265 で HEVC Main10 にしたもの
 *   (keyint 8・B ピクチャ 3・閉じた GOP・AUD と VPS/SPS/PPS をキーフレームごとに)。`-f hevc` の Annex B
 * - 音声: 440 Hz の正弦波を AAC LC (48 kHz・2 チャンネル) にした 13 フレームを `-f latm` (LOAS) で書いたもの
 *
 * どちらも 1 つの mp4 から書き出した。そのときの映像の PTS と DTS (180000 の単位、デコードの順) が `VIDEO_TIMES`。
 * `SynthMmtAv` は映像の GOP (8 コマ) を 1 つの MPU にして繰り返し、時刻と番号を進めながら流し続ける
 * (偽エージェントの 4K の局。`tests/fake/broadcast.ts`)
 */

import { concatBytes } from "./bytes.js";
import {
  compressedIp,
  mfuPackets,
  mptTable,
  mpuExtendedTimestampDescriptor,
  mpuTimestampDescriptor,
  paMessage,
  signalingPackets,
  type SynthNtp,
} from "./synth-mmt.js";

/** 映像の素材 (HEVC Main10 の Annex B。base64) */
export const HEVC =
  "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" +
  "4MItf9xhrMpA";
/** 音声の素材 (AAC LC の LOAS。base64) */
export const LOAS =
  "VuCHIAARkB/kBvAQAmMLsxmxiXGJyXGJgYgCEoD///8AUlJR2mIOieyvGtevpckuRaQ5Ikn1cAQLJq2nY7Ix35jUYLRTDkJQ2htL" +
  "AwMDAwMDAwMbBgYGRIkRs2bBgZEiRGzZs2iRIpZZYoooooooqQb6bw6J7K8a16+lyS5FpDkiSLgAAAAAAAOAVuDf7pClNn8Pw/D8" +
  "JiyV2WS6sl1ZTpv9/OrbnEv1/0/fzrXF61/T/p+/nWuNXfr/6fjrjWtasbU7NuueeYM7YUnhIlFCl/fyfgiWKhgwboH0oV9KB9Pp" +
  "QYD6fTXQB9PpQYD6fTXroMAPp9Po3A2DgiDAkMjDqQMy77jmFI3YpEIYmfKJnyiZ8vlETB8vlETB8vlx4sHy5vlFFEAOPyf4kgAE" +
  "qHLCfgPOLOBISEhIScCTgSEhISlamB2wd8HfB3xv9/OrbfEnr/p+/nWg5/6fv51oOP/p+OuNAAAAAAAAAADgAFbgebuQvGf///gA" +
  "SjGKOmEOlK/b+v41rjzxOpwaS5HJa6nkgDpxxmgqyxvb4+PhvP7+8L/x8N5/f30H+PjMn394R8fDYz+/oen4bsdEaQxzlBvpxDoR" +
  "GV+39fxrXHnidTg0lyOS11HDLAAAAAAAAmStd2JwAkTdV6kMrgBW4Hu8kIxn///4AD7ByQKNEQdGItEIh/r/9P9/9viVd3l5Uvd8" +
  "6edzlvd3FAJzPxK92gB6OLe4zGiiiKJESC48olailRCBdIWnCw8gWQghVcoPsUs0RgtjIVPo30Xh0fi0XiH+v/0/3/2+JV3eXlS9" +
  "3zp525bLgAAAAAAADgBW4IbCEIxn///4ADrR0hoxHoRDoxCzx+3/8X3//G5JM1VJJfJ9OVJamCOsKrEqo1D4o16WzP5CUqYJCQkJ" +
  "wmWtcy14Tu67JHewsgmeuvy4bHzzoQ7LTvE4TjSFJowlmSy1m5rTRhY6jfR+PQ+HR+Fnj9v/4vv/+NySZqqSS+T6ciFAAAAAAAAO" +
  "AFbgjMUQjGf///kAO9HKGiIOiEehEbK/8f8fj/7St9KSmpvjmPm5zMlVlwSMkxoq7mSLzgf4nUDtqMn2c08885556lEEeoBSRACs" +
  "kDkMa1jj4nxxQGlc7Tc1BOUbImKs6by8VQpVOkE5oQzncb6IQ6Lx6Hxsr/x/x+P/tK30pKam+OY+bnMFAAAAAAAAAHAAVuCTyJCM" +
  "Z///+QA52kmILRCHRKHQqHRiFPn9v/2+//t7XuS0czqu+j+veVpSmBihcI125I7ZeMRx9J0qU1iFmmI/3pee0s0vScksvWAE0PMT" +
  "7YgMuc73/0ctxZTdIWXTpwqDVcC8AYtU24UrwIbTmN9EIdF4dD4dH4U+f2//b7/+3te5LRzOq76P695QUAAAAAAAAA4AVuCczRCM" +
  "Z///+YA52dIaIzaEQ6EQn2/r/2/f/rq86oRl6yuH7O7c3e91QTKj6whbdBuO4zsY2/preh9WGGjPSPHsIF5zOvG7g7wLdxBKRbzW" +
  "F99DH3T8aunBdpxh1kb6XYcS3ta8GulcjIRla9aJZrWn2BggsL2ISOY30Qi8mh8Oh8J9v6/9v3/66vOqEZesrh+zuw2oAAAAAAAA" +
  "ADgAVuCZy5CMZ///+0A42dEiVBaExaFQ6Ew6Vm//j/j/b/Pmd645mq9dayRAN8ZHKUCyc1Wzoa8eJBSMNmRH5D3mpl3ZfJ0SIz9z" +
  "0FLLKbNg8slSGLnU7cy91r99dxPbXRLmHqvsD5vWzU21fh1xCOY7l9nTq4jfQiLQiHQ+HSs3/8f8f7f58zvXHM1XrrWSIBvjIJQA" +
  "AAAAAAAAADgAVuCezhCMZ///+EA42pG6RSaMQq5/8f+n+//lM9uZCXlqzT/vmGXVNjcWxdFdu5S7dMp5zdr1GNt7JTFAWKmUQnVI" +
  "TMEiQmO0qJnHBOa46L4XblF7c75jf8beT9N/t6UyX2d0zbnFuDhTd9JIW0m5m5tgLjhWrTXRTx5CGWriN9IIfHo/Crn/x/6f7/+U" +
  "z25kJeWrNP++YFUAAAAAAAAAcABW4KTREIxn///5wDrZyYhNEIkJoVDoRCZ/f/6ff/14VrLXhd0Py8XKrcrsOWFSX4T3/PDPsfkP" +
  "q3vgbjM/V6znnOqcbD80y/UAJnCqW1GrHlua06oY5naifOW1jdZLY+zNCHxpl0Ugz3159hE72+4hn4Gvk9nvY50ygdjhcQ5UC5DE" +
  "dRvohH49D4dD4TP7//T7/+vCtZa8Luh+XixtQAAAAAAAAAADgFbgqNMQjGf///lAOdHRAmYWiUOhIWhUOiUSc/+P/T8f/fVV7bjz" +
  "6rSZ1j+1nLFqqwin2zsfAeroZQ8f0ba46ORTI1fifwNGjF3cZReMK+Mht/E1fhzMZGnOilbgS8JjglEdBxTRsUNKLG11ApJ3QU6L" +
  "hFuVUGEnFm4scOcG6lPbZzG+iEOhEPh0Ph0XiTn/x/6fj/76qvbcefVaTOsf2s5BQAAAAAAAAABwAFbgstgQjGf////AUhMS7M5/" +
  "P341clySJIiREJQPo889knnnnnnnnnDLwYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGB" +
  "gYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgZSDzzszn8/fjVyXJIki" +
  "JEAAAAAAAAAAAAAA4AA=";

/** ffprobe が読んだ映像の [PTS, DTS] (180000 の単位、デコードの順) */
export const VIDEO_TIMES: [number, number][] = [
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
/** 映像の 1 GOP のコマ数 (keyint) */
export const GOP = 8;
/** 音声の素材のフレーム数 */
export const AUDIO_FRAMES = 13;
/** MPT の時刻の単位 (実機の BS4K と同じ) */
export const TIMESCALE = 180000;
/** 映像の 1 コマ (180000 の単位。59.94 コマ) */
const FRAME = 3003;
/** 音声の 1 フレーム (1024 標本 @48kHz を 180000 の単位で) */
const AUDIO_FRAME = 3840;
/** 音声の 1 MPU のフレーム数 (実機の BS4K と同じ) */
const AUDIO_PER_MPU = 4;

/** base64 をバイト列に */
export function base64Bytes(base64: string): Uint8Array {
  const text = atob(base64);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** HEVC の NAL ユニットの種類 */
function nalType(nal: Uint8Array): number {
  return (nal[0]! >> 1) & 0x3f;
}

/** Annex B を NAL ユニットに切り、AUD (35) ごとにコマにまとめる (デコードの順) */
export function hevcPictures(annexB: Uint8Array): Uint8Array[][] {
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
export function latmElements(loas: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at + 3 <= loas.length;) {
    if (((loas[at]! << 3) | (loas[at + 1]! >> 5)) !== 0x2b7) break;
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

/** 4K の局 1 つぶんの組み立ての決まり (`SynthMmtAv`) */
export interface SynthMmtAvOptions {
  /** 局の service_id (MPT の MMT_package_id) */
  serviceId: number;
  /** MPT の packet_id */
  mptPacketId: number;
  /** 映像の packet_id。省くと実機の BS4K と同じ 0xF100 */
  videoPacketId?: number;
  /** 音声の packet_id。省くと 0xF110 */
  audioPacketId?: number;
  /** 字幕の packet_id。省くと 0xF130 */
  captionPacketId?: number;
  /** 映像の最初の MPU の提示時刻 (UNIX 時刻のミリ秒)。放送の時計 (NTP) にして MPT に書く */
  startMs: number;
  /** 字幕の文字。省くと字幕を流さない。映像の MPU `CAPTION_EVERY` 個ごとに TTML の文書を 1 つ流す */
  caption?: string;
  /** ヘッダー圧縮した IP の CID。省くと 1 */
  cid?: number;
}

/** 字幕の文書を流す間隔 (映像の MPU の数。約 2 秒) */
const CAPTION_EVERY = 15;
/** 字幕の 1 つの文書が出ている長さ (秒) */
const CAPTION_SECONDS = 1.5;

/** NTP の時刻 (1900 年から) と UNIX 時刻 (1970 年から) の差 (秒) */
const NTP_UNIX = 2_208_988_800;

/** 字幕の TTML の文書 (B62 に似せたもの。1920x1080 の下の領域に中央寄せ) */
function captionDocument(text: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tt xml:lang="ja" xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" tts:extent="1920px 1080px">',
    '<head><styling><style xml:id="s" tts:fontSize="60px" tts:color="white"/></styling>',
    '<layout><region xml:id="r" tts:origin="160px 840px" tts:extent="1600px 180px" tts:textAlign="center" tts:displayAlign="after"/></layout></head>',
    `<body><div><p begin="0s" end="${CAPTION_SECONDS}s" region="r" style="s"><span>${text}</span></p></div></body></tt>`,
  ].join("\n");
}

/** 映像の 1 MPU の長さ (ミリ秒)。実時間で流すときの間隔 */
export const MPU_MS = (GOP * FRAME * 1000) / TIMESCALE;

/**
 * **素材の映像と音声 (と字幕) を、MMT/TLV で流し続ける。** `next` を呼ぶたびに映像の 1 MPU (1 GOP・8 コマ・約 0.13 秒) と、
 * そこまでに要る音声の MPU を、時刻と番号を進めて返す。どの MPU の前にも、これから来る MPU の時刻を並べた MPT を付ける
 * (途中から読み始めても、次の MPU から読める)
 */
export class SynthMmtAv {
  private readonly video: Uint8Array[][];
  private readonly audio: Uint8Array[];
  private readonly ids: { video: number; audio: number; caption: number };
  private readonly cid: number;
  /** 映像の最初の MPU の提示時刻 (180000 の単位、NTP の始まりから) */
  private readonly base: number;
  /** 次に流す映像の MPU (0 から。mpu_sequence_number) */
  private k = 0;
  /** 次に流す音声の MPU (0 から) */
  private j = 0;
  /** packet_id ごとの、次の packet_sequence_number */
  private readonly sequence = new Map<number, number>();

  constructor(private readonly options: SynthMmtAvOptions) {
    this.video = hevcPictures(base64Bytes(HEVC));
    this.audio = latmElements(base64Bytes(LOAS));
    this.ids = {
      video: options.videoPacketId ?? 0xf100,
      audio: options.audioPacketId ?? 0xf110,
      caption: options.captionPacketId ?? 0xf130,
    };
    this.cid = options.cid ?? 1;
    this.base = Math.round((options.startMs / 1000 + NTP_UNIX) * TIMESCALE);
  }

  /** 180000 の単位の時刻を NTP に */
  private ntp(ticks: number): SynthNtp {
    const whole = Math.floor(ticks / TIMESCALE);
    return [
      whole >>> 0,
      Math.round(((ticks - whole * TIMESCALE) / TIMESCALE) * 2 ** 32) >>> 0,
    ];
  }

  /** packet_id ごとに続き番号を振りながら MFU を作る */
  private mfu(
    packetId: number,
    mpu: number,
    units: { sample: number; data: Uint8Array | number[] }[],
    options: { aggregate?: boolean; fragment?: number; rap?: boolean } = {},
  ): Uint8Array[] {
    const sequenceNumber = this.sequence.get(packetId) ?? 0;
    const made = mfuPackets(packetId, mpu, units, {
      ...options,
      sequenceNumber,
    });
    this.sequence.set(packetId, sequenceNumber + made.length);
    return made;
  }

  /** 映像の MPU `k` のコマの [PTS, DTS] (180000 の単位、NTP の始まりから。デコードの順) */
  private videoTimes(k: number): [number, number][] {
    const gop = k % 2;
    const shift = this.base + (k - gop) * GOP * FRAME;
    return VIDEO_TIMES.slice(gop * GOP, (gop + 1) * GOP).map(([pts, dts]) => [
      shift + pts,
      shift + dts,
    ]);
  }

  /** これから流す映像・音声・字幕の MPU の時刻を並べた MPT */
  private mpt(): Uint8Array[] {
    const videoMpus = [this.k, this.k + 1, this.k + 2].map((k) => {
      const times = this.videoTimes(k);
      const first = Math.min(...times.map(([pts]) => pts));
      return {
        sequence: k,
        presentation: this.ntp(first),
        decodingOffset: first - times[0]![1],
        dtsPtsOffsets: times.map(([pts, dts]) => pts - dts),
      };
    });
    const audioMpus = [this.j, this.j + 1, this.j + 2, this.j + 3].map((j) => ({
      sequence: j,
      presentation: this.ntp(this.base + j * AUDIO_PER_MPU * AUDIO_FRAME),
      decodingOffset: 0,
      dtsPtsOffsets: new Array<number>(AUDIO_PER_MPU).fill(0),
    }));
    const caption = Math.floor(this.k / CAPTION_EVERY);
    const captionMpus = [caption, caption + 1].map((c) => ({
      sequence: c,
      presentation: this.ntp(this.base + c * CAPTION_EVERY * GOP * FRAME),
      decodingOffset: 0,
      dtsPtsOffsets: [0],
    }));
    const assets = [
      {
        type: "hev1",
        packetId: this.ids.video,
        descriptors: [
          ...mpuTimestampDescriptor(
            videoMpus.map((m) => [m.sequence, m.presentation]),
          ),
          ...mpuExtendedTimestampDescriptor(TIMESCALE, videoMpus, FRAME),
        ],
      },
      {
        type: "mp4a",
        packetId: this.ids.audio,
        descriptors: [
          ...mpuTimestampDescriptor(
            audioMpus.map((m) => [m.sequence, m.presentation]),
          ),
          ...mpuExtendedTimestampDescriptor(TIMESCALE, audioMpus, AUDIO_FRAME),
        ],
      },
      ...(this.options.caption === undefined
        ? []
        : [
            {
              type: "stpp",
              packetId: this.ids.caption,
              descriptors: [
                ...mpuTimestampDescriptor(
                  captionMpus.map((m) => [m.sequence, m.presentation]),
                ),
                ...mpuExtendedTimestampDescriptor(TIMESCALE, captionMpus, 0),
              ],
            },
          ]),
    ];
    return signalingPackets(this.options.mptPacketId, [
      paMessage(mptTable({ packageId: this.options.serviceId, assets })),
    ]);
  }

  /** 映像の 1 MPU と、そこまでの音声 (と字幕) を TLV のバイト列で */
  next(): Uint8Array {
    const k = this.k;
    const packets: Uint8Array[] = [...this.mpt()];
    if (this.options.caption !== undefined && k % CAPTION_EVERY === 0)
      packets.push(
        ...this.mfu(this.ids.caption, k / CAPTION_EVERY, [
          {
            sample: 0,
            data: new TextEncoder().encode(
              captionDocument(this.options.caption),
            ),
          },
        ]),
      );
    const gop = k % 2;
    this.video.slice(gop * GOP, (gop + 1) * GOP).forEach((nals, sample) => {
      // スライスの手前の小さな NAL ユニットは集約、スライスは分割して送る (実機と同じ運び方)
      const unit = (nal: Uint8Array) => ({
        sample,
        data: [...be32(nal.length), ...nal],
      });
      const small = nals.filter((n) => nalType(n) >= 32);
      const slices = nals.filter((n) => nalType(n) < 32);
      packets.push(
        ...this.mfu(this.ids.video, k, small.map(unit), {
          aggregate: true,
          rap: sample === 0,
        }),
        ...this.mfu(this.ids.video, k, slices.map(unit), { fragment: 1000 }),
      );
    });
    this.k++;
    // 音声は映像の終わりまでのぶんを流す
    const until = (this.k * GOP * FRAME) / (AUDIO_PER_MPU * AUDIO_FRAME);
    while (this.j < until) {
      const j = this.j++;
      const units = Array.from({ length: AUDIO_PER_MPU }, (_, sample) => ({
        sample,
        data: this.audio[(j * AUDIO_PER_MPU + sample) % this.audio.length]!,
      }));
      packets.push(...this.mfu(this.ids.audio, j, units));
    }
    return concatBytes(packets.map((p) => compressedIp(this.cid, p)));
  }
}
