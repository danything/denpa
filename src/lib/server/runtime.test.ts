import { afterEach, describe, expect, test } from "bun:test";

import { settleThen, takeOverSignals } from "./runtime";
import { oneAtATime } from "./scheduler";

/**
 * 停止のシグナルを誰が受けるか。
 *
 * adapter は SIGTERM を受けたその場で listen を閉じる。録画が終わるまで
 * 居座る denpa では、そのせいで「Pod は生きているのに画面だけ落ちる」状態が
 * 実機で 34 分続いた。合図はこちらで受け取り、閉じるのは止まる直前だけにする。
 */
const SIGNALS = ["SIGTERM", "SIGINT"] as const;

// この場のプロセスの後始末を本当に外すので、終わったら元に戻す
const original = new Map(
  SIGNALS.map((signal) => [signal, process.listeners(signal)]),
);
afterEach(() => {
  for (const signal of SIGNALS) {
    process.removeAllListeners(signal);
    for (const listener of original.get(signal) ?? []) {
      process.on(signal, listener as () => void);
    }
  }
});

describe("停止のシグナルの受け取り", () => {
  test("先に入っていた後始末を外して、こちらだけが受ける", () => {
    let others = 0;
    const other = () => {
      others += 1;
    };
    process.on("SIGTERM", other);

    const received: string[] = [];
    const taken = takeOverSignals((signal) => received.push(signal));

    expect(taken).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("SIGTERM")).toBe(1);

    process.emit("SIGTERM");
    expect(received).toEqual(["SIGTERM"]);
    // 外したものは呼ばれない (ここが呼ばれると listen が閉じていた)
    expect(others).toBe(0);
  });

  test("SIGINT も同じ扱い。合図の名前はそのまま渡す", () => {
    const received: string[] = [];
    takeOverSignals((signal) => received.push(signal));

    process.emit("SIGINT");
    expect(received).toEqual(["SIGINT"]);
  });

  test("誰も入れていなくても壊れない", () => {
    for (const signal of SIGNALS) process.removeAllListeners(signal);

    expect(takeOverSignals(() => {})).toBe(0);
    expect(process.listenerCount("SIGTERM")).toBe(1);
  });

  /*
   * **adapter が登録するのはこちらより後。** `build/index.js` のいちばん
   * 最後で `process.on('SIGTERM', graceful_shutdown)` を入れるのに対し、
   * こちらはアプリの読み込み中に走る。1 度きりの引き取りだと**外すものがまだ
   * 無い**ので、両方が登録された状態になる。実機ではこれで、録画が続いている
   * のにポートだけ閉じて画面がどこからも開けなくなっていた
   */
  test("あとから入ってきた後始末も、引き取り直せば外れる", () => {
    for (const signal of SIGNALS) process.removeAllListeners(signal);

    const received: string[] = [];
    // 1 度目。まだ誰もいないので 0 件
    expect(takeOverSignals((signal) => received.push(signal))).toBe(0);

    // ここで adapter が入ってくる
    let closed = 0;
    process.on("SIGTERM", () => {
      closed += 1;
    });
    expect(process.listenerCount("SIGTERM")).toBe(2);

    // 2 度目の引き取りで外れる (SIGTERM の 2 件 + SIGINT に入れた自分の 1 件)
    expect(takeOverSignals((signal) => received.push(signal))).toBe(3);
    expect(process.listenerCount("SIGTERM")).toBe(1);

    process.emit("SIGTERM");
    expect(received).toEqual(["SIGTERM"]);
    // ここが 1 になると listen が閉じている
    expect(closed).toBe(0);
  });

  /*
   * **2 度目の合図でも落ちない。** `once` にしていた頃は、1 度目で自分の
   * 後始末が外れて誰も聞いていない状態になり、デプロイがもう一度走ると
   * Node の既定どおり録画の途中でも終わっていた
   */
  test("2 度目の合図は受け取るだけで、畳み直さない", () => {
    for (const signal of SIGNALS) process.removeAllListeners(signal);

    let drains = 0;
    takeOverSignals(() => {
      drains += 1;
    });

    process.emit("SIGTERM");
    process.emit("SIGTERM");

    expect(drains).toBe(1);
    // 聞き手がいなくなると Node の既定 (その場で終了) に落ちる
    expect(process.listenerCount("SIGTERM")).toBe(1);
  });

  /*
   * **起動の途中に来た合図を捨てない** (`hold-signals.ts`)。コンテナの PID 1 では
   * 受け手のいない SIGTERM が捨てられ、入れ替えの始まった Pod が 6 時間降りなかった
   */
  test("入口が取っておいた合図を、引き取ったところで受け直す", () => {
    for (const signal of SIGNALS) process.removeAllListeners(signal);
    const global = globalThis as Record<string, unknown>;
    global["__denpaHeldSignal"] = "SIGTERM";

    let drains = 0;
    const received: string[] = [];
    takeOverSignals((signal) => {
      drains += 1;
      received.push(signal);
    });
    expect(received).toEqual(["SIGTERM"]);
    // 受け直すのは 1 度だけ。あとの引き取りや合図では畳み直さない
    expect(global["__denpaHeldSignal"]).toBeUndefined();
    process.emit("SIGTERM");
    expect(drains).toBe(1);
  });

  test("取っておいた合図が無ければ、何も受けない", () => {
    const received: string[] = [];
    takeOverSignals((signal) => received.push(signal));
    expect(received).toEqual([]);
  });

  /*
   * **すき間を作らない。** 外してから入れると、その間に来た合図は PID 1 では捨てられる
   */
  test("ほかを外すときには、もう自分が聞いている", () => {
    for (const signal of SIGNALS) process.removeAllListeners(signal);
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});

    const counts: number[] = [];
    const remove = process.removeListener;
    process.removeListener = ((
      signal: NodeJS.Signals,
      listener: () => void,
    ) => {
      const result = remove.call(process, signal, listener);
      counts.push(process.listenerCount(signal));
      return result;
    }) as typeof process.removeListener;
    try {
      expect(takeOverSignals(() => {})).toBe(2);
    } finally {
      process.removeListener = remove;
    }
    expect(counts).toEqual([1, 1]);
  });
});

/**
 * カードが契約の更新 (EMM) を受け入れたという通知 (`card`) から、契約を確かめ直すまで。
 * 本物は 10 秒置くが、ここでは短くして同じ組み立て (`settleThen` と `oneAtATime`) を通す
 */
describe("card の通知で契約を確かめ直す", () => {
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  test("置いた間のあとに 1 回だけ確かめ直し、続けて来た通知は 1 回にまとめる", async () => {
    let runs = 0;
    const recheck = oneAtATime(async () => {
      runs += 1;
    });
    const onCard = settleThen(40, () => void recheck());

    onCard();
    onCard();
    await wait(10);
    onCard();
    expect(runs).toBe(0);

    await wait(80);
    expect(runs).toBe(1);

    // 間のあとに来た通知は、また 1 回
    onCard();
    await wait(80);
    expect(runs).toBe(2);
  });

  test("確かめ直している間に来たら、終わったあとに 1 回だけ走らせ直す", async () => {
    let runs = 0;
    let finish: () => void = () => {};
    const recheck = oneAtATime(async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    const first = recheck();
    expect(recheck.running).toBe(true);
    // 走っている間に何度呼ばれても、走らせ直すのは 1 回
    void recheck();
    void recheck();
    expect(runs).toBe(1);

    finish();
    await wait(0);
    expect(runs).toBe(2);
    finish();
    await first;
    expect(runs).toBe(2);
    expect(recheck.running).toBe(false);
  });
});
