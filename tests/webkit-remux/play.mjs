// @ts-nocheck -- ランナーの node でそのまま動かし、関数をページへ渡す (page.evaluate・WebDriver) 確かめるための道具なので、型は付けない
// 詰め替えを macOS の Safari で確かめる (#2884)。make.ts が作った fMP4 を、ブラウザ (`PLAY_BROWSER`) の MSE に流す。
//
//     node play.mjs <make.ts の出力先> <結果の JSON>
//
// - player-open: 製品の remux-player.ts (`REMUX_JS` に組んだもの) で、その位置から開く。観る画面と同じく、作ってすぐ play() を呼ぶ
// - player-seek: 同じく先頭から開き、`FIRST` ミリ秒流してから飛ぶ (H.265 の報告の「飛ぶと止まる」)
// - open・seek: remux-player を使わず、足し方を変えて試す (`PLAY_ORDERS`。Playwright の WebKit で切り分けたときのもの)

import {
  createReadStream,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { chromium, webkit } from "playwright";

const [root, resultPath] = process.argv.slice(2);
/** 開いた位置から 2 秒進むまで待つ上限 (ms)。手前の IDR からデコードし直すぶん、観はじめまでの時間も測る */
const WATCH = 20_000;
const FIRST = 3000;
/** 1 つの case の上限 (ms)。超えたら、そこまでの進み具合を残して次へ */
const CASE_LIMIT = 60_000;

const manifests = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) =>
    JSON.parse(readFileSync(join(root, d.name, "manifest.json"), "utf8")),
  );

/**
 * 絞り込み (環境変数。カンマ区切り。空なら全部)。ワークフローの入力から渡す
 *
 * - `PLAY_VARIANTS`: 録画の種類 (`h264-closed` など)
 * - `PLAY_VERSIONS`: 作り方 (`both`・`copy`・`fixed`・`silent`)
 * - `PLAY_KINDS`: 流し方 (`open`・`seek`・`player-open`・`player-seek`。player は remux-player.ts で流す)
 * - `PLAY_ORDERS`: 開く位置を currentTime に入れる時。`before` は足す前 (直す前の remux-player.ts)、`metadata` は先頭を読んだとき、
 *   `covered` は開く位置まで溜まったとき (直したあとの remux-player.ts)、`after` は足し終えてから
 * - `PLAY_ROUNDS`: open を何回ずつ流すか (既定 2)
 */
const pick = (name, all) => {
  const value = process.env[name] ?? "";
  return value === "" ? all : value.split(",").map((s) => s.trim());
};
const VARIANTS = pick("PLAY_VARIANTS", null);
const VERSIONS = pick("PLAY_VERSIONS", null);
const KINDS = pick("PLAY_KINDS", ["open", "seek"]);
const ORDERS = pick("PLAY_ORDERS", ["covered"]);
const ROUNDS = Number(process.env.PLAY_ROUNDS || 2);
const versionOf = (x) =>
  x.file
    .split("/")[1]
    .replace(/^[0-9_]+-/, "")
    .replace(".mp4", "");

/**
 * fMP4 の最初の映像の塊の時刻 (tfdt。秒)。開く位置との差を見るため。読めなければ null。
 * 映像のトラックは moov の hdlr が `vide` の trak、時刻の刻みはその mdhd
 */
