/**
 * **ライブと追っかけで、どの形式で観るか** (コーデックのメニュー)。画面 (`live-player.svelte.ts`) とサーバ
 * (`server/live-start.ts` の先回り) が同じ決め方をするので、ここに置く (docs/stream.md「どの形式で流すか」)。
 */

import { LIVE_CODECS, type LiveCodec } from "./live";

/**
 * メニューで選んだもの。`auto` は端末と開いた場所 (家の中か) に合わせる (`autoCodec`)。
 * `raw` は MPEG-2 (放送のまま。ライブだけ)。**端末ごとに覚える** (`LAST_COOKIE` の `choice`)
 */
export type LiveChoice = "auto" | LiveCodec | "raw";

/** 実際にリクエストする形式。エンコードするもの (AV1・H.264) か、放送のまま (`raw`) */
export type LiveFormat = LiveCodec | "raw";

/**
 * **世帯の設定でメニューから外すコーデック** (設定 `hideH264Hevc`)。外すのはメニューだけで、
 * AV1 を再生できない端末には自動で H.265 や H.264 を流す (サーバは今までどおり出す)
 */
export const HIDDEN_CODECS = ["h264", "hevc"] as const;

/** 形式の名前 (メニューと断り書き) */
export function formatLabel(format: LiveFormat): string {
  if (format === "raw") return "MPEG-2";
  return LIVE_CODECS.find((codec) => codec.id === format)?.label ?? format;
}

/**
 * 覚えていた選択を読む。**知らない値・前の形式の cookie (`codec`・`raw` だけで `choice` が無い) は自動。**
 * H.264・H.265 を外す設定 (`hidden`) なら、それを選んでいた端末も自動として扱う。H.265 を選んでいても、ライブの
 * エンコーダが GPU でなくなっていれば、画面が代わりを選んで断り書きを出す (`live-player.svelte.ts` の `pickFormat`)
 */
export function readChoice(value: unknown, hidden: boolean): LiveChoice {
  if (value === "av1" || value === "raw") return value;
  if ((value === "h264" || value === "hevc") && !hidden) return value;
  return "auto";
}

/**
 * **「自動」の形式。** 使えるもの (`rawOk`・`av1`・`hevc`・`h264`) のうち、次の順で先頭のもの。どれも使えなければ null。
 *
 * | 場面 | 順 |
 * | --- | --- |
 * | 家の中 (`indoor`) | MPEG-2 → AV1 → H.265 → H.264 |
 * | 外 | AV1 → H.265 → H.264 |
 * | 互換モード (`compat`。canvas に描く) | AV1 → H.264 → MPEG-2 |
 * | 追っかけ (`chase`。MPEG-2 は無い) | AV1 → H.264 (家の中でも、互換モードでも) |
 *
 * 家の中で MPEG-2 を先にするのは、サーバがエンコードせずに済み、画質も放送のままだから。外では太すぎる
 * (放送のままは 1局で 15Mbit/s ほど)。互換モードで MPEG-2 を後ろにするのは、エンコードしたものより canvas に描くのが重いから。
 * H.265 は同じ画質で H.264 より小さいので先にする。互換モードと追っかけでは出さない。
 *
 * `rawOk` は「この端末で MPEG-2 をデコードできて、まだ諦めていない」、`av1`・`hevc`・`h264` は「受け取れて (互換モードなら
 * 描けて)、まだ諦めていない」。`hevc` はそのうえでライブのエンコーダが GPU のとき (`server/viewing.ts` の
 * `ViewingOptions.hevc`)。どれが諦められたかは呼ぶ側が持つ
 */
export function autoCodec(o: {
  indoor: boolean;
  rawOk: boolean;
  av1: boolean;
  hevc: boolean;
  h264: boolean;
  compat: boolean;
  chase: boolean;
}): LiveFormat | null {
  const order: LiveFormat[] = o.chase
    ? ["av1", "h264"]
    : o.compat
      ? ["av1", "h264", "raw"]
      : o.indoor
        ? ["raw", "av1", "hevc", "h264"]
        : ["av1", "hevc", "h264"];
  return (
    order.find((format) => (format === "raw" ? o.rawOk : o[format])) ?? null
  );
}
