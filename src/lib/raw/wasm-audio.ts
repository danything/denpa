/**
 * **WASM のデコーダ (`wasm/decoder.c`) の音の関数。** canvas に描く worker (`worker.ts`) が使う。
 * AAC は ADTS で渡す (TS はもとから ADTS。fMP4 から読むときは
 * ヘッダを付ける)。Opus は OpusHead を渡して開く (`fmp4.ts` の `audioCodec`・`audioFrame`)
 */

/** 壊れたコマ (`"broken"`) がこれより多く続いたら打ち切る。1 つずつなら飛ばす (放送の取りこぼし) */
const BROKEN_MOST = 20;

/** デコーダのうち、音とメモリの関数 */
export interface AudioDecoder {
  _aac_open(): number;
  _opus_open(extra: number, length: number): number;
  _audio_push(data: number, length: number): number;
  _audio_peek(): number;
  _malloc(size: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}

/** デコードできた 1 コマ。面は写して持ち出したもの (デコーダの面は次のコマで上書きされる) */
interface Pcm {
  sampleRate: number;
  samples: number;
  /** チャンネルの並び (FFmpeg の `AV_CH_*` の和。分からなければ 0)。2ch に下げるときに使う (`downmix.ts`) */
  layout: number;
  planes: Float32Array<ArrayBuffer>[];
}

/** WASM のメモリの置き場 */
interface Slot {
  pointer: number;
  size: number;
}

/**
 * WASM のメモリに `size` バイトの置き場を用意する。**足りるうちは使い回す。** 取れなければ
 * `pointer` が 0 で大きさも 0 (次にまた確保する。アドレス 0 へ書かせない)
 */
export function ensure(decoder: AudioDecoder, slot: Slot, size: number): Slot {
  if (size <= slot.size) return slot;
  if (slot.pointer !== 0) decoder._free(slot.pointer);
  const pointer = decoder._malloc(size);
  return { pointer, size: pointer === 0 ? 0 : size };
}

/** デコーダ (`<base>/decoder.mjs` と `.wasm`) を読む。`base` は `/api/live/mpeg2` (置いたパスの下も含む) */
export async function loadDecoder<D>(base: string, origin: string): Promise<D> {
  const url = (name: string) => new URL(`${base}/${name}`, origin).href;
  const module = (await import(/* @vite-ignore */ url("decoder.mjs"))) as {
    default: (options: object) => Promise<D>;
  };
  return await module.default({ locateFile: url });
}

/** 音を開き直してデコードする係。置き場 (`Slot`) を持ち回る */
export class WasmAudio {
  private slot: Slot = { pointer: 0, size: 0 };
  /** 続けて壊れていたコマの数 (`BROKEN_MOST`)。開き直すか、デコードできたら 0 に戻す */
  private broken = 0;

  constructor(private readonly decoder: AudioDecoder) {}

  /** 開き直す (前のデコーダは `audio_open` が閉じる)。Opus は OpusHead が要る。**開けなければ false** */
  open(codec: "aac" | "opus", config: Uint8Array | null): boolean {
    this.broken = 0;
    if (codec === "aac") return this.decoder._aac_open() === 0;
    const at = config === null ? 0 : this.put(config);
    return at !== 0 && this.decoder._opus_open(at, config!.length) === 0;
  }

  /**
   * 1 コマデコードする。**出てこなければ null、壊れたコマ (と置き場を取れない・形式がおかしい) は `"broken"`** で、呼ぶ側は飛ばす
   * (放送の取りこぼし)。`BROKEN_MOST` より多く続いたら `"failed"` で、呼ぶ側は打ち切る
   */
  decode(data: Uint8Array): Pcm | null | "broken" | "failed" {
    const pcm = this.decodeOne(data);
    if (pcm === "broken") return ++this.broken > BROKEN_MOST ? "failed" : pcm;
    if (pcm !== null) this.broken = 0;
    return pcm;
  }

  private decodeOne(data: Uint8Array): Pcm | null | "broken" {
    const d = this.decoder;
    const at = this.put(data);
    if (at === 0) return "broken";
    const samples = d._audio_push(at, data.length);
    if (samples < 0) return "broken";
    if (samples === 0) return null;
    // デコードしたあとに読む。メモリが伸びると HEAPU8 の下の ArrayBuffer が替わる
    const info = d._audio_peek() >> 2;
    const channels = d.HEAP32[info]!;
    const sampleRate = d.HEAP32[info + 1]!;
    // 面は 8 本まで (`wasm/decoder.c` の AUDIO_PLANES)。外れていたら読み違えている
    if (
      channels < 1 ||
      channels > 8 ||
      sampleRate < 8000 ||
      sampleRate > 192000
    )
      return "broken";
    // C の int で渡るので、上のビットが立つと負になる。ビットの和として読む
    const layout = d.HEAP32[info + 3]! >>> 0;
    const planes = Array.from({ length: channels }, (_, i) =>
      new Float32Array(
        d.HEAPU8.buffer,
        d.HEAP32[info + 4 + i]!,
        samples,
      ).slice(),
    );
    return { sampleRate, samples, layout, planes };
  }

  /** WASM のメモリへ写す。**取れなければ 0** (書かない) */
  private put(data: Uint8Array): number {
    this.slot = ensure(this.decoder, this.slot, data.length);
    if (this.slot.pointer !== 0)
      this.decoder.HEAPU8.set(data, this.slot.pointer);
    return this.slot.pointer;
  }
}
