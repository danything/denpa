/**
 * データ放送と字幕、画面の放送の字を描くためのフォント (Denpa Font。danything/denpa-font のリリースの woff2 をそのまま)。
 *
 * - `denpa-font.woff2`: 基本の字 (JIS X 0208・ARIB の外字・JIS X 0213 の記号やかななど漢字でない字)。データ放送はこれだけで足りる
 * - `denpa-font-jisx0213.woff2`: JIS X 0213 で足された漢字 (第 3・第 4 水準。字幕・番組表にはめったに出ない)
 * - `denpa-font.css`: 2 つを同じファミリ名で名乗らせる CSS (`#lib/server/font.ts` の `fontCss`)。
 *   後のほうは `unicode-range` 付きなので、その字が出たときだけブラウザが取得する
 *
 * BML は仕様で**等幅**を求めていて (狭い画面で空白を使って組むため)、
 * **丸ゴシック**を名指しし、**ARIB の外字**を使う。Denpa Font は 3 つとも満たす
 * ([docs/stream.md](../../../../../docs/stream.md#データ放送の統合))。
 * 字幕もブラウザがこの字で描くので、**データ放送と字幕で字形が揃う**。
 *
 * 手元での開発ではイメージに入っていないので、無ければ 404 を返す。画面側は
 * 端末のフォントへ落ちる。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { error } from "@sveltejs/kit";

import { config } from "#lib/server/config.js";
import { FONT_FILES, fontCacheControl, fontCss } from "#lib/server/font.js";
import { etagMatches } from "#lib/server/serve.js";

import type { RequestHandler } from "./$types";

/** 置き場 (リリースのファイルそのまま。`FONT_DIR`。イメージは Dockerfile が、Mac と Windows は配布物の `server/font` に置く) */
const DIR = config.fontDir;
/** 入っているバージョン (`v2.1` など。Dockerfile が `DENPA_FONT_VERSION` を書く) */
const VERSION = `${DIR}/VERSION`;

/**
 * 指紋と、作った CSS (woff2 は null。中身は置き場から流すので持たない)。字はイメージか配布物に入っていて、
 * 動いている間は変わらないので 1 度だけ読む
 */
const loaded = new Map<string, { css: string | null; tag: string } | null>();
let installed: string | null = null;

function read(file: string): { css: string | null; tag: string } | null {
  const known = loaded.get(file);
  if (known !== undefined) return known;
  let body: string | Buffer | null = null;
  if (file === "denpa-font.css") {
    // 基本の字が無ければ名乗らせるものも無い
    if (existsSync(`${DIR}/denpa-font.woff2`)) {
      const ranges = `${DIR}/denpa-font-jisx0213.txt`;
      body = fontCss(
        installed ?? "",
        existsSync(ranges) ? readFileSync(ranges, "utf8") : null,
      );
    }
  } else if (existsSync(`${DIR}/${file}`)) {
    body = readFileSync(`${DIR}/${file}`);
  }
  const found =
    body === null
      ? null
      : {
          css: typeof body === "string" ? body : null,
          tag: `"${createHash("sha256").update(body).digest("base64url")}"`,
        };
  loaded.set(file, found);
  return found;
}

export const GET: RequestHandler = ({ params, request, url }) => {
  const type = FONT_FILES.get(params.file);
  if (type === undefined) error(404, "そのファイルはありません");
  installed ??= existsSync(VERSION) ? readFileSync(VERSION, "utf8").trim() : "";
  const found = read(params.file);
  if (found === null) error(404, "フォントが入っていません");
  /*
   * バージョン付きの URL でバージョンが合えば 1 年持たせる。それ以外は**持たせてよいが、毎回確かめさせる**
   * (`no-cache` + ETag)。理由は `#lib/server/font.ts`
   */
  const headers = {
    "content-type": type,
    "cache-control": fontCacheControl(url.searchParams.get("v"), installed),
    etag: found.tag,
  };
  if (etagMatches(request, found.tag))
    return new Response(null, { status: 304, headers });
  // CSS は作ったもの、woff2 は置き場のファイルをそのまま流す
  const body = found.css ?? Bun.file(`${DIR}/${params.file}`).stream();
  return new Response(body, { headers });
};
