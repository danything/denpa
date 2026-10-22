import { redirect } from "@sveltejs/kit";
import { relative } from "#lib/server/paths.js";

/**
 * **チューナーの画面は設定の「受信」の「チューナー」に移った** (`/settings/reception#tuners`)。
 * 前の URL (ブックマーク・docs・古い通知のリンク) は、ずっとそちらへ送る (308)
 */
export function GET({ url }) {
  redirect(308, relative(url, "/settings/reception#tuners"));
}
