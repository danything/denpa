import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendRecording,
  openRecording,
  openRecordingSync,
  readRecording,
  recordingInput,
  recordingProbeInput,
  recordingSize,
  recordingStream,
} from "./recording-io";

/** 0, 1, 2, … と並んだ 1000 バイトの録画を作る */
function sample(): { path: string; bytes: Uint8Array<ArrayBuffer> } {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
  const path = join(mkdtempSync(join(tmpdir(), "denpa-recording-io-")), "a.ts");
  writeFileSync(path, bytes);
  return { path, bytes };
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("recordingInput", () => {
  test("ffmpeg の入力は -i とパス", () => {
    expect(recordingInput("/rec/a.ts")).toEqual(["-i", "/rec/a.ts"]);
  });

  test("ffprobe の入力はパスだけ", () => {
    expect(recordingProbeInput("/rec/a.ts")).toEqual(["/rec/a.ts"]);
  });
});

describe("recordingStream", () => {
  test("省けば先頭から末尾まで", async () => {
    const { path, bytes } = sample();
    expect(await collect(recordingStream(path))).toEqual(bytes);
  });

  test("途中から末尾まで", async () => {
    const { path, bytes } = sample();
    expect(await collect(recordingStream(path, 600))).toEqual(bytes.slice(600));
  });

  test("end の手前まで", async () => {
    const { path, bytes } = sample();
    expect(await collect(recordingStream(path, 100, 200))).toEqual(
      bytes.slice(100, 200),
    );
  });
});

describe("readRecording", () => {
  test("位置と長さを指定して読む。末尾に掛かれば短くなる", async () => {
    const { path, bytes } = sample();
    expect(await readRecording(path, 10, 5)).toEqual(bytes.slice(10, 15));
    expect(await readRecording(path, 990, 100)).toEqual(bytes.slice(990));
  });
});

describe("openRecording", () => {
  test("位置を指定して何度も読む", async () => {
    const { path, bytes } = sample();
    const handle = await openRecording(path);
    try {
      const buffer = new Uint8Array(4);
      const { bytesRead } = await handle.read(buffer, 0, 4, 500);
      expect(bytesRead).toBe(4);
      expect(buffer).toEqual(bytes.slice(500, 504));
    } finally {
      await handle.close();
    }
  });

  test("同期でも読める", () => {
    const { path, bytes } = sample();
    const file = openRecordingSync(path);
    try {
      const buffer = new Uint8Array(8);
      expect(file.read(buffer, 0, 8, 996)).toBe(4);
      expect(buffer.subarray(0, 4)).toEqual(bytes.slice(996));
    } finally {
      file.close();
    }
  });
});

describe("recordingSize", () => {
  test("中身の大きさ。無ければ null", () => {
    const { path } = sample();
    expect(recordingSize(path)).toBe(1000);
    expect(recordingSize(`${path}.none`)).toBeNull();
  });
});

describe("appendRecording", () => {
  test("追記で開くので、それまでの分を消さない", async () => {
    const { path, bytes } = sample();
    const sink = appendRecording(path);
    await new Promise<void>((resolve, reject) =>
      sink.end(Uint8Array.of(1, 2, 3), (error?: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    const after = new Uint8Array(readFileSync(path));
    expect(after.length).toBe(1003);
    expect(after.subarray(0, 1000)).toEqual(bytes);
    expect(after.subarray(1000)).toEqual(Uint8Array.of(1, 2, 3));
  });
});
