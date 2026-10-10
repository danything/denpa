/**
 * データ放送と字幕、画面の放送の字を描くためのフォント (Denpa Font。danything/denpa-font のリリースの woff2 をそのまま)。
 *
 * BML は仕様で**等幅**を求めていて (狭い画面で空白を使って組むため)、
 * **丸ゴシック**を名指しし、**ARIB の外字**を使う。Denpa Font は3つとも満たす —
 * 借りている側が抱えている Kosugi は外字を持っていないので、こちらのほうが適している
 * ([docs/stream.md](../../../../../docs/stream.md#56-データ放送の統合))。
 * 字幕もブラウザがこの字で描くので、**データ放送と字幕で字形が揃う**。
 *
 * 手元での開発ではイメージに入っていないので、無ければ 404 を返す。画面側は
 * 端末のフォントへ落ちる。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { error } from '@sveltejs/kit';
import { fontCacheControl } from '#lib/server/font.js';
import type { RequestHandler } from './$types';

/** Dockerfile が置く場所 (リリースの woff2 そのまま) */
const FONT = '/usr/share/denpa-font/denpa-font.woff2';
/** 入っている版 (`v2.1` など。Dockerfile が `DENPA_FONT_VERSION` を書く) */
const VERSION = '/usr/share/denpa-font/VERSION';

/** 中身の指紋と版。字はイメージに焼いてあり、動いている間は変わらないので1度だけ読む */
let tag: string | null = null;
let installed: string | null = null;

export const GET: RequestHandler = ({ request, url }) => {
    if (!existsSync(FONT)) error(404, 'フォントが入っていません');
    tag ??= `"${createHash('sha256').update(readFileSync(FONT)).digest('base64url')}"`;
    installed ??= existsSync(VERSION) ? readFileSync(VERSION, 'utf8').trim() : '';
    /*
     * 版付きの URL で版が合えば1年持たせる。それ以外は**持たせてよいが、毎回確かめさせる**
     * (`no-cache` + ETag)。理由は `#lib/server/font.ts`
     */
    const headers = {
        'content-type': 'font/woff2',
        'cache-control': fontCacheControl(url.searchParams.get('v'), installed),
        etag: tag,
    };
    // 前段の proxy が弱い形 (`W/"…"`) にしたり、いくつも並べたりしても 304 にする
    const asked = (request.headers.get('if-none-match') ?? '')
        .split(',')
        .map((t) => t.trim().replace(/^W\//, ''));
    if (asked.includes(tag)) return new Response(null, { status: 304, headers });
    return new Response(Bun.file(FONT).stream(), { headers });
};
