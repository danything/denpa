import { error, redirect } from '@sveltejs/kit';
import { relative } from '#lib/server/paths.js';
import { MOVED_SECTIONS } from '#lib/settings-sections.js';

/**
 * **前の節ごとの画面** (`/settings/tuners` など) は、グループの画面のその節へ送る (308)。
 * 設定は節ごとの画面からグループごとの画面に変わった。ブックマーク・docs・古い通知のリンクを切らない
 */
export function GET({ params, url }) {
    // 自分のキーだけ (`constructor` などの継承したキーで飛ばない)
    if (!Object.hasOwn(MOVED_SECTIONS, params.moved)) error(404, 'Not Found');
    redirect(308, relative(url, `/settings/${MOVED_SECTIONS[params.moved]}`));
}
