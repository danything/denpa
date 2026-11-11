/**
 * 4K の放送 (MMT/TLV) の HEVC と AAC を、**エンコードせずに** fragmented MP4 に詰め替える。
 *
 * MPEG-2 TS の局は ffmpeg が TS を読んで fMP4 を出すが、4K の局は TS を経由しない。
 * `@danything/arib/mmt-media` が取り出したアクセスユニットを、ここで直に `moof` + `mdat` にする。
 * 出すものは ffmpeg の fMP4 を割ったもの (`ts/fmp4.ts` の `Fmp4Splitter`) と同じ形 (init と media) で、
 * MSE にも ffmpeg の入力にも渡せる。
 *
 * - **時刻 0 は、最初に使う映像の頭出しできるコマの DTS。** それより前の音声は捨てる。字幕も同じ 0 で数える (`origin`)
 * - 断片は映像の MPU (頭出しできる所から次の頭出しできる所まで) ごとに 1 つ出す。音声は、映像の断片の終わりまでのぶんを一緒に出す
 * - 初期化セグメントは、映像の VPS・SPS・PPS と、音声の設定がそろったときに 1 回だけ出す。
 *   そろう前に映像の MPU が終わったら、それまでのコマを捨て、次の頭出しできるコマから始め直す (時刻 0 もそのコマにする)。
 *   アセットが変わったら (`MediaEvent` の `assets`) 作り直すのは使う側
 */

import { concatBytes } from "@danything/arib/bytes";
import type {
  AudioUnit,
  MediaAsset,
  VideoUnit,
} from "@danything/arib/mmt-media";

import {
  type AudioTrack,
  initSegment,
  mediaSegment,
  type Mp4Sample,
  type VideoTrack,
} from "./fmp4";
import { hvcC, NAL_PPS, NAL_SPS, NAL_VPS, nalType, parseSps } from "./hevc";

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

/** 出すもの (`ts/fmp4.ts` の `Fmp4Splitter` が出すものと同じ形) */
export interface Fmp4Segment {
  kind: "init" | "media";
  data: Uint8Array;
}

/** 長さ (4 バイト) を前に付けて並べる (MP4 のサンプルの形) */
function sampleData(nals: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nals.reduce((n, nal) => n + 4 + nal.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const nal of nals) {
    view.setUint32(at, nal.length);
    out.set(nal, at + 4);
    at += 4 + nal.length;
  }
  return out;
}

/** 頭出しできるコマの VPS・SPS・PPS から、映像のトラックを作る。そろっていなければ null */
function videoTrack(unit: VideoUnit): VideoTrack | null {
  const find = (type: number) => unit.nals.find((nal) => nalType(nal) === type);
  const vps = find(NAL_VPS);
  const sps = find(NAL_SPS);
  const pps = find(NAL_PPS);
  if (vps === undefined || sps === undefined || pps === undefined) return null;
  const info = parseSps(sps);
  if (info === null) return null;
  return {
    kind: "video",
    id: VIDEO_TRACK,
    width: info.width,
    height: info.height,
    hvcC: hvcC(info, { vps, sps, pps }),
  };
}

interface Pending<T> {
  /** DTS (90 kHz、放送の時刻のまま) */
  dts: number;
  sample: Mp4Sample;
  unit: T;
}

/**
 * アクセスユニット (`MmtMediaReader` が返す映像と音声) を受けて、fMP4 のセグメントを返す。
 * 字幕は受けない (`ttml.ts` で文字の配置にして別に送る。時刻は `origin` からの差にする)
 */
export class MmtFmp4 {
  /** 時刻 0 に当たる放送の時刻 (90 kHz)。初期化セグメントを出すまでは null */
  origin: number | null = null;
  private readonly hasVideo: boolean;
  private readonly hasAudio: boolean;
  private video: VideoTrack | null = null;
  private audio: AudioTrack | null = null;
  private started = false;
  private sequence = 1;
  private videoSamples: Pending<VideoUnit>[] = [];
  private audioSamples: Pending<AudioUnit>[] = [];

