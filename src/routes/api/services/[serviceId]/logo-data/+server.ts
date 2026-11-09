import { error } from "@sveltejs/kit";

import { parseId } from "#lib/id.js";
import { readLearnedLogo } from "#lib/server/logo-data.js";

/**
 * その局について CM 検出のために**覚えたロゴ**を画像にして返す。
 *
 * 番組表に出すロゴ (`/api/services/<id>/logo`) とは別物。あちらは放送波から
 * 取得した局のマークで、こちらは「画面のどこにロゴが出ているか」を録画から
 * 覚えたもの。覚えているものがロゴらしい画像になっていない (ロゴではない縁を検出した) とき、
 * それを確かめる手立てが要る。
 *
 * 線の向きの揃い方を明るさにした白黒 (縁が白)。原寸は小さいので、出す側で拡大する。
 */
export function GET({ params }) {
  const serviceId = parseId(params.serviceId);
  if (serviceId === null) error(400, "局 ID が不正です");
  const logo = readLearnedLogo(serviceId);
  if (logo === null) error(404, "まだロゴを覚えていません");

  return new Response(new Uint8Array(logo.png), {
    headers: {
      "Content-Type": "image/png",
      // エンコードするたびに書き直す。画面は書いた時刻を URL に付けて取り直す
      "Cache-Control": "no-cache",
    },
  });
}
