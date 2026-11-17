/**
 * **サーバがその場で流す fMP4 を `<video>` に流す** (`/api/recordings/<id>/stream`。決め方は `ts/playback.ts`、
 * 作り方は `server/playback.ts`)。詰め替え (映像は写すだけ) も、その場の変換も同じ受け方。
 *
 * 観る画面はそれまでどおり `<video>` の `currentTime`・`duration`・`playbackRate` を触るだけで
 * 済むようにする。ここが受け持つのは、飛んだ先が溜まっていなければ**そこからリクエストし直す**ことと、
 * 先へ溜めすぎないこと、回線に合わせて段を替えるときに**継ぎ目なく切り替える**こと (`switchTo`)。
 *
 * - **尺は先に渡す** (`MediaSource.duration`)。バーは最初から全長で出て、続きの位置へも飛べる
 * - **ストリームの時刻はページの物差しのまま** (`PlayAxis`)。字幕・チャプター・データ放送は
 *   `currentTime` で引いているので、そのまま合う
 * - 溜めるのは先 `AHEAD` 秒まで、後ろは `BEHIND` 秒まで。iPhone は溜められる量が小さい
 * - `ManagedMediaSource` (iPhone) は**送り込んでよい間をブラウザが知らせる** (`startstreaming`・`endstreaming`)。止められている間は読まない
 * - 切れたら、溜まっているぶんの続きからリクエストし直す (1 秒→2 秒→…10 秒で頭打ち、続けて 8 回で打ち切る)。
 *   観る画面の繋ぎ直し (`recover`) と同じ数。溜まっているぶんは捨てずに再生し続け、継ぎ方は段の切り替え (`switchTo`) と同じ
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
  failureText,
  PACE_HEADER,
  type Ranges,
  retryable,
  RUNG_HEADER,
  type StreamCause,
  streamOrigin,
  StreamRetry,
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
/**
 * 1 回に足す上限 (バイト)。読むのを止めている間にブラウザが溜めたぶんは 1 回の読み出しでまとめて返る (`aheadLimit`)。
 * 空の SourceBuffer に溜められる量を超える塊は、後ろを捨てても足せず (`QuotaExceededError`)、観て減るのを待ったまま止まる
 * (手元から速く届くと、Safari は 1 回で 20〜36 MB を返した。Chrome は 2 MB まで。`.github/workflows/webkit-remux.yml`。#2884)
 */
