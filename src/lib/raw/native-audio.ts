/**
 * ライブの映像は <video> のまま、音声だけ既存の WASM デコーダーと Web Audio で再生する。
 * WebKit の MSE → MediaElementAudioSource が音声を渡さない問題を避ける (WebKit だけ。`native-audio-choice.ts`)。
 * 同期は映像の時計に合わせ、AudioContext 上では連続する音声の間隔を保つ。
 *
 * **Audio Session はこれが持つ** (作ったら `playback`、畳んだら戻す)。音は常に Web Audio で鳴るので、
 * 言わずにおくと iOS は効果音として扱い、消音スイッチで黙り、裏へ回すと止める (`#lib/sound.ts` の `playbackSession`)
 */
import { Outlet, playbackSession } from "#lib/sound.js";

import {
  type AudioInput,
  type AudioOutput,
  audioPlan,
  MAX_PENDING_BYTES,
  type PcmChunk,
} from "./native-audio-protocol";

const TICK_MS = 20;
/**
 * 復号した PCM を持つ上限。**止めていても増え続けない**ための天井で、`HISTORY_SECONDS` とは別の歯止め。
 * float の 48kHz 2ch なら約 43 秒ぶん (このときは `HISTORY_SECONDS` が先に効く)、5.1ch なら約 14 秒ぶん
 */
const PCM_LIMIT = 16 * 1024 * 1024;
/** 観ている位置よりこれだけ前の PCM は捨てる (秒) */
const HISTORY_SECONDS = 30;
const SCHEDULE_AHEAD = 0.3;
const RESYNC_SECONDS = 0.08;

