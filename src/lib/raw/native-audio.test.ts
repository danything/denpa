import { afterEach, beforeEach, expect, test } from "bun:test";

import { NativeAudio } from "./native-audio";
import type { AudioInput, AudioOutput } from "./native-audio-protocol";

class Param {
  value = 1;
  /** 予約した変化 (`[種類, 値, 時刻]`)。取り消しは `cancel` */
  events: [string, number, number][] = [];
  setValueAtTime(value: number, at: number) {
    this.events.push(["set", value, at]);
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.events.push(["ramp", value, at]);
  }
  cancelScheduledValues(at: number) {
    this.events.push(["cancel", 0, at]);
  }
}
class Node {
  gain = new Param();
  stopAt: number | undefined;
  /** つないだ先 */
  outputs: Node[] = [];
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  playbackRate = { value: 1 };
  buffer: unknown;
  stopped = false;
  starts: number[][] = [];
  onended: (() => void) | null = null;
  connect(to: Node) {
    this.outputs.push(to);
  }
  disconnect() {}
  stop(at?: number) {
    this.stopped = true;
    this.stopAt = at;
  }
  start(...args: number[]) {
    this.starts.push(args);
  }
}
class Context {
  static all: Context[] = [];
  static failGraph = false;
  state = "running";
  currentTime = 50;
  baseLatency = 0;
  outputLatency = 0;
  destination = new Node();
  sources: Node[] = [];
  onstatechange: (() => void) | null = null;
  constructor() {
    Context.all.push(this);
  }
  createGain() {
    return new Node();
  }
  createDynamicsCompressor() {
    if (Context.failGraph) throw new Error("audio graph unavailable");
    return new Node();
  }
  createBuffer() {
    return { copyToChannel() {} };
  }
  createBufferSource() {
    const node = new Node();
    this.sources.push(node);
    return node;
  }
  async resume() {
    this.state = "running";
  }
  async close() {
    this.state = "closed";
  }
}
class TestWorker {
  static all: TestWorker[] = [];
  messages: AudioInput[] = [];
  terminated = false;
  onmessage: ((event: { data: AudioOutput }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    TestWorker.all.push(this);
  }
  postMessage(message: AudioInput) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  pcm(epoch: number, pts: number) {
    this.onmessage?.({
      data: {
        type: "pcm",
        epoch,
        chunk: { pts, sampleRate: 48000, planes: [new Float32Array(1024)] },
      },
    });
  }
}
class Video extends EventTarget {
  currentTime = 10;
  readyState = 4;
  paused = false;
  muted = false;
  playbackRate = 1;
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
  }
}
const originals = new Map<string, PropertyDescriptor | undefined>();
let audio: InstanceType<typeof NativeAudio> | null;
function set(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}
beforeEach(() => {
  Context.all = [];
  Context.failGraph = false;
  TestWorker.all = [];
  audio = null;
  set("AudioContext", Context);
  set("Worker", TestWorker);
  set("window", new EventTarget());
  set("navigator", { userAgent: "test", audioSession: { type: "auto" } });
  set("document", { body: { append() {} } });
});
afterEach(() => {
  audio?.destroy();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});
function setup(decoder = "/api/live/mpeg2") {
  const video = new Video(),
    errors: string[] = [];
  audio = new NativeAudio(
    video as unknown as HTMLVideoElement,
    (reason) => errors.push(reason),
    decoder,
  );
  const worker = TestWorker.all[0]!,
    context = Context.all[0]!;
  audio.feed(new Uint8Array([1]), true);
  video.dispatchEvent(new Event("playing"));
  return { video, worker, context, errors, audio };
}
test("画面が渡した WASM の置き場 (置いたパスの下も) を使い、PCM を映像の時計の上に予約する", () => {
  const { worker, context, audio } = setup("/tv/api/live/mpeg2");
  expect(worker.messages.find((m) => m.type === "load")?.base).toBe(
    "/tv/api/live/mpeg2",
  );
  audio.setMuted(false);
  worker.pcm(1, 10.1);
  expect(context.sources).toHaveLength(1);
  expect(context.sources[0]!.starts[0]![0]).toBeCloseTo(50.1, 8);
});
test("先頭から読み直したら前の音を止め、前の局から遅れて来たものは捨てる", () => {
  const { worker, context, audio } = setup();
  worker.pcm(1, 10.1);
  audio.feed(new Uint8Array([2]), true);
  expect(context.sources[0]!.stopped).toBe(true);
  worker.pcm(1, 10.1);
  expect(context.sources).toHaveLength(1);
  worker.pcm(2, 10.15);
  expect(context.sources).toHaveLength(2);
});
test("止めたら予約した音を取り消し、再開は映像の新しい位置から", () => {
  const { video, worker, context } = setup();
  worker.pcm(1, 10.1);
  video.pause();
  expect(context.sources[0]!.stopped).toBe(true);
  video.currentTime = 10.1;
  void video.play();
  expect(context.sources).toHaveLength(2);
  expect(context.sources[1]!.starts[0]![1]).toBeCloseTo(0.005, 8);
});
test("デコード待ちが上限を超えたら打ち切って片付ける", () => {
  const { audio, errors, worker, context } = setup();
  audio.feed(new Uint8Array(8 * 1024 * 1024), false);
  expect(errors).toHaveLength(1);
  expect(worker.terminated).toBe(true);
  expect(context.state).toBe("closed");
});
test("畳んだあとに来たコマは鳴らさない", () => {
  const { worker, context, audio } = setup();
  audio.destroy();
  worker.pcm(1, 10.1);
  expect(context.sources).toHaveLength(0);
  expect(worker.terminated).toBe(true);
});

