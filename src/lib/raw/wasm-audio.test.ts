import { describe, expect, test } from "bun:test";

import { fakeDecoder } from "../../../tests/fake/wasm-decoder";
import { ensure, WasmAudio } from "./wasm-audio";

describe("WasmAudio", () => {
  test("AAC はそのまま開き、Opus は OpusHead をメモリに写して開く。OpusHead が無ければ開かない", () => {
    const d = fakeDecoder();
    const audio = new WasmAudio(d);
    expect(audio.open("aac", null)).toBe(true);
    expect(audio.open("opus", new Uint8Array([1, 2, 3]))).toBe(true);
    expect([...d.last]).toEqual([1, 2, 3]);
    expect(audio.open("opus", null)).toBe(false);
    expect(d.opened).toEqual(["aac", "opus"]);
  });

  test("デコードできた面を写して持ち出す (デコーダの面が書き換わっても変わらない)", () => {
    const d = fakeDecoder({ sampleRate: 44100, samples: () => 4 });
    const audio = new WasmAudio(d);
    const pcm = audio.decode(new Uint8Array([7, 8, 9]));
    if (pcm === null || pcm === "broken")
      throw new Error("デコードできていない");
    expect([...d.last]).toEqual([7, 8, 9]);
    expect(pcm.sampleRate).toBe(44100);
    expect(pcm.samples).toBe(4);
    expect(pcm.planes.map((p) => [...p])).toEqual([
      [0.5, 0.5, 0.5, 0.5],
      [1.5, 1.5, 1.5, 1.5],
    ]);
    audio.decode(new Uint8Array([1]));
    new Float32Array(d.HEAPU8.buffer, d.HEAP32[256 + 3]!, 4).fill(9);
    expect([...pcm.planes[0]!]).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(pcm.planes[0]!.buffer).not.toBe(d.HEAPU8.buffer);
  });

  test("出てこなければ null、壊れたコマは broken", () => {
    const audio = new WasmAudio(fakeDecoder({ samples: (b) => b[0]! - 1 }));
    expect(audio.decode(new Uint8Array([1]))).toBeNull();
    expect(audio.decode(new Uint8Array([0]))).toBe("broken");
  });

  test("面の数・標本化周波数がおかしければ (読み違え) 面を切り出さず broken", () => {
    expect(
      new WasmAudio(fakeDecoder({ channels: 9 })).decode(new Uint8Array([1])),
    ).toBe("broken");
    expect(
      new WasmAudio(fakeDecoder({ channels: 0 })).decode(new Uint8Array([1])),
    ).toBe("broken");
    expect(
      new WasmAudio(fakeDecoder({ sampleRate: 0 })).decode(new Uint8Array([1])),
    ).toBe("broken");
  });

  test("メモリを取れなければ書かずに broken・開けない (0 番地へ書かない)", () => {
    const d = fakeDecoder();
    d._malloc = () => 0;
    const audio = new WasmAudio(d);
    d.HEAPU8[0] = 42;
    expect(audio.decode(new Uint8Array([7]))).toBe("broken");
    expect(audio.open("opus", new Uint8Array([1]))).toBe(false);
    expect(d.HEAPU8[0]).toBe(42);
    // 置き場の大きさは 0 のまま (次にまた取りに行く)
    expect(ensure(d, { pointer: 0, size: 0 }, 8)).toEqual({
      pointer: 0,
      size: 0,
    });
  });
});

test("ensure: 足りるうちは使い回し、足りなくなったら前のを返して取り直す", () => {
  const d = fakeDecoder();
  const first = ensure(d, { pointer: 0, size: 0 }, 8);
  expect(first.size).toBe(8);
  expect(ensure(d, first, 4)).toBe(first);
  expect(d.frees).toEqual([]);
  const second = ensure(d, first, 16);
  expect(second.size).toBe(16);
  expect(second.pointer).not.toBe(first.pointer);
  expect(d.frees).toEqual([first.pointer]);
});
