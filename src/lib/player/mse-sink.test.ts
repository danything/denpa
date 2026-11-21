import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { MediaSourceClass } from "../ts/media-source";
import { APPEND_MOST, mseSink, type MseSinkOptions } from "./mse-sink";

/*
 * MSE を真似た最小の入れ物。足したバイト数を秒と見なして、0 秒から順に並べる。
 * 足す・捨てるは次の刻みで終わる (本物と同じく、その間は `updating`。その間に呼ぶと例外)
 */
class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode = "sequence";
  start = 0;
  end = 0;
  /** 足した大きさ (順に) */
  sizes: number[] = [];
  /** 捨てた範囲 (順に) */
  removed: [number, number][] = [];
  types: string[] = [];
  aborted = 0;
  /** これより多く溜めようとしたら `QuotaExceededError` */
  capacity = Number.POSITIVE_INFINITY;
  get buffered(): TimeRanges {
    const empty = this.end <= this.start;
    return {
      length: empty ? 0 : 1,
      start: () => this.start,
      end: () => this.end,
    } as unknown as TimeRanges;
  }
  private later(change: () => void): void {
    if (this.updating) throw new DOMException("busy", "InvalidStateError");
    this.updating = true;
    setTimeout(() => {
      change();
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    }, 1);
  }
  appendBuffer(data: BufferSource): void {
    const size = (data as Uint8Array).byteLength;
    if (this.updating) throw new DOMException("busy", "InvalidStateError");
    if (this.end - this.start + size > this.capacity)
      throw new DOMException("full", "QuotaExceededError");
    this.later(() => {
      this.sizes.push(size);
      this.end += size;
    });
  }
  remove(from: number, to: number): void {
    this.later(() => {
      this.removed.push([from, to]);
      if (from <= this.start) this.start = Math.min(this.end, to);
      else this.end = Math.min(this.end, from);
    });
  }
  abort(): void {
    this.aborted++;
  }
  changeType(type: string): void {
    this.types.push(type);
  }
}

