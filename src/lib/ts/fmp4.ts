/**
 * ffmpeg が吐く fMP4 を、MSE が食える単位に割る。
 *
 * MSE は**最初に init セグメント (`ftyp` + `moov`) を渡さないと**、そのあとの
 * 中身を1バイトも受け取らない。ffmpeg は1本のストリームとして出してくるので、
 * こちらで切れ目を見つける。
 *
 *     ftyp moov | moof mdat | moof mdat | ...
 *     ~~~~~~~~~   ~~~~~~~~~
 *     init        媒体 (0.05秒ぶん。`live.ts` の `-frag_duration`)
 *
 * **途中から入ってきた人のために init は取っておく** ([stream.md](../../../docs/stream.md#websocket-プロトコル))。
 * ライブは誰がいつ繋いでくるか分からないので、最初の1回だけ流して終わりにはできない。
 *
 * MP4 の箱は `[4バイト: 大きさ][4バイト: 種別][中身]` の繰り返し。
 * 大きさは箱ぜんぶ (頭の8バイトを含む) を数えた値。
 */

import { ascii, concatBytes, joinBytes, u32 } from "@danything/arib/bytes";
import { ADTS_RATES } from "@danything/arib/pes";

/** 箱の頭。大きさと種別で8バイト */
const HEADER = 8;

export type Segment =
  { kind: "init"; data: Uint8Array } | { kind: "media"; data: Uint8Array };

/**
 * バイト列を食わせると、組み上がったセグメントを返す。
 *
 * **足りないぶんは持ち越す。** ffmpeg の出力はパイプなので、箱の切れ目で
 * 届くとは限らない。半端なところで切って渡すと MSE がその場で投げる。
 */
export class Fmp4Splitter {
  private buffer = new Uint8Array(0);
  /** `moof` に入るまでが init。入ったら以降は媒体 */
  private started = false;
  /** 組み立て中の媒体セグメント (moof から次の moof の手前まで) */
  private pending: Uint8Array[] = [];

  feed(chunk: Uint8Array): Segment[] {
    this.buffer = concatBytes([this.buffer, chunk]);
    const out: Segment[] = [];
    let at = 0;
    while (this.buffer.length - at >= HEADER) {
      const size = u32(this.buffer, at);
      /*
       * 大きさ 0 は「ここから最後まで」、1 は「次の8バイトに本当の大きさ」。
       * ffmpeg の fMP4 では出てこないが、来たら読めないので諦める
       * (黙って詰めると、以降ずっとずれたまま流れ続ける)
       */
      if (size < HEADER || this.buffer.length - at < size) break;
      const type = ascii(this.buffer, at + 4, 4);
      const box = this.buffer.slice(at, at + size);
      at += size;

      if (type === "moof") {
        /*
         * **`moof` が来たら、それまでが init。** 頭の `ftyp` `moov` を
         * 溜めておいて、ここで1つにして出す
         */
        if (!this.started && this.pending.length > 0) {
          out.push({ kind: "init", data: joinBytes(this.pending) });
          this.pending = [];
        }
        this.started = true;
      }
      this.pending.push(box);

      /*
       * **`mdat` で1つ。** `moof` の次に `mdat` が来たら、その組が
       * 1フラグメント。次の `moof` を待って区切ると**必ず1つぶん遅れる**ので、
       * 細かく出させている (`-frag_duration`) 意味が無くなる。
       *
       * 数で区切らないのは、間に `sidx` などが挟まることがあるため。
       * 「2つ溜まったら出す」にしていると `moof`+`sidx` を1枚として
       * 出してしまい、中身の無いものを MSE に渡すことになる
       */
      if (this.started && type === "mdat") {
        out.push({ kind: "media", data: joinBytes(this.pending) });
        this.pending = [];
      }
    }
    this.buffer = this.buffer.slice(at);
    return out;
  }
}

