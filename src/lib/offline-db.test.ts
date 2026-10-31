import { describe, expect, test } from "bun:test";

import {
  downloadRequests,
  fetchId,
  kindOf,
  offlineSource,
  parseFetchId,
} from "./offline-db";

describe("Background Fetch の登録ID", () => {
  test("作って読み戻せる (試みの印つき)", () => {
    expect(parseFetchId(fetchId(42, "encoded", "a1b2"))).toEqual({
      id: 42,
      source: "encoded",
      attempt: "a1b2",
    });
    expect(parseFetchId(fetchId(7, "alt", "zz9"))).toEqual({
      id: 7,
      source: "alt",
      attempt: "zz9",
    });
    expect(parseFetchId(fetchId(8, "hevc", "q1"))?.source).toBe("hevc");
  });

  test("印の無い古い形式も読める (付ける前に預けたぶんの残骸)", () => {
    expect(parseFetchId("rec-42-encoded")).toEqual({
      id: 42,
      source: "encoded",
      attempt: "",
    });
  });

  test("よそのIDは読まない", () => {
    expect(parseFetchId("rec-abc-encoded")).toBeNull();
    expect(parseFetchId("other-1-encoded")).toBeNull();
    expect(parseFetchId("rec-1-ts")).toBeNull();
  });
});

describe("落とすものの仕分け", () => {
  test("落とす一覧の全部が仕分けできる (取りこぼすと保存されない)", () => {
    for (const url of downloadRequests(42, "encoded")) {
      expect(kindOf(url)).not.toBeNull();
    }
  });

  test("URL から種類が分かる", () => {
    expect(kindOf("https://x/api/recordings/42/file?source=encoded")).toBe(
      "video",
    );
    // 以前の画像字幕 (PGS) はもう落とさない
    expect(kindOf("https://x/api/recordings/42/captions.sup")).toBeNull();
    expect(kindOf("https://x/api/recordings/42/captions.json")).toBe(
      "captionText",
    );
    expect(kindOf("https://x/api/recordings/42/chapters")).toBe("chapters");
    expect(kindOf("https://x/api/recordings/42/databroadcast")).toBe(
      "databroadcast",
    );
    expect(kindOf("https://x/api/recordings/42/poster")).toBe("poster");
    expect(kindOf("https://x/api/recordings/42/frame")).toBeNull();
  });
});

describe("どれを落とすか (offlineSource)", () => {
  const all = {
    library_path: "/m/番組/番組.mkv",
    hevc_path: "/m/番組/番組 [H265].mkv",
    alt_path: "/m/番組/番組 [H264].mkv",
  };
  /** この端末で観られるコーデック */
  const can =
    (...codecs: string[]) =>
    async (codec: string) =>
      codecs.includes(codec);

  test("AV1 → H.265 → H.264 の順に、観られる最初のもの", async () => {
    expect(await offlineSource(all, can("av1", "hevc", "h264"))).toBe(
      "encoded",
    );
    expect(await offlineSource(all, can("hevc", "h264"))).toBe("hevc");
    expect(await offlineSource(all, can("h264"))).toBe("alt");
  });

  test("H.265 が主 (AV1 を選ばなかった) なら主が H.265", async () => {
    const rec = {
      library_path: "/m/番組/番組 [H265].mkv",
      hevc_path: null,
      alt_path: "/m/番組/番組 [H264].mkv",
    };
    expect(await offlineSource(rec, can("hevc", "h264"))).toBe("encoded");
    expect(await offlineSource(rec, can("h264"))).toBe("alt");
  });

  test("H.264 だけの録画は、AV1 を観られない端末でも主を落とす (#1806)", async () => {
    const rec = {
      library_path: "/m/番組/番組 [H264].mkv",
      hevc_path: null,
      alt_path: null,
    };
    expect(await offlineSource(rec, can("h264"))).toBe("encoded");
  });

  test("どれも観られなければ断る", async () => {
    const rec = { ...all, alt_path: null };
    await expect(offlineSource(rec, can("h264"))).rejects.toThrow("AV1・H.265");
  });
});
