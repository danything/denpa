import { describe, expect, test } from "bun:test";

import { afterPrevious } from "./after-previous";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

describe("afterPrevious", () => {
  test("同じ key は前の仕事が終わってから始める", async () => {
    const pending = new Map<number, Promise<void>>();
    const log: string[] = [];
    afterPrevious(
      pending,
      1,
      async () => {
        log.push("a start");
        await sleep(20);
        log.push("a end");
      },
      noop,
    );
    const second = afterPrevious(
      pending,
      1,
      async () => {
        log.push("b start");
      },
      noop,
    );
    await second;
    expect(log).toEqual(["a start", "a end", "b start"]);
  });

  test("前が失敗しても次を始め、失敗は onError に渡す", async () => {
    const pending = new Map<number, Promise<void>>();
    const errors: unknown[] = [];
    let ran = false;
    afterPrevious(
      pending,
      1,
      () => Promise.reject(new Error("boom")),
      (error) => errors.push(error),
    );
    await afterPrevious(
      pending,
      1,
      async () => {
        ran = true;
      },
      (error) => errors.push(error),
    );
    expect(ran).toBe(true);
    expect(errors).toHaveLength(1);
  });

  test("key が違えば待たない", async () => {
    const pending = new Map<number, Promise<void>>();
    const log: string[] = [];
    afterPrevious(
      pending,
      1,
      async () => {
        await sleep(20);
        log.push("one");
      },
      noop,
    );
    await afterPrevious(
      pending,
      2,
      async () => {
        log.push("two");
      },
      noop,
    );
    expect(log).toEqual(["two"]);
  });

  test("終わった仕事は覚えておかない", async () => {
    const pending = new Map<number, Promise<void>>();
    await afterPrevious(pending, 1, () => Promise.resolve(), noop);
    expect(pending.size).toBe(0);
  });
});
