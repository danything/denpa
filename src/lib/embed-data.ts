/**
 * **データ放送のページ (`/embed/data`) とテレビのアプリの間のメッセージ。** 約束は [docs/api.md](../../docs/api.md#データ放送のページ-embeddata) に書いてある。
 *
 * アプリは映像を自分で映し (ExoPlayer)、その上に透明な WebView でこのページを重ねる。ページはデータ放送を描き、
 * 映像の場所・選局・音声の切り替えをアプリへ頼む。間は MessagePort 1 本で、どちらの向きも 1 通が JSON の文字列 1 つ
 */

import type { ResponseMessage } from "@danything/arib/bml-protocol";

import type { VideoPlace } from "#lib/components/player/DataBroadcast.svelte";
import type { HybridcastLink } from "#lib/live.js";

/** アプリがポートを渡すメッセージの中身。これ以外の中身で届いたポートは受けない */
export const PORT_GREETING = "denpa-tv";

/** アプリ → ページ */
export type Incoming =
  | {
      type: "init";
      mode: "live";
      /** 局 (`GET /api/services` の `id`) */
      service: number;
      open: boolean;
      receive: boolean;
      captions: boolean;
    }
  | {
      type: "init";
      mode: "recording";
      /** 録画 (`GET /api/recordings` の `id`) */
      recording: number;
      open: boolean;
      receive: boolean;
      captions: boolean;
    }
  | { type: "data"; message: ResponseMessage }
  | { type: "notice"; message: Record<string, unknown> }
  | {
      type: "time";
      air: number | null;
      pos: number;
      rate: number;
      paused: boolean;
    }
  | { type: "key"; code: number; down: boolean }
  | { type: "d" }
  | { type: "close" }
  | { type: "receive"; on: boolean }
  | { type: "channel"; service: number }
  | { type: "captions"; on: boolean };

/** ページ → アプリ */
export type Outgoing =
  | { type: "ready" }
  | { type: "failed"; reason: "engine" }
  | { type: "open"; on: boolean }
  | { type: "video"; rect: VideoPlace }
  | {
      type: "tune";
      service: number;
      onid: number;
      tsid: number | null;
      sid: number;
    }
  | { type: "audio"; index: number | null }
  | { type: "captions"; on: boolean }
  | { type: "note"; text: string }
  | { type: "toast"; text: string };

/**
 * **最初のポートを受けてよいメッセージか。** アプリの WebView (`postWebMessage`) から来たもの (送り元のウィンドウが無い) か、
 * このページ自身が送ったもの (同じウィンドウ・同じオリジン。テスト) だけ。Hybridcast のアプリの iframe からのものは、
 * 送り元がその iframe のウィンドウなので受けない
 */
export function portFrom(
  event: Pick<MessageEvent, "data" | "origin" | "ports" | "source">,
  self: { origin: string; window: unknown },
): MessagePort | null {
  if (event.data !== PORT_GREETING) return null;
  const port = event.ports[0];
  if (port === undefined) return null;
  if (event.source === null) return port;
  if (event.source === self.window && event.origin === self.origin) return port;
  return null;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * アプリから届いたもの (JSON の文字列。テストは object のまま送ってもよい) を読む。**形の合わないものは null** (捨てる)。
 * 省いてよい真偽値は false、速さは 1、位置は 0 にする
 */
export function readIncoming(data: unknown): Incoming | null {
  let value: unknown = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const flag = (key: string): boolean => value[key] === true;
  switch (value["type"]) {
    case "init": {
      const common = {
        type: "init" as const,
        open: flag("open"),
        receive: flag("receive"),
        captions: flag("captions"),
      };
      if (value["mode"] === "live" && isNumber(value["service"]))
        return { ...common, mode: "live", service: value["service"] };
      if (value["mode"] === "recording" && isNumber(value["recording"]))
        return { ...common, mode: "recording", recording: value["recording"] };
      return null;
    }
    case "data":
      return isRecord(value["message"]) &&
        typeof value["message"]["type"] === "string"
        ? {
            type: "data",
            message: value["message"] as unknown as ResponseMessage,
          }
        : null;
    case "notice":
      return isRecord(value["message"]) &&
        typeof value["message"]["type"] === "string"
        ? { type: "notice", message: value["message"] }
        : null;
    case "time": {
      const air = value["air"];
      if (air !== null && air !== undefined && !isNumber(air)) return null;
      const pos = value["pos"] ?? 0;
      const rate = value["rate"] ?? 1;
      if (!isNumber(pos) || !isNumber(rate)) return null;
      return {
        type: "time",
        air: air ?? null,
        pos,
        rate,
        paused: flag("paused"),
      };
    }
    case "key":
      return isNumber(value["code"]) && isBoolean(value["down"])
        ? { type: "key", code: value["code"], down: value["down"] }
        : null;
    case "d":
      return { type: "d" };
    case "close":
      return { type: "close" };
    case "receive":
      return isBoolean(value["on"])
        ? { type: "receive", on: value["on"] }
        : null;
    case "channel":
      return isNumber(value["service"])
        ? { type: "channel", service: value["service"] }
        : null;
    case "captions":
      return isBoolean(value["on"])
        ? { type: "captions", on: value["on"] }
        : null;
    default:
      return null;
  }
}

/** アプリが中継する 0x40 の通知 (`notice`) のうち、ページが読むもの。カードの番号と Hybridcast のアプリ */
export function readNotice(
  message: Record<string, unknown>,
):
  | { type: "card"; id: string }
  | { type: "hybridcast"; apps: HybridcastLink[] }
  | null {
  if (message["type"] === "card" && typeof message["id"] === "string")
    return { type: "card", id: message["id"] };
  if (message["type"] === "hybridcast" && Array.isArray(message["apps"]))
    return { type: "hybridcast", apps: message["apps"] as HybridcastLink[] };
  return null;
}

/**
 * **アプリが知らせた再生の時刻から、いまの時刻を出す。** 知らせを受けた時点の `{air, pos, rate, paused}` と
 * `performance.now()` を覚え、止まっていなければ経った時間 × 速さを足す。アプリは変わったとき (シーク・一時停止・速さ) と、
 * ずれを直すために数秒ごとに送る
 */
export class PlayClock {
  #air: number | null = null;
  #pos = 0;
  #rate = 1;
  #paused = true;
  #at = 0;

  set(
    time: Extract<Incoming, { type: "time" }>,
    now = performance.now(),
  ): void {
    this.#air = time.air;
    this.#pos = time.pos;
    this.#rate = time.rate;
    this.#paused = time.paused;
    this.#at = now;
  }

  #moved(now: number): number {
    return this.#paused ? 0 : (now - this.#at) * this.#rate;
  }

  /** 映しているコマの放送の時刻 (UNIX ミリ秒)。まだ知らされていない・分からないなら null */
  air(now = performance.now()): number | null {
    return this.#air === null ? null : this.#air + this.#moved(now);
  }

  /** 再生位置 (ms。録画)。まだ知らされていなければ 0 */
  pos(now = performance.now()): number {
    return Math.round(this.#pos + this.#moved(now));
  }
}
