import { describe, expect, mock, test } from "bun:test";

/**
 * canvas に描く先を作る所と、描けなくなったときの移り先 (`canvas-sink.ts`)。
 * エンジン (worker・Web Audio・canvas) は偽物に替え、作るときに渡したものと入れた消音・音量を見る
 */
class FakeEngine {
  static fail: string | null = null;
  readonly args: unknown[];
  muted = false;
  level: number | null | undefined;
  constructor(...args: unknown[]) {
    if (FakeEngine.fail !== null) throw new Error(FakeEngine.fail);
    this.args = args;
  }
  mute(): void {
    this.muted = true;
  }
  set volume(level: number | null) {
    this.level = level;
  }
}
void mock.module("../raw/engine", () => ({ RawEngine: FakeEngine }));

const { fallBackTo, openCanvas } = await import("./canvas-sink");

const events = {
  shown() {},
  stalled() {},
  gaveUp() {},
  remote() {},
  full() {},
  ended() {},
};

function options(host: HTMLElement | null = {} as HTMLElement) {
  return {
    host,
    before: null,
    target: 1,
    input: "ts-mpeg2" as const,
    follow: true,
    muted: true,
    volume: 80,
    playback: false,
    events,
  };
}

describe("openCanvas", () => {
  test("作るときに消音と音量を入れ、受け取るもの・追うか・「再生する音」をエンジンに渡す", () => {
    FakeEngine.fail = null;
    const made = openCanvas(options()) as unknown as FakeEngine;
    expect(made.muted).toBe(true);
    expect(made.level).toBe(80);
    expect(made.args.slice(2)).toEqual([1, events, false, "ts-mpeg2", true]);
  });

  test("消音していなければ消さず、音量が null (放送のまま) ならそのまま渡す", () => {
    FakeEngine.fail = null;
    const made = openCanvas({
      ...options(),
      muted: false,
      volume: null,
    }) as unknown as FakeEngine;
    expect(made.muted).toBe(false);
    expect(made.level).toBeNull();
  });

  test("エンジンを作れなければ、例外の文言を理由として返す", () => {
    FakeEngine.fail = "WebGL2 がありません";
    expect(openCanvas(options())).toBe("WebGL2 がありません");
    FakeEngine.fail = null;
  });

  test("差し込む先が無ければ作らずに理由を返す", () => {
    expect(openCanvas(options(null))).toBe("表示先がありません");
  });
});

describe("fallBackTo", () => {
  test("互換モードでエンコードしたものをやめたら、描ける MPEG-2 へ移る", () => {
    expect(fallBackTo("encoded", ["av1", "mpeg2"], true)).toBe("mpeg2");
  });

  test("互換モードでエンコードしたものをやめ、MPEG-2 も描けなければ止まる (ほかの H.264 / AV1 にも <video> にも移らない)", () => {
    expect(fallBackTo("encoded", ["av1", "h264"], true)).toBeNull();
    expect(fallBackTo("encoded", [], true)).toBeNull();
  });

  test("互換モードで MPEG-2 をやめたら、並びの先頭の H.264 / AV1 へ移る", () => {
    expect(fallBackTo("mpeg2", ["h264", "av1", "mpeg2"], true)).toBe("h264");
    expect(fallBackTo("mpeg2", ["mpeg2", "av1"], true)).toBe("av1");
  });

  test("互換モードで MPEG-2 をやめ、描ける H.264 / AV1 が無ければ止まる", () => {
    expect(fallBackTo("mpeg2", ["mpeg2"], true)).toBeNull();
    expect(fallBackTo("mpeg2", [], true)).toBeNull();
  });

  test("互換モードでなければ <video> に戻す", () => {
    expect(fallBackTo("mpeg2", [], false)).toBe("video");
    expect(fallBackTo("encoded", ["mpeg2"], false)).toBe("video");
  });
});
