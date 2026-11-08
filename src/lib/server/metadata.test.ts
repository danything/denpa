import { describe, expect, test } from "bun:test";

import { config } from "./config";
import { buildThumbnailArgs, sidecarPaths, thumbnailPlace } from "./metadata";

describe("sidecarPaths", () => {
  test("拡張子を差し替えたパスになる (サムネは -poster.jpg)", () => {
    const paths = sidecarPaths("/library/番組/番組 - 2026-08-01 - 2130.mkv");
    expect(paths.thumbnail).toBe(
      "/library/番組/番組 - 2026-08-01 - 2130-poster.jpg",
    );
    expect(paths.dataBroadcast).toBe(
      "/library/番組/番組 - 2026-08-01 - 2130.bml.jsonl",
    );
  });
});

describe("buildThumbnailArgs", () => {
  test("位置ぴったりではなく thumbnail フィルタで代表のコマを選ぶ (CM 明けの黒コマを選ばない)", () => {
    const args = buildThumbnailArgs(
      "/library/番組/a.mkv",
      "/library/番組/a-poster.jpg",
      { at: 130 },
    );
    const i = args.indexOf("-vf");
    // 片方のフィールド → 正方形の画素に縮小 → 選ぶ (候補を全部持つフィルタなので、1080p のままだと GB 単位で使う)
    expect(args[i + 1]).toMatch(
      /^field=top,setsar=[^,]+,scale=\d+:[^,]+,setsar=1,thumbnail=\d+$/,
    );
    expect(args).toContain("130");
    expect(args).not.toContain("-t");
    expect(args.at(-1)).toBe("/library/番組/a-poster.jpg");
  });

  test("負の位置は 0 に丸める", () => {
    expect(buildThumbnailArgs("/a.mkv", "/a-poster.jpg", { at: -5 })).toContain(
      "0",
    );
  });

  test("読む長さと探りは入力より前に置く", () => {
    const args = buildThumbnailArgs(
      "/a.ts",
      "/a-poster.jpg",
      { at: 10, limit: 20 },
      ["-probesize", "1"],
    );
    const input = args.indexOf("-i");
    expect(args.indexOf("-ss")).toBeLessThan(input);
    expect(args[args.indexOf("-t") + 1]).toBe("20");
    expect(args.indexOf("-t")).toBeLessThan(input);
    expect(args.indexOf("-probesize")).toBeLessThan(input);
  });
});

describe("thumbnailPlace (元の TS の時刻で決める)", () => {
  const position = config.thumbnailPosition;

  test("CM 無し: 先頭を捨てた所から数える", () => {
    expect(thumbnailPlace(1800, { skip: 0.93, content: null })).toEqual({
      at: 0.93 + position,
    });
    // 短い番組は尺の 1/3
    expect(thumbnailPlace(60, { skip: 0.5, content: null })).toEqual({
      at: 20.5,
    });
    // 元の TS を渡さない (エンコードしない録画) なら動画の先頭から
    expect(thumbnailPlace(1800)).toEqual({ at: position });
  });

  test("CM がある: 本編の最初の区間の先頭から測り、区間の終わりまで読む", () => {
    expect(
      thumbnailPlace(1800, {
        skip: 0.93,
        content: { start: 95.5, end: 700 },
      }),
    ).toEqual({
      at: 95.5 + position,
      limit: 700 - 95.5 - position,
    });
    // 区間が短ければ真ん中
    expect(
      thumbnailPlace(1800, {
        skip: 0.93,
        content: { start: 100, end: 140 },
      }),
    ).toEqual({
      at: 120,
      limit: 20,
    });
  });
});