  /** `assets` は `MmtMediaReader` が選んだアセット。映像も音声も無ければ何も出さない */
  constructor(assets: readonly MediaAsset[]) {
    this.hasVideo = assets.some((a) => a.kind === "video");
    this.hasAudio = assets.some((a) => a.kind === "audio");
  }

  push(unit: VideoUnit | AudioUnit): Fmp4Segment[] {
    const out: Fmp4Segment[] = [];
    if (unit.kind === "video") {
      if (!this.hasVideo) return out;
      const last = this.videoSamples.at(-1);
      if (
        last !== undefined &&
        last.unit.mpuSequenceNumber !== unit.mpuSequenceNumber
      )
        out.push(...this.cut(unit.dts));
      if (this.video === null) {
        // 頭出しできるコマから始める。それまでのコマは前のコマが無いとデコードできない
        if (!unit.keyframe) return out;
        this.video = videoTrack(unit);
        if (this.video === null) return out;
        this.origin = unit.dts;
      }
      this.videoSamples.push({
        dts: unit.dts,
        unit,
        sample: {
          data: sampleData(unit.nals),
          duration: unit.duration,
          offset: unit.pts - unit.dts,
          keyframe: unit.keyframe,
        },
      });
    } else {
      if (!this.hasAudio) return out;
      this.audio ??= {
        kind: "audio",
        id: AUDIO_TRACK,
        sampleRate: unit.config.sampleRate,
        channels: unit.config.channels,
        audioSpecificConfig: unit.config.audioSpecificConfig,
      };
      // 映像が無ければ、最初の音声の DTS が 0
      if (!this.hasVideo) this.origin ??= unit.dts;
      if (this.origin === null || unit.dts < this.origin) return out;
      const last = this.audioSamples.at(-1);
      if (
        !this.hasVideo &&
        last !== undefined &&
        last.unit.mpuSequenceNumber !== unit.mpuSequenceNumber
      )
        out.push(...this.cut(unit.dts));
      this.audioSamples.push({
        dts: unit.dts,
        unit,
        sample: {
          data: unit.frame,
          duration: unit.duration,
          offset: 0,
          keyframe: true,
        },
      });
    }
    return out;
  }

  /** 溜めているぶんを全部出す (終わるとき) */
  flush(): Fmp4Segment[] {
    return this.cut(Infinity);
  }

  /** `until` (90 kHz) より前の DTS のコマを、1 つのメディアセグメントにする */
  private cut(until: number): Fmp4Segment[] {
    const out: Fmp4Segment[] = [];
    const ready =
      (!this.hasVideo || this.video !== null) &&
      (!this.hasAudio || this.audio !== null);
    if (this.origin === null) return out;
    if (!ready) {
      // 設定がそろう前のコマは溜め続けずに捨て、次の頭出しできるコマから始め直す (時刻 0 もそのコマにする)
      this.videoSamples = [];
      this.audioSamples = [];
      this.video = null;
      this.origin = null;
      return out;
    }
    if (!this.started) {
      this.started = true;
      const tracks = [this.video, this.audio].filter((t) => t !== null);
      out.push({ kind: "init", data: initSegment(tracks) });
    }
    const parts: Uint8Array[] = [];
    const take = <T>(list: Pending<T>[], trackId: number): Pending<T>[] => {
      const index = list.findIndex((p) => p.dts >= until);
      const taken = index < 0 ? list : list.slice(0, index);
      if (taken.length > 0)
        parts.push(
          mediaSegment(
            this.sequence++,
            trackId,
            taken[0]!.dts - this.origin!,
            taken.map((p) => p.sample),
          ),
        );
      return index < 0 ? [] : list.slice(index);
    };
    this.videoSamples = take(this.videoSamples, VIDEO_TRACK);
    this.audioSamples = take(this.audioSamples, AUDIO_TRACK);
    if (parts.length > 0)
      out.push({
        kind: "media",
        data: concatBytes(parts),
      });
    return out;
  }
}
