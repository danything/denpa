import { statSync } from "node:fs";

import { config } from "#lib/server/config.js";
import { encodedPath, tsChapters } from "#lib/server/playback.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { etagMatches, fileEtag } from "#lib/server/serve.js";
import { run } from "#lib/server/stream.js";
import { parseChapters } from "#lib/ts/watch.js";

/**
 * エンコードしたものに入っているチャプターを返す。**CM飛ばしの行き先。**
 *
 * 観る画面のほか、テレビのアプリも使う外向けの API (形式は docs/api.md で約束している)。
 * 時刻は `playback` の物差し (`PlayAxis`) の秒 — 録画の時間そのもので、どの形式で流しても、
 * `/stream` をシークでリクエストし直しても、そのまま使える
 *
 * ## DB ではなくファイルから読む
 *
 * `recordings.cm_ranges` にも検出した位置は残っているが、**エンコードの完了と
 * 食い違うことがある**:
 *
 * - CMを**切って**エンコードしたものは、切ったぶんだけ後ろが前に詰まっている
 * - 引き継いだ録画 (EPGStation) は denpa が検出していないので `cm_ranges` が空。
 *   それでもチャプターは入っている
 *
 * **入っているものを読めば、どれも同じ扱いで済む。**
 *
 * ## まだエンコードできていない録画は検出した区間から
 *
 * 元の TS にチャプターは入らない (入れ物が持てない)。観る画面は TS の頭を 0 とした時刻で
 * 流す (`server/playback.ts`) ので、元の TS の頭から数えた `cm_ranges` がそのまま使える (`tsChapters`)
 *
 * ## 待たせない
 *
 * `-show_chapters` は見出しだけを読むので、中身を舐めない。実機の30分ものでも
 * 一瞬で返る。**開くたびに呼ぶ**ので、録画ごとに控えを持つほどではない
 * (ファイルが再エンコードされたら中身も変わる)。
 *
 * ## 持たせてよいが、毎回確かめさせる
 *
 * **CM検出のやり直しは、同じパスのファイルのチャプターを書き直す** (`encoder.runCmJob`)。
 * パスで1時間持たせていた頃は、やり直したあとも古いチャプターが返っていた。
 * `no-cache` + ETag (ファイルの大きさと更新時刻) にして、変わっていなければ ffprobe も走らせずに 304 で返す
 */

/** 待ち時間の上限。壊れたファイルで居座らせない */
const TIMEOUT = 15_000;

export async function GET({ params, request }) {
  const recording = recordingOr404(params.id);
  const path = encodedPath(recording);
  // エンコードが終われば中身が変わるので控えさせない
  if (path === null) {
    return Response.json(
      { chapters: await tsChapters(recording) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const stat = statSync(path, { throwIfNoEntry: false });
  const tag = stat === undefined ? null : fileEtag(stat);
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
  };
  if (tag !== null) {
    headers["ETag"] = tag;
    if (etagMatches(request, tag))
      return new Response(null, { status: 304, headers });
  }

  /*
   * **読めなくても空を返す。** ffprobe が無い・ファイルが壊れている・
   * そもそもチャプターが無い、のどれでも画面のすることは同じ (送りを出さない)。
   * ここで転ぶと、**観られるはずの録画が観られなくなる**
   */
  const probed = await run(
    [
      config.ffprobe,
      "-v",
      "error",
      "-show_chapters",
      "-print_format",
      "json",
      path,
    ],
    { timeoutMs: TIMEOUT, stdout: true },
  );
  const out = new TextDecoder().decode(probed.stdout);

  return Response.json({ chapters: parseChapters(out) }, { headers });
}
