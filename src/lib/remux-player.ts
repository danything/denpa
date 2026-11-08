/**
 * **サーバがその場で流す fMP4 を `<video>` に流す** (`/api/recordings/<id>/stream`。決め方は `ts/playback.ts`、
 * 作り方は `server/playback.ts`)。詰め替え (映像は写すだけ) も、その場の変換も同じ受け方。
 *
 * 観る画面はそれまでどおり `<video>` の `currentTime`・`duration`・`playbackRate` を触るだけで
 * 済むようにする。ここが受け持つのは、飛んだ先が溜まっていなければ**そこからリクエストし直す**ことと、
 * 先へ溜めすぎないこと、回線に合わせて段を替えるときに**継ぎ目なく切り替える**こと (`switchTo`)。
 *
 * - **尺は先に言う** (`duration`)。バーは最初から全長で出て、続きの位置へも飛べる
 * - **ストリームの時刻はページの物差しのまま** (`PlayAxis`)。字幕・チャプター・データ放送は
 *   `currentTime` で引いているので、そのまま合う
 * - 溜めるのは先 `AHEAD` 秒まで、後ろは `BEHIND` 秒まで。iPhone は溜められる量が小さい
 * - `ManagedMediaSource` (iPhone) は**送り込む頃合いをブラウザが言う**。言われていない間は読まない
 * - 切れたら観ていた位置からリクエストし直す (1 秒→2 秒→…10 秒で頭打ち、続けて 8 回で打ち切る)。
 *   観る画面の繋ぎ直し (`recover`) と同じ数
 * - **サーバが混んでいて断られたら (503) リクエストし直さない** (`busy`)。その場の変換の枠が埋まっている
 *   (`server/transcode.ts`)。待っても空くとは限らないので、画面がほかの形式を勧める
 * - **受け取りの速さを測る** (`ts/meter.ts`)。読んでいる間だけ数える。先が埋まったままだと測れないので、
 *   `PROBE_EVERY` 測れていなければ、測れるまで先の上限を外して読む (`aheadLimit`)
 */

import { UP_WAIT_WATCH } from "#lib/adapt.js";
import { mseType } from "#lib/live.js";
import { parseRung, type Rung } from "#lib/rungs.js";
import type { PickedMediaSource } from "#lib/ts/media-source.js";
import { Meter } from "#lib/ts/meter.js";
import {
  aheadOf,
  busyAnswer,
  CODEC_HEADER,
  covers,
  PACE_HEADER,
  type Ranges,
  retryable,
  retryWait,
  RUNG_HEADER,
  STREAM_RETRIES,
  type StreamState,
  switchPoint,
  typeOfCodec,
} from "#lib/ts/playback.js";

/** 先へ溜める上限 (秒) */
const AHEAD = 60;
/** 後ろに残す長さ (秒)。これより前は捨てる */
const BEHIND = 30;
/** 読んでいるストリームの末尾からこれだけ先までは、リクエストし直さずに届くのを待つ (秒。`covers`) */
const SLACK = 15;
/** 受け取りの速さをこれだけ測れていなければ、先を多めに溜めて測る (ms)。`adapt.ts` の上げるまでの待ちと同じ */
const PROBE_EVERY = UP_WAIT_WATCH;

/** リクエストする先。`from` 秒から、`audio` (`playback` の `audios` の `id`) の音声で */
export type StreamUrl = (from: number, audio: string) => string;

/** 応答のヘッダに書いてあったもの (`ts/playback.ts` の `CODEC_HEADER`・`RUNG_HEADER`・`PACE_HEADER`) */
export interface StreamHeard {
  /** 中身のコーデック (`h264` / `hevc` / `av1` / `audio`)。無ければ null */
  codec: string | null;
  rung: Rung;
  /** 送り出しの具合を読む id (`GET /api/playback/pace?id=`)。無ければ null */
  pace: string | null;
}

/**
 * 段の切り替えの結果。
 *
 * - `switched`: 新しいストリームに切り替えた
 * - `busy`: サーバが混んでいて断られた。前のストリームのまま続けている
 * - `failed`: 繋がらなかった・待つ間に飛ばれた。前のストリームのまま続けている
 */
