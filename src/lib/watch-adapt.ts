/**
 * **録画の観る画面で、回線に合わせて画質の段を上げ下げする** (段の決め方は `adapt.ts`、段の表は `rungs.ts`、
 * 切り替えは `remux-player.ts` の `switchTo`。docs/stream.md「回線に合わせて画質を下げる」)。
 *
 * ここは 1 秒ごとの呼び出しと送り出しの状態 (`pace`) の読み出し、画面に出す文言だけを持つ。どの経路に移すか (ファイルの直再生から
 * 変換へ移す・同じ MSE のまま替える・音声だけは作り直す) は観る画面が決める。DOM は触らないので、ここだけ単体で確かめられる
 */

import {
  type AdaptDecision,
  type AdaptSample,
  autoValue,
  RungAdapter,
  type Step,
} from "./adapt";
import { CODEC_LABEL } from "./hw";
import type { LiveCodec } from "./live";
import type { Pace, Rung } from "./rungs";
import type { Ranges } from "./ts/playback";

/** `adapt.ts` を呼ぶ間隔 (ms)。`adapt.ts` の数 (2〜3 秒続いたら) を読み分けられる細かさ */
export const ADAPT_TICK = 1_000;
/** 送り出しの具合を読み直す間 (ms)。WebSocket の `pace` と同じ 2 秒ごと */
const PACE_EVERY = 2_000;

/** `HTMLMediaElement.NETWORK_IDLE` (ここは DOM を触らないので値で持つ) */
const NETWORK_IDLE = 1;

/** `fileIdle` に渡す `<video>` の様子 */
interface FileMedia {
  networkState: number;
  seeking: boolean;
  /** 読めている区間 (`remux-player.ts` の `rangesOf`) */
  buffered: Ranges;
  currentTime: number;
}

/**
 * **ファイルの直再生で、ブラウザがファイルを読むのを止めているか** (`adapt.ts` の `AdaptSample.idle`)。
 * `networkState` が `NETWORK_IDLE` か、直前の刻みの間に `suspend` が来た (`suspendAt`) ときに止めていると見る。
 *
 * いまの位置をまだ読んでいない間と、飛んでいる最中は false にする。`NETWORK_IDLE` は読み終えたときだけでなく、
 * 読み始める前 (`preload` が `none` なら再生するまで読まない) と、飛んだ先を読み始める前にも付く。
 * ここで足りている印にすると、回線が細くて 1 バイトも届かなくても下げなくなる
 */
export function fileIdle(
  media: FileMedia,
  suspendAt: number,
  now: number,
): boolean {
  if (media.seeking) return false;
  const t = media.currentTime;
  // 先頭は映像と音声の始まりのずれ (数十 ms) だけ後ろから溜まることがあるので、少し手前も含める (`aheadOf` と同じ 0.5 秒)
  if (!media.buffered.some(([start, end]) => start <= t + 0.5 && t <= end))
    return false;
  return media.networkState === NETWORK_IDLE || now - suspendAt <= ADAPT_TICK;
}

/** 段を下げた変換をリクエストするときに足すクエリ (`&rung=2&playable=av1,h264`)。段 0 は空 */
export function rungQuery(rung: Rung, playable: readonly LiveCodec[]): string {
  if (rung === 0) return "";
  return `&rung=${rung}&playable=${playable.join(",")}`;
}

/**
 * 観る画面のコーデックのメニューの「自動」の行の値 (組み立ては `adapt.ts` の `autoValue`)。
 * 段 0 は「自動」だけ (いまの形式は添えない)
 */
export function autoLabel(step: Step, codec: string | null): string {
  if (step === 0) return "自動";
  const name =
    codec === "h264" || codec === "hevc" || codec === "av1"
      ? CODEC_LABEL[codec]
      : "";
  return autoValue(step, name);
}

/** サーバが混んでいて段を替えられなかったときの文言。ライブのサーバの通知と同じ文なので、段の表 (`rungs.ts`) が持つ */
export { busyNote } from "./rungs";

/** 呼ぶたびに観る画面が渡すもの。`now`・`route`・`pace` はここで足す */
export type WatchSample = Omit<AdaptSample, "now" | "route" | "pace"> & {
  /** 送り出しの具合を読む id (`remux-player.ts` の `StreamHeard`)。ファイルの直再生なら null */
  paceId: string | null;
};

interface WatchAdaptHost {
  /** いまの様子。段を動かさない間 (止めている・切り替えの最中・端末に保存したもの) は null */
  sample(): WatchSample | null;
  /** 送り出しの具合を読む (`GET /api/playback/pace?id=`)。読めなければ null */
  readPace(id: string): Promise<Pace | null>;
  /** 段を動かす・断り書きを出す */
  decide(decision: AdaptDecision): void;
  /** いまの時刻 (ms)。試しで差し替える */
  now?(): number;
}

interface WatchAdapt {
  /** `adapt.ts` を呼ぶ (`ADAPT_TICK` ごと) */
  tick(): void;
  /** シーク・CM スキップのあと。段は持ち越し、測った値だけ捨てる */
  reset(): void;
}

export function watchAdapt(host: WatchAdaptHost): WatchAdapt {
  const adapter = new RungAdapter();
  const now = host.now ?? (() => Date.now());
  /** 最後に読んだ具合と、どの id のものか */
  let pace: Pace | null = null;
  let paceOf: string | null = null;
  let paceAt = Number.NEGATIVE_INFINITY;
  let reading = false;
  /** 前の呼び出しで様子を読めなかったか (止めていた・切り替えの最中) */
  let idle = true;

  function poll(id: string | null, at: number): void {
    if (id !== paceOf) {
      // 別のストリームに替わった。前のストリームの具合は使わない
      pace = null;
      paceOf = id;
      paceAt = Number.NEGATIVE_INFINITY;
    }
    if (id === null || reading || at - paceAt < PACE_EVERY) return;
    reading = true;
    paceAt = at;
    void host
      .readPace(id)
      .catch(() => null)
      .then((got) => {
        reading = false;
        if (paceOf === id) pace = got;
      });
  }

  return {
    tick(): void {
      const s = host.sample();
      if (s === null) {
        idle = true;
        return;
      }
      const at = now();
      // 止めていた間のバッファの伸びを、回線のぶんとして読まない
      if (idle) adapter.reset(at);
      idle = false;
      const { paceId, ...sample } = s;
      poll(paceId, at);
      const decision = adapter.tick({
        ...sample,
        now: at,
        route: "watch",
        pace,
      });
      if (decision !== null) host.decide(decision);
    },
    reset(): void {
      adapter.reset(now());
    },
  };
}
