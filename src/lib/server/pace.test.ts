import { describe, expect, test } from "bun:test";

import { SOURCE_GAP } from "#lib/rungs.js";

import {
  InputGaps,
  openPace,
  PACE_EVERY,
  PACE_STEP,
  PaceMeter,
  readPace,
  SPEED_MOST,
  SpeedMeter,
  StreamPace,
  timedInput,
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

  test("使った時間が実時間に占める割合 (HTTP の変換の wait)。窓より古い点は使わず、1 秒に満たなければ測れていない", () => {
    const meter = new SpeedMeter();
    // 初めの 10 秒は待たず、あとの 5 秒は 8 割待った
    for (let s = 0; s <= 10; s++) meter.record(s * 1000, s, 0);
    for (let s = 11; s <= 15; s++) meter.record(s * 1000, s, (s - 10) * 800);
    expect(meter.share(15_000)).toBe(0.8);
    const short = new SpeedMeter();
    short.record(0, 0, 0);
    short.record(500, 0.5, 500);
    expect(short.share(500)).toBeNull();
  });

  test("使った時間が 0 (ffmpeg を待たずに済んでいる) なら上限", () => {
    const meter = new SpeedMeter();
    meter.record(0, 0, 0);
    meter.record(2000, 2, 0);
    expect(meter.speed(2000)).toBe(SPEED_MOST);
  });
});

/** **`pace` をいつ送るか** (`PaceMeter`)。2 秒ごとか、塊を捨てた・バッファの量が動いたとき */
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

  test("バッファの量が大きく動いたら待たずに送る", () => {
    const meter = new PaceMeter();
    meter.next(0, 0, 0, 1);
    expect(meter.next(500, PACE_STEP - 1, 0, 1)).toBeNull();
    expect(meter.next(1000, PACE_STEP, 0, 1)?.backlog).toBe(PACE_STEP);
  });

  test("チューナーから届かなかった間 (gap) を添える。測らない経路 (null) は入れない", () => {
    const meter = new PaceMeter();
    expect(meter.next(0, 0, 0, 1, 700)).toEqual({
      backlog: 0,
      dropped: 0,
      speed: 1,
      gap: 700,
    });
    expect(meter.next(PACE_EVERY, 0, 0, 1, null)).not.toHaveProperty("gap");
  });
});

/**
 * **チューナーから届くのを待った間** (`InputGaps`・`timedInput`)。読みに行ってから届くまでだけを数え、
 * 受け取ったものを書くのを待った間は数えない
 */
describe("チューナーから届くのを待った間", () => {
  test("直近 5 秒でいちばん長い待ち。最初の塊までは選局の待ちなので数えない", () => {
    const gaps = new InputGaps();
    expect(gaps.longest(0)).toBeNull();
    const b119 = gaps.begin(0);
    gaps.end(b119, 3_000);
    expect(gaps.longest(3_000)).toBe(0);
    const b122 = gaps.begin(3_100);
    gaps.end(b122, 3_900);
    const b124 = gaps.begin(4_000);
    gaps.end(b124, 4_050);
    expect(gaps.longest(4_100)).toBe(800);
    // 窓 (5 秒) から外れた
    expect(gaps.longest(9_100)).toBe(0);
  });

  test("いま待っている最中の間も入れる", () => {
    const gaps = new InputGaps();
    const b133 = gaps.begin(0);
    gaps.end(b133, 10);
    gaps.begin(100);
    expect(gaps.longest(1_300)).toBe(1_200);
  });

  test("例外で終わった読み出しは捨てる。待っている最中と数え続けない", () => {
    const gaps = new InputGaps();
    gaps.end(gaps.begin(0), 10);
    gaps.cancel(gaps.begin(100));
    expect(gaps.longest(5_000)).toBe(0);
  });

  test("起こし直しで古い読み出しと新しい読み出しが同時に待っても、新しいほうの長さで数える", () => {
    const seen: number[] = [];
    const gaps = new InputGaps((ms) => seen.push(ms));
    gaps.end(gaps.begin(0), 10);
    gaps.begin(100);
    const fresh = gaps.begin(600);
    // 届く前は、長く待っている古いほうで数える
    expect(gaps.longest(650)).toBe(550);
    gaps.end(fresh, 700);
    expect(gaps.longest(800)).toBe(100);
    expect(seen).toEqual([]);
  });

  test("手放された古い読み出しは、新しい読み出しに届いた時点で捨てる。待っている最中と数え続けない", () => {
    const gaps = new InputGaps();
    gaps.end(gaps.begin(0), 10);
    gaps.begin(100); // end も cancel も呼ばれない
    gaps.end(gaps.begin(200), 250);
    expect(gaps.longest(9_000)).toBe(0);
  });

  test("SOURCE_GAP 以上待ったときだけ知らせる", () => {
    const seen: number[] = [];
    const gaps = new InputGaps((ms) => seen.push(ms));
    const b142 = gaps.begin(0);
    gaps.end(b142, 10);
    const b144 = gaps.begin(100);
    gaps.end(b144, 100 + SOURCE_GAP - 1);
    const b146 = gaps.begin(1_000);
    gaps.end(b146, 1_000 + SOURCE_GAP);
    expect(seen).toEqual([SOURCE_GAP]);
  });

  test("読む側が受け取ったあとに待った間 (ffmpeg に書くのを待った) は数えない", async () => {
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }
    const gaps = new InputGaps();
    for await (const _ of timedInput(source(), gaps))
      await new Promise((resolve) => setTimeout(resolve, 60));
    expect(gaps.longest(Date.now())!).toBeLessThan(50);
  });
});

/** **HTTP の変換の具合** (`StreamPace`・`openPace`)。写すだけなら速さは null、閉じたら読めない */
describe("HTTP の具合", () => {
  test("写すだけなら速さは null。回線のバッファと捨てた数は HTTP では 0", () => {
    const copy = new StreamPace(false);
    copy.output(new Uint8Array([1, 2, 3]));
    expect(copy.read()).toEqual({
      backlog: 0,
      dropped: 0,
      speed: null,
      wait: null,
    });
  });

  test("読みに来てから ffmpeg が出すまでの時間を、出したときに足す (wait は写すだけでも測る)", () => {
    // 1 秒ごとに読みに来て、0.8 秒待って出る (エンコードが届く速さを決めている)
    const bound = new StreamPace(false);
    for (let s = 0; s < 6; s++) {
      bound.ask(s * 1000);
      bound.output(new Uint8Array([1]), s * 1000 + 800);
    }
    expect(bound.read(5_800).wait).toBe(0.8);
    // 読みに来るとすぐ出る (回線のほうが遅く、ffmpeg は先に出して待っている)
    const thin = new StreamPace(false);
    for (let s = 0; s < 6; s++) {
      thin.ask(s * 1000 + 990);
      thin.output(new Uint8Array([1]), s * 1000 + 1000);
    }
    expect(thin.read(6_000).wait).toBe(0.01);
  });

  test("ヘッダで返す id で読め、閉じたら null", () => {
    const opened = openPace(() => ({ backlog: 0, dropped: 0, speed: 0.8 }));
    expect(readPace(opened.id)).toEqual({ backlog: 0, dropped: 0, speed: 0.8 });
    opened.close();
    expect(readPace(opened.id)).toBeNull();
    expect(readPace("知らない")).toBeNull();
  });
});

/** **WebSocket が捨てた塊の数** (`Connection.dropped`)。バッファが上限を超えたら、捨ててよいものだけ捨てて数える */
describe("WebSocket のバッファ", () => {
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