type SwitchResult = "switched" | "busy" | "failed";

interface RemuxOptions {
  url: StreamUrl;
  /** MSE に渡す型 (`ts/playback.ts` の `streamType`)。null なら応答の `CODEC_HEADER` から決める (段を下げた変換) */
  codecs: string | null;
  /** 尺 (秒) */
  duration: number;
  /** 観はじめる位置 (秒。続きから) */
  start: number;
  /** どの音声で始めるか */
  audio: string;
  /** 繋ぎ直している・打ち切った・戻った・混んでいて断られた */
  state(state: StreamState): void;
  /** 応答を受けるたびに呼ぶ */
  heard?(stream: StreamHeard): void;
}

export interface RemuxPlayer {
  /** 音声を選び直す。**いまの位置からリクエストし直す** (選んだ 1 本だけを流しているため) */
  setAudio(id: string): void;
  /**
   * **段を替える。** 溜まっているものは、いまの位置を含む区間の末尾 (`switchPoint`) まで残して再生を続け、そこから先を
   * `url` でリクエストする。応答が来てから前のストリームを止めるので、断られたら前のまま続く。
   * コーデックが違えば `changeType` で替える (`codecs` が null なら応答の `CODEC_HEADER` から)。そのあとのシーク・
   * 繋ぎ直しも `url` でリクエストする。
   *
   * **映像の有無は替えられない** (MSE は SourceBuffer の中のトラックの数を変えられない)。音声だけとの行き来は作り直す
   */
  switchTo(codecs: string | null, url: StreamUrl): Promise<SwitchResult>;
  /** 受け取りの速さ (bit/s。`ts/meter.ts`)。まだ測れていなければ null */
  throughput(): number | null;
  /** 畳む。読んでいるストリームを切る (サーバの ffmpeg も止まる) */
  destroy(): void;
}

/** `TimeRanges` を配列にする (`ts/playback.ts` の `aheadOf` などに渡す) */
export function rangesOf(buffered: TimeRanges): Ranges {
  const out: [number, number][] = [];
  for (let i = 0; i < buffered.length; i++)
    out.push([buffered.start(i), buffered.end(i)]);
  return out;
}

/** 応答のヘッダを読む。canvas のプレイヤーで観ているときも使う (`canvas-player.ts` の `heard`) */
export function heardOf(response: Response): StreamHeard {
  return {
    codec: response.headers.get(CODEC_HEADER),
    rung: parseRung(response.headers.get(RUNG_HEADER)),
    pace: response.headers.get(PACE_HEADER),
  };
}

