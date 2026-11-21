/**
 * **MSE (`MediaSource` と SourceBuffer) を開いて、届いたものを足し、古いものを捨てる。** 観る画面のその場で流す録画
 * (`remux-player.ts`) と、ライブ・追っかけ (`live-player.svelte.ts`) が使う。
 *
 * 何をどこから読むか、どこまで溜めるか、いつ捨てるかは呼ぶ側が決める。ここが受け持つのは次のこと。
 *
 * - **開く。** `ManagedMediaSource` (iPhone の Safari) なら `disableRemotePlayback` を立ててから `<video>` に付ける
 *   (`ts/media-source.ts`)。開いたら尺を入れる (録画は尺、終わりが無ければ `Infinity`)。時刻はストリームのものをそのまま使う (`segments`)
 * - **足す・捨てる・型を替えるのは 1 つずつ。** `appendBuffer`・`remove`・`changeType` は前のものが終わる前に呼ぶと例外になるので、
 *   呼ばれた順に 1 つずつ回す。待たずに続けて呼んでもよい。開く前に渡されたものは、開いてから回す。
 *   並んだものを回し終えたら呼ぶ側の関数を呼ぶ (`settled`)
 * - **1 回に足すのは 1 MB まで** (`APPEND_MOST`)。溜めきれなければ (`QuotaExceededError`)、捨ててよい所 (`keepFrom`) より前を捨てて
 *   入れ直す。捨てるものが無ければ、呼ぶ側が待つ処理 (`waitRoom`) が終わってから入れ直す。待てない呼ぶ側 (ライブ) は
 *   `waitRoom` を渡さず、例外で受け取る
 * - **`ManagedMediaSource` は送り込んでよい間をブラウザが知らせる** (`startstreaming`・`endstreaming`)。いま送ってよいか
 *   (`streaming`) を返し、送ってよくなったら呼ぶ側の関数を呼ぶ (`onStreaming`)。止められている間に読むのを止めるかは呼ぶ側が決める
 *
 * 足す・捨てる・型を替えるときは、まだそのストリームのものか (`still`) を渡せる。前のものが終わるのを待つ間に呼ぶ側がリクエストし直していれば、
 * 何もせずに戻る。古いストリームの残りを、新しいストリームのために捨てた所へ足さないため
 */

import { mseType } from "#lib/live.js";
import type { PickedMediaSource } from "#lib/ts/media-source.js";
import type { Ranges } from "#lib/ts/playback.js";

/**
 * 1 回に足す上限 (バイト)。読むのを止めている間にブラウザが溜めたぶんは 1 回の読み出しでまとめて返る (`remux-player.ts` の `aheadLimit`)。
 * 空の SourceBuffer に溜められる量を超える塊は、後ろを捨てても足せず (`QuotaExceededError`)、観て減るのを待ったまま止まる
 * (手元から速く届くと、Safari は 1 回で 20〜36 MB を返した。Chrome は 2 MB まで。`.github/workflows/webkit-remux.yml`。#2884)
 */
export const APPEND_MOST = 1024 * 1024;

/** まだそのストリームのものか。false を返したら、足す・捨てる・型を替えるのをやめる */
export type Still = () => boolean;

export interface MseSinkOptions {
  /** SourceBuffer の型。null なら、型が分かって `use` が呼ばれるまで作らない (応答のヘッダで型が分かるとき) */
  type: string | null;
  /** 尺 (秒)。終わりが無ければ `Number.POSITIVE_INFINITY` */
  duration: number;
  /** この位置 (秒) より前は捨ててよい。`trim` と、溜めきれないとき (`QuotaExceededError`) に読む */
  keepFrom(): number;
  /**
   * 溜めきれず、捨てられるものも無い。観て減るまで待つ。終わったら入れ直す。渡さなければ、溜めきれないときは捨ても
   * 入れ直しもせず、`append` が `QuotaExceededError` を投げる (ライブは放送が待ってくれない)
   */
  waitRoom?(): Promise<void>;
  /** MediaSource が開いた (`sourceopen`)。`type` があれば SourceBuffer を作ったあとに呼ぶ */
  opened(): void;
  /**
   * 並んだ仕事 (足す・捨てる・型を替える・落とす・閉じる) をすべて終え、SourceBuffer の手が空いた。
   * 続けて渡されているあいだは、最後のものが終わるまで呼ばない
   */
  settled?(): void;
  /** ブラウザが送り込んでよいと知らせた (`ManagedMediaSource` の `startstreaming`) */
  onStreaming?(): void;
}

