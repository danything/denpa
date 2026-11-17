/**
 * **詰め替えた fMP4 の映像の sync の印を、始めてよいコマ (`random-access.startable`) にだけ残す** (`server/playback.ts` の詰め替え)。
 *
 * ffmpeg の mp4 の muxer は、Matroska のキーフレームの印をそのまま sync の印にする。MediaCodec でエンコードした録画では、
 * P のコマ (intra-refresh の回復点) にも印が付いていることがある。**WebKit は飛ぶとき・開くときに、目標の時刻の手前で
 * いちばん近い sync のコマからデコーダに渡す** (WebKit の `TrackBuffer::reenqueueMediaForTime`) ので、印の付いた P のコマから
 * 渡され、VideoToolbox が MEDIA_ERR_DECODE を返す (#2884。macOS の WebKit で確かめた)。サーバが IDR から送っても、
 * 目標の手前に印の付いた P があればそこから渡される。
 *
 * 印を外したコマは「ほかを参照する」(sample_depends_on 1) にする。WebKit は手前の IDR からデコードし直す。
 *
 * - moof とその後ろの mdat が揃うまで溜めてから、trun の sample_flags をその場で書き換えて出す。大きさは変わらない
 * - 映像のトラックは moov の hdlr が `vide` の trak。見つからなければ何も変えない
 * - tfhd の既定値 (default_sample_flags) に頼るサンプルは書き換えない (既定値は同じ traf の全部のサンプルに効く)。
 *   ffmpeg は sync のコマに trun の先頭のサンプルの flags かサンプルごとの flags を書くので、ここには来ない
 *
 * DOM も worker も触らない (`fmp4-marks.test.ts`)
 */

import { type NalCodec, startable } from "./random-access";

/** sample_flags の sample_is_non_sync_sample */
const NON_SYNC = 0x10000;
/** sample_flags の sample_depends_on (2 ビット) */
const DEPENDS_MASK = 0x03000000;
const DEPENDS_YES = 0x01000000;

const TRUN_DATA_OFFSET = 0x01;
const TRUN_FIRST_FLAGS = 0x04;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_CTO = 0x800;

const TFHD_BASE_OFFSET = 0x01;
const TFHD_DESCRIPTION = 0x02;
const TFHD_DURATION = 0x08;
const TFHD_SIZE = 0x10;

function boxType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    bytes[at + 4]!,
    bytes[at + 5]!,
    bytes[at + 6]!,
    bytes[at + 7]!,
  );
}

/** `start` から `end` までの子の箱 (位置と大きさ)。大きさが壊れていれば、そこまで */
function children(
  view: DataView,
  start: number,
  end: number,
): { at: number; size: number }[] {
  const out: { at: number; size: number }[] = [];
  for (let at = start; at + 8 <= end;) {
    const size = view.getUint32(at);
    if (size < 8 || at + size > end) break;
    out.push({ at, size });
    at += size;
  }
  return out;
}

/** moov から映像の trak の track_ID を読む。無ければ null */
export function videoTrackId(moov: Uint8Array): number | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  for (const trak of children(view, 8, moov.length)) {
    if (boxType(moov, trak.at) !== "trak") continue;
    let id: number | null = null;
    let video = false;
    for (const box of children(view, trak.at + 8, trak.at + trak.size)) {
      const type = boxType(moov, box.at);
      if (type === "tkhd") {
        const version = moov[box.at + 8]!;
        id = view.getUint32(box.at + (version === 1 ? 28 : 20));
      } else if (type === "mdia") {
        for (const sub of children(view, box.at + 8, box.at + box.size))
          if (
            boxType(moov, sub.at) === "hdlr" &&
            boxType(moov, sub.at + 12) === "vide"
          )
            video = true;
      }
    }
    if (video && id !== null) return id;
  }
  return null;
}

/**
 * moof (`bytes` の `moof` から) と、それに続くデータの sync の印を直す。`bytes` をその場で書き換え、外した数を返す。
 * データの位置は moof の先頭から数える (default-base-is-moof。`playback.FMP4_OUT`)
 */