const APPEND_MOST = 1024 * 1024;

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
  /** 繋ぎ直している・打ち切った・戻った・混んでいて断られた。打ち切ったときは理由 (`failureText`) を添える */
  state(state: StreamState, reason?: string): void;
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
  /** 最後にリクエストしたきっかけと位置、いまの再生位置 (幕に添える 1 文。`ts/playback.ts` の `streamOrigin`) */
  origin(): string;
  /** 受け取りの速さ (bit/s。`ts/meter.ts`)。まだ測れていなければ null */
  throughput(): number | null;
  /** 閉じる。読んでいるストリームを切る (サーバの ffmpeg も止まる) */
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
  /** 最後にリクエストしたきっかけと位置 (`origin`) */
  let cause: StreamCause = "open";
  let causeFrom = options.start;
  let audio = options.audio;
  const retry = new StreamRetry((state) => options.state(state));
  let closed = false;
  /** MediaSource が開いたか (`sourceopen`)。開く前の位置の変更は、開いてから始める位置に入る */
  let opened = false;
  /** 溜めすぎて待っている読み込みを起こす */
  let wake: (() => void) | null = null;
  const meter = new Meter();
  /**
   * **開く位置。溜まるまで currentTime に入れない** (`place`)。何も無いうちに入れると、macOS の WebKit は
   * seeking のまま止まるか、1 コマ映して止まることがある (MediaSource・ManagedMediaSource、headless でも画面を出しても。
   * `.github/workflows/webkit-remux.yml` で確かめた。#2884)。入れたら null
   */
  let startAt: number | null = null;
  /**
   * 開く位置を入れるまで、こちらで止めているか (`hold`)。手前のキーフレームから送ると、届いた映像の先頭が 0 秒近くに
   * あるとき、開く位置まで溜まるまでの間に先頭から映ってしまう。開く位置を入れたら流す (`release`)
   */
  let held = false;
  /** `hold` が止めて、まだ来ていない `pause` の数。`pause` は後から届くので、こちらで止めたものを数えて見分ける */
  let ownPauses = 0;
  /** いまの位置。開く位置をまだ入れていなければ、その位置 */
  const position = (): number => startAt ?? video.currentTime;

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

  /** 観て減るか、ブラウザが送り込んでよいと知らせるまで待つ (`nudge`)。待つ間は速さを数えない */
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
    const cut = position() - BEHIND;
    const first = buffered()[0];
    if (first === undefined || first[0] >= cut) return false;
    await update((target) => target.remove(0, cut), mine);
    return true;
  }

  /** 先へ溜めすぎていない・ブラウザが送り込んでよいとしている、まで待つ。待つ間は速さを数えない */
  async function room(mine: number): Promise<void> {
    for (;;) {
      if (mine !== run) return;
      // 開く位置を入れる前は、ブラウザが止めても読む (`startAt`)。止めている (`held`) 間は 0 秒のままなので、ブラウザは
      // 0 秒から先が溜まったと見て送り込みを止め (`endstreaming`)、手前のキーフレームが 30 秒より前にあると開く位置まで届かない
      const streaming =
        !picked.managed ||
        startAt !== null ||
        (media as MediaSource & { streaming?: boolean }).streaming !== false;
      const ahead = aheadOf(buffered(), position());
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
  function begin(
    from: number,
    abort: AbortController,
    why: StreamCause,
  ): number {
    const mine = ++run;
    controller?.abort();
    controller = abort;
    nudge();
    retry.cancel();
    loadingFrom = from;
    cause = why;
    causeFrom = from;
    meter.pause();
    return mine;
  }

  /** 最後にリクエストしたきっかけと位置、いまの再生位置 (`RemuxPlayer.origin`) */
  function origin(): string {
    return streamOrigin(cause, causeFrom, position());
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
      // 大きな塊は分けて足す (`APPEND_MOST`)
      for (let at = 0; at < value.length && mine === run; at += APPEND_MOST)
        await append(value.subarray(at, at + APPEND_MOST), mine);
      place();
      retry.flowing();
      // 後ろを捨てるのは足したついでに。捨てる長さが溜まってから (毎回は削らない)
      if (position() - (buffered()[0]?.[0] ?? position()) > BEHIND * 2)
        await trim(mine);
    }
    if (mine !== run) return;
    loadingFrom = null;
    // 開く位置まで届かずに終わった (尺の端より後ろを開いた)。届いた末尾に入れる
    if (startAt !== null) {
      const last = buffered().at(-1);
      const at = last === undefined ? startAt : Math.min(startAt, last[1]);
      startAt = null;
      video.currentTime = at;
      release();
    }
    // 末尾まで届いた。終わりを伝えない (`endOfStream`) と、最後で止まったまま `ended` が来ない
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
      const reason = [failureText(video.error, error), origin()]
        .filter((part) => part !== "")
        .join("。");
      console.warn(`[remux] 流せませんでした: ${reason}`, error);
      options.state("failed", reason);
      return;
    }
    /*
     * 倍々に待って、溜まっているぶんの続きからリクエストし直す。溜まっているぶんは捨てずに再生し続け、
     * 使い切るまでは「繋ぎ直しています」を出さない (`onWaiting`)。継ぎ方は段の切り替え (`switchTo`) と同じ
     */
    retry.schedule(
      () => void load(switchPoint(buffered(), position()), "retry", true),
      aheadOf(buffered(), position()) > 0,
    );
  }

  /**
   * `from` 秒からリクエストし直す。溜まっていたものは捨てる。`keep` なら `from` より前に溜まっているものは残す
   * (切れたあとに続きをリクエストするとき)
   */
  async function load(
    from: number,
    why: StreamCause,
    keep = false,
  ): Promise<void> {
    pendingSwitch?.abort();
    const abort = new AbortController();
    const mine = begin(from, abort, why);
    try {
      await cut(keep ? from : 0, mine);
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
    const at = switchPoint(buffered(), position());
    let response: Response;
    try {
      response = await fetch(next(at, audio), { signal: asking.signal });
    } catch {
      return "failed";
    } finally {
      if (pendingSwitch === asking) pendingSwitch = null;
    }
    // 待っている間に飛んだ・閉じた。飛んだ先は前の段のまま読んでいる
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
    const mine = begin(at, asking, "switch");
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

  /**
   * 開く位置まで溜まったら、currentTime に入れる (`startAt`)。届いたものが開く位置より後ろから始まっていれば
   * (変換は印の付いたコマの都合で少し後ろから出ることがある)、その始まりに入れる
   */
  function place(): void {
    if (startAt === null) return;
    const range = buffered().find(([, end]) => end > startAt!);
    if (range === undefined) return;
    const at = Math.max(startAt, range[0]);
    startAt = null;
    video.currentTime = at;
    release();
  }

  /** 開く位置を入れる前に流れ出したら止める (`held`)。止めるのは、流すようにリクエストされているときだけ */
  function hold(): void {
    if (startAt === null || video.paused) return;
    held = true;
    ownPauses++;
    video.pause();
  }

  /** こちらで止めたのでない一時停止 (画面が止めた)。開く位置を入れても流さない */
  function onPause(): void {
    if (ownPauses > 0) ownPauses--;
    else held = false;
  }

  /** 止めていたら流す */
  function release(): void {
    if (!held) return;
    held = false;
    void video.play().catch(() => undefined);
  }

  /** 飛んだ先が溜まっておらず、待っても届かないなら、そこからリクエストし直す */
  const onSeeking = (): void => {
    nudge();
    // 開く位置を入れる前に飛ばれた。飛んだ先を採り、止めていたら流す
    startAt = null;
    release();
    if (!opened || retry.waiting) return;
    if (!covers(buffered(), video.currentTime, loadingFrom, SLACK))
      void load(video.currentTime, "seek");
  };
  /**
   * 詰まった。読み終えたあとに戻った・ブラウザが捨てた (`ManagedMediaSource`) で
   * いまの位置が無ければ、リクエストし直す
   */
  const onWaiting = (): void => {
    nudge();
    // 続きを待ちながら溜まっているぶんを再生していて、使い切った。ここから「繋ぎ直しています」を出す
    retry.starved();
    // 開く位置まで溜まるのを待っている (`place`)
    if (startAt !== null) return;
    if (buffer === null || retry.waiting || loadingFrom !== null) return;
    if (aheadOf(buffered(), video.currentTime) === 0)
      void load(video.currentTime, "stall");
  };

  video.addEventListener("seeking", onSeeking);
  video.addEventListener("play", hold);
  video.addEventListener("pause", onPause);
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
       * **始める位置は、溜まってから入れる** (`startAt`・`place`)。それまでは、いまの位置をその位置とみなす
       * (`position`)。0 にいると見なすと、詰まり (`waiting`) で先頭からリクエストし直す
       */
      const start = Math.min(
        Math.max(0, options.start),
        Math.max(0, options.duration - 1),
      );
      startAt = start > 0 ? start : null;
      // 開く前に流すようにリクエストされていた (観る画面は作ってすぐ play() を呼ぶ)
      hold();
      void load(start, "open");
    },
    { once: true },
  );

  return {
    setAudio(id: string): void {
      if (id === audio) return;
      audio = id;
      void load(position(), "audio");
    },
    switchTo,
    origin,
    throughput: () => meter.bps(),
    destroy(): void {
      closed = true;
      run++;
      controller?.abort();
      pendingSwitch?.abort();
      nudge();
      retry.cancel();
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("play", hold);
      video.removeEventListener("pause", onPause);
      held = false;
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("timeupdate", nudge);
      media.removeEventListener("startstreaming", nudge);
      // sourceopen が来る前に閉じると、そこで解放しないまま残る (2 回解放しても害は無い)
      URL.revokeObjectURL(objectUrl);
    },
  };
}
