/// <reference lib="webworker" />
/**
 * ライブの fMP4 から音だけ読み、WASM でデコードして PCM を画面へ返す (`native-audio.ts`)。
 * デコードは canvas に描く worker と同じ口 (`wasm-audio.ts`)。デコーダを読み終えるまでに届いたものは溜めておき、
 * 読み終えたら順に流す
 */
import { type Fmp4Track, readFragment, readInit } from "../ts/fmp4";
import { audioCodec, audioFrame } from "./fmp4";
import {
  type AudioInput,
  type AudioOutput,
  MAX_PENDING_BYTES,
} from "./native-audio-protocol";
import { type AudioDecoder, loadDecoder, WasmAudio } from "./wasm-audio";

type Segment = Extract<AudioInput, { type: "segment" }>;

/** 続けて壊れたコマがこれより多ければ諦める (`worker.ts` の `AUDIO_ERRORS_MOST` と同じ) */
const BROKEN_MOST = 20;

const scope = self as unknown as DedicatedWorkerGlobalScope;
let decoder: WasmAudio | null = null;
let track: Fmp4Track | undefined;
let epoch = -1;
let broken = 0;
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

/** init なら開き直す。それ以外は音のコマをデコードして返す */
function segment(d: WasmAudio, message: Segment): void {
  if (message.init) {
    epoch = message.epoch;
    broken = 0;
    track = readInit(message.bytes).find((t) => t.kind === "audio");
    if (track === undefined) throw new Error("audio track missing");
    const open = audioCodec(track);
    if (open === null || !d.open(open.codec, open.config))
      throw new Error(`${track.codec} could not open`);
    return;
  }
  if (message.epoch !== epoch || track === undefined) return;
  for (const sample of readFragment(message.bytes, [track])) {
    const frame = audioFrame(track, sample.data);
    if (frame === null) throw new Error("unsupported AAC configuration");
    const pcm = d.decode(frame);
    // 壊れたコマは飛ばす (放送の取りこぼし)。続けて転ぶなら諦める (canvas に描く worker と同じ)
    if (pcm === "broken") {
      if (++broken > BROKEN_MOST) throw new Error("audio decode failed");
      continue;
    }
    if (pcm === null) continue;
    broken = 0;
    const { sampleRate, planes } = pcm;
    const pts = sample.pts / track.timescale;
    post(
      { type: "pcm", epoch, chunk: { pts, sampleRate, planes } },
      planes.map((p) => p.buffer),
    );
  }
}

/** 流して、受け取ったと返す (画面はこれで送り込みすぎを測る) */
function handle(d: WasmAudio, message: Segment): void {
  segment(d, message);
  post({ type: "ack", bytes: message.bytes.byteLength });
}

async function load(base: string): Promise<void> {
  try {
    const d = new WasmAudio(
      await loadDecoder<AudioDecoder>(base, scope.location.origin),
    );
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
