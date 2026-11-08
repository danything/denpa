/**
 * **どの形式で観るか** (コーデックのメニュー)。「自動」の順はライブ・追っかけ・録画の観る画面で同じ関数 (`autoOrder`) から出す。
 * 録画の観る画面の互換モードは、エンコード済みと同じ形式の詰め替えを先にして、そのあとは互換モードの順 (`ts/playback.ts` の `pickCanvas`。下の `autoOrder` の表)。
 * 画面 (`live-player.svelte.ts`・`ts/playback.ts`) とサーバ (`server/viewing.ts` の先回りと、テレビのアプリ向けの `codec=auto`) が同じ決め方をするので、
 * ここに置く (docs/stream.md「どの形式で流すか」)。
 */

import { HW_CODECS, type HwCodec } from "./hw";
import { LIVE_CODECS, type LiveCodec } from "./live";

/**
 * メニューで選んだもの。`auto` は端末と開いた場所 (家の中か) に合わせる (`autoCodec`)。
 * `raw` は MPEG-2 (放送のまま)。ライブは**端末ごとに覚える** (`LAST_COOKIE` の `choice`)
 */
export type LiveChoice = "auto" | LiveCodec | "raw";

/** 実際にリクエストする形式。エンコードするもの (AV1・H.265・H.264) か、放送のまま (`raw`) */
export type LiveFormat = LiveCodec | "raw";

/**
 * **メニューに並べないコーデック** (ライブ・追っかけ・録画の観る画面。テレビのアプリには `GET /api/playback/options` の `hidden` で渡す)。
 * 外すのはメニューだけで、AV1 を再生できない端末には自動で H.265 や H.264 を流す (サーバは今までどおり出す)
 */
export const HIDDEN_CODECS = ["h264", "hevc"] as const;

/** 形式の名前 (メニューと断り書き) */
export function formatLabel(format: LiveFormat): string {
  if (format === "raw") return "MPEG-2";
  return LIVE_CODECS.find((codec) => codec.id === format)?.label ?? format;
}

/**
 * 覚えていた選択を読む。**知らない値・前の形式の cookie (`codec`・`raw` だけで `choice` が無い) は自動。**
 * メニューに並べない H.264・H.265 (`HIDDEN_CODECS`) を前に選んでいた端末も自動として扱う
 */
export function readChoice(value: unknown): LiveChoice {
  return value === "av1" || value === "raw" ? value : "auto";
}

/** エンコード済みのコーデック (録画の観る画面で選ぶもの)。並びは GPU でエンコードする順 (`HW_CODECS`) と同じ */
type EncodedCodec = HwCodec;

/**
 * **「自動」の順。ライブ・追っかけ・録画の観る画面で、この 1 つで決める。** その画面で出せない形式
 * (追っかけの H.265 など) は呼ぶ側が並びから外すだけにする。
 *
 * | 場面 | 家の中 (`indoor`) | 外 | 互換モード (`compat`。canvas に描く) |
 * | --- | --- | --- | --- |
 * | その場でエンコード (ライブ・追っかけ) | MPEG-2 → H.264 → AV1 → H.265 | AV1 → H.265 → H.264 | AV1 → H.264 → MPEG-2 |
 * | エンコード済み (`encoded`。録画の観る画面) | AV1 → H.265 → H.264 | AV1 → H.265 → H.264 | 同じ形式の詰め替え → 上の互換モードの順 (`ts/playback.ts` の `pickCanvas`) |
 *
 * - 家の中は**開くまでの速さ**を採る。MPEG-2 はエンコードせずに済み、画質も放送のまま。次はエンコードの立ち上がりが速い H.264
 * - 外は**回線**を採る。放送のままは 1 局で 15Mbit/s ほどあり太すぎる。同じ画質で小さい順 (AV1 → H.265 → H.264)
 * - 互換モードで MPEG-2 を後ろにするのは、エンコードしたものより canvas に描くのが重いから
 * - エンコード済みは小さい順。もうエンコードしてあるので、開く速さはコーデックで変わらない
 */
export function autoOrder(scene: "encoded"): readonly EncodedCodec[];
export function autoOrder(scene: {
  indoor: boolean;
  compat: boolean;
}): readonly LiveFormat[];
export function autoOrder(
  scene: "encoded" | { indoor: boolean; compat: boolean },
): readonly LiveFormat[] {
  if (scene === "encoded") return HW_CODECS;
  if (scene.compat) return ["av1", "h264", "raw"];
  return scene.indoor
    ? ["raw", "h264", "av1", "hevc"]
    : ["av1", "hevc", "h264"];
}

/**
 * **ライブと追っかけの「自動」の形式。** `autoOrder` の順で、使えるもの (`rawOk`・`av1`・`hevc`・`h264`) の先頭。どれも
 * 使えなければ null。
 *
 * `rawOk` は「この端末で MPEG-2 をデコードできて、まだ打ち切っていない」、`av1`・`hevc`・`h264` は「受け取れて (互換モードなら
 * 描けて)、まだ打ち切っていない」。`hevc` はそのうえでライブのエンコーダが GPU のとき (`server/viewing.ts` の
 * `ViewingOptions.hevc`)。追っかけと互換モードでは呼ぶ側が false にする。どれをやめたかは呼ぶ側が持つ
 */
export function autoCodec(o: {
  indoor: boolean;
  rawOk: boolean;
  av1: boolean;
  hevc: boolean;
  h264: boolean;
  compat: boolean;
}): LiveFormat | null {
  return (
    autoOrder(o).find((format) => (format === "raw" ? o.rawOk : o[format])) ??
    null
  );
}
