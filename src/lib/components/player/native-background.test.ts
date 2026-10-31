import { expect, test } from "bun:test";

import { nativeBackgroundRecovery } from "./native-background";

/** 偽の `<video>`。play() を呼んだ数を数える */
class Video extends EventTarget {
  paused = false;
  ended = false;
  muted = false;
  readyState = 3;
  calls = 0;
  reject = false;
  play(): Promise<void> {
    this.calls++;
    if (this.reject) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

class Visibility extends EventTarget {
  visibilityState = "visible";
  set(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function fixture(controls = true, separateMuted?: boolean) {
  const video = new Video();
  const visibility = new Visibility();
  const page = new EventTarget();
  const state = {
    time: 0,
    enabled: true,
    paused: false,
    interrupted: false,
    separateMuted,
  };
  const handlers = new Map<string, (() => void) | null>();
  const stop = nativeBackgroundRecovery({
    video,
    page,
    visibility,
    media: controls
      ? { setActionHandler: (action, fn) => handlers.set(action, fn) }
      : undefined,
    enabled: () => state.enabled,
    userPaused: () => state.paused,
    pause: () => {
      state.paused = true;
      video.pause();
    },
    resume: () => {
      state.paused = false;
      void video.play();
    },
    interrupted: () => state.interrupted,
    audible: () => !(state.separateMuted ?? video.muted),
    now: () => state.time,
  });
  return { video, visibility, page, state, handlers, stop };
}

test("隠れる直前 (300ms 以内) と直後 (1.5 秒以内) に止められたら、1 回だけ再生し直す", () => {
  const before = fixture();
  before.state.time = 1000;
  before.video.pause();
  before.state.time = 1150;
  before.visibility.set("hidden");
  expect(before.video.calls).toBe(1);
  before.video.pause();
  expect(before.video.calls).toBe(1);
  before.stop();

  const after = fixture();
  after.visibility.set("hidden");
  after.state.time = 1100;
  after.video.pause();
  expect(after.video.calls).toBe(1);
  after.stop();
});

test("隠れるずっと前に止めたもの・隠れて 1.5 秒より後に止められたものは戻さない", () => {
  const early = fixture();
  early.video.pause();
  early.state.time = 1000;
  early.visibility.set("hidden");
  expect(early.video.calls).toBe(0);
  early.stop();

  const late = fixture();
  late.visibility.set("hidden");
  late.state.time = 2000;
  late.video.pause();
  expect(late.video.calls).toBe(0);
  late.stop();
});

test("ページのボタンとロック画面で止めたものは戻さない。ロック画面の再生は効く", () => {
  const button = fixture();
  button.state.paused = true;
  button.video.pause();
  button.visibility.set("hidden");
  expect(button.video.calls).toBe(0);
  button.stop();

  const lock = fixture();
  lock.visibility.set("hidden");
  lock.handlers.get("pause")?.();
  expect(lock.state.paused).toBe(true);
  expect(lock.video.calls).toBe(0);
  lock.state.time = 5000;
  lock.handlers.get("play")?.();
  expect(lock.state.paused).toBe(false);
  expect(lock.video.calls).toBe(1);
  lock.stop();
});

test("オフ・割り込み・消音・終わり・中身が無い・MediaSession が無い端末では戻さない", () => {
  for (const kind of [
    "disabled",
    "interrupted",
    "muted",
    "ended",
    "empty",
    "no-controls",
  ] as const) {
    const f = fixture(kind !== "no-controls");
    if (kind === "disabled") f.state.enabled = false;
    if (kind === "interrupted") f.state.interrupted = true;
    if (kind === "muted") f.video.muted = true;
    if (kind === "ended") f.video.ended = true;
    if (kind === "empty") f.video.readyState = 0;
    f.visibility.set("hidden");
    f.video.pause();
    expect(f.video.calls).toBe(0);
    f.stop();
  }
});

test("断られても繰り返さない。見えてからまた隠れれば、もう 1 回試す", async () => {
  const f = fixture();
  f.video.reject = true;
  f.visibility.set("hidden");
  f.video.pause();
  await Promise.resolve();
  f.video.dispatchEvent(new Event("pause"));
  expect(f.video.calls).toBe(1);

  f.video.reject = false;
  f.visibility.set("visible");
  f.video.paused = false;
  f.video.dispatchEvent(new Event("playing"));
  f.state.time = 3000;
  f.visibility.set("hidden");
  f.video.pause();
  expect(f.video.calls).toBe(2);
  f.stop();
});

test("pagehide のあとと、止めたあとは戻さない。止めると MediaSession の操作も外す", () => {
  const f = fixture();
  f.visibility.set("hidden");
  f.page.dispatchEvent(new Event("pagehide"));
  f.video.pause();
  expect(f.video.calls).toBe(0);
  f.stop();
  expect(f.handlers.get("pause")).toBeNull();
  expect(f.handlers.get("play")).toBeNull();
});

test("音を別に鳴らしていれば、<video> が消音でも戻す", () => {
  const f = fixture(true, false);
  f.video.muted = true;
  f.visibility.set("hidden");
  f.video.pause();
  expect(f.video.calls).toBe(1);
  f.stop();
});

test("別に鳴らす音を消音にしている・外から止められたときは戻さない", () => {
  const muted = fixture(true, true);
  muted.video.muted = true;
  muted.visibility.set("hidden");
  muted.video.pause();
  expect(muted.video.calls).toBe(0);
  muted.stop();
  const remote = fixture(true, false);
  remote.video.muted = true;
  remote.visibility.set("hidden");
  remote.handlers.get("pause")?.();
  expect(remote.video.calls).toBe(0);
  remote.stop();
});