function firstTfdt(path) {
  const bytes = readFileSync(path).subarray(0, 4 * 1024 * 1024);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at) => String.fromCharCode(...bytes.subarray(at + 4, at + 8));
  const kids = (start, end) => {
    const out = [];
    for (let at = start; at + 8 <= end;) {
      const size = view.getUint32(at);
      if (size < 8 || at + size > end) break;
      out.push([at, size]);
      at += size;
    }
    return out;
  };
  let track = null;
  let scale = null;
  for (const [at, size] of kids(0, bytes.length)) {
    if (type(at) === "moov")
      for (const [trak, trakSize] of kids(at + 8, at + size)) {
        if (type(trak) !== "trak") continue;
        let id = null;
        let video = false;
        let timescale = null;
        for (const [box, boxSize] of kids(trak + 8, trak + trakSize)) {
          if (type(box) === "tkhd")
            id = view.getUint32(box + (bytes[box + 8] === 1 ? 28 : 20));
          if (type(box) === "mdia")
            for (const [sub] of kids(box + 8, box + boxSize)) {
              if (type(sub) === "hdlr" && type(sub + 12) === "vide")
                video = true;
              if (type(sub) === "mdhd")
                timescale = view.getUint32(
                  sub + (bytes[sub + 8] === 1 ? 28 : 20),
                );
            }
        }
        if (video) {
          track = id;
          scale = timescale;
        }
      }
    if (type(at) === "moof" && track !== null && scale)
      for (const [traf, trafSize] of kids(at + 8, at + size)) {
        if (type(traf) !== "traf") continue;
        const parts = kids(traf + 8, traf + trafSize);
        const tfhd = parts.find(([b]) => type(b) === "tfhd");
        const tfdt = parts.find(([b]) => type(b) === "tfdt");
        if (
          tfhd === undefined ||
          tfdt === undefined ||
          view.getUint32(tfhd[0] + 12) !== track
        )
          continue;
        const v1 = bytes[tfdt[0] + 8] === 1;
        const time = v1
          ? Number(view.getBigUint64(tfdt[0] + 12))
          : view.getUint32(tfdt[0] + 12);
        return +(time / scale).toFixed(3);
      }
  }
  return null;
}
for (const m of manifests)
  for (const x of m.made) x.tfdt = firstTfdt(join(root, x.file));

const cases = [];
for (const m of manifests) {
  if (VARIANTS !== null && !VARIANTS.includes(m.variant)) continue;
  const start = m.made.find((x) => x.pos === 0);
  // iPhone の Safari と同じ ManagedMediaSource で流す (Mac の Safari の MediaSource でも同じ結果だった。#2884)
  const source = "ManagedMediaSource";
  for (const x of m.made) {
    if (VERSIONS !== null && !VERSIONS.includes(versionOf(x))) continue;
    const codecs = x.codecs ?? m.codecs;
    for (const order of ORDERS) {
      // 開く位置から始める場合は、同じものでも止まったり止まらなかったりしたので何回か
      if (KINDS.includes("open"))
        for (let round = 1; round <= ROUNDS; round++)
          cases.push({
            kind: "open",
            round,
            order,
            source,
            variant: m.variant,
            codecs,
            steps: [x],
          });
      if (KINDS.includes("seek") && x.pos !== 0 && x.codecs === m.codecs)
        cases.push({
          kind: "seek",
          round: 1,
          order,
          source,
          variant: m.variant,
          codecs,
          steps: [start, x],
        });
    }
    // player: 観る画面と同じく remux-player.ts で流す (`REMUX_JS` に組んだもの)。開く位置の入れ方も remux-player に任せる
    const files = Object.fromEntries(
      m.made
        .filter((y) => y.pos === 0 || versionOf(y) === versionOf(x))
        .map((y) => [y.pos, y.file]),
    );
    if (KINDS.includes("player-open"))
      for (let round = 1; round <= ROUNDS; round++)
        cases.push({
          kind: "player-open",
          round,
          order: "player",
          source,
          variant: m.variant,
          codecs,
          steps: [x],
          files,
        });
    if (KINDS.includes("player-seek") && x.pos !== 0 && x.codecs === m.codecs)
      cases.push({
        kind: "player-seek",
        round: 1,
        order: "player",
        source,
        variant: m.variant,
        codecs,
        steps: [start, x],
        files,
      });
  }
}

