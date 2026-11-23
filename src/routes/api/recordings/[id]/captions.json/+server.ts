import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import { DRCS_REPLACE } from "@danything/arib/b24-tables";
import { CAPTION_TEXT_VERSION } from "@danything/arib/caption-text";
import { error } from "@sveltejs/kit";

import { fileMemo, sharing } from "#lib/server/file-memo.js";
import {
  type CaptionResult,
  captionSource,
  extractCaptions,
  MISSING,
} from "#lib/server/recording-captions.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { etagMatches, fileEtag } from "#lib/server/serve.js";

/**
 * 録画の字幕を**文字の配置**で渡す (docs/api.md)。観る画面がライブと同じやり方で描く
 * (`components/player/caption-draw.ts`)。取り出し方は `recording-captions.ts` (字幕で探すためのインデックスと同じ)。
 *
 * エンコードしたもの (mkv) に入っている放送の字幕そのもの (`S_ARIBSUB`) を抜いて、サーバでデコードする。
 * 抜くには ffmpeg が動画を先頭から末尾まで読む (実測 0.1〜1 秒。ディスクが遅いと観はじめの読み込みと取り合う)。
 * **一度作ったものは覚えておき、同じファイルなら作り直さない** (`file-memo.ts`)。
 * 画像の字幕 (PGS) は読まずに 404 を返す (扱いは docs/encode.md「字幕は放送の ARIB 字幕をそのまま」)。
 *
 * **まだエンコードできていない録画は元の TS から抜く** (`playback.captionArgs`)。時刻は観る画面の物差し
 * (TS の先頭を 0) に揃える。TS は先頭から末尾まで読むのでエンコードしたものより時間がかかる (1 時間の BS で 7 GB)。
 * エンコードが終わると物差しが変わるので、こちらは覚えない (同時に来たリクエストだけ、1 回の取り出しを共有する)
 *
 * **4K の局の録画 (TTML) は ffmpeg を通さない** (`playback.uhdCaptionSource`)。エンコード済みがあれば、その隣に置いた
 * 文字の配置 (`….captions.json`) をそのまま渡す。無ければ元の録画 (`.mmts`) を denpa が丸ごと読む (`mmts.mmtsCaptions`)。
 * 録り終えた `.mmts` はエンコードするまで変わらず、物差しも変わらないので、読んだものは覚える (元の TS と違う)
 */

/** 作ったもの。JSON か、字幕が無いこと。1 本で数百 KB なので、最近観た十数本ぶん */
type Made = { json: string } | { missing: true };
const made = fileMemo<Made>(16);
/**
 * 元の TS から抜いている最中のもの。覚えはしないが、**同じ録画に同時に来たリクエストは 1 回の取り出しを待たせる**
 * (TS を丸ごと読む ffmpeg を 2 本起こさない。画面を開き直す・端末を 2 台で開くと重なる)
 */
const extracting = sharing<Made>();

/**
 * 字幕を作る側のバージョン。JSON の形式 (`CAPTION_TEXT_VERSION`) と、外字の置き換え表の中身の MD5 の先頭 8 桁。
 * 表に足したり値を直したりしたら、端末に控えてある古い JSON (置き換える前の画像) を 304 で使い続けさせない
 */
const CAPTION_TAG = `c${CAPTION_TEXT_VERSION}.${createHash("md5")
  .update(JSON.stringify([...DRCS_REPLACE]))
  .digest("hex")
  .slice(0, 8)}`;

/**
 * 取り出した結果を JSON にする。**失敗 (時間切れ・上限で切れた・ffmpeg を起こせなかった) は覚えない** (404 を投げる)。
 * 時間切れや、ffmpeg を起こせなかっただけかもしれないため
 */
function toMade(result: CaptionResult): Made {
  if (result.kind === "failed") error(404, MISSING);
  return result.kind === "missing"
    ? { missing: true }
    : { json: JSON.stringify(result.pages) };
}

/** 4K の局の隣に置いた文字の配置を、そのまま渡す (`encoder.writeCaptions`) */
function sidecar(path: string, request: Request): Response {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) error(404, MISSING);
  const tag = fileEtag(stat);
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "private, no-cache",
    ETag: tag,
  };
  if (etagMatches(request, tag))
    return new Response(null, { status: 304, headers });
  return new Response(Bun.file(path), { headers });
}

export async function GET({ params, request }) {
  const recording = recordingOr404(params.id);
  const source = await captionSource(recording);
  if (source.kind === "none") error(404, MISSING);
  if (source.kind === "sidecar") return sidecar(source.path, request);
  if (source.kind === "mmts") {
    // 録り終えた `.mmts` は変わらないので、同じファイル (大きさ・更新時刻) なら覚えたものを返す (丸ごと読み直さない)
    const result = await made.get(source.path, async () =>
      toMade(await extractCaptions(source)),
    );
    if ("missing" in result) error(404, MISSING);
    return new Response(result.json, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  /*
   * **持たせてよいが、毎回確かめさせる** (チャプターと同じ)。再エンコードしても置き場所は同じ名前のことがあり、
   * 捨てる先頭の長さが変われば字幕の時刻も変わる。`no-cache` + ETag (ファイルの大きさと更新時刻) にして、変わっていなければ 304。
   * 元の TS はエンコードが終わると物差しが変わるので控えさせない。
   * **ETag には字幕を作る側の変化も入れる** (`CAPTION_TAG`)。外字の置き換え表に足すと、同じファイルでも作り直した JSON を渡す
   */
  const stat = source.encoded
    ? statSync(source.path, { throwIfNoEntry: false })
    : undefined;
  const tag =
    stat === undefined
      ? null
      : fileEtag(stat).replace(/"$/, `-${CAPTION_TAG}"`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": source.encoded ? "private, no-cache" : "no-store",
  };
  if (tag !== null) {
    headers["ETag"] = tag;
    if (etagMatches(request, tag))
      return new Response(null, { status: 304, headers });
  }

  const make = async () => toMade(await extractCaptions(source));
  const result = source.encoded
    ? await made.get(source.path, make)
    : await extracting(String(recording.id), make);
  if ("missing" in result) error(404, MISSING);

  return new Response(result.json, { headers });
}