/** AudioContext の `at` 秒に、映像は `position` 秒を `rate` 倍で進んでいた */
interface Clock {
  at: number;
  position: number;
  rate: number;
}
interface Frame extends PcmChunk {
  /** PCM のバイト数 (`pcmBytes` の出し入れ) */
  bytes: number;
}
export class NativeAudio {
  private readonly context: AudioContext;
  private readonly worker: Worker;
  private readonly outlet: Outlet;
  private readonly muteGain: GainNode;
  private readonly timer: ReturnType<typeof setInterval>;
  /** `<video>`・window に付けた受け口。畳むときにまとめて外す */
  private readonly listening = new AbortController();
  private frames: Frame[] = [];
  private nodes = new Set<AudioBufferSourceNode>();
  private epoch = 0;
  /** まだ予約していない最初のコマ (`frames` の添字)。組み直す (`flush`) と 0 に戻る */
  private cursor = 0;
  private inFlight = 0;
  private pcmBytes = 0;
  private gone = false;
  private waiting = true;
  /** 映像の時計と AudioContext の時計の対応。組み直すまで同じものを使う */
  private last: Clock | null = null;
  private clockLatency = 0;
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly failed: (reason: string) => void,
    decoder: string,
  ) {
    this.context = new AudioContext({ latencyHint: "interactive" });
    let outlet: Outlet | null = null;
    try {
      this.outlet = outlet = new Outlet(
        this.context,
        (audio) => document.body.append(audio),
        (paused) => {
          if (paused) video.pause();
          else void video.play().catch(() => undefined);
        },
        "live-audio-compat",
      );
      this.muteGain = this.context.createGain();
      this.muteGain.gain.value = 0;
      this.muteGain.connect(this.outlet.input);
      this.worker = new Worker(
        new URL("./native-audio-worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      outlet?.destroy();
      void this.context.close().catch(() => undefined);
      throw error;
    }
    this.worker.onmessage = (event: MessageEvent<AudioOutput>) =>
      this.receive(event.data);
    this.worker.onerror = () =>
      this.fail("音声デコーダーでエラーが発生しました");
    this.send({ type: "load", base: decoder });
    const signal = this.listening.signal;
    const bind = (event: string, fn: () => void) =>
      video.addEventListener(event, fn, { signal });
    bind("playing", () => {
      this.waiting = false;
      this.wake();
      this.flush();
      this.tick();
    });
    for (const event of ["waiting", "seeking", "pause", "ended", "emptied"])
      bind(event, () => {
        this.waiting = true;
        this.flush();
      });
    bind("seeked", () => {
      this.waiting = video.readyState < 3;
      this.flush();
    });
    bind("ratechange", () => this.flush());
    this.timer = setInterval(() => this.tick(), TICK_MS);
    for (const event of ["pointerdown", "keydown"])
      window.addEventListener(event, this.wake, { capture: true, signal });
    this.context.onstatechange = () => this.flush();
    playbackSession(true);
    void this.context.resume().catch(() => undefined);
  }
  private send(message: AudioInput, transfer: Transferable[] = []): void {
    if (!this.gone) this.worker.postMessage(message, transfer);
  }
  private readonly wake = (): void => {
    if (!this.gone && this.context.state !== "running")
      void this.context.resume().catch(() => undefined);
  };
  setVolume(level: number): void {
    this.outlet.level = level;
  }
  setMuted(muted: boolean): void {
    this.muteGain.gain.value = muted ? 0 : 1;
    this.video.muted = true;
    if (!muted) this.wake();
  }
  /** `<audio>` を通すか (バックグラウンド再生・小窓)。Audio Session は作ったときから `playback` */
  setBackground(on: boolean): void {
    this.outlet.want(on);
  }
  feed(bytes: Uint8Array, init: boolean): void {
    if (this.gone) return;
    if (init) {
      this.epoch++;
      this.flush();
      this.frames = [];
      this.cursor = 0;
      this.pcmBytes = 0;
    }
    if (this.inFlight + bytes.byteLength > MAX_PENDING_BYTES) {
      this.fail("音声の読み込みが追いつきません");
      return;
    }
    const copy = bytes.slice();
    this.inFlight += copy.byteLength;
    this.send({ type: "segment", init, epoch: this.epoch, bytes: copy }, [
      copy.buffer,
    ]);
  }
  private receive(message: AudioOutput): void {
    if (this.gone) return;
    if (message.type === "ack") {
      this.inFlight = Math.max(0, this.inFlight - message.bytes);
      return;
    }
    if (message.type === "error") {
      this.fail(message.message);
      return;
    }
    if (message.epoch !== this.epoch) return;
    const chunk = message.chunk;
    const frame: Frame = {
      ...chunk,
      bytes: chunk.planes.reduce((n, p) => n + p.byteLength, 0),
    };
    this.frames.push(frame);
    this.pcmBytes += frame.bytes;
    while (this.pcmBytes > PCM_LIMIT && this.frames.length > 1)
      this.dropFirst();
    this.tick();
  }
  private dropFirst(): void {
    const first = this.frames.shift();
    if (first === undefined) return;
    this.pcmBytes -= first.bytes;
    this.cursor = Math.max(0, this.cursor - 1);
  }
  private flush(): void {
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        /* もう終わっている */
      }
      node.disconnect();
    }
    this.nodes.clear();
    this.cursor = 0;
    this.last = null;
  }
  private tick(): void {
    if (this.gone) return;
    const video = this.video,
      now = this.context.currentTime,
      position = video.currentTime;
    this.outlet.hold(video.paused || this.waiting);
    if (
      video.paused ||
      this.waiting ||
      video.readyState < 3 ||
      this.context.state !== "running"
    )
      return;
    const rate = video.playbackRate;
    const follow = (last: Clock) => last.position + (now - last.at) * last.rate;
    // 映像と音の対応は1つに保つ。21ms の AAC の1コマごとに video.currentTime を読み直すと、
    // 時刻の揺れがそのまま音の隙間・重なりになる。大きくずれたときだけ組み直す
    if (
      this.last !== null &&
      Math.abs(follow(this.last) - position) > RESYNC_SECONDS
    )
      this.flush();
    if (this.last === null) {
      this.last = { at: now, position, rate };
      const { baseLatency, outputLatency } = this.context;
      this.clockLatency = Math.min(
        0.25,
        Math.max(0, (baseLatency || 0) + (outputLatency || 0)),
      );
    }
    const audioPosition = follow(this.last);
    while (
      this.frames[0] !== undefined &&
      this.frames[0].pts < position - HISTORY_SECONDS
    )
      this.dropFirst();
    const latency = this.clockLatency;
    // Worker は音声の PTS 順に渡す。予約済みの次から見て、予約する先の範囲を超えたら残りは次の刻みに回す
    for (; this.cursor < this.frames.length; this.cursor++) {
      const frame = this.frames[this.cursor]!;
      if (frame.pts > audioPosition + latency + SCHEDULE_AHEAD) break;
      const length = frame.planes[0]!.length;
      const plan = audioPlan(
        frame.pts,
        length / frame.sampleRate,
        audioPosition,
        rate,
        now,
        latency,
      );
      if (plan === null) continue;
      const buffer = this.context.createBuffer(
        frame.planes.length,
        length,
        frame.sampleRate,
      );
      frame.planes.forEach((plane, ch) => buffer.copyToChannel(plane, ch));
      const node = this.context.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = rate;
      node.connect(this.muteGain);
      this.nodes.add(node);
      node.onended = () => {
        this.nodes.delete(node);
        node.disconnect();
      };
      node.start(plan.when, plan.offset, plan.duration);
    }
  }
  /** 自動再生を断られたら、通常の「音を出す」操作へ渡す。 */
  get blocked(): boolean {
    return this.context.state !== "running";
  }
  private fail(reason: string): void {
    if (this.gone) return;
    this.destroy();
    this.failed(reason);
  }
  destroy(): void {
    if (this.gone) return;
    this.gone = true;
    this.flush();
    clearInterval(this.timer);
    this.listening.abort();
    this.worker.terminate();
    this.outlet.destroy();
    this.context.onstatechange = null;
    void this.context.close().catch(() => undefined);
    playbackSession(false);
    this.frames = [];
    this.cursor = 0;
    this.pcmBytes = 0;
  }
}
