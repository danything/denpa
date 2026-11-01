/**
 * **WASM のデコーダ (`wasm/decoder.c`) の音の口。** canvas に描く worker (`worker.ts`) と、ライブの音だけを
 * 鳴らす worker (`native-audio-worker.ts`) で同じものを使う。どちらも AAC は ADTS の頭を付けて、
 * Opus は OpusHead を渡して開く (`fmp4.ts` の `audioCodec`・`audioFrame`)
 */

/** デコーダのうち、音とメモリの口 */
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

/** デコードできた1コマ。面は写して持ち出したもの (デコーダの面は次のコマで上書きされる) */
interface Pcm {
  sampleRate: number;
  samples: number;
  planes: Float32Array<ArrayBuffer>[];
}

/** WASM のメモリの置き場 */
export interface Slot {
  pointer: number;
  size: number;
}

/**
 * WASM のメモリに `size` バイトの置き場を用意する。**足りるうちは使い回す。** 取れなければ
 * `pointer` が 0 で大きさも 0 (次にまた取りに行く。0 番地へ書かせない)
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

  constructor(private readonly decoder: AudioDecoder) {}

  /** 開き直す (前のデコーダは `audio_open` が閉じる)。Opus は OpusHead が要る。**開けなければ false** */
  open(codec: "aac" | "opus", config: Uint8Array | null): boolean {
    if (codec === "aac") return this.decoder._aac_open() === 0;
    const at = config === null ? 0 : this.put(config);
    return at !== 0 && this.decoder._opus_open(at, config!.length) === 0;
  }

  /** 1コマデコードする。**出てこなければ null、壊れたコマ (と置き場を取れない・形式がおかしい) は `"broken"`** */
  decode(data: Uint8Array): Pcm | null | "broken" {
    const d = this.decoder;
    const at = this.put(data);
    if (at === 0) return "broken";
    const samples = d._audio_push(at, data.length);
    if (samples < 0) return "broken";
    if (samples === 0) return null;
    // デコードしたあとに読む — メモリが伸びると HEAPU8 の下の ArrayBuffer が替わる
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
    const planes = Array.from({ length: channels }, (_, i) =>
      new Float32Array(
        d.HEAPU8.buffer,
        d.HEAP32[info + 3 + i]!,
        samples,
      ).slice(),
    );
    return { sampleRate, samples, planes };
  }

  /** WASM のメモリへ写す。**取れなければ 0** (書かない) */
  private put(data: Uint8Array): number {
    this.slot = ensure(this.decoder, this.slot, data.length);
    if (this.slot.pointer !== 0)
      this.decoder.HEAPU8.set(data, this.slot.pointer);
    return this.slot.pointer;
  }
}