export function remuxPlayer(
  video: HTMLVideoElement,
  picked: PickedMediaSource,
  options: RemuxOptions,
): RemuxPlayer {
  const media = new picked.Source();
  let buffer: SourceBuffer | null = null;
  /** いまの SourceBuffer の型 */
  let bufferType: string | null = null;
  let url = options.url;
  let wanted = options.codecs;
  /** リクエストし直すたびに増やす。古いストリームの続きを捨てる目印 */
  let run = 0;
  let controller: AbortController | null = null;
  /** 応答を待っている段の切り替え。飛んだら取りやめる */
  let pendingSwitch: AbortController | null = null;
  /** 読んでいるストリームのリクエストした位置。読んでいなければ null */
  let loadingFrom: number | null = null;
  let audio = options.audio;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** MediaSource が開いたか (`sourceopen`)。開く前の位置の変更は、開いてから始める位置に入る */
  let opened = false;
  /** 溜めすぎて待っている読み込みを起こす */
  let wake: (() => void) | null = null;
  const meter = new Meter();

  const nudge = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const buffered = (): Ranges =>
    buffer === null ? [] : rangesOf(buffer.buffered);

  /** MSE に渡す型 (MP4 の `Opus` を受け取れるなら小文字に。`live.ts` の `mseType`)。`bufferType` は元の型のまま比べる */
  const forMse = (type: string): string =>
    mseType(type, (t) => picked.Source.isTypeSupported(t));

  /** SourceBuffer を作る。ストリームの時刻をそのまま使う (ページの物差し。`server/playback.ts`) */
  function createBuffer(type: string): void {
    buffer = media.addSourceBuffer(forMse(type));
    buffer.mode = "segments";
    bufferType = type;
  }

  /** 観て減るか、ブラウザが送り込んでよいと言うまで待つ (`nudge`)。待つ間は速さを数えない */
  function sleep(): Promise<void> {
    meter.pause();
    return new Promise<void>((resolve) => {
      wake = resolve;
    });
  }

  /** SourceBuffer の手が空くまで待つ */
  function idle(): Promise<void> {
    const target = buffer;
    if (target === null || !target.updating) return Promise.resolve();
    return new Promise((resolve) =>
      target.addEventListener("updateend", () => resolve(), { once: true }),
    );
  }

  /**
   * 1 つリクエストして、終わるまで待つ。読めない中身なら例外を投げる。
   *
   * `mine` を渡したら、手が空くのを待つ間にリクエストし直されていれば (`load`) 何もしない。
   * 古いストリームの残りを、新しいストリームの捨てた後へ足さないため
   */
  async function update(
    job: (target: SourceBuffer) => void,
    mine?: number,
  ): Promise<void> {
    const target = buffer;
    if (target === null) return;
    await idle();
    if (mine !== undefined && mine !== run) return;
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        target.removeEventListener("error", fail);
        resolve();
      };
      const fail = (): void => {
        target.removeEventListener("updateend", done);
        reject(new Error("SourceBuffer error"));
      };
      target.addEventListener("updateend", done, { once: true });
      target.addEventListener("error", fail, { once: true });
      try {
        job(target);
      } catch (error) {
        target.removeEventListener("updateend", done);
        target.removeEventListener("error", fail);
        reject(error);
      }
    });
  }

  /** 後ろの捨ててよいぶんを捨てる。捨てたら true */
  async function trim(mine: number): Promise<boolean> {
    const cut = video.currentTime - BEHIND;
    const first = buffered()[0];
    if (first === undefined || first[0] >= cut) return false;
    await update((target) => target.remove(0, cut), mine);
    return true;
  }

  /** 先へ溜めすぎていない・ブラウザが送り込んでよいと言っている、まで待つ。待つ間は速さを数えない */
  async function room(mine: number): Promise<void> {
    for (;;) {
      if (mine !== run) return;
      const streaming =
        !picked.managed ||
        (media as MediaSource & { streaming?: boolean }).streaming !== false;
      const ahead = aheadOf(buffered(), video.currentTime);
      if (streaming && ahead < aheadLimit()) return;
      await sleep();
    }
  }

  /**
   * 先へ溜める上限 (秒)。しばらく (`PROBE_EVERY`) 測れていなければ、測れるまで上限を外して読み続ける
   * (先が埋まったままだと、回線が戻っても上げられない)。溜められる量を越えたら、`QuotaExceededError` で後ろを捨てて待つ。
   *
   * 上限を足すだけでは足りなかった。読むのを止めている間にブラウザが溜めたぶん (手元で 2〜8 MB) は 1 回の読み出しで
   * まとめて返り、それだけで先が数十秒伸びる。10 秒・60 秒と足した上限はそれで越えてしまい、回線を待つ読み出しが 1 回も
   * 来ないまま止まった (0.8 Mbit/s を挟んで絞りを外したとき、速さが 2 Mbit/s のまま 120 秒以上変わらず、段が上がらなかった)
   */
  function aheadLimit(): number {
    const stale =
      meter.measuredAt === null ||
      performance.now() - meter.measuredAt > PROBE_EVERY;
    return stale ? Number.POSITIVE_INFINITY : AHEAD;
  }

  async function append(data: Uint8Array, mine: number): Promise<void> {
    for (;;) {
      if (mine !== run) return;
      try {
        await update(
          (target) => target.appendBuffer(data as BufferSource),
          mine,
        );
        return;
      } catch (error) {
        // 溜めきれない。後ろを捨てて入れ直す。捨てるものが無ければ観て減るのを待つ
        if (!(
          error instanceof DOMException && error.name === "QuotaExceededError"
        ))
          throw error;
        if (!(await trim(mine))) await sleep();
      }
    }
  }

  /** 新しいストリームを読み始める。前のストリームを止めて、`from` から読んでいることにする */
  function begin(from: number, abort: AbortController): number {
    const mine = ++run;
    controller?.abort();
    controller = abort;
    nudge();
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    loadingFrom = from;
    meter.pause();
    return mine;
  }

  /** 前のストリームの読みかけを落とし、`from` 秒から先を捨てる (0 なら全部) */
  async function cut(from: number, mine: number): Promise<void> {
    await idle();
    if (mine !== run || buffer === null) return;
    // 末尾まで読み終えて閉じていれば、足せば開き直る
    if (media.readyState === "open") buffer.abort();
    if (buffered().some(([, end]) => end > from))
      await update(
        (target) => target.remove(from, Number.POSITIVE_INFINITY),
        mine,
      );
  }

  /**
   * 応答の中身の型に SourceBuffer を合わせる。まだ無ければ作り、型が違えば `changeType` で替える。
   * 型が分からなければ例外を投げる
   */
  async function prepare(response: Response, mine: number): Promise<void> {
    const heard = heardOf(response);
    options.heard?.(heard);
    const type = wanted ?? typeOfCodec(heard.codec);
    if (type === null)
      throw new Error(`中身の型が分かりません: ${heard.codec}`);
    if (buffer === null) {
      createBuffer(type);
      return;
    }
    if (type === bufferType) return;
    // 古いブラウザには無い。何度リクエストし直しても同じなので、読めない中身として扱う (`retryable` で外れる)
    if (typeof buffer.changeType !== "function")
      throw new Error(`型を替えられません: ${type}`);
    await idle();
    if (mine !== run) return;
    buffer.changeType(forMse(type));
    bufferType = type;
  }

  /** 応答を末尾まで読んで足す。読めない中身なら例外を投げる */
  async function pump(response: Response, mine: number): Promise<void> {
    if (response.body === null) throw new Error("HTTP 本文がありません");
    const reader = response.body.getReader();
    for (;;) {
      await room(mine);
      if (mine !== run) {
        void reader.cancel().catch(() => undefined);
        return;
      }
      const asked = performance.now();
      const { done, value } = await reader.read();
      if (mine !== run) return;
      if (done) break;
      meter.add(value.byteLength, asked, performance.now());
      await append(value, mine);
      if (retries > 0) {
        retries = 0;
        options.state("flowing");
      }
      // 後ろを捨てるのは足したついでに。捨てる長さが溜まってから (毎回は削らない)
      if (
        video.currentTime - (buffered()[0]?.[0] ?? video.currentTime) >
        BEHIND * 2
      )
        await trim(mine);
    }
    if (mine !== run) return;
    loadingFrom = null;
    // 末尾まで届いた。終わりを言わないと、最後で止まったまま `ended` が来ない
    await idle();
    if (mine === run && media.readyState === "open") media.endOfStream();
  }

  /** 読んでいる途中で切れた・読めなかった */
  function broke(error: unknown, mine: number): void {
    if (mine !== run || closed) return;
    loadingFrom = null;
    // 切れた (繋がらない・途中で落ちた・サーバの 5xx) ならリクエストし直す。読めない中身
    // (SourceBuffer が断った) と 4xx は何度やっても同じ。画面が観られる先の案内を出す
    if (video.error !== null || !retryable(error)) {
      console.warn("[remux] 流せませんでした", error);
      options.state("failed");
      return;
    }
    retry();
  }

  /** `from` 秒からリクエストし直す。溜まっていたものは捨てる */
  async function load(from: number): Promise<void> {
    pendingSwitch?.abort();
    const abort = new AbortController();
    const mine = begin(from, abort);
    try {
      await cut(0, mine);
      if (mine !== run) return;
      const response = await fetch(url(from, audio), {
        signal: abort.signal,
      });
      /*
       * **混んでいて断られたらリクエストし直さない** (その場の変換の枠が埋まっている)。デプロイの最中の 503
       * (前段が返すもの) とは言い分で見分ける
       */
      if (response.status === 503 && (await busyAnswer(response))) {
        if (mine !== run) return;
        loadingFrom = null;
        options.state("busy");
        return;
      }
      if (!response.ok || response.body === null)
        throw new Error(`HTTP ${response.status}`);
      await prepare(response, mine);
      if (mine !== run) return;
      await pump(response, mine);
    } catch (error) {
      broke(error, mine);
    }
  }

  async function switchTo(
    codecs: string | null,
    next: StreamUrl,
  ): Promise<SwitchResult> {
    if (closed || buffer === null) return "failed";
    pendingSwitch?.abort();
    const asking = new AbortController();
    pendingSwitch = asking;
    const before = run;
    const at = switchPoint(buffered(), video.currentTime);
    let response: Response;
    try {
      response = await fetch(next(at, audio), { signal: asking.signal });
    } catch {
      return "failed";
    } finally {
      if (pendingSwitch === asking) pendingSwitch = null;
    }
    // 待っている間に飛んだ・畳んだ。飛んだ先は前の段のまま読んでいる
    if (before !== run || closed || asking.signal.aborted) {
      asking.abort();
      return "failed";
    }
    if (response.status === 503 && (await busyAnswer(response))) return "busy";
    if (!response.ok || response.body === null) {
      asking.abort();
      return "failed";
    }
    // 切り替える。前のストリームを止めて、`at` から先を新しいストリームで埋める
    const mine = begin(at, asking);
    url = next;
    wanted = codecs;
    void (async () => {
      try {
        await cut(at, mine);
        if (mine !== run) return;
        await prepare(response, mine);
        if (mine !== run) return;
        await pump(response, mine);
      } catch (error) {
        broke(error, mine);
      }
    })();
    return "switched";
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
      void load(video.currentTime);
    }, wait);
  }

  /** 飛んだ先が溜まっておらず、待っても届かないなら、そこからリクエストし直す */
  const onSeeking = (): void => {
    nudge();
    if (!opened || retryTimer !== null) return;
    if (!covers(buffered(), video.currentTime, loadingFrom, SLACK))
      void load(video.currentTime);
  };
  /**
   * 詰まった。読み終えたあとに戻った・ブラウザが捨てた (`ManagedMediaSource`) で
   * いまの位置が無ければ、リクエストし直す
   */
  const onWaiting = (): void => {
    nudge();
    if (buffer === null || retryTimer !== null || loadingFrom !== null) return;
    if (aheadOf(buffered(), video.currentTime) === 0)
      void load(video.currentTime);
  };

  video.addEventListener("seeking", onSeeking);
  video.addEventListener("waiting", onWaiting);
  video.addEventListener("timeupdate", nudge);
  media.addEventListener("startstreaming", nudge);

  /*
   * **ManagedMediaSource は AirPlay を断らないと開かない** (`ts/media-source.ts`)。
   * 付ける前に立てておく
   */
  if (picked.managed) video.disableRemotePlayback = true;
  const objectUrl = URL.createObjectURL(media);
  video.src = objectUrl;
  media.addEventListener(
    "sourceopen",
    () => {
      URL.revokeObjectURL(objectUrl);
      if (closed) return;
      media.duration = options.duration;
      opened = true;
      // 型が分かっていれば先に作る。分からなければ (段を下げた変換) 応答を受けてから (`prepare`)
      if (wanted !== null) createBuffer(wanted);
      /*
       * **始める位置を先に言っておく。** まだ何も無いうちに代入した位置は、尺が分かった
       * ところで効く。言わないと 0 にいると見なされ、詰まり (`waiting`) で先頭からリクエストし直す
       */
      const start = Math.min(
        Math.max(0, options.start),
        Math.max(0, options.duration - 1),
      );
      if (start > 0) video.currentTime = start;
      void load(start);
    },
    { once: true },
  );

  return {
    setAudio(id: string): void {
      if (id === audio) return;
      audio = id;
      void load(video.currentTime);
    },
    switchTo,
    throughput: () => meter.bps(),
    destroy(): void {
      closed = true;
      run++;
      controller?.abort();
      pendingSwitch?.abort();
      nudge();
      if (retryTimer !== null) clearTimeout(retryTimer);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("timeupdate", nudge);
      media.removeEventListener("startstreaming", nudge);
    },
  };
}
