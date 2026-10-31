/// <reference lib="webworker" />
/**
 * ライブの fMP4 から音だけ読み、WASM (`wasm/decoder.c`) でデコードして PCM を画面へ返す (`native-audio.ts`)。
 * デコーダを読み終えるまでに届いたものは溜めておき、読み終えたら順に流す
 */
import { concatBytes } from "@danything/arib/bytes";

import {
  adtsHeader,
  type Fmp4Track,
  opusHead,
  readFragment,
  readInit,
} from "../ts/fmp4";
import {
  type AudioInput,
  type AudioOutput,
  MAX_PENDING_BYTES,
} from "./native-audio-protocol";

interface Decoder {
  _aac_open(): number;
  _opus_open(pointer: number, length: number): number;
  _audio_push(pointer: number, length: number): number;
  _audio_peek(): number;
  _malloc(length: number): number;
  _free(pointer: number): void;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
}
type Segment = Extract<AudioInput, { type: "segment" }>;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let decoder: Decoder | null = null;
let audio: Fmp4Track | undefined;
let epoch = -1;
let pointer = 0;
let capacity = 0;
/** デコーダを読み終える前に届いたもの */
let held: Segment[] = [];
let heldBytes = 0;
let failed = false;

function post(message: AudioOutput, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}
function fail(message: string): void {
  if (failed) return;
  failed = true;
  held = [];
  post({ type: "error", message });
}

/** WASM の置き場へ写す (足りなければ取り直す) */
function put(d: Decoder, bytes: Uint8Array): number {
  if (bytes.length > capacity) {
    if (pointer !== 0) d._free(pointer);
    pointer = d._malloc(bytes.length);
    if (pointer === 0) throw new Error("audio allocation failed");
    capacity = bytes.length;
  }
  d.HEAPU8.set(bytes, pointer);
  return pointer;
}

/** 1コマデコードして画面へ返す。出てこなければ何もしない */
function decode(d: Decoder, frame: Uint8Array, pts: number): void {
  const count = d._audio_push(put(d, frame), frame.length);
  if (count < 0) throw new Error("audio decode failed");
  if (count === 0) return;
  const info = d._audio_peek() >> 2;
  const channels = d.HEAP32[info]!;
  const sampleRate = d.HEAP32[info + 1]!;
  if (channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000)
    throw new Error("invalid PCM format");
  const planes = Array.from({ length: channels }, (_, ch) =>
    new Float32Array(d.HEAPU8.buffer, d.HEAP32[info + 3 + ch]!, count).slice(),
  );
  post(
    { type: "pcm", epoch, chunk: { pts, sampleRate, planes } },
    planes.map((p) => p.buffer),
  );
}

/** init なら開き直す (前のデコーダは `audio_open` が閉じる)。それ以外は音のコマを流す */
function segment(d: Decoder, message: Segment): void {
  const bytes = message.bytes;
  if (message.init) {
    epoch = message.epoch;
    audio = readInit(bytes).find((t) => t.kind === "audio");
    if (audio === undefined) throw new Error("audio track missing");
    const head = audio.codec === "opus" ? opusHead(audio.config) : null;
    const opened =
      audio.codec === "opus"
        ? head !== null && d._opus_open(put(d, head), head.length) === 0
        : audio.codec.startsWith("mp4a") && d._aac_open() === 0;
    if (!opened) throw new Error(`${audio.codec} could not open`);
    return;
  }
  if (message.epoch !== epoch || audio === undefined) return;
  for (const sample of readFragment(bytes, [audio])) {
    let frame = sample.data;
    // AAC は ADTS の頭を付けて渡す (デコーダは extradata 無しで ADTS として読む)
    if (audio.codec !== "opus") {
      const head = adtsHeader(audio.config, frame.length);
      if (head === null) throw new Error("unsupported AAC configuration");
      frame = concatBytes([head, frame]);
    }
    decode(d, frame, sample.pts / audio.timescale);
  }
}

/** 流して、受け取ったと返す (画面はこれで送り込みすぎを測る) */
function handle(d: Decoder, message: Segment): void {
  segment(d, message);
  post({ type: "ack", bytes: message.bytes.byteLength });
}

async function load(base: string): Promise<void> {
  try {
    const url = (name: string) =>
      new URL(`${base}/${name}`, scope.location.origin).href;
    const mod = (await import(/* @vite-ignore */ url("decoder.mjs"))) as {
      default: (options: object) => Promise<Decoder>;
    };
    const d = await mod.default({ locateFile: url });
    decoder = d;
    const waiting = held;
    held = [];
    heldBytes = 0;
    for (const message of waiting) handle(d, message);
  } catch (error) {
    fail(String(error));
  }
}

scope.onmessage = (event: MessageEvent<AudioInput>) => {
  if (failed) return;
  const message = event.data;
  if (message.type === "load") {
    void load(message.base);
    return;
  }
  try {
    if (decoder !== null) handle(decoder, message);
    else {
      heldBytes += message.bytes.byteLength;
      if (heldBytes > MAX_PENDING_BYTES)
        throw new Error("decoder startup queue exceeded limit");
      held.push(message);
    }
  } catch (error) {
    fail(String(error));
  }
};
