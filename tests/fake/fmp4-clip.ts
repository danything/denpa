/**
 * **作り置きの fMP4 (`live-h264.mp4` / `live-av1.mp4`) を、時刻をずらして並べ直す。** 偽 ffmpeg (`fmp4-loop.ts`・
 * `fmp4-out.ts`) と E2E (`40-watch-compat`) が使う。作り方は `fmp4-loop.ts` の頭に。
 *
 * 2秒ぶんの媒体 (moof + mdat) の時刻 (tfdt) に足して、好きな位置から好きな長さだけ並べる。
 * 頭 (ftyp + moov) はそのまま。Bun にも Node にも依らない (E2E は Playwright の中で読む)
 */

interface Box {
  type: string;
  start: number;
  end: number;
}

export interface Fmp4Fragment {
  data: Uint8Array;
  /** トラックごとの tfdt の在りか (data の中の位置) と、版 (1 なら 64 ビット) */
  stamps: { track: number; at: number; wide: boolean }[];
  /** 先頭のコマの時刻 (秒)。流す頃合いを決める */
  seconds: number;
}

export interface Fmp4Clip {
  /** ftyp + moov */
  head: Uint8Array;
  fragments: Fmp4Fragment[];
  /** トラックごとの時刻の刻み (1秒あたり) */
  timescales: Map<number, number>;
  /** 1周の長さ (秒)。トラックのうち長いほう */
  period: number;
}

function boxes(data: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = view.getUint32(at);
    if (size < 8 || at + size > to) break;
    out.push({
      type: String.fromCharCode(...data.subarray(at + 4, at + 8)),
      start: at,
      end: at + size,
    });
    at += size;
  }
  return out;
}

/** 作り置きの fMP4 を読む */
export function readClip(file: Uint8Array): Fmp4Clip {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const top = boxes(file, 0, file.length);

  /** トラックごとの時刻の刻み (moov → trak → mdia → mdhd) */
  const timescales = new Map<number, number>();
  const moov = top.find((b) => b.type === "moov");
  const traks = moov === undefined ? [] : boxes(file, moov.start + 8, moov.end);
  for (const trak of traks.filter((b) => b.type === "trak")) {
    const inner = boxes(file, trak.start + 8, trak.end);
    const tkhd = inner.find((b) => b.type === "tkhd");
    const mdia = inner.find((b) => b.type === "mdia");
    const mdhd =
      mdia === undefined
        ? undefined
        : boxes(file, mdia.start + 8, mdia.end).find((b) => b.type === "mdhd");
    if (tkhd === undefined || mdhd === undefined) continue;
    const id = view.getUint32(
      tkhd.start + 8 + (file[tkhd.start + 8] === 1 ? 20 : 12),
    );
    timescales.set(
      id,
      view.getUint32(mdhd.start + 8 + (file[mdhd.start + 8] === 1 ? 20 : 12)),
    );
  }

  const head = file.subarray(
    0,
    top.find((b) => b.type === "moof")?.start ?? file.length,
  );
  const fragments: Fmp4Fragment[] = [];
  /** トラックごとの1周の長さ (そのトラックの刻み)。最後のコマの終わり */
  const loop = new Map<number, number>();
  for (let i = 0; i < top.length; i++) {
    const moof = top[i]!;
    if (moof.type !== "moof") continue;
    const mdat = top.slice(i + 1).find((b) => b.type === "mdat");
    if (mdat === undefined) break;
    const data = file.slice(moof.start, mdat.end);
    const stamps: Fmp4Fragment["stamps"] = [];
    let seconds = Number.POSITIVE_INFINITY;
    for (const traf of boxes(data, 8, moof.end - moof.start).filter(
      (b) => b.type === "traf",
    )) {
      const inner = boxes(data, traf.start + 8, traf.end);
      const tfhd = inner.find((b) => b.type === "tfhd");
      const tfdt = inner.find((b) => b.type === "tfdt");
      const trun = inner.find((b) => b.type === "trun");
      if (tfhd === undefined || tfdt === undefined) continue;
      const v = new DataView(data.buffer);
      const track = v.getUint32(tfhd.start + 12);
      const wide = data[tfdt.start + 8] === 1;
      const at = tfdt.start + 12;
      const base = wide ? Number(v.getBigUint64(at)) : v.getUint32(at);
      stamps.push({ track, at, wide });
      const scale = timescales.get(track) ?? 90000;
      seconds = Math.min(seconds, base / scale);
      // 1周の長さ: このかたまりのコマの長さを足した終わり (trun に長さが無ければ tfhd の既定)
      if (trun !== undefined) {
        const flags = v.getUint32(trun.start + 8) & 0xffffff;
        const count = v.getUint32(trun.start + 12);
        let p =
          trun.start + 16 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
        const each =
          [0x100, 0x200, 0x400, 0x800].filter((bit) => flags & bit).length * 4;
        const tf = v.getUint32(tfhd.start + 8) & 0xffffff;
        let fallback = 0;
        if (tf & 0x08)
          fallback = v.getUint32(
            tfhd.start + 16 + (tf & 0x01 ? 8 : 0) + (tf & 0x02 ? 4 : 0),
          );
        let total = 0;
        for (let n = 0; n < count; n++, p += each)
          total += flags & 0x100 ? v.getUint32(p) : fallback;
        loop.set(track, Math.max(loop.get(track) ?? 0, base + total));
      }
    }
    fragments.push({
      data,
      stamps,
      seconds: Number.isFinite(seconds) ? seconds : 0,
    });
  }
  const period = Math.max(
    ...[...loop].map(([track, end]) => end / (timescales.get(track) ?? 90000)),
    0.1,
  );
  return { head, fragments, timescales, period };
}

/**
 * 媒体1つを、時刻を `shift` 秒ずらして写す。**ずらす量はトラックで揃える** (それぞれの刻みで数える)。
 * 揃えないと音と映像が1周ごとにずれていく
 */
export function shiftFragment(
  clip: Fmp4Clip,
  fragment: Fmp4Fragment,
  shift: number,
): Uint8Array {
  const data = fragment.data.slice();
  const v = new DataView(data.buffer);
  for (const { track, at, wide } of fragment.stamps) {
    const by = Math.round(shift * (clip.timescales.get(track) ?? 90000));
    if (wide) v.setBigUint64(at, v.getBigUint64(at) + BigInt(by));
    else v.setUint32(at, v.getUint32(at) + by);
  }
  return data;
}

/**
 * **`from` 秒から `length` 秒ぶん** を繰り返して並べた fMP4 (頭つき)。録画をその場で流す API
 * (`/api/recordings/<id>/stream`) の代わり — 時刻はページの物差しのまま (`from` から始まる)
 */
export function clipFrom(
  clip: Fmp4Clip,
  from: number,
  length: number,
): Uint8Array {
  const parts: Uint8Array[] = [clip.head];
  const rounds = Math.max(1, Math.ceil(length / clip.period));
  for (let round = 0; round < rounds; round++) {
    for (const fragment of clip.fragments)
      parts.push(shiftFragment(clip, fragment, from + round * clip.period));
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
