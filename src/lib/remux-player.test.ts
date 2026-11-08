import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { codecsFor } from "./live";
import { remuxPlayer, type StreamHeard } from "./remux-player";
import type { MediaSourceClass } from "./ts/media-source";
import { AUDIO_TYPE } from "./ts/playback";

/*
 * MSE を真似た最小の入れ物。中身の代わりに「この塊は何秒から何秒か」を Float64 2 つで運ぶ。
 * 足す・捨てるは次の刻みで終わる (本物と同じく、その間は `updating`)
 */
type Range = [number, number];

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = "segments";
  ranges: Range[] = [];
  get buffered(): TimeRanges {
    const ranges = [...this.ranges].sort((a, b) => a[0] - b[0]);
    return {
      length: ranges.length,
      start: (i: number) => ranges[i]![0],
      end: (i: number) => ranges[i]![1],
    } as TimeRanges;
  }
  private later(change: () => void): void {
    this.updating = true;
    setTimeout(() => {
      change();
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    }, 1);
  }
  appendBuffer(data: BufferSource): void {
    const [start, end] = new Float64Array((data as Uint8Array).slice().buffer);
    this.later(() => {
      const last = this.ranges.find(
        (range) => Math.abs(range[1] - start!) < 0.01,
      );
      if (last !== undefined) last[1] = end!;
      else this.ranges.push([start!, end!]);
    });
  }
  remove(start: number, end: number): void {
    this.later(() => {
      this.ranges = this.ranges
        .map(([a, b]): Range =>
          a >= start && b <= end
            ? [0, 0]
            : a < end && a >= start
              ? [end, b]
              : [a, b],
        )
        .filter(([a, b]) => b > a);
    });
  }
  /** `changeType` で替えた型 (順に) */
  types: string[] = [];
  abort(): void {}
  changeType(type: string): void {
    this.types.push(type);
  }
}

class FakeMediaSource extends EventTarget {
  static last: FakeMediaSource | null = null;
  readyState = "open";
  duration = Number.NaN;
  buffer: FakeSourceBuffer | null = null;
  /** SourceBuffer を作ったときの型 */
  created: string | null = null;
  constructor() {
    super();
    FakeMediaSource.last = this;
    setTimeout(() => this.dispatchEvent(new Event("sourceopen")), 1);
  }
  static isTypeSupported(): boolean {
    return true;
  }
  addSourceBuffer(type: string): FakeSourceBuffer {
    this.created = type;
    this.buffer = new FakeSourceBuffer();
    return this.buffer;
  }
  endOfStream(): void {
    this.readyState = "ended";
  }
}

class FakeVideo extends EventTarget {
  src = "";
  error = null;
  disableRemotePlayback = false;
  private at = 0;
  get currentTime(): number {
    return this.at;
  }
  set currentTime(value: number) {
    this.at = value;
    this.dispatchEvent(new Event("seeking"));
  }
}

/** リクエストされた位置から、2 秒ずつの塊を `count` 個流す。`gate` がデコードできるまで 2 つ目から先を止められる */
let requests: string[] = [];
let gate: Promise<void> = Promise.resolve();
const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL;

/** 応答に付けるヘッダ (段を下げた変換の `X-Denpa-Codec` など) */
let headers: Record<string, string> = {};

const fakeFetch = (async (url: string, init?: RequestInit) => {
  requests.push(url);
  const from = Number(new URL(url, "http://x").searchParams.get("from"));
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i > 0) await gate;
      if (init?.signal?.aborted || i >= 3) {
        controller.close();
        return;
      }
      controller.enqueue(
        new Uint8Array(
          new Float64Array([from + i * 2, from + i * 2 + 2]).buffer,
        ),
      );
      i++;
    },
  });
  return new Response(body, { headers });
}) as typeof fetch;

