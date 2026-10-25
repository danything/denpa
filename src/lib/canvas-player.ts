/**
 * **録画を canvas に描いて観る** (互換モード。`canvas-video.ts`)。観る画面が `<video>` を使わずに観るときのプレイヤー。
 *
 * `<video>` の再生が止まる端末 (テスラの車載ブラウザ) のための方式。サーバへのリクエストの仕方は `<video>` で
 * その場で流すとき (`remux-player.ts`) と同じ `/api/recordings/<id>/stream` で、届いたものを MSE ではなく
 * ライブ・追っかけと同じエンジン (`raw/engine.ts`) へ流す:
 *
 * - `fmp4` … H.264 / AV1 の fMP4。時刻はページの物差しのまま (`PlayAxis`)。箱の切れ目で割ってから渡す
 *   (`ts/fmp4.ts` の `Fmp4Splitter`。worker は箱ごとに受け取る)
 * - `ts-mpeg2` … 元の TS (MPEG-2)。時刻は放送の PTS なので、応答の `X-Denpa-Origin` (物差しの 0 にあたる PTS)
 *   を引いて物差しに直す (`ts/seek.ts` の `sinceHead`)
 * - `mkv` … **端末に保存した録画** (エンコード済みの Matroska)。サーバではなく Blob を切り出して読む
 *   (`mkv-source.ts`)。時刻はエンコード済みの物差しのまま
 *
 * 決め方は追っかけと同じ `follow` (`raw/playout.ts`) — 止めたら位置を保ち、そこから再開し、今へは飛ばない。
 * 録画のために足したのは:
 *
 * - **飛ぶ** … 持っているものを捨てて、飛び先からリクエストし直す (`seek`)。サーバは飛び先の少し手前 (キーフレーム・
 *   1 秒前) から流すので、手前は鳴らさず描かない (`RawEngine.reset` の `from`)。描けるまでは前の映像のまま
 * - **先へ読みすぎない** … 手元が `AHEAD` 秒を超えたら読むのを待つ (fetch のストリームはそこで詰まり、サーバも
 *   送るのを待つ)。デコードし始める前 (デコーダの読み込み中) はバイト数で区切る (`EARLY_BYTES`)
 * - **終わり** … 尻まで読んだら `finish`。残りを鳴らしきったら `ended`
 * - **切れたら** 観ていた位置からリクエストし直す (`remux-player.ts` と同じ数)。混んでいて断られたらリクエストし直さない
 *
 * 速さは等速だけ (音を自前で鳴らしている)。DOM はエンジン (`RawEngine`) が触る canvas と `<audio>` だけ
 */

import { CLOCK, WRAP } from "@doany/arib/pes";

import type { AudioSide } from "#lib/arib.js";
import { RawEngine } from "#lib/raw/engine.js";
import type { GrabSize, RawInput } from "#lib/raw/messages.js";
import { Fmp4Splitter } from "#lib/ts/fmp4.js";
import {
  busyAnswer,
  ORIGIN_HEADER,
  retryable,
  retryWait,
  STREAM_RETRIES,
  type StreamState,
} from "#lib/ts/playback.js";
import { sinceHead } from "#lib/ts/seek.js";

/** 鳴らし始めるまでに貯める長さ (秒) */
const TARGET = 1;
/** 先へ読む上限 (秒。手元の音の尺)。元の TS は重い (1 秒 2MB ほど) ので短く */
const AHEAD: Record<RawInput, number> = { fmp4: 30, mkv: 30, "ts-mpeg2": 10 };
/** デコードし始める前に渡しておく上限 (バイト)。デコーダを読み終えるまでは、手元の尺で測れない */
const EARLY_BYTES = 8 * 1024 * 1024;
/** 読むのを待つときの間 (ms) */
const WAIT = 100;
/** 時計を画面へ配る間 (ms)。字幕の貼り直し・CM の跨ぎ・データ放送はこれで回る */
const TICK = 40;
/** 尻からこれより手前へ飛んだら、リクエストせずに終わりにする (秒) */
const END_EDGE = 0.5;

