import { describe, expect, test } from "bun:test";

import {
  type MediaSourceClass,
  pickMediaSource,
  wantsCleanStart,
} from "./media-source";

// 中身は見ない。どれが選ばれたかだけ (同じものかどうか) を見る
const fake = (): MediaSourceClass =>
  Object.assign(() => {}, {
    isTypeSupported: () => true,
  }) as unknown as MediaSourceClass;

describe("pickMediaSource", () => {
  test("MediaSource があればそちら", () => {
    const MediaSource = fake();
    const ManagedMediaSource = fake();
    expect(pickMediaSource({ MediaSource, ManagedMediaSource })).toEqual({
      Source: MediaSource,
      managed: false,
    });
  });

  test("ManagedMediaSource しか無ければ (iPhone の Safari) そちらで、managed を立てる", () => {
    const ManagedMediaSource = fake();
    expect(pickMediaSource({ ManagedMediaSource })).toEqual({
      Source: ManagedMediaSource,
      managed: true,
    });
  });

  test("どちらも無ければ null", () => {
    expect(pickMediaSource({})).toBeNull();
  });
});

describe("wantsCleanStart", () => {
  test("ManagedMediaSource があれば (WebKit) 求める。MediaSource と両方あっても同じ", () => {
    expect(wantsCleanStart({ ManagedMediaSource: fake() })).toBe(true);
    expect(
      wantsCleanStart({ MediaSource: fake(), ManagedMediaSource: fake() }),
    ).toBe(true);
  });

  test("MediaSource だけ (Chrome・Edge) なら求めない", () => {
    expect(wantsCleanStart({ MediaSource: fake() })).toBe(false);
    expect(wantsCleanStart({})).toBe(false);
  });
});
