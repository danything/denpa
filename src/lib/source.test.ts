import { describe, expect, test } from "bun:test";

import { cmRedo, encodeSource, reencodeState, TS_MISSING } from "./source";

describe("エンコードの元", () => {
  test("元の TS があればそれ", () => {
    expect(encodeSource({ ts_path: "/recorded/a.m2ts" })).toBe(
      "/recorded/a.m2ts",
    );
  });

  test("元の TS が無ければ再エンコードできない", () => {
    // エンコード済みを元に再エンコードしても画質は戻らないので、ボタン自体を出さない
    expect(encodeSource({ ts_path: null })).toBeNull();
  });
});

describe("CM の再検出", () => {
  const ts = "/recorded/a.m2ts";
  const mkv = "/encoded/a.mkv";

  test("元の TS かエンコードしたものがあれば押せる", () => {
    expect(
      cmRedo({ ts_path: ts, library_path: null, cm_kept: null }).state,
    ).toBe("ok");
    expect(
      cmRedo({ ts_path: null, library_path: mkv, cm_kept: null }).state,
    ).toBe("ok");
  });

  test("読む元が無ければ出さない", () => {
    expect(
      cmRedo({ ts_path: null, library_path: null, cm_kept: null }).state,
    ).toBe("hidden");
  });

  test("CM を切ってエンコードしたものは、元の TS があれば再エンコードを促し、無ければ理由を出して押せない", () => {
    const kept = [{ start: 0, end: 100 }];
    expect(
      cmRedo({ ts_path: ts, library_path: mkv, cm_kept: kept }).state,
    ).toBe("prompt");
    const blocked = cmRedo({ ts_path: null, library_path: mkv, cm_kept: kept });
    expect(blocked.state).toBe("disabled");
    expect("reason" in blocked && blocked.reason).toContain("元の TS");
  });
});

describe("再エンコード", () => {
  const ts = "/recorded/a.m2ts";

  test("元の TS のファイルが在れば押せる", () => {
    expect(reencodeState({ ts_path: ts, ts_found: true })).toEqual({
      state: "ok",
    });
  });

  test("行に元の TS が無ければ出さない (元の TS を残さない設定でエンコードし終えた)", () => {
    expect(reencodeState({ ts_path: null, ts_found: false }).state).toBe(
      "hidden",
    );
  });

  test("行に元の TS があってもファイルが見つからなければ、理由を出して押せない (#3238)", () => {
    expect(reencodeState({ ts_path: ts, ts_found: false })).toEqual({
      state: "disabled",
      reason: TS_MISSING,
    });
  });
});
