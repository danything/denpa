import { describe, expect, test } from "bun:test";

import {
  openPace,
  PACE_EVERY,
  PACE_STEP,
  PaceMeter,
  readPace,
  SPEED_MOST,
  SpeedMeter,
  StreamPace,
} from "./pace";
import { Connection } from "./ws";

/** **エンコードの速さ** (`SpeedMeter`)。出した映像の長さ ÷ 使った時間を、窓の中で割る */
describe("エンコードの速さ", () => {
  test("実時間で出し続ければ 1、半分しか出なければ 0.5", () => {
    const meter = new SpeedMeter();
    for (let s = 0; s <= 4; s++) meter.record(s * 1000, s, s * 1000);
    expect(meter.speed(4000)).toBe(1);
    const slow = new SpeedMeter();
    for (let s = 0; s <= 4; s++) slow.record(s * 1000, s / 2, s * 1000);
    expect(slow.speed(4000)).toBe(0.5);
  });

  test("測った幅が 1 秒に満たないうちは測れていない", () => {
    const meter = new SpeedMeter();
    meter.record(0, 0, 0);
    meter.record(500, 0.5, 500);
    expect(meter.speed(500)).toBeNull();
    expect(new SpeedMeter().speed(0)).toBeNull();
  });

  test("窓 (5 秒) より古い点は使わない", () => {
    const meter = new SpeedMeter();
    // 初めの 10 秒は遅く、あとの 5 秒は実時間
    for (let s = 0; s <= 10; s++) meter.record(s * 1000, s / 4, s * 1000);
    for (let s = 11; s <= 15; s++)
      meter.record(s * 1000, 2.5 + (s - 10), s * 1000);
    expect(meter.speed(15_000)).toBe(1);
  });

  test("使った時間が 0 (ffmpeg を待たずに済んでいる) なら上限", () => {
    const meter = new SpeedMeter();
    meter.record(0, 0, 0);
    meter.record(2000, 2, 0);
    expect(meter.speed(2000)).toBe(SPEED_MOST);
  });
});

/** **`pace` をいつ送るか** (`PaceMeter`)。2 秒ごとか、塊を捨てた・溜まりが動いたとき */
describe("pace を送る頃合い", () => {
  test("何も変わらなければ 2 秒ごと", () => {
    const meter = new PaceMeter();
    expect(meter.next(0, 0, 0, 1)).toEqual({
      backlog: 0,
      dropped: 0,
      speed: 1,
    });
    expect(meter.next(500, 0, 0, 1)).toBeNull();
    expect(meter.next(PACE_EVERY, 0, 0, 1)).not.toBeNull();
  });

  test("捨てたら待たずに送り、捨てた数は前に送ってからのぶん", () => {
    const meter = new PaceMeter();
    meter.next(0, 0, 0, null);
    expect(meter.next(500, 0, 3, null)).toEqual({
      backlog: 0,
      dropped: 3,
      speed: null,
    });
    expect(meter.next(1000, 0, 3, null)).toBeNull();
    expect(meter.next(1500, 0, 5, null)?.dropped).toBe(2);
  });

  test("溜まりが大きく動いたら待たずに送る", () => {
    const meter = new PaceMeter();
    meter.next(0, 0, 0, 1);
    expect(meter.next(500, PACE_STEP - 1, 0, 1)).toBeNull();
    expect(meter.next(1000, PACE_STEP, 0, 1)?.backlog).toBe(PACE_STEP);
  });
});

/** **HTTP の変換の具合** (`StreamPace`・`openPace`)。写すだけなら速さは null、閉じたら読めない */
describe("HTTP の具合", () => {
  test("写すだけなら速さは null。回線の溜まりと捨てた数は HTTP では 0", () => {
    const copy = new StreamPace(false);
    copy.output(new Uint8Array([1, 2, 3]));
    expect(copy.read()).toEqual({ backlog: 0, dropped: 0, speed: null });
  });

  test("ヘッダで返す id で読め、閉じたら null", () => {
    const opened = openPace(() => ({ backlog: 0, dropped: 0, speed: 0.8 }));
    expect(readPace(opened.id)).toEqual({ backlog: 0, dropped: 0, speed: 0.8 });
    opened.close();
    expect(readPace(opened.id)).toBeNull();
    expect(readPace("知らない")).toBeNull();
  });
});

/** **WebSocket が捨てた塊の数** (`Connection.dropped`)。溜まりが上限を超えたら、捨ててよいものだけ捨てて数える */
describe("WebSocket の溜まり", () => {
  test("溜まりすぎたら捨ててよいものだけ捨てて数え、ほかは送る", () => {
    let buffered = 0;
    let sent = 0;
    const socket = {
      getBufferedAmount: () => buffered,
      sendBinary: () => {
        sent++;
      },
    };
    const connection = new Connection(socket as never);
    connection.send(1, 0n, new Uint8Array(1), true);
    expect(sent).toBe(1);
    expect(connection.dropped).toBe(0);
    buffered = 8 * 1024 * 1024;
    expect(connection.backlog).toBe(buffered);
    connection.send(1, 0n, new Uint8Array(1), true);
    connection.send(1, 0n, new Uint8Array(1), true);
    connection.send(0x40, 0n, new Uint8Array(1));
    expect(connection.dropped).toBe(2);
    expect(sent).toBe(2);
  });
});
