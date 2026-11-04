/**
 * **どの形式で観るか** (コーデックのメニュー)。「自動」の順はライブ・追っかけ・録画の観る画面で同じ関数 (`autoOrder`) から出す。
 * 例外は録画の観る画面の互換モードで、`ts/playback.ts` の `pickCanvas` がエンコード済みと同じ形式 → H.264 → AV1 → MPEG-2 の順に選ぶ
 * (下の `autoOrder` の表)。画面 (`live-player.svelte.ts`・`ts/playback.ts`) とサーバ (`server/viewing.ts` の先回りと、テレビのアプリ向けの `codec=auto`) が同じ決め方をするので、
 * ここに置く (docs/stream.md「どの形式で流すか」)。
 */

import { LIVE_CODECS, type LiveCodec } from "./live";

/**
 * メニューで選んだもの。`auto` は端末と開いた場所 (家の中か) に合わせる (`autoCodec`)。
 * `raw` は MPEG-2 (放送のまま)。ライブは**端末ごとに覚える** (`LAST_COOKIE` の `choice`)
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

/** エンコード済みのコーデック (録画の観る画面で選ぶもの) */
export type EncodedCodec = "av1" | "hevc" | "h264";

/**
 * **「自動」の順。ライブ・追っかけ・録画の観る画面で、この1つで決める。** その画面で出せない形式
 * (追っかけの H.265 など) は呼ぶ側が並びから外すだけにする。例外は録画の観る画面の互換モードだけ (表の右下)。
 *
 * | 場面 | 家の中 (`indoor`) | 外 | 互換モード (`compat`。canvas に描く) |
 * | --- | --- | --- | --- |
 * | その場でエンコード (ライブ・追っかけ) | MPEG-2 → H.264 → AV1 → H.265 | AV1 → H.265 → H.264 | AV1 → H.264 → MPEG-2 |
 * | エンコード済み (`encoded`。録画の観る画面) | AV1 → H.265 → H.264 | AV1 → H.265 → H.264 | (`ts/playback.ts` の `pickCanvas`) |
 *
 * - 家の中は**開くまでの速さ**を採る。MPEG-2 はエンコードせずに済み、画質も放送のまま。次はエンコードの立ち上がりが速い H.264
 * - 外は**回線**を採る。放送のままは 1局で 15Mbit/s ほどあり太すぎる。同じ画質で小さい順 (AV1 → H.265 → H.264)
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
  if (scene === "encoded") return ["av1", "hevc", "h264"];
  if (scene.compat) return ["av1", "h264", "raw"];
  return scene.indoor
    ? ["raw", "h264", "av1", "hevc"]
    : ["av1", "hevc", "h264"];
}

/**
 * **ライブと追っかけの「自動」の形式。** `autoOrder` の順で、使えるもの (`rawOk`・`av1`・`hevc`・`h264`) の先頭。どれも
 * 使えなければ null。
 *
 * `rawOk` は「この端末で MPEG-2 をデコードできて、まだ諦めていない」、`av1`・`hevc`・`h264` は「受け取れて (互換モードなら
 * 描けて)、まだ諦めていない」。`hevc` はそのうえでライブのエンコーダが GPU のとき (`server/viewing.ts` の
 * `ViewingOptions.hevc`)。追っかけと互換モードでは呼ぶ側が false にする。どれが諦められたかは呼ぶ側が持つ
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
