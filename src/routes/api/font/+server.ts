/**
 * データ放送を描くための字。**字幕を焼いているのと同じフォントを配る。**
 *
 * BML は仕様で**等幅**を求めていて (狭い画面で空白を使って組むため)、
 * **丸ゴシック**を名指しし、**ARIB の外字**を使う。像に入れてある
 * `rounded-mplus-1m-arib` は3つとも満たす — 借りている側が抱えている Kosugi は
 * 外字を持っていないので、こちらのほうが適している
 * ([vendor/web-bml](../../../lib/vendor/web-bml/README.md))。
 *
 * **ttf と woff2 の2つを置いてある** (Dockerfile)。字幕は ffmpeg が fontconfig
 * 越しに ttf を読み、こちらはブラウザへ woff2 を渡す。同じ字なので、
 * **データ放送と字幕で字形が揃う**。
 *
 * 手元での開発では像に入っていないので、無ければ 404 を返す。画面側は
 * `local(...)` を並べてあるので、そのときは端末のフォントで出る。
 */

import { existsSync } from 'node:fs';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Dockerfile が置く場所。ffmpeg (字幕) が読むのと同じディレクトリ */
const FONT = '/usr/share/fonts/truetype/rounded-mplus-arib/rounded-mplus-1m-arib.woff2';

export const GET: RequestHandler = () => {
    if (!existsSync(FONT)) error(404, 'フォントが入っていません');
    return new Response(Bun.file(FONT).stream(), {
        headers: {
            'content-type': 'font/woff2',
            /*
             * **像ごとに変わるものなので、長く持たせて構わない。**
             * 入れ替えれば URL ごと変わる (`?v=`) — 付けるのは画面側
             */
            'cache-control': 'public, max-age=31536000, immutable',
        },
    });
};