/*
 * ---------------------------------------------------------------------------
 * 中身を読む (画面の canvas で描く経路。`raw/fmp4.ts`)。
 *
 * MSE に渡すときは割るだけで済んだが、**自分でデコードするときは中身が要る** — moov から
 * 何の映像・音声か (avcC / av1C / esds / dOps) を、moof から1コマずつの時刻と在りかを
 * (tfdt / trun) 読む。読むのは denpa の ffmpeg が出す形式 (`server/live.ts` の
 * `+empty_moov+default_base_moof`) に要るものだけ:
 *
 * - 中身の在りかは moof の頭から数える (`default-base-is-moof`)。tfhd の
 *   `base-data-offset` (ストリームの頭から数える) は、途中から繋いだ受け側には読めないので扱わない
 * - 1コマの長さ・大きさ・印は trun → tfhd → trex (moov の mvex) の順に探す
 * ---------------------------------------------------------------------------
 */

/** moov から読んだ1本 */
export interface Fmp4Track {
  id: number;
  kind: "video" | "audio";
  /** 時刻の刻み (1秒あたり) */
  timescale: number;
  /** WebCodecs の書き方の codec (`avc1.640029` / `av01.0.08M.08` / `mp4a.40.2` / `opus`) */
  codec: string;
  /**
   * デコードする道具に渡すもの。映像は avcC / av1C の中身 (VideoDecoder の `description`)、
   * AAC は AudioSpecificConfig、Opus は dOps の中身
   */
  config: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  /** 音声のチャンネル数と標本化周波数 (sample entry に書いてある値) */
  channels: number;
  sampleRate: number;
  /** trex に書いてある既定 (trun・tfhd に無いとき) */
  defaults: { duration: number; size: number; flags: number };
}

/** moof から読んだ1コマ。時刻はそのトラックの刻み (`Fmp4Track.timescale`) */
export interface Fmp4Sample {
  track: number;
  /** デコードする時刻 */
  dts: number;
  /** 見せる時刻 (dts + 合成時刻のずれ) */
  pts: number;
  duration: number;
  /** 単独でデコードできるコマ (sync sample) か */
  key: boolean;
  data: Uint8Array;
}

interface Box {
  type: string;
  /** 中身 (頭の8バイトを除く) */
  body: Uint8Array;
  /** 渡された範囲の頭から見た、箱の頭の位置 */
  start: number;
}

/** `data` に並んでいる箱を読む。**壊れていたらそこで止める** (読めたぶんだけ返す) */
function boxes(data: Uint8Array): Box[] {
  const out: Box[] = [];
  let at = 0;
  while (at + HEADER <= data.length) {
    const size = u32(data, at);
    if (size < HEADER || at + size > data.length) break;
    const body = data.subarray(at + HEADER, at + size);
    out.push({ type: ascii(data, at + 4, 4), body, start: at });
    at += size;
  }
  return out;
}

function child(body: Uint8Array, type: string): Uint8Array | null {
  return boxes(body).find((b) => b.type === type)?.body ?? null;
}