class FakeMediaSource extends EventTarget {
  static last: FakeMediaSource | null = null;
  readyState: ReadyState = "open";
  duration = Number.NaN;
  streaming: boolean | undefined = undefined;
  buffer: FakeSourceBuffer | null = null;
  created: string | null = null;
  constructor() {
    super();
    FakeMediaSource.last = this;
    setTimeout(() => this.dispatchEvent(new Event("sourceopen")), 1);
  }
  static isTypeSupported(type: string): boolean {
    return !type.includes("Opus");
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

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
beforeEach(() => {
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

const H264 = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';

/** `wait` が false なら `waitRoom` を渡さない (ライブ) */
function open(
  options: Partial<MseSinkOptions> = {},
  managed = false,
  wait = true,
) {
  const video = { src: "", disableRemotePlayback: false };
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const sink = mseSink(
    video as unknown as HTMLVideoElement,
    { Source: FakeMediaSource as unknown as MediaSourceClass, managed },
    {
      type: H264,
      duration: 600,
      keepFrom: () => 0,
      ...(wait ? { waitRoom: () => Promise.resolve() } : {}),
      ...options,
      opened: () => {
        options.opened?.();
        opened();
      },
    },
  );
  const media = FakeMediaSource.last!;
  return { video, sink, media, ready, buffer: () => media.buffer! };
}

describe("MSE を開いて足す (mseSink)", () => {
  test("開いたら尺を入れ、型が分かっていれば SourceBuffer を作る。時刻はストリームのまま (segments)", async () => {
    const { video, media, sink, ready } = open({
      duration: Number.POSITIVE_INFINITY,
    });
    expect(video.src).toBe("blob:fake");
    expect(sink.opened).toBe(false);
    await ready;
    expect(sink.opened).toBe(true);
    expect(media.duration).toBe(Number.POSITIVE_INFINITY);
    expect(media.created).toBe(H264);
    expect(media.buffer?.mode).toBe("segments");
    expect(sink.type).toBe(H264);
  });

  test("型が分からなければ、use まで作らない。違う型なら changeType で替え、MP4 の Opus は受け取れる小文字で渡す", async () => {
    const { media, sink, ready } = open({ type: null });
    await ready;
    expect(media.buffer).toBeNull();
    expect(sink.type).toBeNull();
    await sink.use(H264);
    expect(media.created).toBe(H264);
    await sink.use(H264);
    expect(media.buffer?.types).toEqual([]);
    await sink.use('video/mp4; codecs="av01.0.08M.08,Opus"');
    expect(media.buffer?.types).toEqual([
      'video/mp4; codecs="av01.0.08M.08,opus"',
    ]);
    expect(sink.type).toBe('video/mp4; codecs="av01.0.08M.08,Opus"');
  });

  test("1 回に足すのは APPEND_MOST まで。大きな塊は分けて足す", async () => {
    const { sink, ready, buffer } = open();
    await ready;
    await sink.append(new Uint8Array(APPEND_MOST * 2 + 10));
    expect(buffer().sizes).toEqual([APPEND_MOST, APPEND_MOST, 10]);
  });

  test("待たずに続けて呼んでも、1 つずつ足す (前のが終わる前に appendBuffer を呼ばない)", async () => {
    const { sink, ready, buffer } = open();
    await ready;
    await Promise.all([
      sink.append(new Uint8Array(3)),
      sink.append(new Uint8Array(5)),
      sink.trim(),
      sink.append(new Uint8Array(7)),
    ]);
    expect(buffer().sizes).toEqual([3, 5, 7]);
  });

  test("開く前に渡されたものは、開いてから順に足す", async () => {
    const { sink, media, ready } = open();
    const appended = Promise.all([
      sink.append(new Uint8Array(3)),
      sink.append(new Uint8Array(5)),
    ]);
    expect(sink.busy).toBe(true);
    await ready;
    await appended;
    expect(media.buffer?.sizes).toEqual([3, 5]);
  });

  test("並んだものを回し終えたら settled を 1 回呼ぶ。回している間は busy", async () => {
    const busyAt: boolean[] = [];
    let sink!: ReturnType<typeof open>["sink"];
    const opened = open({ settled: () => busyAt.push(sink.busy) });
    sink = opened.sink;
    await opened.ready;
    expect(sink.busy).toBe(false);
    const first = sink.append(new Uint8Array(3));
    const second = sink.append(new Uint8Array(5));
    expect(sink.busy).toBe(true);
    await Promise.all([first, second]);
    // 続けて渡したあいだは呼ばない。最後のものを終えたところで、手が空いた状態で 1 回
    expect(busyAt).toEqual([false]);
    await sink.remove(0, 1);
    expect(busyAt).toEqual([false, false]);
  });

  test("足すのに失敗しても settled を呼ぶ", async () => {
    let settled = 0;
    const { sink, ready, buffer } = open(
      { settled: () => settled++ },
      false,
      false,
    );
    await ready;
    buffer().capacity = 2;
    await sink.append(new Uint8Array(3)).catch(() => undefined);
    expect(settled).toBe(1);
  });

  test("waitRoom が無ければ、溜めきれないときは捨てずに QuotaExceededError を投げる", async () => {
    const { sink, ready, buffer } = open({ keepFrom: () => 6 }, false, false);
    await ready;
    await sink.append(new Uint8Array(8));
    buffer().capacity = 10;
    const error = await sink.append(new Uint8Array(4)).catch((e) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("QuotaExceededError");
    expect(buffer().removed).toEqual([]);
    expect(buffer().sizes).toEqual([8]);
    // 続けて足せる
    buffer().capacity = Number.POSITIVE_INFINITY;
    await sink.append(new Uint8Array(1));
    expect(buffer().sizes).toEqual([8, 1]);
  });

  test("溜めきれなければ、捨ててよい所より前を捨てて入れ直す", async () => {
    const { sink, ready, buffer } = open({ keepFrom: () => 6 });
    await ready;
    await sink.append(new Uint8Array(8));
    buffer().capacity = 10;
    await sink.append(new Uint8Array(4));
    expect(buffer().removed).toEqual([[0, 6]]);
    expect(buffer().sizes).toEqual([8, 4]);
  });

  test("捨てるものが無ければ、呼ぶ側の待ちが終わってから入れ直す", async () => {
    let waits = 0;
    let keep = 0;
    const { sink, ready, buffer } = open({
      keepFrom: () => keep,
      waitRoom: () => {
        waits++;
        // 観て進んだことにする
        keep = 8;
        return Promise.resolve();
      },
    });
    await ready;
    await sink.append(new Uint8Array(8));
    buffer().capacity = 10;
    await sink.append(new Uint8Array(4));
    expect(waits).toBe(1);
    expect(buffer().removed).toEqual([[0, 8]]);
    expect(buffer().sizes).toEqual([8, 4]);
  });

  test("still が false を返したら足さない (待つ間にリクエストし直された古いストリームの残り)", async () => {
    const { sink, ready, buffer } = open();
    await ready;
    let mine = true;
    const first = sink.append(new Uint8Array(3));
    const stale = sink.append(new Uint8Array(5), () => mine);
    mine = false;
    await Promise.all([first, stale]);
    expect(buffer().sizes).toEqual([3]);
  });

  test("trim は捨ててよい所より前に溜まっていれば捨てて true、無ければ false", async () => {
    let keep = 2;
    const { sink, ready, buffer } = open({ keepFrom: () => keep });
    await ready;
    expect(await sink.trim()).toBe(false);
    await sink.append(new Uint8Array(5));
    expect(await sink.trim()).toBe(true);
    expect(buffer().removed).toEqual([[0, 2]]);
    keep = 1;
    expect(await sink.trim()).toBe(false);
  });

  test("abort は開いている間だけ落とし、end は endOfStream を呼ぶ", async () => {
    const { sink, ready, media, buffer } = open();
    await ready;
    await sink.abort();
    expect(buffer().aborted).toBe(1);
    await sink.end();
    expect(media.readyState).toBe("ended");
    await sink.abort();
    expect(buffer().aborted).toBe(1);
  });

  test("ManagedMediaSource は AirPlay を断ってから付け、送り込んでよいかと startstreaming を伝える", async () => {
    let woke = 0;
    const { video, sink, media, ready } = open(
      { onStreaming: () => woke++ },
      true,
    );
    expect(video.disableRemotePlayback).toBe(true);
    await ready;
    expect(sink.streaming()).toBe(true);
    media.streaming = false;
    expect(sink.streaming()).toBe(false);
    media.dispatchEvent(new Event("startstreaming"));
    expect(woke).toBe(1);
    sink.destroy();
    media.dispatchEvent(new Event("startstreaming"));
    expect(woke).toBe(1);
  });

  test("MediaSource なら、送り込んでよいかはいつも true", async () => {
    const { video, sink, media, ready } = open();
    expect(video.disableRemotePlayback).toBe(false);
    await ready;
    media.streaming = false;
    expect(sink.streaming()).toBe(true);
  });

  test("開く前に閉じたら、開いても何もしない", async () => {
    let called = 0;
    const { sink, media } = open({ opened: () => called++ });
    sink.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(called).toBe(0);
    expect(media.buffer).toBeNull();
  });
});