test("映像の時刻が揺れても、続く PCM の間に隙間を作らない", () => {
  const { video, worker, context } = setup();
  worker.pcm(1, 10.1);
  const firstStart = context.sources[0]!.starts[0]![0]!;
  context.currentTime = 50.01;
  video.currentTime = 10.012; // 読んだときの 2ms の揺れ (飛んだのではない)
  worker.pcm(1, 10.1 + 1024 / 48000);
  expect(context.sources[1]!.starts[0]![0]).toBeCloseTo(
    firstStart + 1024 / 48000,
    8,
  );
});

test("音を出しても <video> は消音のまま (二重に鳴らさない)", () => {
  const { audio, video } = setup();
  audio.setMuted(false);
  expect(video.muted).toBe(true);
});

test("<video> が再生に戻ったら、別に鳴らす AudioContext も起こす", () => {
  const { video, context } = setup();
  context.state = "suspended";
  video.dispatchEvent(new Event("playing"));
  expect(context.state).toBe("running");
});

test("Audio Session は作ったら playback にし、畳んだら戻す (バックグラウンド再生のオン・オフでは変えない)", () => {
  const session = (navigator as unknown as { audioSession: { type: string } })
    .audioSession;
  const { audio } = setup();
  expect(session.type).toBe("playback");
  audio.setBackground(true);
  audio.setBackground(false);
  expect(session.type).toBe("playback");
  audio.destroy();
  expect(session.type).toBe("auto");
});

test("予約済みのコマは次の刻みで見直さず、続きから予約する", () => {
  const { worker, context } = setup();
  for (let i = 0; i < 5; i++) worker.pcm(1, 10.1 + (i * 1024) / 48000);
  expect(context.sources).toHaveLength(5);
  // 刻んでも予約し直さない
  context.currentTime = 50.02;
  worker.pcm(1, 10.1 + (5 * 1024) / 48000);
  expect(context.sources).toHaveLength(6);
  expect(context.sources[5]!.starts[0]![0]).toBeCloseTo(
    context.sources[0]!.starts[0]![0]! + (5 * 1024) / 48000,
    8,
  );
});

test("自動再生を断られたら、ふだんの「音を出す」に渡す", () => {
  const { audio, context } = setup();
  expect(audio.blocked).toBe(false);
  context.state = "suspended";
  expect(audio.blocked).toBe(true);
  audio.setMuted(false);
  expect(audio.blocked).toBe(false);
});

test("音の経路を組めなかったら、作りかけの AudioContext を閉じる", () => {
  Context.failGraph = true;
  let threw = false;
  try {
    new NativeAudio(
      new Video() as unknown as HTMLVideoElement,
      () => {},
      "/api/live/mpeg2",
    );
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(Context.all[0]!.state).toBe("closed");
  expect(TestWorker.all).toHaveLength(0);
});

// #2474。波形が途中で 0 に飛ぶ・0 から飛ぶと「プツッ」と聞こえる
test("映像が止まったら、鳴っている音を絞りきってから止める", () => {
  const { video, worker, context } = setup();
  worker.pcm(1, 10.0);
  const node = context.sources[0]!;
  const fade = node.outputs[0]!;
  context.currentTime = 50.01;
  video.dispatchEvent(new Event("waiting"));
  expect(node.stopAt).toBeCloseTo(50.018, 8);
  expect(fade.gain.events.at(-1)).toEqual(["ramp", 0, node.stopAt!]);
});
test("止めたあとに鳴らす音は、絞っている音量とは別に、音量を上げながら鳴らす", () => {
  const { video, worker, context } = setup();
  worker.pcm(1, 10.0);
  const before = context.sources[0]!.outputs[0]!;
  context.currentTime = 50.01;
  video.dispatchEvent(new Event("waiting"));
  video.dispatchEvent(new Event("playing"));
  worker.pcm(1, 10.1);
  const after = context.sources.at(-1)!;
  expect(after.outputs[0]).not.toBe(before);
  const when = after.starts[0]![0]!;
  expect(after.outputs[0]!.gain.events.slice(-2)).toEqual([
    ["set", 0, when],
    ["ramp", 1, when + 0.008],
  ]);
});
test("続いているコマの間では音量を動かさない", () => {
  const { worker, context } = setup();
  for (let i = 0; i < 5; i++) worker.pcm(1, 10.1 + (i * 1024) / 48000);
  const fade = context.sources[0]!.outputs[0]!;
  // 1 つ目のコマで上げるだけ
  expect(fade.gain.events.filter(([kind]) => kind === "ramp")).toHaveLength(1);
});
test("コマを捨てて間が空いたら、そこからまた音量を上げながら鳴らす", () => {
  const { worker, context } = setup();
  worker.pcm(1, 10.1);
  worker.pcm(1, 10.1 + (2 * 1024) / 48000); // 1 コマ抜けた
  const fade = context.sources[0]!.outputs[0]!;
  const second = context.sources[1]!.starts[0]![0]!;
  expect(fade.gain.events.at(-1)).toEqual(["ramp", 1, second + 0.008]);
});