export function fixMoof(
  bytes: Uint8Array,
  moof: number,
  track: number,
  codec: NalCodec,
  lengthSize: number,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moofSize = view.getUint32(moof);
  let cleared = 0;
  for (const traf of children(view, moof + 8, moof + moofSize)) {
    if (boxType(bytes, traf.at) !== "traf") continue;
    const boxes = children(view, traf.at + 8, traf.at + traf.size);
    const tfhd = boxes.find((b) => boxType(bytes, b.at) === "tfhd");
    if (tfhd === undefined || view.getUint32(tfhd.at + 12) !== track) continue;
    const tfhdFlags = view.getUint32(tfhd.at + 8) & 0xffffff;
    let p = tfhd.at + 16;
    if (tfhdFlags & TFHD_BASE_OFFSET) p += 8;
    if (tfhdFlags & TFHD_DESCRIPTION) p += 4;
    if (tfhdFlags & TFHD_DURATION) p += 4;
    const defaultSize = tfhdFlags & TFHD_SIZE ? view.getUint32(p) : 0;
    for (const trun of boxes) {
      if (boxType(bytes, trun.at) !== "trun") continue;
      const flags = view.getUint32(trun.at + 8) & 0xffffff;
      // データの位置が無ければ、どこを読めばよいか分からない
      if (!(flags & TRUN_DATA_OFFSET)) continue;
      const count = view.getUint32(trun.at + 12);
      let q = trun.at + 16;
      let data = moof + view.getInt32(q);
      q += 4;
      let firstFlags = -1;
      if (flags & TRUN_FIRST_FLAGS) {
        firstFlags = q;
        q += 4;
      }
      for (let i = 0; i < count; i++) {
        if (flags & TRUN_DURATION) q += 4;
        let size = defaultSize;
        if (flags & TRUN_SIZE) {
          size = view.getUint32(q);
          q += 4;
        }
        let flagsAt = i === 0 ? firstFlags : -1;
        if (flags & TRUN_FLAGS) {
          flagsAt = q;
          q += 4;
        }
        if (flags & TRUN_CTO) q += 4;
        if (q > trun.at + trun.size) return cleared;
        if (flagsAt >= 0 && data >= 0 && data + size <= bytes.length) {
          const sample = view.getUint32(flagsAt);
          if (
            (sample & NON_SYNC) === 0 &&
            !startable(codec, lengthSize, bytes.subarray(data, data + size))
          ) {
            view.setUint32(
              flagsAt,
              ((sample | NON_SYNC) & ~DEPENDS_MASK) | DEPENDS_YES,
            );
            cleared++;
          }
        }
        data += size;
      }
    }
  }
  return cleared;
}

/**
 * **流れてくる fMP4 の印を直す** (冒頭の説明)。`push` に届いた順に渡し、返ったものを順に送る。終わりに `end` の分も送る
 */
export class SyncMarks {
  /** 届いたまま繋いでいないもの。`need` バイト溜まるまで繋がない (大きな mdat を少しずつ繋ぎ直さない) */
  private parts: Uint8Array[] = [];
  private have = 0;
  private need = 8;
  private track: number | null = null;
  /** 外した印の数 (ログに出す) */
  cleared = 0;

  constructor(
    private readonly codec: NalCodec,
    private readonly lengthSize: number,
  ) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.parts.push(chunk);
    this.have += chunk.length;
    if (this.have < this.need) return [];
    const joined = this.take();
    const view = new DataView(
      joined.buffer,
      joined.byteOffset,
      joined.byteLength,
    );
    const out: Uint8Array[] = [];
    let at = 0;
    // 先へ進むのに要る長さ (`at` から)。足りなければ待つ
    let need = 8;
    for (;;) {
      if (at + 8 > joined.length) break;
      const size = view.getUint32(at);
      // 64 ビットの大きさ・末尾までの箱は ffmpeg の fMP4 に出てこない。読めないものはそのまま流す
      if (size < 8) {
        out.push(joined.slice(at));
        at = joined.length;
        break;
      }
      need = size;
      if (at + size > joined.length) break;
      const type = boxType(joined, at);
      if (type === "moof") {
        // 後ろの mdat まで揃うのを待つ
        const next = at + size;
        need = size + 8;
        if (next + 8 > joined.length) break;
        const mdatSize = view.getUint32(next);
        need = size + Math.max(mdatSize, 8);
        if (next + mdatSize > joined.length) break;
        const end = mdatSize >= 8 ? next + mdatSize : next;
        const part = joined.slice(at, end);
        if (this.track !== null)
          this.cleared += fixMoof(
            part,
            0,
            this.track,
            this.codec,
            this.lengthSize,
          );
        out.push(part);
        at = end;
        need = 8;
        continue;
      }
      const box = joined.slice(at, at + size);
      if (type === "moov") this.track = videoTrackId(box);
      out.push(box);
      at += size;
      need = 8;
    }
    const rest = joined.subarray(at);
    if (rest.length > 0) {
      this.parts = [rest];
      this.have = rest.length;
    }
    this.need = need;
    return out;
  }

  /** 溜めたものを 1 つに繋いで空にする */
  private take(): Uint8Array {
    const joined =
      this.parts.length === 1 ? this.parts[0]! : new Uint8Array(this.have);
    if (this.parts.length > 1) {
      let at = 0;
      for (const part of this.parts) {
        joined.set(part, at);
        at += part.length;
      }
    }
    this.parts = [];
    this.have = 0;
    return joined;
  }

  /** 残り (途中で切れた箱) をそのまま返す */
  end(): Uint8Array[] {
    if (this.have === 0) return [];
    return [this.take().slice()];
  }
}

/** `SyncMarks` を TransformStream にする。終わりに外した数を `done` に渡す */
export function syncMarksStream(
  codec: NalCodec,
  lengthSize: number,
  done?: (cleared: number) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const marks = new SyncMarks(codec, lengthSize);
  return new TransformStream({
    transform(chunk, controller) {
      for (const part of marks.push(chunk)) controller.enqueue(part);
    },
    flush(controller) {
      for (const part of marks.end()) controller.enqueue(part);
      done?.(marks.cleared);
    },
  });
}
