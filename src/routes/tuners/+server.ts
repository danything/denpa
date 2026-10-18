import { redirect } from '@sveltejs/kit';
import { relative } from '#lib/server/paths.js';

/**
 * **チューナーの画面は設定の「チューナー」に移った** (`/settings/tuners`)。
 * 前の URL (ブックマーク・docs・古い通知のリンク) は、ずっとそちらへ送る (308)。
 * 画面にはアンカーが無かったので、行き先は節ひとつで足りる
 */
export function GET({ url }) {
    redirect(308, relative(url, '/settings/tuners'));
}
