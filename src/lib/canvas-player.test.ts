import { afterEach, describe, expect, mock, test } from "bun:test";

import { OFFSET_HEADER, ORIGIN_HEADER } from "./ts/playback";

/**
 * **元の TS が途中で切れたら、持っているものを捨てずに続きをリクエストする** (`canvas-player.ts` の `resume`)。
 * エンジン (worker・Web Audio・canvas) は偽物に替え、渡されたバイトと空にした回数を数える
 */
class FakeEngine {
  static made: FakeEngine[] = [];
  /** 手元の尺 (秒) */
  lead = 5;
  resets: (number | null)[] = [];
  fed: Uint8Array[] = [];
  finished = false;
  readonly position = null;
  readonly playing = false;
  readonly blocked = false;
  constructor(
    _host: unknown,
    _before: unknown,
    _target: number,
    readonly events: { stalled(): void },
  ) {
    FakeEngine.made.push(this);
  }
  feed(buffer: ArrayBuffer): void {
    this.fed.push(new Uint8Array(buffer).slice());
  }
  reset(from: number | null = null): void {
    this.resets.push(from);
  }
  stops: (number | null)[] = [];
  stopAt(at: number | null): void {
    this.stops.push(at);
  }
  finish(): void {
    this.finished = true;
  }
  selectAudio(): void {}
  pause(): void {}
  resume(): void {}
  mute(): void {}
  unmute(): void {}
  destroy(): void {}
  set background(_on: boolean) {}
  set volume(_level: number) {}
}
void mock.module("./raw/engine", () => ({ RawEngine: FakeEngine }));

const { canvasPlayer } = await import("./canvas-player");

/** 合成した元の TS (中身は数えるだけなので何でもよい) */
const DATA = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
const ORIGIN = 900_000;
const START = 1880;

/** `bytes` を流す応答。`broken` なら流し終えたところで切れる (fetch と同じく TypeError) */
function stream(
  bytes: Uint8Array,
  offset: number,
  broken: boolean,
  origin = ORIGIN,
): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes.slice());
        return;
      }
      if (broken) controller.error(new TypeError("network error"));
      else controller.close();
    },
  });
  return new Response(body, {
    headers: {
      [ORIGIN_HEADER]: String(origin),
      [OFFSET_HEADER]: String(offset),
    },
  });
}

interface Asked {
  from: number;
  offset: number | undefined;
}

function open(answer: (asked: Asked, n: number) => Response) {
  const asked: Asked[] = [];
  const states: string[] = [];
  const player = canvasPlayer({
    host: {} as HTMLElement,
    before: null,
    input: "ts-mpeg2",
    request: (from, _audio, _signal, offset) => {
      asked.push({ from, offset });
      return Promise.resolve(answer({ from, offset }, asked.length));
    },
    duration: 0,
    start: 10,
    audio: "0",
    background: false,
    muted: false,
    volume: null,
    state: (state) => states.push(state),
    gaveUp: () => {},
    remote: () => {},
    waiting: () => {},
    ended: () => {},
    tick: () => {},
  });
  return { player, asked, states, engine: FakeEngine.made.at(-1)! };
}

