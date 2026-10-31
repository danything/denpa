import { afterAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

import { fakeDecoder } from "../../../tests/fake/wasm-decoder";
import { readFragment, readInit } from "../ts/fmp4";
import type { AudioInput, AudioOutput } from "./native-audio-protocol";
import * as wasmAudio from "./wasm-audio";

/**
 * **ライブの音だけの worker** (`native-audio-worker.ts`)。E2E は Chromium で流すのでこの経路を通らない —
 * ここで worker をそのまま読み込み、デコーダだけ偽物 (`tests/fake/wasm-decoder.ts`) に替えて流す。
 * 流すのは作り置きの fMP4 (本物の ffmpeg が書いた H.264 + AAC)。init と断片は同じファイルを渡す
 */
const posted: AudioOutput[] = [];
const decoder = fakeDecoder();
const { WasmAudio, ensure } = wasmAudio;
mock.module("./wasm-audio", () => ({
  WasmAudio,
  ensure,
  loadDecoder: async () => decoder,
}));
const scope = globalThis as unknown as {
  postMessage: (message: AudioOutput) => void;
  onmessage: ((event: { data: AudioInput }) => void) | null;
  location: { origin: string };
};
const before = Object.getOwnPropertyDescriptors(globalThis);
scope.postMessage = (message) => posted.push(message);
scope.location = { origin: "http://denpa.test" };
await import("./native-audio-worker");
afterAll(() => {
  for (const name of ["postMessage", "onmessage", "location"] as const) {
    const was = before[name];
    if (was === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, was);
  }
});
const send = (data: AudioInput) => scope.onmessage?.({ data });

const bytes = new Uint8Array(
  readFileSync(new URL("../../../tests/fake/live-h264.mp4", import.meta.url)),
);
const tracks = readInit(bytes);
const audioTrack = tracks.find((t) => t.kind === "audio")!;
const audioSamples = readFragment(bytes, [audioTrack]);
const segment = (init: boolean, epoch: number): AudioInput => ({
  type: "segment",
  init,
  epoch,
  bytes: bytes.slice(),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("読み終える前に届いたものは溜め、読み終えたら開いてデコードし、時刻を秒で返す", async () => {
  send(segment(true, 1));
  send(segment(false, 1));
  expect(posted).toEqual([]);
  send({ type: "load", base: "/api/live/mpeg2" });
  await settle();
  expect(decoder.opened).toEqual(["aac"]);
  const pcm = posted.filter((m) => m.type === "pcm");
  expect(pcm).toHaveLength(audioSamples.length);
  expect(pcm[0]).toMatchObject({ epoch: 1 });
  expect(pcm.map((m) => m.type === "pcm" && m.chunk.pts)).toEqual(
    audioSamples.map((s) => s.pts / audioTrack.timescale),
  );
  // 受け取ったと2回返す (init と断片)
  expect(posted.filter((m) => m.type === "ack")).toHaveLength(2);
  // AAC は ADTS の頭を付けて渡している
  expect([decoder.last[0], decoder.last[1]! & 0xf6]).toEqual([0xff, 0xf0]);
});

test("前の局 (古い epoch) の断片は捨てる", () => {
  posted.length = 0;
  send(segment(true, 2));
  send(segment(false, 1));
  expect(posted.filter((m) => m.type === "pcm")).toHaveLength(0);
  send(segment(false, 2));
  expect(posted.filter((m) => m.type === "pcm")).toHaveLength(
    audioSamples.length,
  );
});

test("壊れたコマは飛ばし (放送の取りこぼし)、続けて 20 より多く壊れたら諦める", () => {
  expect(audioSamples.length).toBeGreaterThan(21);
  // 頭の 20 コマだけ壊れている → 飛ばして続ける
  posted.length = 0;
  let count = 0;
  decoder.samples = () => (++count <= 20 ? -1 : 1024);
  send(segment(false, 2));
  expect(posted.filter((m) => m.type === "pcm")).toHaveLength(
    audioSamples.length - 20,
  );
  expect(posted.some((m) => m.type === "error")).toBe(false);
  // ずっと壊れている → 1回だけ諦めを返し、あとは何も返さない
  posted.length = 0;
  decoder.samples = () => -1;
  send(segment(false, 2));
  send(segment(false, 2));
  expect(posted).toEqual([{ type: "error", message: expect.any(String) }]);
});