/** ページの中で回す。1 つの case を流して、段ごとの結果を返す */
async function inPage({ source, codecs, steps, watch, first, order, nudge }) {
  const type = `video/mp4; codecs="${codecs}"`;
  // 途中で止まっても読めるように、進み具合をここへ書く (node から読む)
  const state = { stage: "start", timeouts: [], events: [], results: [] };
  window.__state = state;
  /** `ms` で諦める。諦めたら `label` を残す */
  const wait = (promise, ms, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          state.timeouts.push(label);
          resolve("timeout");
        }, ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const mediaError = (video) =>
    video.error === null
      ? null
      : { code: video.error.code, message: video.error.message };
  const Source = window[source];
  if (typeof Source !== "function")
    return { skipped: `${source} がありません` };
  const supported = Source.isTypeSupported(type);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  if (source === "ManagedMediaSource") video.disableRemotePlayback = true;
  document.body.append(video);
  const media = new Source();
  const url = URL.createObjectURL(media);
  video.src = url;
  state.stage = "sourceopen";
  const opened = new Promise((resolve) =>
    media.addEventListener("sourceopen", resolve, { once: true }),
  );
  if ((await wait(opened, 5000, "sourceopen")) === "timeout")
    return { ...state, supported };
  media.duration = 150;
  let buffer;
  try {
    buffer = media.addSourceBuffer(type);
  } catch (error) {
    return { supported, addSourceBuffer: String(error) };
  }
  buffer.mode = "segments";
  let presented = 0;
  if (typeof video.requestVideoFrameCallback === "function") {
    const count = () => {
      presented++;
      video.requestVideoFrameCallback(count);
    };
    video.requestVideoFrameCallback(count);
  }
  const events = state.events;
  for (const name of ["error", "stalled", "waiting", "playing", "seeked"])
    video.addEventListener(name, () =>
      events.push(
        `${name}@${video.currentTime.toFixed(2)}${name === "error" ? ` ${video.error?.code} ${video.error?.message}` : ""}`,
      ),
    );
  buffer.addEventListener("error", () => events.push("sb-error"));

  const idle = () =>
    buffer.updating
      ? wait(
          new Promise((resolve) =>
            buffer.addEventListener("updateend", resolve, { once: true }),
          ),
          5000,
          "idle",
        )
      : Promise.resolve();
  const results = state.results;
  for (const [i, step] of steps.entries()) {
    const at = step.pos;
    try {
      await idle();
      if (media.readyState === "open") buffer.abort();
      if (buffer.buffered.length > 0) {
        buffer.remove(0, Number.POSITIVE_INFINITY);
        await idle();
      }
      if (at > 0 && order === "before") video.currentTime = at;
      // metadata: 先頭 (init segment) を読んだところで入れる (観る画面の `resume` が loadedmetadata で入れるのと同じ)
      if (at > 0 && order === "metadata")
        video.addEventListener(
          "loadedmetadata",
          () => {
            video.currentTime = at;
          },
          { once: true },
        );
      let placed = false;
      const stepStart = performance.now();
      state.stage = `step ${i} fetch`;
      const data = new Uint8Array(
        await (await fetch(`/files/${step.file}`)).arrayBuffer(),
      );
      let appendError = null;
      for (
        let o = 0;
        o < data.length && video.error === null;
        o += 256 * 1024
      ) {
        try {
          buffer.appendBuffer(data.subarray(o, o + 256 * 1024));
          state.stage = `step ${i} append ${o}`;
          const appended = new Promise((resolve) => {
            buffer.addEventListener("updateend", resolve, { once: true });
            buffer.addEventListener("error", resolve, { once: true });
          });
          if ((await wait(appended, 5000, `append ${i} ${o}`)) === "timeout") {
            appendError = `append が ${o} バイト目で 5 秒返りませんでした`;
            break;
          }
          // covered: 足したもので開く位置まで溜まったところで入れる (remux-player.ts の直し方)
          // covered+N: 開く位置から N 秒先まで溜まったところで入れる
          const margin = order.startsWith("covered")
            ? Number(order.split("+")[1] ?? 0)
            : null;
          if (at > 0 && margin !== null && !placed) {
            const ranges = buffer.buffered;
            for (let r = 0; r < ranges.length; r++)
              if (ranges.end(r) > at + margin) {
                video.currentTime = Math.max(at, ranges.start(r));
                placed = true;
                break;
              }
          }
        } catch (error) {
          appendError = String(error);
          break;
        }
      }
      if (at > 0 && order === "after") video.currentTime = at;
      // covered+N で N 秒先まで届かなかった (末尾まで足した)
      if (at > 0 && order.startsWith("covered") && !placed)
        video.currentTime = at;
      const quality0 = video.getVideoPlaybackQuality();
      const presented0 = presented;
      const t0 = video.currentTime;
      let playError = null;
      state.stage = `step ${i} play`;
      const playing = video.play().then(
        () => "ok",
        (error) => {
          playError = String(error);
        },
      );
      if ((await wait(playing, 3000, `play ${i}`)) === "timeout")
        playError = "play() が 3 秒返りませんでした";
      const limit = i < steps.length - 1 ? first : watch;
      const begin = performance.now();
      // 観はじめ: 読み始めてから、開いた位置より先へ進むまで
      let startup = null;
      // nudge: 流しているのに 1.5 秒進まなければ、同じ位置へ入れ直す (1 回だけ)
      let nudged = false;
      let lastTime = video.currentTime;
      let lastMoved = performance.now();
      while (performance.now() - begin < limit && video.error === null) {
        if (startup === null && video.currentTime > t0 + 0.1)
          startup = performance.now() - stepStart;
        if (video.currentTime !== lastTime) {
          lastTime = video.currentTime;
          lastMoved = performance.now();
        } else if (
          nudge &&
          !nudged &&
          !video.paused &&
          !video.seeking &&
          video.readyState >= 3 &&
          performance.now() - lastMoved > 1500
        ) {
          nudged = true;
          state.events.push(`nudge@${video.currentTime.toFixed(2)}`);
          const here = video.currentTime;
          video.currentTime = here;
        }
        if (i === steps.length - 1 && video.currentTime > t0 + 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const quality = video.getVideoPlaybackQuality();
      // デコードに失敗すると SourceBuffer が外され、buffered を読むと InvalidStateError になる
      let ranges = [];
      try {
        for (let r = 0; r < buffer.buffered.length; r++)
          ranges.push([
            +buffer.buffered.start(r).toFixed(2),
            +buffer.buffered.end(r).toFixed(2),
          ]);
      } catch (error) {
        ranges = String(error);
      }
      results.push({
        pos: at,
        file: step.file,
        from: step.from,
        first: step.first,
        appendError,
        playError,
        error:
          video.error === null
            ? null
            : { code: video.error.code, message: video.error.message },
        startTime: +t0.toFixed(3),
        currentTime: +video.currentTime.toFixed(3),
        advanced: +(video.currentTime - t0).toFixed(3),
        startupMs: startup === null ? null : Math.round(startup),
        decoded: quality.totalVideoFrames - quality0.totalVideoFrames,
        dropped: quality.droppedVideoFrames - quality0.droppedVideoFrames,
        corrupted:
          (quality.corruptedVideoFrames ?? 0) -
          (quality0.corruptedVideoFrames ?? 0),
        presented: presented - presented0,
        readyState: video.readyState,
        seeking: video.seeking,
        paused: video.paused,
        buffered: ranges,
      });
    } catch (error) {
      results.push({
        pos: at,
        file: step.file,
        from: step.from,
        first: step.first,
        exception: `${state.stage}: ${error}`,
        error: mediaError(video),
        currentTime: +video.currentTime.toFixed(3),
        readyState: video.readyState,
        decoded: video.getVideoPlaybackQuality().totalVideoFrames,
      });
      break;
    }
    if (video.error !== null) break;
  }
  state.stage = "done";
  return { supported, results, events, timeouts: state.timeouts };
}

/**
 * ページの中で回す。観る画面と同じく remux-player.ts で流す (`player-open`・`player-seek`)。
 * 観る画面と同じく、作ってすぐ play() を呼ぶ。player-seek は先頭から `first` ミリ秒流してから飛ぶ
 */
async function inPlayer({ codecs, steps, files, watch, first, kind, rechunk }) {
  const state = {
    stage: "start",
    events: [],
    results: [],
    states: [],
    timeline: [],
  };
  window.__state = state;
  const { remuxPlayer } = await import("/remux.js");
  const ranges = (r) => {
    try {
      const out = [];
      for (let i = 0; i < r.length; i++)
        out.push([+r.start(i).toFixed(3), +r.end(i).toFixed(3)]);
      return out;
    } catch (error) {
      return String(error);
    }
  };
  // iPhone と同じく ManagedMediaSource があればそれ (Chrome には無い)。SourceBuffer を控えて中の範囲を残す
  const Base = window.ManagedMediaSource ?? window.MediaSource;
  const managed = Base === window.ManagedMediaSource;
  let made = null;
  let sourceBuffer = null;
  class Source extends Base {
    constructor() {
      super();
      made = this;
      for (const name of [
        "sourceopen",
        "sourceended",
        "startstreaming",
        "endstreaming",
      ])
        this.addEventListener(name, () => state.events.push(name));
    }
    addSourceBuffer(type) {
      sourceBuffer = super.addSourceBuffer(type);
      sourceBuffer.addEventListener("error", () =>
        state.events.push("sb-error"),
      );
      return sourceBuffer;
    }
  }
  // 届いたバイト数を数える (中身は変えない)
  const realFetch = window.fetch.bind(window);
  let received = 0;
  let largest = 0;
  window.fetch = async (...args) => {
    state.events.push(`fetch ${String(args[0]).split("/").at(-1)}`);
    const response = await realFetch(...args);
    const reader = response.body.getReader();
    // rechunk: 256 KB ずつに分けて渡す (大きな塊で止まる件と分けて見るため)
    let rest = new Uint8Array(0);
    const body = new ReadableStream({
      async pull(controller) {
        if (rest.length === 0) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          largest = Math.max(largest, value.length);
          rest = value;
        }
        const part = rechunk ? rest.subarray(0, 256 * 1024) : rest;
        rest = rest.subarray(part.length);
        received += part.length;
        controller.enqueue(part.slice());
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      headers: response.headers,
      status: response.status,
    });
  };
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  document.body.append(video);
  for (const name of [
    "error",
    "stalled",
    "waiting",
    "playing",
    "seeked",
    "seeking",
    "loadedmetadata",
    "canplay",
  ])
    video.addEventListener(name, () =>
      state.events.push(`${name}@${video.currentTime.toFixed(2)}`),
    );
  const positions = Object.keys(files).map(Number);
  // 飛んだ先に近い位置の fMP4 を返す (どれも開く位置から先が入っている)
  const url = (from) => {
    const near = positions.reduce((a, b) =>
      Math.abs(b - from) < Math.abs(a - from) ? b : a,
    );
    return `/files/${files[near]}`;
  };
  let failure = null;
  const player = remuxPlayer(
    video,
    { Source, managed },
    {
      url,
      codecs: `video/mp4; codecs="${codecs}"`,
      duration: 150,
      start: kind === "player-seek" ? 0 : steps[0].pos,
      audio: "0",
      state: (s, reason) => {
        state.states.push(`${s}${reason ? `: ${reason}` : ""}`);
        if (s === "failed") failure = reason ?? s;
      },
    },
  );
  void video.play().catch((error) => state.events.push(`play: ${error}`));
  const begin = performance.now();
  const snapshot = () => ({
    ms: Math.round(performance.now() - begin),
    currentTime: +video.currentTime.toFixed(3),
    readyState: video.readyState,
    networkState: video.networkState,
    seeking: video.seeking,
    paused: video.paused,
    buffered: ranges(video.buffered),
    seekable: ranges(video.seekable),
    sourceBuffer: sourceBuffer === null ? null : ranges(sourceBuffer.buffered),
    decoded: video.getVideoPlaybackQuality().totalVideoFrames,
  });
  if (kind === "player-seek") {
    while (performance.now() - begin < first && video.error === null)
      await new Promise((resolve) => setTimeout(resolve, 50));
    video.currentTime = steps[1].pos;
  }
  const at = steps.at(-1).pos;
  const stepStart = performance.now();
  const quality0 = video.getVideoPlaybackQuality();
  let startup = null;
  let next = 0;
  while (
    performance.now() - stepStart < watch &&
    video.error === null &&
    failure === null
  ) {
    if (startup === null && video.currentTime > at + 0.1)
      startup = performance.now() - stepStart;
    if (video.currentTime > at + 2) break;
    // 250 ms ごとに様子を残す (始めの 5 秒)
    if (performance.now() - stepStart >= next && next <= 5000) {
      state.timeline.push(snapshot());
      next += 250;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const quality = video.getVideoPlaybackQuality();
  const end = snapshot();
  const advanced = +(video.currentTime - at).toFixed(3);
  /*
   * 止まった段を言う。進んだ・エラーなら null
   * - data: いまの位置にデータが無い
   * - seek: seeking のまま
   * - decode: 位置にデータがあるのに、デコードしたコマがほとんど無い
   * - clock: デコードはしたが、時刻が進まない
   */
  const inRange = (list, t) =>
    Array.isArray(list) && list.some(([a, b]) => a <= t + 0.05 && t < b);
  const stuck =
    video.error !== null || failure !== null || advanced > 1
      ? null
      : !inRange(end.buffered, video.currentTime)
        ? "data"
        : video.seeking
          ? "seek"
          : quality.totalVideoFrames - quality0.totalVideoFrames < 2
            ? "decode"
            : "clock";
  state.results.push({
    pos: at,
    file: steps.at(-1).file,
    from: steps.at(-1).from,
    first: steps.at(-1).first,
    tfdt: steps.at(-1).tfdt ?? null,
    error:
      video.error === null
        ? null
        : { code: video.error.code, message: video.error.message },
    failure,
    stuck,
    managed,
    startTime: at,
    currentTime: +video.currentTime.toFixed(3),
    advanced,
    decoded: quality.totalVideoFrames - quality0.totalVideoFrames,
    readyState: video.readyState,
    seeking: video.seeking,
    paused: video.paused,
    startupMs: startup === null ? null : Math.round(startup),
    origin: player.origin(),
    received,
    largest,
    streaming: made?.streaming ?? null,
    msState: made?.readyState ?? null,
    end,
  });
  player.destroy();
  state.stage = "done";
  return state;
}

/*
 * **流す先のブラウザ** (`PLAY_BROWSER`)。確かめ方のせいで止まっていないかを比べるため、3 つから選ぶ。
 *
 * - `webkit`: Playwright の WebKit
 * - `chrome`: Playwright から本物の Google Chrome (`channel: "chrome"`。Playwright の Chromium は H.264 を再生できない)
 * - `safari`: 本物の Safari を safaridriver (WebDriver) で動かす。先に `sudo safaridriver --enable` と `safaridriver -p 4444` が要る
 *
 * どれも同じページを、手元の HTTP サーバから読む (Playwright の route は本文を 1 つの塊で返すので使わない)
 */
const BROWSER = process.env.PLAY_BROWSER || "webkit";

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
  if (path === "/remux.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    createReadStream(process.env.REMUX_JS).pipe(response);
    return;
  }
  if (path.startsWith("/files/")) {
    const file = join(root, path.slice("/files/".length));
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": statSync(file).size,
    });
    createReadStream(file, { highWaterMark: 64 * 1024 }).pipe(response);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>t</title><body></body>");
});
await new Promise((resolve) => server.listen(8765, "127.0.0.1", resolve));
const BASE = "http://127.0.0.1:8765/";

/** ページを開き直して `fn(args)` を回す。ブラウザごとの違いはここだけ */
async function driver() {
  if (BROWSER === "safari") {
    const at = "http://127.0.0.1:4444";
    const call = async (method, path, body) => {
      const response = await fetch(`${at}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(json.value));
      return json.value;
    };
    const session = await call("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "safari" } },
    });
    const id = session.sessionId;
    await call("POST", `/session/${id}/timeouts`, {
      script: CASE_LIMIT + 10_000,
    });
    console.log(`safari ${session.capabilities.browserVersion}`);
    return {
      async run(fn, args) {
        await call("POST", `/session/${id}/url`, { url: BASE });
        return call("POST", `/session/${id}/execute/async`, {
          script: `const done = arguments[arguments.length - 1];
            (${fn.toString()})(arguments[0]).then(done, (error) => done({ evaluateError: String(error) }));`,
          args: [args],
        });
      },
      state: async () => {
        try {
          return await call("POST", `/session/${id}/execute/sync`, {
            script: "return window.__state",
            args: [],
          });
        } catch {
          return {};
        }
      },
      async close() {
        await call("DELETE", `/session/${id}`).catch(() => undefined);
      },
    };
  }
  const browser =
    BROWSER === "chrome"
      ? await chromium.launch({
          channel: "chrome",
          headless: process.env.HEADED !== "1",
          args: ["--autoplay-policy=no-user-gesture-required"],
        })
      : await webkit.launch({ headless: process.env.HEADED !== "1" });
  console.log(`${BROWSER} ${browser.version()}`);
  let page = null;
  let context = null;
  return {
    async run(fn, args) {
      await context?.close().catch(() => undefined);
      context = await browser.newContext();
      page = await context.newPage();
      page.on("console", (m) => console.log(`  [page] ${m.text()}`));
      await page.goto(BASE);
      return page.evaluate(fn, args);
    },
    state: async () =>
      (await page?.evaluate(() => window.__state).catch(() => ({}))) ?? {},
    async close() {
      await context?.close().catch(() => undefined);
      await browser.close();
    },
  };
}

const browser = await driver();
const out = [];
console.log(`${BROWSER}、${cases.length} 件`);
for (const c of cases) {
  let result;
  try {
    result = await Promise.race([
      browser
        .run(c.kind.startsWith("player") ? inPlayer : inPage, {
          ...c,
          nudge: process.env.PLAY_NUDGE === "1",
          rechunk: process.env.PLAY_RECHUNK === "1",
          watch: WATCH,
          first: FIRST,
        })
        .catch((error) => ({ evaluateError: String(error) })),
      new Promise((resolve) => setTimeout(() => resolve(null), CASE_LIMIT)),
    ]);
    if (result === null)
      result = { caseTimeout: true, ...(await browser.state()) };
  } catch (error) {
    result = { evaluateError: String(error) };
  }
  const row = {
    browser: BROWSER,
    kind: c.kind,
    round: c.round ?? 1,
    order: c.order,
    headed: process.env.HEADED === "1",
    source: c.source,
    variant: c.variant,
    codecs: c.codecs,
    ...result,
  };
  out.push(row);
  const last = result?.results?.at(-1);
  console.log(
    `${c.kind} ${c.variant} ${c.steps.map((s) => s.file.split("/")[1]).join(" → ")}: ` +
      JSON.stringify(
        last
          ? {
              error: last.error,
              decoded: last.decoded,
              advanced: last.advanced,
              t: last.currentTime,
              rs: last.readyState,
              stuck: last.stuck,
            }
          : result,
      ),
  );
}
await browser.close();
server.close();
writeFileSync(resultPath, JSON.stringify(out, null, 2));

const lines = [
  "| 流し方 | 回 | currentTime を入れる時 | 録画 | 位置 | バージョン | -ss | 先頭のコマ (NAL・始められるか) | エラー | デコード | 進んだ秒 | 観はじめ (ms) |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];
for (const row of out) {
  const last = row.results?.at(-1);
  const file = last?.file?.split("/")[1] ?? "";
  const failure = last?.error
    ? `${last.error.code} ${last.error.message}`
    : (last?.exception ??
      last?.appendError ??
      row.skipped ??
      row.addSourceBuffer ??
      row.evaluateError ??
      "");
  const cells = [
    row.kind,
    row.round,
    row.order,
    row.variant,
    last?.pos ?? "",
    file.replace(/^.*-/, "").replace(".mp4", ""),
    last?.from ?? "",
    last?.first
      ? `${last.first.pts} (${last.first.type}, ${last.first.clean})`
      : "",
    `${failure}${row.caseTimeout ? ` (上限で打ち切り: ${row.stage})` : ""}${row.timeouts?.length ? ` [待ちきれず: ${row.timeouts.join(", ")}]` : ""}`,
    last?.decoded ?? "",
    last?.advanced ?? "",
    last?.startupMs ?? "",
  ];
  // エラーの文言に `|` が入ると列がずれる。先に `\` を重ねてから `|` の前に `\` を置く
  const escape = (cell) =>
    String(cell).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  lines.push(`| ${cells.map(escape).join(" | ")} |`);
}
writeFileSync(resultPath.replace(/\.json$/, ".md"), `${lines.join("\n")}\n`);
