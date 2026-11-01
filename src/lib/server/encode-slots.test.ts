import { expect, test } from "bun:test";

import { type Release, slotPool } from "./encode-slots";

const signal = () => new AbortController().signal;

/** 枠と、新しいジョブを始めてよいと言われた回数 */
function pool(limit: number) {
  const calls = { free: 0 };
  const slots = slotPool(
    () => limit,
    () => calls.free++,
  );
  return { slots, calls };
}

test("ジョブは持ち枠を1つ取り、上限まで始められる", () => {
  const { slots } = pool(2);
  expect(slots.open(1)).toBe(true);
  expect(slots.open(2)).toBe(true);
  expect(slots.free()).toBe(false);
  expect(slots.open(3)).toBe(false);
  expect(slots.inUse()).toBe(2);
});

test("1本目のコーデックは持ち枠で、2本目は空いた枠でエンコードする", async () => {
  const { slots } = pool(3);
  slots.open(1);
  const first = await slots.acquire(1, signal());
  const second = await slots.acquire(1, signal());
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  // 持ち枠 + 1。数えるのは ffmpeg の本数
  expect(slots.inUse()).toBe(2);
});

test("上限がコーデックの数より小さければ、残りは枠が空いてから走る", async () => {
  const { slots } = pool(2);
  slots.open(1);
  const av1 = (await slots.acquire(1, signal()))!;
  const h264 = (await slots.acquire(1, signal()))!;
  let hevc: Release | null = null;
  const waiting = slots.acquire(1, signal()).then((r) => (hevc = r));
  await Promise.resolve();
  expect(hevc).toBeNull();
  // 待っている人がいる間は、新しいジョブを始めない (走り出したジョブを先に終わらせる)
  expect(slots.free()).toBe(false);
  h264();
  await waiting;
  expect(hevc).not.toBeNull();
  expect(slots.inUse()).toBe(2);
  av1();
  hevc!();
  // 持ち枠だけが残る
  expect(slots.inUse()).toBe(1);
});

test("上限 1 なら1本ずつ。1本目が終わると持ち枠が2本目に渡る", async () => {
  const { slots } = pool(1);
  slots.open(1);
  const first = (await slots.acquire(1, signal()))!;
  let second: Release | null = null;
  const waiting = slots.acquire(1, signal()).then((r) => (second = r));
  await Promise.resolve();
  expect(second).toBeNull();
  first();
  await waiting;
  expect(second).not.toBeNull();
  expect(slots.inUse()).toBe(1);
});

test("待っている枠は、ほかのジョブが空けた枠でも受け取れる", async () => {
  const { slots } = pool(2);
  slots.open(1);
  slots.open(2);
  await slots.acquire(1, signal());
  let extra: Release | null = null;
  const waiting = slots.acquire(1, signal()).then((r) => (extra = r));
  slots.close(2);
  await waiting;
  expect(extra).not.toBeNull();
  expect(slots.inUse()).toBe(2);
});

test("待っている間に中止されたら null。待ちが消えて新しいジョブを始められる", async () => {
  const { slots, calls } = pool(2);
  slots.open(1);
  slots.open(2);
  await slots.acquire(1, signal());
  const controller = new AbortController();
  const waiting = slots.acquire(1, controller.signal);
  controller.abort();
  expect(await waiting).toBeNull();
  slots.close(2);
  expect(slots.free()).toBe(true);
  expect(calls.free).toBeGreaterThan(0);
});

test("中止されたあとは取らない", async () => {
  const { slots } = pool(2);
  slots.open(1);
  const controller = new AbortController();
  controller.abort();
  expect(await slots.acquire(1, controller.signal)).toBeNull();
  expect(slots.inUse()).toBe(1);
});

test("ジョブが終われば持ち枠を返し、そのジョブの待ちは取り下げる", async () => {
  const { slots, calls } = pool(1);
  slots.open(1);
  await slots.acquire(1, signal());
  const waiting = slots.acquire(1, signal());
  slots.close(1);
  expect(await waiting).toBeNull();
  expect(slots.inUse()).toBe(0);
  expect(slots.free()).toBe(true);
  expect(calls.free).toBe(1);
});

test("返すのは何度呼んでも1回だけ", async () => {
  const { slots } = pool(3);
  slots.open(1);
  await slots.acquire(1, signal());
  const extra = (await slots.acquire(1, signal()))!;
  extra();
  extra();
  expect(slots.inUse()).toBe(1);
});