/** 箱を辿る (`mdia` → `minf` → ...)。**最初に見つかったもの** */
function path(body: Uint8Array, ...types: string[]): Uint8Array | null {
  let at: Uint8Array | null = body;
  for (const type of types) {
    if (at === null) return null;
    at = child(at, type);
  }
  return at;
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

const hex = (value: number) => value.toString(16).padStart(2, "0");

/** trex に何も無いときの既定 */
const NO_DEFAULTS = { duration: 0, size: 0, flags: 0 };

/**
 * init (`ftyp` + `moov`) を読む。**分からないトラック (字幕など) は飛ばす。**
 * moov が無ければ空
 */
export function readInit(data: Uint8Array): Fmp4Track[] {
  const moov = boxes(data).find((b) => b.type === "moov")?.body;
  if (moov === undefined) return [];
  const defaults = new Map<number, Fmp4Track["defaults"]>();
  const mvex = child(moov, "mvex");
  for (const trex of mvex === null
    ? []
    : boxes(mvex).filter((b) => b.type === "trex")) {
    // version+flags(4) track_ID(4) default_sample_description_index(4) 長さ 大きさ 印
    if (trex.body.length < 24) continue;
    const v = view(trex.body);
    defaults.set(v.getUint32(4), {
      duration: v.getUint32(12),
      size: v.getUint32(16),
      flags: v.getUint32(20),
    });
  }
  const tracks: Fmp4Track[] = [];
  for (const trak of boxes(moov).filter((b) => b.type === "trak")) {
    const tkhd = child(trak.body, "tkhd");
    const mdhd = path(trak.body, "mdia", "mdhd");
    const stsd = path(trak.body, "mdia", "minf", "stbl", "stsd");
    if (tkhd === null || mdhd === null || stsd === null || stsd.length < 8)
      continue;
    const id = view(tkhd).getUint32(tkhd[0] === 1 ? 20 : 12);
    const timescale = view(mdhd).getUint32(mdhd[0] === 1 ? 20 : 12);
    // stsd: version+flags(4) entry_count(4) のあとに sample entry が並ぶ
    const entry = boxes(stsd.subarray(8))[0];
    if (entry === undefined || timescale === 0) continue;
    const track = readEntry(
      entry,
      id,
      timescale,
      defaults.get(id) ?? NO_DEFAULTS,
    );
    if (track !== null) tracks.push(track);
  }
  return tracks;
}

function readEntry(
  entry: Box,
  id: number,
  timescale: number,
  defaults: Fmp4Track["defaults"],
): Fmp4Track | null {
  const body = entry.body;
  const v = view(body);
  const base = {
    id,
    timescale,
    defaults,
    width: 0,
    height: 0,
    channels: 0,
    sampleRate: 0,
  };
  if (entry.type === "avc1" || entry.type === "av01") {
    // VisualSampleEntry: 中身の頭から 78 バイトが決まった並び (幅は 24、高さは 26)
    if (body.length < 78) return null;
    const inner = body.subarray(78);
    const size = { width: v.getUint16(24), height: v.getUint16(26) };
    if (entry.type === "avc1") {
      const avcC = child(inner, "avcC");
      if (avcC === null || avcC.length < 4) return null;
      return {
        ...base,
        ...size,
        kind: "video",
        codec: avcCodec(avcC),
        config: avcC.slice(),
      };
    }
    const av1C = child(inner, "av1C");
    if (av1C === null || av1C.length < 4) return null;
    return {
      ...base,
      ...size,
      kind: "video",
      codec: av1Codec(av1C),
      config: av1C.slice(),
    };
  }
  if (entry.type === "mp4a" || entry.type === "Opus") {
    // AudioSampleEntry: チャンネル数は 16、標本化周波数は 24 (16.16 の上半分)、中身の箱は 28 から
    if (body.length < 28) return null;
    const sound = {
      channels: v.getUint16(16),
      sampleRate: v.getUint32(24) >>> 16,
    };
    const inner = body.subarray(28);
    if (entry.type === "Opus") {
      const dOps = child(inner, "dOps");
      if (dOps === null) return null;
      return {
        ...base,
        ...sound,
        kind: "audio",
        codec: "opus",
        config: dOps.slice(),
      };
    }
    const esds = child(inner, "esds");
    const asc = esds === null ? null : audioSpecificConfig(esds);
    if (asc === null || asc.length < 2) return null;
    return {
      ...base,
      ...sound,
      kind: "audio",
      codec: aacCodec(asc),
      config: asc,
    };
  }
  return null;
}

/** avcC から `avc1.PPCCLL` を起こす — profile・互換の印・level (avcC の 1〜3 バイト目) */
export function avcCodec(avcC: Uint8Array): string {
  return `avc1.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`;
}

/** AudioSpecificConfig から `mp4a.40.N` を起こす (N は頭の 5 ビットのオブジェクトの種類) */
export function aacCodec(asc: Uint8Array): string {
  return `mp4a.40.${asc[0]! >> 3}`;
}

/** av1C から `av01.P.LLT.DD` を起こす (AV1 の ISOBMFF の決まり) */
export function av1Codec(av1C: Uint8Array): string {
  const profile = av1C[1]! >> 5;
  const level = av1C[1]! & 0x1f;
  const tier = av1C[2]! >> 7 ? "H" : "M";
  const high = (av1C[2]! >> 6) & 1;
  const twelve = (av1C[2]! >> 5) & 1;
  const depth = high === 0 ? 8 : twelve === 1 ? 12 : 10;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`;
}

/**
 * esds から AudioSpecificConfig を抜く。記述子は `[印 1][長さ 1〜4 (7ビットずつ)][中身]` の入れ子
 * (ES_Descriptor 0x03 → DecoderConfigDescriptor 0x04 → DecoderSpecificInfo 0x05)
 */
function audioSpecificConfig(esds: Uint8Array): Uint8Array<ArrayBuffer> | null {
  let at = 4; // version+flags
  const descriptor = (): { tag: number; start: number; end: number } | null => {
    if (at >= esds.length) return null;
    const tag = esds[at++]!;
    let length = 0;
    for (let i = 0; i < 4 && at < esds.length; i++) {
      const byte = esds[at++]!;
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return { tag, start: at, end: Math.min(esds.length, at + length) };
  };
  const es = descriptor();
  if (es?.tag !== 0x03) return null;
  // ES_ID(2) 印(1)。印の上3ビットで、後ろに付くものが増える
  const flags = esds[at + 2] ?? 0;
  at += 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + (esds[at] ?? 0);
  if (flags & 0x20) at += 2;
  const config = descriptor();
  if (config?.tag !== 0x04) return null;
  // objectTypeIndication(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
  at = config.start + 13;
  while (at < config.end) {
    const info = descriptor();
    if (info === null) return null;
    if (info.tag === 0x05) return esds.slice(info.start, info.end);
    at = info.end;
  }
  return null;
}

/** sample_flags の `sample_is_non_sync_sample` (ISO/IEC 14496-12 §8.8.3.1) */
const NON_SYNC = 0x10000;

/**
 * 媒体 (`moof` + `mdat`。間に別の箱が挟まってもよい) を読む。**知らないトラックのコマは捨てる。**
 * 壊れていたら、そこまでに読めたぶんを返す
 */
export function readFragment(
  data: Uint8Array,
  tracks: readonly Fmp4Track[],
): Fmp4Sample[] {
  const out: Fmp4Sample[] = [];
  for (const moof of boxes(data).filter((b) => b.type === "moof")) {
    for (const traf of boxes(moof.body).filter((b) => b.type === "traf")) {
      if (!readTraf(data, moof.start, traf.body, tracks, out)) return out;
    }
  }
  return out;
}

/** traf 1つぶん。**壊れていたら false** (呼ぶ側は読むのをやめる) */
function readTraf(
  data: Uint8Array,
  origin: number,
  traf: Uint8Array,
  tracks: readonly Fmp4Track[],
  out: Fmp4Sample[],
): boolean {
  const tfhd = child(traf, "tfhd");
  if (tfhd === null || tfhd.length < 8) return true;
  const h = view(tfhd);
  const flags = h.getUint32(0) & 0xffffff;
  const track = tracks.find((t) => t.id === h.getUint32(4));
  if (track === undefined) return true;
  let at = 8;
  const field = (present: boolean, fallback: number): number => {
    if (!present || at + 4 > tfhd.length) return fallback;
    at += 4;
    return h.getUint32(at - 4);
  };
  if (flags & 0x01) at += 8; // base-data-offset (扱わない。上の説明)
  if (flags & 0x02) at += 4; // sample-description-index
  const duration0 = field((flags & 0x08) !== 0, track.defaults.duration);
  const size0 = field((flags & 0x10) !== 0, track.defaults.size);
  const flags0 = field((flags & 0x20) !== 0, track.defaults.flags);

  const tfdt = child(traf, "tfdt");
  let dts = 0;
  if (tfdt !== null && tfdt.length >= 8) {
    const t = view(tfdt);
    dts =
      tfdt[0] === 1 && tfdt.length >= 12
        ? Number(t.getBigUint64(4))
        : t.getUint32(4);
  }
  for (const trun of boxes(traf).filter((b) => b.type === "trun")) {
    const body = trun.body;
    if (body.length < 8) return false;
    const r = view(body);
    const tflags = r.getUint32(0) & 0xffffff;
    const count = r.getUint32(4);
    let p = 8;
    let offset = 0;
    if (tflags & 0x01) {
      offset = r.getInt32(p);
      p += 4;
    }
    let first: number | null = null;
    if (tflags & 0x04) {
      first = r.getUint32(p);
      p += 4;
    }
    // 1コマぶんの並び (長さ・大きさ・印・合成時刻のずれのうち、書いてあるもの)
    const each =
      [0x100, 0x200, 0x400, 0x800].filter((bit) => tflags & bit).length * 4;
    if (p + each * count > body.length) return false;
    /** 1コマぶんの並びから次の4バイトを読む。版 1 の合成時刻のずれは符号あり (B フレームで負になる) */
    const next = (signed = false): number => {
      const value = signed ? r.getInt32(p) : r.getUint32(p);
      p += 4;
      return value;
    };
    // data_offset の無い trun (前の trun の続き) は、denpa の ffmpeg は出さない (いつも付ける) ので扱わない
    let position = origin + offset;
    for (let i = 0; i < count; i++) {
      const duration = tflags & 0x100 ? next() : duration0;
      const size = tflags & 0x200 ? next() : size0;
      const fallback = i === 0 && first !== null ? first : flags0;
      const sampleFlags = tflags & 0x400 ? next() : fallback;
      const shift = tflags & 0x800 ? next(body[0] !== 0) : 0;
      if (position < 0 || position + size > data.length) return false;
      out.push({
        track: track.id,
        dts,
        pts: dts + shift,
        duration,
        key: (sampleFlags & NON_SYNC) === 0,
        data: data.subarray(position, position + size),
      });
      position += size;
      dts += duration;
    }
  }
  return true;
}

/**
 * **MP4 の AAC の1コマに付ける ADTS の頭。** デコーダ (`wasm/decoder.c` の `aac_open`) は
 * 放送の ADTS を食う作りなので、MP4 の1コマ (頭無し) はそのままでは渡せない。
 * 頭の中身は AudioSpecificConfig (esds) から起こす: 種類 (LC なら 2)・標本化周波数の番号・チャンネル数。
 *
 * 頭は 7 バイト (CRC 無し)。ADTS に書ける種類は 1〜4 (Main / LC / SSR / LTP) だけで、
 * それ以外 (HE-AAC など) と、標本化周波数を値で書いたもの (番号 15) は null
 *
 * @param payload 1コマの大きさ (頭を除く)
 */
export function adtsHeader(
  config: Uint8Array,
  payload: number,
): Uint8Array | null {
  if (config.length < 2) return null;
  const objectType = config[0]! >> 3;
  const rateIndex = ((config[0]! & 0x07) << 1) | (config[1]! >> 7);
  const channels = (config[1]! >> 3) & 0x0f;
  if (objectType < 1 || objectType > 4 || rateIndex >= ADTS_RATES.length)
    return null;
  const length = payload + 7;
  if (length > 0x1fff) return null;
  return Uint8Array.of(
    0xff,
    0xf1, // MPEG-4、層 0、CRC 無し
    ((objectType - 1) << 6) | (rateIndex << 2) | (channels >> 2),
    ((channels & 0x03) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 0x07) << 5) | 0x1f,
    0xfc, // 溜まり具合は「可変」(0x7ff)、1つの ADTS に 1 コマ
  );
}

/**
 * dOps (MP4 の Opus の設定) を、FFmpeg の Opus デコーダが受け取る OpusHead (Ogg の形式) に
 * 書き換える。並びは同じで、**数の並べ方だけが違う** (dOps は大きい桁が先、OpusHead は
 * 小さい桁が先)。頭に `OpusHead`、版は 1。並べ方が読めなければ null
 */
export function opusHead(dOps: Uint8Array): Uint8Array | null {
  if (dOps.length < 11) return null;
  const v = view(dOps);
  const family = dOps[10]!;
  const table = family === 0 ? new Uint8Array(0) : dOps.subarray(11);
  const out = new Uint8Array(19 + table.length);
  const o = new DataView(out.buffer);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // OpusHead
  out[8] = 1;
  out[9] = dOps[1]!; // 出すチャンネル数
  o.setUint16(10, v.getUint16(2), true); // 頭で捨てる標本数
  o.setUint32(12, v.getUint32(4), true); // 元の標本化周波数
  o.setInt16(16, v.getInt16(8), true); // 音量の補正
  out[18] = family;
  out.set(table, 19);
  return out;
}