beforeEach(() => {
  requests = [];
  headers = {};
  gate = Promise.resolve();
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
  globalThis.fetch = fakeFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const H264 = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';

function start(from = 100, codecs: string | null = H264) {
  const video = new FakeVideo();
  const states: string[] = [];
  const heard: StreamHeard[] = [];
  const player = remuxPlayer(
    video as unknown as HTMLVideoElement,
    { Source: FakeMediaSource as unknown as MediaSourceClass, managed: false },
    {
      url: (at, audio) => `remux?from=${at}&audio=${audio}`,
      codecs,
      duration: 600,
      start: from,
      audio: "0",
      state: (state) => states.push(state),
      heard: (stream) => heard.push(stream),
    },
  );
  return { video, player, states, heard, media: () => FakeMediaSource.last! };
}

describe("その場で流すものの受け方 (remuxPlayer)", () => {
  test("尺を先に言い、続きの位置からリクエストして、尻まで読んだら終わりを言う", async () => {
    const { video, media } = start(100);
    await settle();
    expect(media().duration).toBe(600);
    expect(video.currentTime).toBe(100);
    expect(requests).toEqual(["remux?from=100&audio=0"]);
    expect(media().buffer?.ranges).toEqual([[100, 106]]);
    expect(media().readyState).toBe("ended");
  });

  test("溜まっている所・読んでいるストリームの少し先へはリクエストし直さない。遠くへ飛べばリクエストし直して前を捨てる", async () => {
    const { video, media } = start(100);
    await settle();
    video.currentTime = 104;
    await settle();
    expect(requests).toHaveLength(1);
    video.currentTime = 300;
    await settle();
    expect(requests).toEqual([
      "remux?from=100&audio=0",
      "remux?from=300&audio=0",
    ]);
    expect(media().buffer?.ranges).toEqual([[300, 306]]);
  });

  test("読んでいる最中に飛んでも、古いストリームの残りは新しいストリームに混ざらない", async () => {
    let open!: () => void;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const { video, media } = start(100);
    await settle();
    // 1 つ目の塊だけ届いて、残りは止まっている
    expect(media().buffer?.ranges).toEqual([[100, 102]]);
    video.currentTime = 300;
    open();
    await settle();
    expect(media().buffer?.ranges).toEqual([[300, 306]]);
  });

  test("音声を選び直すと、いまの位置からリクエストし直す", async () => {
    const { video, player } = start(100);
    await settle();
    video.currentTime = 103;
    player.setAudio("1");
    await settle();
    expect(requests.at(-1)).toBe("remux?from=103&audio=1");
  });

  test("畳んだら読むのをやめる", async () => {
    const { video, player } = start(100);
    await settle();
    player.destroy();
    video.currentTime = 400;
    await settle();
    expect(requests).toHaveLength(1);
  });
});

describe("混んでいて断られたとき", () => {
  test("「サーバが混んでいます」の 503 はリクエストし直さずに知らせる。ほかの 5xx はリクエストし直す", async () => {
    let answer: Response = Response.json(
      { message: "サーバが混んでいます" },
      { status: 503 },
    );
    globalThis.fetch = (async (url: string) => {
      requests.push(url);
      return answer.clone();
    }) as typeof fetch;
    const { states } = start(100);
    await settle();
    expect(states).toEqual(["busy"]);
    expect(requests).toHaveLength(1);

    answer = new Response("Bad Gateway", { status: 502 });
    const other = start(100);
    await settle();
    expect(other.states).toEqual(["retrying"]);
    other.player.destroy();
  });
});

describe("段の切り替え (switchTo)", () => {
  const AV1 = codecsFor("av1");
  // 小文字の opus を受け取れる端末 (偽の MediaSource はどれも受け取る) には小文字で渡す (`live.ts` の `mseType`)
  const AV1_MSE = AV1.replace(",Opus", ",opus");
  const rung = (at: number, audio: string) => `rung?from=${at}&audio=${audio}`;

  test("いまの位置を含む区間の末尾から新しい段をリクエストし、そこまでは残して続ける。型が違えば changeType で替える", async () => {
    const { video, player, media } = start(100);
    await settle();
    video.currentTime = 101;
    expect(await player.switchTo(AV1, rung)).toBe("switched");
    await settle();
    expect(requests.at(-1)).toBe("rung?from=106&audio=0");
    expect(media().buffer?.types).toEqual([AV1_MSE]);
    // 残した 100〜106 に、106 から先が続く
    expect(media().buffer?.ranges).toEqual([[100, 112]]);
  });

  test("切り替えたあとのシークと繋ぎ直しは、新しい段でリクエストする。型が同じなら替えない", async () => {
    const { video, player, media } = start(100);
    await settle();
    expect(await player.switchTo(H264, rung)).toBe("switched");
    await settle();
    video.currentTime = 300;
    await settle();
    expect(requests.at(-1)).toBe("rung?from=300&audio=0");
    expect(media().buffer?.types).toEqual([]);
  });

  test("混んでいて断られたら、前のストリームを止めずにそのまま続ける", async () => {
    let open!: () => void;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!url.startsWith("rung")) return fakeFetch(url, init);
      requests.push(url);
      return Response.json(
        { message: "サーバが混んでいます" },
        { status: 503 },
      );
    }) as typeof fetch;
    const { player, media, states } = start(100);
    await settle();
    // 1 つ目の塊だけ届いて、残りは止まっている
    expect(media().buffer?.ranges).toEqual([[100, 102]]);
    expect(await player.switchTo(AV1, rung)).toBe("busy");
    open();
    await settle();
    expect(media().buffer?.ranges).toEqual([[100, 106]]);
    expect(media().buffer?.types).toEqual([]);
    // 作り直しを勧める「混んでいます」は出さない
    expect(states).toEqual([]);
  });

  test("応答を待つ間に飛んだら、切り替えをやめて飛んだ先を前の段で読む", async () => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.startsWith("rung")) await held;
      return fakeFetch(url, init);
    }) as typeof fetch;
    const { video, player, media } = start(100);
    await settle();
    const result = player.switchTo(AV1, rung);
    video.currentTime = 300;
    answer();
    expect(await result).toBe("failed");
    await settle();
    expect(requests.filter((url) => url.startsWith("remux"))).toEqual([
      "remux?from=100&audio=0",
      "remux?from=300&audio=0",
    ]);
    expect(media().buffer?.ranges).toEqual([[300, 306]]);
  });

  test("型を言わずに始めたら、応答の X-Denpa-Codec から SourceBuffer の型を決める。段と送り出しの具合の id も受け取る", async () => {
    headers = {
      "X-Denpa-Codec": "av1",
      "X-Denpa-Rung": "2",
      "X-Denpa-Pace": "p1",
    };
    const { media, heard } = start(100, null);
    await settle();
    expect(media().created).toBe(AV1_MSE);
    expect(heard).toEqual([{ codec: "av1", rung: 2, pace: "p1" }]);
    expect(media().buffer?.ranges).toEqual([[100, 106]]);
  });

  test("音声だけの応答には音声の型を使う", async () => {
    headers = { "X-Denpa-Codec": "audio" };
    const { media } = start(100, null);
    await settle();
    expect(media().created).toBe(AUDIO_TYPE);
  });
});
