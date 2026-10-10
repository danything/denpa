/**
 * データ放送と字幕を描くための字。**字幕を焼いているのと同じフォントを配る。**
 *
 * BML は仕様で**等幅**を求めていて (狭い画面で空白を使って組むため)、
 * **丸ゴシック**を名指しし、**ARIB の外字**を使う。イメージに入れてある
 * Denpa Font (danything/denpa-font) は3つとも満たす — 借りている側が抱えている Kosugi は
 * 外字を持っていないので、こちらのほうが適している
 * ([docs/stream.md](../../../../../docs/stream.md#56-データ放送の統合))。
 *
 * **ttf と woff2 の2つを置いてある** (Dockerfile。どちらもリリースのものをそのまま)。
 * 字幕は ffmpeg が fontconfig 越しに ttf を読み、こちらはブラウザへ woff2 を渡す。
 * 同じ字なので、**データ放送と字幕で字形が揃う**。
 *
 * 手元での開発ではイメージに入っていないので、無ければ 404 を返す。画面側は
 * `local(...)` を並べてあるので、そのときは端末のフォントで出る。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Dockerfile が置く場所。ffmpeg (字幕) が読むのと同じディレクトリ */
const FONT = '/usr/share/fonts/truetype/denpa-font/denpa-font.woff2';

/** 中身の指紋。字はイメージに焼いてあり、動いている間は変わらないので1度だけ測る */
let tag: string | null = null;

export const GET: RequestHandler = ({ request }) => {
    if (!existsSync(FONT)) error(404, 'フォントが入っていません');
    tag ??= `"${createHash('sha256').update(readFileSync(FONT)).digest('base64url')}"`;
    /*
     * **持たせてよいが、毎回確かめさせる** (`no-cache` + ETag)。イメージを入れ替えて
     * 字が変わっても URL は同じなので、長く持たせると古い字が残る
     * (以前は `/api/font` を1年 immutable で配っていて、字を足しても届かなかった)
     */
    const headers = { 'content-type': 'font/woff2', 'cache-control': 'no-cache', etag: tag };
    if (request.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers });
    return new Response(Bun.file(FONT).stream(), { headers });
};
