// @ts-nocheck -- ランナーの node でそのまま動かし、関数をページへ渡す (page.evaluate) 確かめるための道具なので、型は付けない
// 詰め替えを macOS の WebKit で確かめる (#2884)。make.ts が作った fMP4 を、Playwright の WebKit (macOS) で MSE に流す。
//
//     node play.mjs <make.ts の出力先> <結果の JSON>
//
// 流し方は src/lib/remux-player.ts と同じ (mode = "segments"、尺を先に渡す、開く位置まで溜まってから currentTime へ入れる (`PLAY_ORDERS`)、
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

/**
 * 絞り込み (環境変数。カンマ区切り。空なら全部)。ワークフローの入力から渡す
 *
 * - `PLAY_VARIANTS`: 録画の種類 (`h264-closed` など)
 * - `PLAY_VERSIONS`: 作り方 (`both`・`copy`・`fixed`・`silent`)
 * - `PLAY_KINDS`: 流し方 (`open`・`seek`)
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
  }
}

/** ページの中で回す。1 つの case を流して、段ごとの結果を返す */
async function inPage({ source, codecs, steps, watch, first, order }) {
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
          if (at > 0 && order === "covered" && !placed) {
            const ranges = buffer.buffered;
            for (let r = 0; r < ranges.length; r++)
              if (ranges.end(r) > at) {
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
    order: c.order,
    headed: process.env.HEADED === "1",
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
