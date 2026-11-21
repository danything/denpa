/**
 * **canvas に描く先 (`RawEngine`) を作る所と、描けなくなったときの移り先。** ライブ・追っかけ (`live-player.svelte.ts`) と
 * 観る画面 (`canvas-player.ts` と観る画面の `canvasFallBack`) が同じものを使う。
 *
 * - `openCanvas` … `RawEngine` を作る。消音・音量・「再生する音」として鳴らすかは、作るときに入れる。
 *   作れなければ理由の文字列を返す
 * - `fallBackTo` … 描けなくなったとき、次にどれで観るかを決める (DOM を触らない)
 *
 * 移ったあとにどうリクエストし直すか (ライブは同じ局をリクエストし直し、観る画面は形式を選び直す) と、
 * 断り書きの文言は呼ぶ側が決める
 */

import { RawEngine, type RawEvents } from "#lib/raw/engine.js";
import type { RawInput } from "#lib/raw/messages.js";
import type { PlayCodec } from "#lib/ts/playback.js";

export interface CanvasSinkOptions {
  /** 映像の入れ物。canvas はここに入る (データ放送が入れ物ごと動かす)。null なら作れない */
  host: HTMLElement | null;
  /** この前に差し込む (字幕の canvas より下に来るように) */
  before: Element | null;
  /** 鳴らし始めるまでに貯める長さ (秒)。あとから変えるときは `RawEngine.target` */
  target: number;
  /** 何を受け取るか (`raw/messages.ts` の `RawInput`) */
  input: RawInput;
  /** 放送の今を追わない (追っかけ・録画。`RawEngine` の `chase`) */
  follow: boolean;
  /** 音を消したまま始めるか */
  muted: boolean;
  /** 音量 (%。`#lib/volume.ts`)。null は放送のまま */
  volume: number | null;
  /** 「再生する音」として鳴らすか (バックグラウンド再生・小窓。`RawEngine.background`) */
  playback: boolean;
  events: RawEvents;
}

/**
 * `RawEngine` を作る。**作れなければ理由 (例外の文言) を返す**。理由に何を添えて断り書きにするかは呼ぶ側が決める。
 * 作る途中で失敗したときは、`RawEngine` が作りかけのもの (canvas・worker・AudioContext) を残さない
 */
export function openCanvas(options: CanvasSinkOptions): RawEngine | string {
  if (options.host === null) return "表示先がありません";
  let engine: RawEngine;
  try {
    engine = new RawEngine(
      options.host,
      options.before,
      options.target,
      options.events,
      options.playback,
      options.input,
      options.follow,
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (options.muted) engine.mute();
  engine.volume = options.volume;
  return engine;
}

/**
 * **描けなくなったとき、次にどれで観るか。** `failed` は打ち切ったもの (MPEG-2 か、エンコードしたもの)、
 * `usable` はこの端末で描けて、まだ打ち切っていない形式 (並びが優先の順)。
 *
 * - 互換モードでない … `"video"` (`<video>` に戻す。canvas に描いていたのは MPEG-2 か、`<video>` が読めなかった保存した録画)
 * - エンコードしたもの (H.264 / AV1) をやめた … `usable` に MPEG-2 があれば `"mpeg2"`
 * - MPEG-2 をやめた … `usable` の先頭の H.264 / AV1
 * - どれも無い … null (理由を出して止まる)。**互換モードでは `<video>` に戻らない** (テスラでは止まってしまう)
 */
export function fallBackTo<C extends PlayCodec>(
  failed: "mpeg2" | "encoded",
  usable: readonly C[],
  compat: boolean,
): C | "video" | null {
  if (!compat) return "video";
  if (failed === "mpeg2")
    return usable.find((codec) => codec !== "mpeg2") ?? null;
  return usable.find((codec) => codec === "mpeg2") ?? null;
}
