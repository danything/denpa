import { statSync } from "node:fs";

import { joinBytes } from "@danything/arib/bytes";
import { error } from "@sveltejs/kit";

import { pagesFromMkv } from "#lib/server/captions.js";
import { config } from "#lib/server/config.js";
import { fileMemo, sharing } from "#lib/server/file-memo.js";
import { mmtsCaptions } from "#lib/server/mmts.js";
import { captionArgs, uhdCaptionSource } from "#lib/server/playback.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { etagMatches, fileEtag } from "#lib/server/serve.js";
import { run } from "#lib/server/stream.js";

/**
 * 録画の字幕を**文字の配置**で渡す (docs/api.md)。観る画面がライブと同じやり方で描く
 * (`components/player/caption-draw.ts`)。
 *
 * エンコードしたもの (mkv) に入っている放送の字幕そのもの (`S_ARIBSUB`) を抜いて、サーバでデコードする。
 * 抜くには ffmpeg が動画を先頭から末尾まで読む (実測 0.1〜1 秒。ディスクが遅いと観はじめの読み込みと取り合う)。
 * **一度作ったものは覚えておき、同じファイルなら作り直さない** (`file-memo.ts`)。
 * 画像の字幕 (PGS) は読まずに 404 を返す (扱いは docs/encode.md「字幕は放送の ARIB 字幕をそのまま」)。
 *
 * **まだエンコードできていない録画は元の TS から抜く** (`playback.captionArgs`)。時刻は観る画面の物差し
 * (TS の先頭を 0) に揃える。TS は丸ごと舐めるのでエンコードしたものより時間がかかる (1 時間の BS で 7GB)。
 * エンコードが終わると物差しが変わるので、こちらは覚えない (同時に来たリクエストだけ、1 回の取り出しを共有する)
 *
 * **4K の局の録画 (TTML) は ffmpeg を通さない** (`playback.uhdCaptionSource`)。エンコード済みがあれば、その隣に置いた
 * 文字の配置 (`….captions.json`) をそのまま渡す。無ければ元の録画 (`.mmts`) を denpa が丸ごと読む (`mmts.mmtsCaptions`)。
 * 録り終えた `.mmts` はエンコードするまで変わらず、物差しも変わらないので、読んだものは覚える (元の TS と違う)
 */

/** 待ち時間の上限。壊れたファイルで ffmpeg を待ち続けない。元の TS は大きいぶん長く待つ */
const TIMEOUT = 30_000;
const TIMEOUT_TS = 300_000;

/** 溜める量の上限。字幕のストリームだけなら 1 時間で数百 KB。壊れたファイルで膨らんでもここで止める */
const LIMIT = 32 * 1024 * 1024;

/** 作ったもの。JSON か、字幕が無い理由。1 本で数百 KB なので、最近観た十数本ぶん */
type Made = { json: string } | { missing: string };
const made = fileMemo<Made>(16);
/**
 * 元の TS から抜いている最中のもの。覚えはしないが、**同じ録画に同時に来たリクエストは 1 回の取り出しを待たせる**
 * (TS を丸ごと読む ffmpeg を 2 本起こさない。画面を開き直す・端末を 2 台で開くと重なる)
 */
const extracting = sharing<Made>();

const MISSING = "字幕がありません";

/**
 * 字幕を抜いてデコードし、JSON にする。字幕を持たない (抜けたものが空・画像の字幕) ならその理由。
 * **ffmpeg が降りた・上限で切れたときは覚えない** (404 を投げる)。時間切れや、ffmpeg を起こせなかっただけかもしれないため
 */
async function build(argv: string[], ts: boolean): Promise<Made> {
  const parts: Uint8Array[] = [];
  let size = 0;
  let over = false;
  const { code } = await run([config.ffmpeg, ...argv], {
    timeoutMs: ts ? TIMEOUT_TS : TIMEOUT,
    onStdout: (chunk) => {
      if (size + chunk.length > LIMIT) {
        over = true;
        return;
      }
      parts.push(chunk);
      size += chunk.length;
    },
  });
  // 字幕を持たない番組のほうが多い (ffmpeg は「そのストリームは無い」で、動画を読む前に降りる)
  if (code !== 0) error(404, MISSING);
  // 上限で切れた。壊れたファイルの途中までを覚えて返し続けない
  if (over) error(404, MISSING);
  const out = joinBytes(parts);
  if (out.length === 0) return { missing: MISSING };
  const pages = pagesFromMkv(out);
  return pages === null
    ? {
        missing:
          "画像の字幕 (PGS) には対応していません。元の TS が残っていれば、再エンコードすると字幕が入ります",
      }
    : { json: JSON.stringify(pages) };
}

/** 4K の局の録画の字幕を渡す (`uhdCaptionSource`) */
async function uhdCaptions(
  source: NonNullable<Awaited<ReturnType<typeof uhdCaptionSource>>>,
  request: Request,
): Promise<Response> {
  if ("missing" in source) error(404, MISSING);
  if ("sidecar" in source) {
    const stat = statSync(source.sidecar, { throwIfNoEntry: false });
    if (stat === undefined) error(404, MISSING);
    const tag = fileEtag(stat);
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache",
      ETag: tag,
    };
    if (etagMatches(request, tag))
      return new Response(null, { status: 304, headers });
    return new Response(Bun.file(source.sidecar), { headers });
  }
  // 録り終えた `.mmts` は変わらないので、同じファイル (大きさ・更新時刻) なら覚えたものを返す (丸ごと読み直さない)
  const result = await made.get(source.mmts.path, async (): Promise<Made> => {
    const pages = await mmtsCaptions(source.mmts, source.serviceId);
    return pages.pages.length === 0
      ? { missing: MISSING }
      : { json: JSON.stringify(pages) };
  });
  if ("missing" in result) error(404, result.missing);
  return new Response(result.json, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET({ params, request }) {
  const recording = recordingOr404(params.id);
  const uhd = await uhdCaptionSource(recording);
  if (uhd !== null) return uhdCaptions(uhd, request);
  const args = await captionArgs(recording);
  if (args === null) error(404, MISSING);
  const { argv, path } = args;
  const ts = path === null;

  /*
   * **持たせてよいが、毎回確かめさせる** (チャプターと同じ)。再エンコードしても置き場所は同じ名前のことがあり、
   * 捨てる先頭の長さが変われば字幕の時刻も変わる。`no-cache` + ETag (ファイルの大きさと更新時刻) にして、変わっていなければ 304。
   * 元の TS はエンコードが終わると物差しが変わるので控えさせない
   */
  const stat =
    path === null ? undefined : statSync(path, { throwIfNoEntry: false });
  const tag = stat === undefined ? null : fileEtag(stat);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": ts ? "no-store" : "private, no-cache",
  };
  if (tag !== null) {
    headers["ETag"] = tag;
    if (etagMatches(request, tag))
      return new Response(null, { status: 304, headers });
  }

  const result =
    path === null
      ? await extracting(String(recording.id), () => build(argv, ts))
      : await made.get(path, () => build(argv, ts));
  if ("missing" in result) error(404, result.missing);

  return new Response(result.json, { headers });
}
