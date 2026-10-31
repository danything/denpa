import { describe, expect, test } from "bun:test";

import { streamParts } from "./stream-parts";

/** 決まった大きさの断片を順に流す */
function chunks(sizes: number[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const size = sizes[i++];
      if (size === undefined) controller.close();
      else controller.enqueue(new Uint8Array(size).fill(i));
    },
  });
}

describe("streamParts", () => {
  test("決まった大きさごとに塊にし、最後の余りも渡す", async () => {
    const got: number[] = [];
    const result = await streamParts(
      chunks([4, 4, 4, 4, 3]),
      8,
      async (part) => {
        got.push(part.size);
      },
      null,
      () => {},
    );
    expect(got).toEqual([8, 8, 3]);
    expect(result).toEqual({ parts: 3, bytes: 19 });
  });

  test("塊をつなぐと、届いた中身そのまま", async () => {
    const parts: Blob[] = [];
    await streamParts(
      chunks([3, 5, 2]),
      4,
      async (part) => {
        parts.push(part);
      },
      null,
      () => {},
    );
    const joined = new Uint8Array(await new Blob(parts).arrayBuffer());
    expect([...joined]).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 3, 3]);
  });

  test("書き終わるまで次の塊を作らない", async () => {
    let writing = false;
    let overlapped = false;
    await streamParts(
      chunks([4, 4, 4]),
      4,
      async () => {
        if (writing) overlapped = true;
        writing = true;
        await new Promise((r) => setTimeout(r, 5));
        writing = false;
      },
      null,
      () => {},
    );
    expect(overlapped).toBe(false);
  });

  test("割合は 1% 変わったときだけ知らせる", async () => {
    const told: number[] = [];
    await streamParts(
      chunks(Array.from({ length: 1000 }, () => 1)),
      100,
      async () => {},
      1000,
      (p) => told.push(p),
    );
    // 0.1% ずつ届いても、知らせるのは 0〜100% の 101 回まで
    expect(told.length).toBeLessThanOrEqual(101);
    expect(told.at(-1)).toBe(1);
  });

  test("全体が分からなければ割合を知らせない", async () => {
    const told: number[] = [];
    await streamParts(
      chunks([5, 5]),
      4,
      async () => {},
      null,
      (p) => told.push(p),
    );
    expect(told).toEqual([]);
  });
});