/** `done` になるまで待つ (切れたあとのリクエストし直しは 1 秒待つ) */
async function until(done: () => boolean): Promise<void> {
  const limit = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > limit) throw new Error("待ちきれませんでした");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const joined = (parts: Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

let playing: { destroy(): void } | null = null;
afterEach(() => {
  playing?.destroy();
  playing = null;
});

describe("元の TS が途中で切れたら (canvasPlayer)", () => {
  test("捨てずに、受け取ったバイトの続きをリクエストする。継ぎ目でバイトは重ならず欠けない", async () => {
    const cut = 1000;
    const { player, asked, states, engine } = open(({ offset }) =>
      offset === undefined
        ? stream(DATA.subarray(0, cut), START, true)
        : stream(DATA.subarray(offset - START), offset, false),
    );
    playing = player;
    await until(() => engine.finished);
    expect(asked.map((a) => a.offset)).toEqual([undefined, START + cut]);
    // 空にしたのは最初の読み込みだけ (`load` と、応答を受けて飛び先を決める `reset`)
    expect(engine.resets).toHaveLength(2);
    expect(joined(engine.fed)).toEqual(DATA);
    // 手元を再生している間は「繋ぎ直しています」を出さない
    expect(states).not.toContain("retrying");
    expect(states.at(-1)).toBe("flowing");
  });

  test("手元を使い切って止まったら「繋ぎ直しています」を出す", async () => {
    let release: (() => void) | null = null;
    const { player, states, engine } = open(({ offset }) => {
      if (offset === undefined)
        return stream(DATA.subarray(0, 1000), START, true);
      // 続きはなかなか届かない
      const gate = new Promise<void>((resolve) => (release = resolve));
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await gate;
          controller.enqueue(DATA.subarray(offset - START).slice());
          controller.close();
        },
      });
      return new Response(body, {
        headers: {
          [ORIGIN_HEADER]: String(ORIGIN),
          [OFFSET_HEADER]: String(offset),
        },
      });
    });
    playing = player;
    await until(() => release !== null);
    expect(states).not.toContain("retrying");
    engine.events.stalled();
    expect(states).toContain("retrying");
    release!();
    await until(() => engine.finished);
    expect(states.at(-1)).toBe("flowing");
  });

  test("続きの物差しの 0 が前と違えば (ファイルが替わった)、捨てて観ていた位置から読み直す", async () => {
    const { player, asked, engine } = open(({ offset }, n) => {
      if (n === 1) return stream(DATA.subarray(0, 1000), START, true);
      if (offset !== undefined)
        return stream(DATA.subarray(offset - START), offset, false, 1);
      return stream(DATA, START, false, 1);
    });
    playing = player;
    await until(() => engine.finished);
    expect(asked.map((a) => a.offset)).toEqual([
      undefined,
      START + 1000,
      undefined,
    ]);
    expect(engine.resets).toHaveLength(4);
  });

  test("続きを断られたら (4xx)、捨てて観ていた位置から読み直す", async () => {
    const { player, asked, engine } = open(({ offset }, n) => {
      if (n === 1) return stream(DATA.subarray(0, 1000), START, true);
      if (offset !== undefined) return new Response("", { status: 400 });
      return stream(DATA, START, false);
    });
    playing = player;
    await until(() => engine.finished);
    expect(asked.map((a) => a.offset)).toEqual([
      undefined,
      START + 1000,
      undefined,
    ]);
    expect(engine.resets).toHaveLength(4);
  });

  test("応答が届く前に切れたら、観ていた位置からリクエストし直す", async () => {
    const { player, asked, engine } = open((_asked, n) => {
      if (n === 1) throw new TypeError("network error");
      return stream(DATA, START, false);
    });
    playing = player;
    await until(() => engine.finished);
    expect(asked.map((a) => a.offset)).toEqual([undefined, undefined]);
  });
});

/**
 * **CM の先頭から先のコマを描かせない** (`stopAt`)。元の TS は応答で物差しの 0 (`X-Denpa-Origin`) を知るまで PTS に直せないので、
 * 知ってから渡す。飛んで worker が空になったら渡し直し、飛び先より手前のもの (跨いだ CM の先頭) は捨てる
 */
describe("描かない位置 (canvasPlayer)", () => {
  test("物差しの 0 を知ってから PTS で渡し、飛んだら渡し直す。跨いだものは捨てる", async () => {
    const { player, asked, engine } = open(() => stream(DATA, START, false));
    playing = player;
    // 応答の前に頼まれた。まだ PTS に直せない
    player.stopAt(60);
    expect(engine.stops).toEqual([]);
    await until(() => engine.finished);
    expect(engine.stops).toEqual([ORIGIN + 60 * 90_000]);
    // 手前へ飛んだ。worker は空になるので渡し直す
    player.seek(30);
    await until(() => asked.length === 2 && engine.resets.length === 4);
    expect(engine.stops.at(-1)).toBe(ORIGIN + 60 * 90_000);
    // CM の先へ飛んだ。跨いだものは渡さない
    const before = engine.stops.length;
    player.seek(90);
    await until(() => asked.length === 3 && engine.resets.length === 6);
    expect(engine.stops).toHaveLength(before);
    // 次の CM を渡し、外す
    player.stopAt(120);
    expect(engine.stops.at(-1)).toBe(ORIGIN + 120 * 90_000);
    player.stopAt(null);
    expect(engine.stops.at(-1)).toBeNull();
  });
});