export interface MseSink {
  /** MediaSource が開いたか (`sourceopen`) */
  readonly opened: boolean;
  /** いまの SourceBuffer の型 (渡された型のまま)。まだ作っていなければ null */
  readonly type: string | null;
  /** MediaSource の状態 (`open`・`ended`・`closed`) */
  readonly readyState: ReadyState;
  /** 並んでいる仕事か、回している仕事があるか。無くなったところで `settled` を呼ぶ */
  readonly busy: boolean;
  /** 溜まっている区間 */
  buffered(): Ranges;
  /** ブラウザが送り込んでよいとしているか。`ManagedMediaSource` でなければいつも true */
  streaming(): boolean;
  /** SourceBuffer をこの型にする。まだ無ければ作り、型が違えば `changeType` で替える。替えられないブラウザなら例外を投げる */
  use(type: string, still?: Still): Promise<void>;
  /** 足す。大きな塊は `APPEND_MOST` ずつに分ける。読めない中身なら例外を投げる */
  append(data: Uint8Array, still?: Still): Promise<void>;
  /** `from` 秒から `to` 秒までを捨てる */
  remove(from: number, to: number, still?: Still): Promise<void>;
  /** 捨ててよい所 (`keepFrom`) より前に溜まっていれば捨てる。捨てたら true */
  trim(still?: Still): Promise<boolean>;
  /** 足しかけのものを落とす (`SourceBuffer.abort`)。末尾まで読み終えて閉じていれば何もしない (足せば開き直る) */
  abort(still?: Still): Promise<void>;
  /** 末尾まで届いたことを伝える (`endOfStream`)。伝えないと、最後で止まったまま `ended` が来ない */
  end(still?: Still): Promise<void>;
  /**
   * 閉じる。開く前なら、開いても何もしない。閉じたあとは使わない。開く前に渡されていた仕事は回らないまま残り、
   * `busy` は true のまま、`settled` も呼ばない
   */
  destroy(): void;
}

/** `TimeRanges` を配列にする (`ts/playback.ts` の `aheadOf` などに渡す) */
export function rangesOf(buffered: TimeRanges): Ranges {
  const out: [number, number][] = [];
  for (let i = 0; i < buffered.length; i++)
    out.push([buffered.start(i), buffered.end(i)]);
  return out;
}

const always: Still = () => true;