interface CanvasOptions {
  /** 映像の入れ物。canvas はここに入る (データ放送が入れ物ごと動かす) */
  host: HTMLElement;
  /** この前に差し込む (字幕の canvas より下に来るように) */
  before: Element | null;
  input: RawInput;
  /**
   * `from` 秒から、`audio` (`playback` の `audios` の `id`) の音声でリクエストする。サーバの `/stream` は fetch、
   * 端末に保存した録画は Blob を切り出したもの (`mkv-source.ts`)。どちらも Response で返す
   */
  request(from: number, audio: string, signal: AbortSignal): Promise<Response>;
  /** 尺 (秒)。**ここまで飛んだらリクエストせずに終わりにする** (`<video>` が尻へ飛ぶと `ended` になるのと同じ) */
  duration: number;
  /** 観はじめる位置 (秒) */
  start: number;
  audio: string;
  /** 「再生する音」として鳴らすか (バックグラウンド再生・小窓。`RawEngine.background`) */
  background: boolean;
  /** 止めて始めるか */
  paused: boolean;
  /** 繋ぎ直している・諦めた・戻った・混んでいて断られた */
  state(state: StreamState): void;
  /** 描けなくなった (間に合わない・デコーダが転び続ける・音が来ない)。**画面がほかの方式へ移す** */
  gaveUp(reason: string): void;
  /** 外 (ロック画面・車の操作) から止められた・再開された */
  remote(paused: boolean): void;
  /** 貯めを使い切って止まった / また流れ出した (読み込み中の輪) */
  waiting(on: boolean): void;
  /** 終わりまで鳴らした */
  ended(): void;
  /** 刻み (`TICK`)。いまの位置で字幕などを合わせる */
  tick(): void;
}

export interface CanvasPlayer {
  /** いまの位置 (秒。物差しの上)。止めている・貯めている間は最後の位置 (飛んだら飛び先) */
  readonly currentTime: number;
  readonly paused: boolean;
  /** 鳴らしているか (止めている・貯めている・飛んだ直後は false) */
  readonly flowing: boolean;
  /** 音を鳴らせていない (自動再生を断られた)。押して `unmute` してもらう */
  readonly blocked: boolean;
  /** 飛ぶ。**持っているものを捨てて、そこからリクエストし直す** */
  seek(to: number): void;
  play(): void;
  pause(): void;
  mute(on: boolean): void;
  /** 音声を選び直す。fMP4 は選んだ1本だけ流れているのでリクエストし直す、元の TS はエンジンの中で選び直す */
  setAudio(id: string): void;
  /** 「再生する音」として鳴らすか */
  background(on: boolean): void;
  /** いまのコマ。`size` を付けると縮めたもの (`RawEngine.grab`) */
  grab(size?: GrabSize): Promise<ImageBitmap | null>;
  pipStream(): MediaStream | null;
  pipFlow(on: boolean): void;
  destroy(): void;
}

/** 元の TS の音声の名指し (`0:main` / `1`) を、何本目かとどちら側かに */
function tsTrack(id: string): { stream: number; side: AudioSide } {
  const match = /^(\d+)(?::(main|sub|both))?$/.exec(id);
  if (match === null) return { stream: 0, side: "both" };
  return {
    stream: Number(match[1]),
    side: (match[2] as AudioSide | undefined) ?? "both",
  };
}

/**
 * 元の TS と保存した録画の音声を、エンジンの中で選ぶ (fMP4 は選んだ1本だけがリクエストで届くので要らない)。
 * 保存した録画は何本目かだけ (デュアルモノの片側はない)
 */
function selectIn(engine: RawEngine, input: RawInput, id: string): void {
  const track = tsTrack(id);
  engine.selectAudio(track.stream, input === "mkv" ? "both" : track.side);
}

/** 写さずに worker へ渡せる形にする (塊が大きな ArrayBuffer の一部なら写す) */
function own(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  )
    return bytes.buffer;
  return bytes.slice().buffer;
}

/**
 * エンジンを作って、`start` からリクエストし始める。**エンジンを作れなければ投げる** (呼ぶ側が理由を出す)
 */
