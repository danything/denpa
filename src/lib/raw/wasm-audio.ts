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
export interface Pcm {
  sampleRate: number;
  samples: number;
  planes: Float32Array<ArrayBuffer>[];
}

/** WASM のメモリの置き場 */
export interface Slot {
  pointer: number;
  size: number;
}

/** WASM のメモリに `size` バイトの置き場を用意する。**足りるうちは使い回す** */
export function ensure(decoder: AudioDecoder, slot: Slot, size: number): Slot {
  if (size <= slot.size) return slot;
  if (slot.pointer !== 0) decoder._free(slot.pointer);
  return { pointer: decoder._malloc(size), size };
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
    if (config === null) return false;
    return this.decoder._opus_open(this.put(config), config.length) === 0;
  }

  /** 1コマデコードする。**出てこなければ null、壊れたコマは `"broken"`** */
  decode(data: Uint8Array): Pcm | null | "broken" {
    const d = this.decoder;
    const samples = d._audio_push(this.put(data), data.length);
    if (samples < 0) return "broken";
    if (samples === 0) return null;
    // デコードしたあとに読む — メモリが伸びると HEAPU8 の下の ArrayBuffer が替わる
    const info = d._audio_peek() >> 2;
    const channels = d.HEAP32[info]!;
    const sampleRate = d.HEAP32[info + 1]!;
    const planes = Array.from({ length: channels }, (_, i) =>
      new Float32Array(
        d.HEAPU8.buffer,
        d.HEAP32[info + 3 + i]!,
        samples,
      ).slice(),
    );
    return { sampleRate, samples, planes };
  }

  private put(data: Uint8Array): number {
    this.slot = ensure(this.decoder, this.slot, data.length);
    this.decoder.HEAPU8.set(data, this.slot.pointer);
    return this.slot.pointer;
  }
}
