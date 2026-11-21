import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * 観る画面の出どころ (`feed-recording.ts`)。リクエスト先の組み立てと、段 0 のビットレートを見る。
 * `$app/paths` は SvelteKit が組むときに入れるものなので、前段の接頭辞 (`/denpa/`) を付ける偽物に替える
 */
void mock.module("$app/paths", () => ({
  resolve: (path: string) => `/denpa/${path}`,
}));

const { RecordingFeed, playable } = await import("./feed-recording");

const scope = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete scope["MediaSource"];
  delete scope["ManagedMediaSource"];
});

/** `isTypeSupported` が `supports` を返す MediaSource */
function supporting(supports: (type: string) => boolean): unknown {
  return class {
    static isTypeSupported = supports;
  };
}

const plan = {
  way: "stream",
  codec: "av1",
  type: 'video/mp4; codecs="av01.0.08M.08,opus"',
} as const;

describe("RecordingFeed のリクエスト先", () => {
  test("録画の番号は読むたびに聞き、接頭辞の下に組む", () => {
    let id = 7;
    const feed = new RecordingFeed(() => id);
    expect(feed.playbackUrl).toBe("/denpa/api/recordings/7/playback");
    id = 8;
    expect(feed.chaptersUrl).toBe("/denpa/api/recordings/8/chapters");
    expect(feed.captionsUrl).toBe("/denpa/api/recordings/8/captions.json");
    expect(feed.timelineUrl).toBe("/denpa/api/recordings/8/databroadcast");
    expect(feed.fileUrl("ts")).toBe("/denpa/api/recordings/8/file?source=ts");
  });

  test("その場で流すものは位置を 3 桁にし、音声を符号化して、画面ごとの値を付ける", () => {
    const feed = new RecordingFeed(() => 1);
    expect(feed.viewer).toMatch(/^[0-9a-f]{24}$/);
    expect(feed.streamUrl("h264", 12.34567, "1 2")).toBe(
      `/denpa/api/recordings/1/stream?codec=h264&from=12.346&audio=1%202&viewer=${feed.viewer}`,
    );
  });

  test("WebKit の MSE (ManagedMediaSource) なら、始めてよいコマから始まるものを求める", () => {
    scope["ManagedMediaSource"] = class {};
    const feed = new RecordingFeed(() => 1);
    expect(feed.streamUrl("h264", 0, "0")).toEndWith("&clean=1");
  });

  test("段 0 は選んだコーデックのまま、段を下げるなら受け取れるコーデックを添え、音声だけは audio", () => {
    scope["MediaSource"] = supporting((type: string) => type.includes("avc1"));
    const feed = new RecordingFeed(() => 1);
    expect(feed.stepUrl(0, plan)(5, "0")).toBe(feed.streamUrl("av1", 5, "0"));
    expect(feed.stepUrl(1, plan)(5, "0")).toBe(
      `${feed.streamUrl("av1", 5, "0")}&rung=1&playable=h264`,
    );
    expect(feed.stepUrl("audio", plan)(5, "0")).toBe(
      feed.streamUrl("audio", 5, "0"),
    );
  });

  test("MSE の型は段 0 なら選んだもの、段を下げたら応答を受けるまで決めない", () => {
    const feed = new RecordingFeed(() => 1);
    expect(feed.stepType(0, plan)).toBe(plan.type);
    expect(feed.stepType(1, plan)).toBeNull();
    expect(feed.stepType("audio", plan)).toStartWith("audio/");
  });

  test("canvas は段 0 なら選んだ形式、段を下げるなら MPEG-2 は H.264 の変換として描ける形式を添える", () => {
    const feed = new RecordingFeed(() => 1);
    expect(feed.canvasUrl(0, "mpeg2", 3, "0", ["h264"])).toBe(
      feed.streamUrl("mpeg2", 3, "0"),
    );
    expect(feed.canvasUrl("audio", "mpeg2", 3, "0", ["h264"])).toBe(
      feed.streamUrl("mpeg2", 3, "0"),
    );
    expect(feed.canvasUrl(2, "mpeg2", 3, "0", ["h264", "av1"])).toBe(
      `${feed.streamUrl("h264", 3, "0")}&rung=2&playable=h264,av1`,
    );
  });
});

describe("段 0 のビットレート", () => {
  test("ファイルの大きさと尺から出し、同じファイルはリクエストし直さない", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return new Response(null, {
        headers: { "Content-Length": String(1_000_000) },
      });
    }) as unknown as typeof fetch;
    let id = 1;
    const feed = new RecordingFeed(() => id);
    expect(feed.baseOf("ts")).toBeNull();
    await feed.readBaseKbps("ts", 10);
    await feed.readBaseKbps("ts", 10);
    expect(asked).toEqual(["/denpa/api/recordings/1/file?source=ts"]);
    expect(feed.baseOf("ts")).toBe(800);
    expect(feed.baseOf(null)).toBeNull();
    // 別の録画へ移ったら、その録画のファイルとして読む
    id = 2;
    expect(feed.baseOf("ts")).toBeNull();
    await feed.readBaseKbps("ts", 10);
    expect(asked).toHaveLength(2);
  });

  test("読めなければ null のまま、同じファイルはリクエストし直さない", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const feed = new RecordingFeed(() => 1);
    await feed.readBaseKbps("0", 10);
    await feed.readBaseKbps("0", 10);
    expect(calls).toBe(1);
    expect(feed.baseOf("0")).toBeNull();
  });
});

describe("playable", () => {
  test("MSE の無い端末は空", () => {
    expect(playable()).toEqual([]);
  });

  test("受け取れるコーデックをエンコードの順で返す", () => {
    scope["MediaSource"] = supporting((type: string) => !type.includes("hvc1"));
    expect(playable()).not.toContain("hevc");
    expect(playable().length).toBeGreaterThan(0);
  });
});
