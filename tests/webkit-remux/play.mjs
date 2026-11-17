// @ts-nocheck -- ランナーの node でそのまま動かし、関数をページへ渡す (page.evaluate) 確かめるための道具なので、型は付けない
// 詰め替えを macOS の WebKit で確かめる (#2884)。make.ts が作った fMP4 を、Playwright の WebKit (macOS) で MSE に流す。
//
//     node play.mjs <make.ts の出力先> <結果の JSON>
//
// 流し方は src/lib/remux-player.ts と同じ (mode = "segments"、尺を先に渡す、開く位置を足す前に currentTime へ入れる、
// 飛ぶときは abort → remove(0, ∞) → 足し直す)。
//
// - open: 新しい <video> で、その位置の fMP4 を足して再生する
// - seek: 先頭の fMP4 を足して `FIRST` ミリ秒再生したあと、その位置へ飛んで足し直す (H.265 の報告の「飛ぶと止まる」)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { webkit } from "playwright";

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

const cases = [];
for (const m of manifests) {
  const start = m.made.find((x) => x.pos === 0);
  // iPhone の Safari と同じ ManagedMediaSource で流す (Mac の Safari の MediaSource でも同じ結果だった。#2884)
  for (const source of ["ManagedMediaSource"])
    for (const x of m.made) {
      // 開く位置から始める場合は、同じものでも止まったり止まらなかったりしたので 2 回ずつ
      for (const round of [1, 2])
        cases.push({
          kind: "open",
          round,
          source,
          variant: m.variant,
          codecs: m.codecs,
          steps: [x],
        });
      if (x.pos !== 0 && source === "ManagedMediaSource")
        cases.push({
          kind: "seek",
          source,
          variant: m.variant,
          codecs: m.codecs,
          steps: [start, x],
        });
    }
}

/** ページの中で回す。1 つの case を流して、段ごとの結果を返す */
async function inPage({ source, codecs, steps, watch, first }) {
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
      if (at > 0) video.currentTime = at;
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
        } catch (error) {
          appendError = String(error);
          break;
        }
      }
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
      while (performance.now() - begin < limit && video.error === null) {
        if (startup === null && video.currentTime > t0 + 0.1)
          startup = performance.now() - stepStart;
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

const browser = await webkit.launch({ headless: process.env.HEADED !== "1" });
const out = [];
console.log(`webkit ${browser.version()}、${cases.length} 件`);
for (const c of cases) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => console.log(`  [page] ${m.text()}`));
  await page.route("http://t.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/files/"))
      return route.fulfill({
        path: join(root, path.slice("/files/".length)),
        contentType: "video/mp4",
      });
    return route.fulfill({
      body: "<!doctype html><title>t</title><body></body>",
      contentType: "text/html",
    });
  });
  await page.goto("http://t.test/");
  let result;
  try {
    result = await Promise.race([
      // 打ち切ったあとに context を閉じると、この evaluate は失敗する。それで node を落とさない
      page
        .evaluate(inPage, { ...c, watch: WATCH, first: FIRST })
        .catch((error) => ({ evaluateError: String(error) })),
      new Promise((resolve) => setTimeout(() => resolve(null), CASE_LIMIT)),
    ]);
    if (result === null)
      result = {
        caseTimeout: true,
        ...(await page.evaluate(() => window.__state).catch(() => ({}))),
      };
  } catch (error) {
    result = { evaluateError: String(error) };
  }
  await Promise.race([
    context.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  const row = {
    kind: c.kind,
    round: c.round ?? 1,
    source: c.source,
    variant: c.variant,
    codecs: c.codecs,
    ...result,
  };
  out.push(row);
  const last = result.results?.at(-1);
  console.log(
    `${c.kind} ${c.source} ${c.variant} ${c.steps.map((s) => s.file.split("/")[1]).join(" → ")}: ` +
      JSON.stringify(
        last
          ? {
              error: last.error,
              decoded: last.decoded,
              advanced: last.advanced,
              t: last.currentTime,
              rs: last.readyState,
              append: last.appendError,
              play: last.playError,
              timeouts: result.timeouts,
              stage: result.stage,
            }
          : result,
      ),
  );
}
await browser.close();
writeFileSync(resultPath, JSON.stringify(out, null, 2));

const lines = [
  "| 流し方 | 回 | MSE | 録画 | 位置 | バージョン | -ss | 先頭のコマ (NAL・始められるか) | エラー | デコード | 進んだ秒 | 観はじめ (ms) |",
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
    row.source,
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
