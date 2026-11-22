import { describe, expect, test } from "bun:test";

import {
  PlayClock,
  PORT_GREETING,
  portFrom,
  readIncoming,
  readNotice,
} from "./embed-data";

describe("portFrom", () => {
  const self = { origin: "https://denpa.example", window: {} };
  const port = {} as MessagePort;

  test("WebView から (送り元のウィンドウが無い) 届いたポートを受ける", () => {
    expect(
      portFrom(
        { data: PORT_GREETING, origin: "", ports: [port], source: null },
        self,
      ),
    ).toBe(port);
  });

  test("同じウィンドウ・同じオリジンから届いたポートを受ける", () => {
    expect(
      portFrom(
        {
          data: PORT_GREETING,
          origin: self.origin,
          ports: [port],
          source: self.window as MessageEventSource,
        },
        self,
      ),
    ).toBe(port);
  });

  test("iframe (Hybridcast のアプリ) から届いたポートは受けない", () => {
    expect(
      portFrom(
        {
          data: PORT_GREETING,
          origin: "null",
          ports: [port],
          source: {} as MessageEventSource,
        },
        self,
      ),
    ).toBeNull();
  });

  test("同じウィンドウでもオリジンが違えば受けない", () => {
    expect(
      portFrom(
        {
          data: PORT_GREETING,
          origin: "https://other.example",
          ports: [port],
          source: self.window as MessageEventSource,
        },
        self,
      ),
    ).toBeNull();
  });

  test("中身が違う・ポートが無いものは受けない", () => {
    expect(
      portFrom({ data: "x", origin: "", ports: [port], source: null }, self),
    ).toBeNull();
    expect(
      portFrom(
        { data: PORT_GREETING, origin: "", ports: [], source: null },
        self,
      ),
    ).toBeNull();
  });
});

describe("readIncoming", () => {
  test("JSON の文字列を読み、省いた真偽値は false にする", () => {
    expect(
      readIncoming('{"type":"init","mode":"live","service":3,"open":true}'),
    ).toEqual({
      type: "init",
      mode: "live",
      service: 3,
      open: true,
      receive: false,
      captions: false,
    });
    expect(
      readIncoming({ type: "init", mode: "recording", recording: 8 }),
    ).toMatchObject({ mode: "recording", recording: 8 });
  });

  test("time は速さ 1・位置 0 を補い、air の null を通す", () => {
    expect(readIncoming({ type: "time", air: null })).toEqual({
      type: "time",
      air: null,
      pos: 0,
      rate: 1,
      paused: false,
    });
  });

  test("形の合わないものは捨てる", () => {
    expect(readIncoming("{")).toBeNull();
    expect(readIncoming({ type: "init", mode: "live" })).toBeNull();
    expect(readIncoming({ type: "key", code: "20", down: true })).toBeNull();
    expect(readIncoming({ type: "time", air: "x" })).toBeNull();
    expect(readIncoming({ type: "data", message: 1 })).toBeNull();
    expect(readIncoming({ type: "unknown" })).toBeNull();
    expect(readIncoming([1])).toBeNull();
  });
});

describe("readNotice", () => {
  test("カードの番号と Hybridcast のアプリだけ読む", () => {
    expect(readNotice({ type: "card", id: "0123" })).toEqual({
      type: "card",
      id: "0123",
    });
    expect(readNotice({ type: "hybridcast", apps: [] })).toEqual({
      type: "hybridcast",
      apps: [],
    });
    expect(readNotice({ type: "ping" })).toBeNull();
  });
});

describe("PlayClock", () => {
  test("止まっていなければ経った時間 × 速さを足す", () => {
    const clock = new PlayClock();
    clock.set(
      { type: "time", air: 1_000_000, pos: 5000, rate: 2, paused: false },
      100,
    );
    expect(clock.air(350)).toBe(1_000_500);
    expect(clock.pos(350)).toBe(5500);
  });

  test("止まっている間は進めない。air が分からなければ null", () => {
    const clock = new PlayClock();
    expect(clock.air(0)).toBeNull();
    expect(clock.pos(0)).toBe(0);
    clock.set({ type: "time", air: null, pos: 700, rate: 1, paused: true }, 0);
    expect(clock.air(1000)).toBeNull();
    expect(clock.pos(1000)).toBe(700);
  });
});