export function canvasPlayer(options: CanvasOptions): CanvasPlayer {
  const { input } = options;
  let paused = options.paused;
  let ended = false;
  /** 最後に分かった位置 (秒)。止めている・貯めている間はこれを返す */
  let time = Math.max(0, options.start);
  /** 元の TS の物差しの 0 (PTS)。ストリームごとに応答で知る */
  let origin = 0;
  let audio = options.audio;
  let run = 0;
  let controller: AbortController | null = null;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** リクエストし直してから渡したバイト数 (デコードし始める前の区切り。`EARLY_BYTES`) */
  let fed = 0;
  /** 貯めを使い切って止まっているか (読み込み中の輪) */
  let starving = false;

  const engine = new RawEngine(
    options.host,
    options.before,
    TARGET,
    {
      shown: () => undefined,
      stalled: () => {
        if (paused || ended) return;
        starving = true;
        options.waiting(true);
      },
      gaveUp: (reason) => {
        if (!closed) options.gaveUp(reason);
      },
      remote: (stop) => {
        if (stop === paused) return;
        options.remote(stop);
      },
      // 抱えきれなくなった (読む側が読みすぎないようにしているので、ふつうは来ない)。いまの位置からリクエストし直す
      full: () => {
        if (!closed) void load(position());
      },
      ended: () => finished(),
    },
    options.background,
    input,
    true,
  );
  if (paused) engine.pause();
  // 選んでいる音声で始める (選び直して作り直したとき・デュアルモノの片側)。fMP4 はリクエストに載せる
  if (input !== "fmp4") selectIn(engine, input, audio);

  /** 終わりまで観た。止めて、次の再生は頭から (`play`) */
  function finished(): void {
    ended = true;
    paused = true;
    engine.pause();
    unstarve();
    options.ended();
  }

  /** 読み込み中の輪を引っ込める */
  function unstarve(): void {
    if (!starving) return;
    starving = false;
    options.waiting(false);
  }

  /** いまの位置 (秒)。鳴らしていなければ最後の位置 */
  function position(): number {
    const at = engine.position;
    if (at === null) return time;
    const pts = Math.round(at * CLOCK);
    // 元の TS の頭の少し前 (音と映像の頭のずれ) は負になる。物差しの頭に揃える
    time = Math.max(
      0,
      input === "ts-mpeg2" ? sinceHead(pts % WRAP, origin) : pts / CLOCK,
    );
    return time;
  }

  /** 先へ読んでよいか。**手元の尺が `AHEAD` を超えたら待つ** (デコードし始める前はバイト数で) */
  async function room(mine: number): Promise<void> {
    for (;;) {
      if (mine !== run) return;
      const lead = engine.lead;
      if (lead < AHEAD[input] && (lead > 0 || fed < EARLY_BYTES)) return;
      await new Promise((resolve) => setTimeout(resolve, WAIT));
    }
  }

  /** `from` 秒からリクエストし直す。持っていたものは捨てる */
  async function load(from: number): Promise<void> {
    const mine = ++run;
    controller?.abort();
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    // 飛んだ。前の音はすぐ止める (映像は次が描けるまで前のまま)
    engine.reset();
    time = from;
    fed = 0;
    /*
     * **尻 (の手前 `END_EDGE`) へ飛んだらリクエストせずに終わり** — 最後が CM の録画で CM を飛ばした・シークバーを
     * 右端まで動かした。サーバは尻の先からは流せない (`<video>` も尻へ飛ぶと `ended` になる)
     */
    if (from >= options.duration - END_EDGE) {
      time = options.duration;
      finished();
      return;
    }
    const abort = new AbortController();
    controller = abort;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await options.request(from, audio, abort.signal);
      if (mine !== run) return;
      if (response.status === 503 && (await busyAnswer(response))) {
        if (mine === run) options.state("busy");
        return;
      }
      if (!response.ok || response.body === null)
        throw new Error(`HTTP ${response.status}`);
      let start = Math.round(from * CLOCK);
      if (input === "ts-mpeg2") {
        const header = response.headers.get(ORIGIN_HEADER);
        const head = header === null ? Number.NaN : Number(header);
        // 物差しに直せない。何度リクエストしても同じ
        if (!Number.isFinite(head))
          throw new Error(`${ORIGIN_HEADER} がありません`);
        origin = head;
        start = (((origin + start) % WRAP) + WRAP) % WRAP;
      }
      if (mine !== run) return;
      engine.reset(start);
      const splitter = input === "fmp4" ? new Fmp4Splitter() : null;
      reader = response.body.getReader();
      for (;;) {
        await room(mine);
        if (mine !== run) {
          void reader.cancel().catch(() => undefined);
          return;
        }
        const { done, value } = await reader.read();
        if (mine !== run) return;
        if (done) break;
        fed += value.length;
        if (splitter === null) engine.feed(own(value), 0);
        else
          for (const segment of splitter.feed(value))
            engine.feed(own(segment.data), 0);
        if (retries > 0) {
          retries = 0;
          options.state("flowing");
        }
      }
      // 尻まで読んだ。残りを鳴らしきったら終わり
      engine.finish();
    } catch (error) {
      // 読みかけのストリームは手放す (リクエストし直すときは新しく読む)
      void reader?.cancel().catch(() => undefined);
      if (mine !== run || closed) return;
      // 繋がらない・途中で落ちた・サーバの 5xx ならリクエストし直す。4xx・読めない中身は何度やっても同じ
      if (!retryable(error)) {
        console.warn("[canvas] 流せませんでした", error);
        options.state("failed");
        return;
      }
      retry();
    }
  }

  /** 切れた。倍々に待って、観ていた位置からリクエストし直す */
  function retry(): void {
    if (retries >= STREAM_RETRIES) {
      options.state("failed");
      return;
    }
    const wait = retryWait(retries);
    retries++;
    options.state("retrying");
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void load(position());
    }, wait);
  }

  const ticker = setInterval(() => {
    const playing = engine.playing;
    if (playing) position();
    /*
     * 貯め直して流れ出した。**流れ出した瞬間ではなく、鳴っているかで見る** — エンジンの刻みのほうが細かいので、
     * 使い切ってから流れ出すまでがこの刻みの間に収まると (読み始めの、音がまとめてデコードされてくるとき)
     * 止まったところを見ないまま、読み込み中の輪が出たままになっていた。止めている間は立てない (`stalled`)
     */
    if (playing) unstarve();
    options.tick();
  }, TICK);

  void load(time);

  return {
    get currentTime() {
      return engine.playing ? position() : time;
    },
    get paused() {
      return paused;
    },
    get flowing() {
      return engine.playing;
    },
    get blocked() {
      return engine.blocked;
    },
    seek(to: number): void {
      if (closed) return;
      ended = false;
      unstarve();
      void load(Math.max(0, to));
    },
    play(): void {
      if (closed || !paused) return;
      paused = false;
      engine.resume();
      // 終わりまで観たあとの再生は頭から (`<video>` と同じ)
      if (ended) {
        ended = false;
        void load(0);
      }
    },
    pause(): void {
      if (closed || paused) return;
      position();
      paused = true;
      engine.pause();
      unstarve();
    },
    mute(on: boolean): void {
      if (on) engine.mute();
      else engine.unmute();
    },
    setAudio(id: string): void {
      if (id === audio) return;
      audio = id;
      if (input === "fmp4") {
        void load(position());
        return;
      }
      selectIn(engine, input, id);
      // 保存した録画はトラックを選び直して、いまの位置から読み直す (音のデコーダを開き直すため)
      if (input === "mkv") void load(position());
    },
    background(on: boolean): void {
      engine.background = on;
    },
    grab: (size) => engine.grab(size),
    pipStream: () => engine.pipStream(),
    pipFlow: (on) => engine.pipFlow(on),
    destroy(): void {
      if (closed) return;
      closed = true;
      run++;
      controller?.abort();
      if (retryTimer !== null) clearTimeout(retryTimer);
      clearInterval(ticker);
      engine.destroy();
    },
  };
}
