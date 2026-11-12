/**
 * **4K の局 (MMT/TLV) のライブの入口** (docs/stream.md「4K の局のライブ」)。
 *
 *     エージェント (TLV。チャンネル丸ごと) → MmtServiceFilter (1 局に絞る。TLV のまま)
 *       ├→ HTTP の raw へ (1 局に絞った TLV)
 *       └→ MmtMediaReader → MmtFmp4 (HEVC + AAC の fMP4。エンコードしない) → MSE、または ffmpeg (縮めてエンコード)
 *                         → ttmlPages (字幕の文字の配置)
 *
 * TS の局のライブは ffmpeg が TS を読むが、4K の局は TS を経由しない。映像と音声は denpa が fMP4 に詰め替え、
 * そのまま端末に送るか (`hevc`)、ffmpeg の入力にする (`live.ts` の `encodeArgs` の `transport`)。
 * 時刻 0 は最初に使う映像の頭出しできるコマの DTS (`MmtFmp4.origin`)。字幕と時計もこの 0 から数える
 */

import type { CaptionPage } from "@danything/arib/caption-text";
import { CLOCK, MmtMediaReader } from "@danything/arib/mmt-media";
import { MmtServiceFilter } from "@danything/arib/mmt-service-filter";
import { ttmlPages } from "@danything/arib/ttml";

import { type Fmp4Segment, MmtFmp4 } from "#lib/mp4/mmt.js";

/** NTP の時刻 (1900 年から) と UNIX 時刻 (1970 年から) の差 (ミリ秒) */
const NTP_TO_UNIX_MS = 2_208_988_800_000;

/** 1 塊を読んだ結果 (`MmtLive.feed`) */
export interface MmtOut {
  /** 1 局に絞った TLV のバイト列 (HTTP の raw へ。何も残らなければ空) */
  tlv: Uint8Array;
  /** 詰め替えた fMP4 (init と media)。`Fmp4Splitter` が出すものと同じ形 */
  segments: Fmp4Segment[];
  /** 字幕の文字の配置。`at` は fMP4 の時刻 (ミリ秒。時刻 0 からのずれ) */
  captions: { at: number; page: CaptionPage }[];
  /**
   * 映像の時刻と、放送がそのコマを出す時刻の組 (`Notice` の `clock`)。`media` は fMP4 の時刻 (秒)、`unixMs` は MPU の提示時刻
   * (NTP。放送の時計) を UNIX 時刻にしたもの。この塊に映像のコマが無ければ null
   */
  anchor: { media: number; unixMs: number } | null;
  /**
   * 番組が替わって、映像・音声・字幕のアセットの並び (MPT) が変わった。TS の PMT が変わったときと同じく作り直す (`live.ts` の `restart`)。
   * 立ったら、それより後ろは読んでいない
   */
  changed: boolean;
}

/**
 * 4K の局 1 つぶんの入口。**ffmpeg を起こし直すたびに作り直す** (fMP4 は init から出し直し、時刻 0 も数え直す)。
 * 入出力は持たず、塊を受けて結果を返すだけ
 */
export class MmtLive {
  private readonly filter: MmtServiceFilter;
  private readonly reader: MmtMediaReader;
  private muxer: MmtFmp4 | null = null;
  /** 字幕のアセットがあるか (選べる字幕に「字幕」を出す) */
  hasCaptions = false;

  /** @param serviceId 局の service_id (MPT の MMT_package_id) */
  constructor(serviceId: number) {
    this.filter = new MmtServiceFilter(serviceId);
    this.reader = new MmtMediaReader(serviceId);
  }

  /** スクランブルされていて読めなかった MMTP のパケットの数 (`MmtMediaReader.scrambled`) */
  get scrambled(): number {
    return this.reader.scrambled;
  }

  feed(chunk: Uint8Array): MmtOut {
    const tlv = this.filter.filter(chunk);
    const out: MmtOut = {
      tlv,
      segments: [],
      captions: [],
      anchor: null,
      changed: false,
    };
    if (tlv.length === 0) return out;
    for (const event of this.reader.feed(tlv)) {
      if (event.kind === "assets") {
        if (this.muxer !== null) {
          out.changed = true;
          return out;
        }
        this.muxer = new MmtFmp4(event.assets);
        this.hasCaptions = event.assets.some((a) => a.kind === "caption");
        continue;
      }
      const muxer = this.muxer;
      if (muxer === null) continue;
      if (event.kind === "caption") {
        const origin = muxer.origin;
        if (origin === null) continue;
        for (const shown of ttmlPages(event.document, event.pts))
          out.captions.push({
            at: ((shown.at - origin) * 1000) / CLOCK,
            page: shown.page,
          });
        continue;
      }
      out.segments.push(...muxer.push(event));
      const origin = muxer.origin;
      if (event.kind === "video" && origin !== null && event.pts >= origin)
        out.anchor = {
          media: (event.pts - origin) / CLOCK,
          unixMs: (event.pts * 1000) / CLOCK - NTP_TO_UNIX_MS,
        };
    }
    return out;
  }
}
