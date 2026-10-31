import type { AudioDecoder } from "../../src/lib/raw/wasm-audio";

/**
 * **WASM のデコーダ (`wasm/decoder.c`) の音の口のふり** (`raw/wasm-audio.ts` の `AudioDecoder`)。
 * メモリは 1 枚の ArrayBuffer で、`_malloc` は後ろへ積むだけ。`_audio_push` は `samples` が返す標本数で
 * (負は壊れたコマ、0 は出てこない)、`_audio_peek` の並び (`[本数, 標本化周波数, 標本数, 各面のアドレス…]`) と
 * 面の中身 (面 i は i + 0.5) を書く
 */
export interface FakeDecoder extends AudioDecoder {
  /** 1コマごとに返す標本数。途中で差し替えられる */
  samples: (bytes: Uint8Array) => number;
  /** 開いた順 (`aac` / `opus`) */
  opened: string[];
  /** 返した置き場 */
  frees: number[];
  /** 最後に渡されたバイト (開くときの OpusHead・デコードした1コマ) */
  last: Uint8Array;
}

export function fakeDecoder(
  options: {
    channels?: number;
    sampleRate?: number;
    samples?: (bytes: Uint8Array) => number;
  } = {},
): FakeDecoder {
  const { channels = 2, sampleRate = 48000, samples = () => 1024 } = options;
  const memory = new ArrayBuffer(1 << 20);
  const info = 1024;
  const planeAt = (i: number) => 4096 + i * 8192 * 4;
  let top = 4096 + 8 * 8192 * 4;
  const d: FakeDecoder = {
    HEAPU8: new Uint8Array(memory),
    HEAP32: new Int32Array(memory),
    samples,
    opened: [],
    frees: [],
    last: new Uint8Array(),
    _malloc: (size: number) => {
      const at = top;
      top += size;
      return at;
    },
    _free: (pointer: number) => {
      d.frees.push(pointer);
    },
    _aac_open: () => {
      d.opened.push("aac");
      return 0;
    },
    _opus_open: (extra: number, length: number) => {
      d.last = d.HEAPU8.slice(extra, extra + length);
      d.opened.push("opus");
      return 0;
    },
    _audio_push: (data: number, length: number) => {
      d.last = d.HEAPU8.slice(data, data + length);
      const count = d.samples(d.last);
      if (count <= 0) return count;
      d.HEAP32.set([channels, sampleRate, count], info / 4);
      for (let i = 0; i < channels; i++) {
        d.HEAP32[info / 4 + 3 + i] = planeAt(i);
        new Float32Array(memory, planeAt(i), count).fill(i + 0.5);
      }
      return count;
    },
    _audio_peek: () => info,
  };
  return d;
}
