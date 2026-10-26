import { joinBytes } from "@danything/arib/bytes";
import { error } from "@sveltejs/kit";

import { pagesFromMkv } from "#lib/server/captions.js";
import { config } from "#lib/server/config.js";
import { fileMemo } from "#lib/server/file-memo.js";
import { captionArgs } from "#lib/server/playback.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { run } from "#lib/server/stream.js";

/**
 * 録画の字幕を**文字の配置**で渡す (docs/api.md)。観る画面がライブと同じやり方で描く
 * (`components/player/caption-draw.ts`)。
 *
 * エンコードしたもの (mkv) に入っている放送の字幕そのもの (`S_ARIBSUB`) を抜いて、サーバでデコードする。
 * 抜くには ffmpeg が動画を頭から尻まで読む (実測 0.1〜1秒。ディスクが遅いと観はじめの読み込みと取り合う)。
 * **一度作ったものは覚えておき、同じファイルなら作り直さない** (`file-memo.ts`)。
 * **ずっと前にエンコードした録画は画像 (PGS) が入っている**ことがあり、それは読まずに 404 を返す (字幕なし)。
 * 元のTSが残っていれば、再エンコードすると ARIB の字幕が入る。
 *
 * **まだエンコードできていない録画は元の TS から抜く** (`playback.captionArgs`)。時刻は観る画面の物差し
 * (TS の頭を 0) に揃える。TS は丸ごと舐めるのでエンコードしたものより時間がかかる (1 時間の BS で 7GB)。
 * エンコードが終わると物差しが変わるので、こちらは覚えない
 */

/** 待ち時間の上限。壊れたファイルで居座らせない。元の TS は大きいぶん長く待つ */
const TIMEOUT = 30_000;
const TIMEOUT_TS = 300_000;

/** 溜める量の上限。字幕の筋だけなら1時間で数百KB。壊れたファイルで膨らんでもここで止める */
const LIMIT = 32 * 1024 * 1024;

/** 作ったもの。JSON か、字幕が無い理由。1本で数百KB なので、最近観た十数本ぶん */
type Made = { json: string } | { missing: string };
const made = fileMemo<Made>(16);

const MISSING = "字幕がありません";

/**
 * 字幕を抜いてデコードし、JSON にする。字幕を持たない (抜けたものが空・画像の字幕) ならその理由。
 * **ffmpeg が降りた・上限で切れたときは覚えない** (404 を投げる) — 時間切れや起こせなかったのかもしれない
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
  // 字幕を持たない番組のほうが多い (ffmpeg は「その筋は無い」で、動画を読む前に降りる)
  if (code !== 0) error(404, MISSING);
  // 上限で切れた。壊れたファイルの途中までを覚えて返し続けない
  if (over) error(404, MISSING);
  const out = joinBytes(parts);
  if (out.length === 0) return { missing: MISSING };
  const pages = pagesFromMkv(out);
  return pages === null
    ? { missing: "字幕がありません (画像の字幕 (PGS) には対応していません)" }
    : { json: JSON.stringify(pages) };
}

export async function GET({ params }) {
  const recording = recordingOr404(params.id);
  const args = await captionArgs(recording);
  if (args === null) error(404, MISSING);

  const result =
    args.path === null
      ? await build(args.argv, args.ts)
      : await made.get(args.path, () => build(args.argv, args.ts));
  if ("missing" in result) error(404, result.missing);

  return new Response(result.json, {
    headers: {
      "Content-Type": "application/json",
      // 同じファイルなら中身は変わらない。再エンコードすればパスごと変わる。元の TS はエンコードが終わると物差しが変わる
      "Cache-Control": args.ts ? "no-store" : "private, max-age=3600",
    },
  });
}