/** `picked` の MediaSource を作って `video` に付ける */
export function mseSink(
  video: HTMLVideoElement,
  picked: PickedMediaSource,
  options: MseSinkOptions,
): MseSink {
  const media = new picked.Source();
  let buffer: SourceBuffer | null = null;
  /** いまの SourceBuffer の型。MSE に渡した型 (`forMse`) ではなく、渡された型のまま比べる */
  let bufferType: string | null = null;
  let opened = false;
  let closed = false;
  /** 開いた (`sourceopen`) ら解決する。開く前に渡された仕事は、これを待ってから回す */
  let openNow!: () => void;
  /** 最後に渡された SourceBuffer の仕事が終わる時。次の仕事はこれを待ってから始める */
  let tail = new Promise<void>((resolve) => {
    openNow = resolve;
  });
  /** 並んでいる仕事と回している仕事の数 (`busy`・`settled`) */
  let queued = 0;

  /** MSE に渡す型 (MP4 の `Opus` を受け取れるなら小文字に。`live.ts` の `mseType`) */
  const forMse = (type: string): string =>
    mseType(type, (t) => picked.Source.isTypeSupported(t));

  function create(type: string): void {
    buffer = media.addSourceBuffer(forMse(type));
    // 並べ直させない。時刻はストリームのものをそのまま使う (録画はページの物差し。`server/playback.ts`)
    buffer.mode = "segments";
    bufferType = type;
  }

  const buffered = (): Ranges =>
    buffer === null ? [] : rangesOf(buffer.buffered);

  /** SourceBuffer の手が空くまで待つ */
  function idle(): Promise<void> {
    const target = buffer;
    if (target === null || !target.updating) return Promise.resolve();
    return new Promise((resolve) =>
      target.addEventListener("updateend", () => resolve(), { once: true }),
    );
  }

  /** 回し終えた。ほかに並んでいなければ呼ぶ側に伝える (`settled`) */
  function finished(): void {
    queued--;
    if (queued === 0) options.settled?.();
  }

  /** 前に渡された仕事が終わり、SourceBuffer の手が空いてから `job` を回す */
  function exclusive<T>(job: () => Promise<T>): Promise<T> {
    queued++;
    const run = tail.then(async () => {
      await idle();
      return job();
    });
    // 次の仕事 (`tail`) より先に数を減らす。続けて渡されていれば 0 にならず、`settled` は呼ばない
    void run.then(finished, finished);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** SourceBuffer に 1 つ渡して、終わるまで待つ (`updateend`)。断られたら例外を投げる */
  function update(
    job: (target: SourceBuffer) => void,
    still: Still,
  ): Promise<void> {
    return exclusive(async () => {
      const target = buffer;
      if (target === null || !still()) return;
      await new Promise<void>((resolve, reject) => {
        const done = (): void => {
          target.removeEventListener("error", fail);
          resolve();
        };
        const fail = (): void => {
          target.removeEventListener("updateend", done);
          reject(new Error("SourceBuffer error"));
        };
        target.addEventListener("updateend", done, { once: true });
        target.addEventListener("error", fail, { once: true });
        try {
          job(target);
        } catch (error) {
          target.removeEventListener("updateend", done);
          target.removeEventListener("error", fail);
          reject(error);
        }
      });
    });
  }

  async function remove(from: number, to: number, still = always) {
    await update((target) => target.remove(from, to), still);
  }

  async function trim(still = always): Promise<boolean> {
    const cut = options.keepFrom();
    const first = buffered()[0];
    if (first === undefined || first[0] >= cut) return false;
    await remove(0, cut, still);
    return true;
  }

  /** 1 つ足す。溜めきれなければ、捨てるか待つかしてから入れ直す */
  async function appendOne(data: Uint8Array, still: Still): Promise<void> {
    for (;;) {
      if (!still()) return;
      try {
        await update(
          (target) => target.appendBuffer(data as BufferSource),
          still,
        );
        return;
      } catch (error) {
        if (
          options.waitRoom === undefined ||
          !(
            error instanceof DOMException && error.name === "QuotaExceededError"
          )
        )
          throw error;
        if (!(await trim(still))) await options.waitRoom();
      }
    }
  }

  const onStreaming = (): void => options.onStreaming?.();
  media.addEventListener("startstreaming", onStreaming);

  /*
   * **ManagedMediaSource は AirPlay を断らないと開かない** (`ts/media-source.ts`)。
   * 付ける前に立てておく
   */
  if (picked.managed) video.disableRemotePlayback = true;
  const objectUrl = URL.createObjectURL(media);
  video.src = objectUrl;
  media.addEventListener(
    "sourceopen",
    () => {
      URL.revokeObjectURL(objectUrl);
      if (closed) return;
      // 終わりが無いもの (ライブ) は `Infinity` にしておく。入れないと尺が届くたびに伸び、備え付けの再生位置が行き来する
      media.duration = options.duration;
      opened = true;
      if (options.type !== null) create(options.type);
      options.opened();
      openNow();
    },
    { once: true },
  );

  return {
    get opened() {
      return opened;
    },
    get type() {
      return bufferType;
    },
    get readyState() {
      return media.readyState;
    },
    get busy() {
      return queued > 0;
    },
    buffered,
    streaming: () =>
      !picked.managed ||
      (media as MediaSource & { streaming?: boolean }).streaming !== false,
    async use(type: string, still = always): Promise<void> {
      if (buffer === null) {
        create(type);
        return;
      }
      if (type === bufferType) return;
      // 古いブラウザには無い。何度リクエストし直しても同じなので、読めない中身として扱う
      if (typeof buffer.changeType !== "function")
        throw new Error(`型を替えられません: ${type}`);
      await exclusive(async () => {
        if (!still() || buffer === null) return;
        buffer.changeType(forMse(type));
        bufferType = type;
      });
    },
    async append(data: Uint8Array, still = always): Promise<void> {
      for (let at = 0; at < data.length && still(); at += APPEND_MOST)
        await appendOne(data.subarray(at, at + APPEND_MOST), still);
    },
    remove,
    trim,
    abort: (still = always) =>
      exclusive(async () => {
        if (!still() || buffer === null) return;
        if (media.readyState === "open") buffer.abort();
      }),
    end: (still = always) =>
      exclusive(async () => {
        if (still() && media.readyState === "open") media.endOfStream();
      }),
    destroy(): void {
      closed = true;
      media.removeEventListener("startstreaming", onStreaming);
      // sourceopen が来る前に閉じると、そこで解放しないまま残る (2 回解放しても害は無い)
      URL.revokeObjectURL(objectUrl);
    },
  };
}
