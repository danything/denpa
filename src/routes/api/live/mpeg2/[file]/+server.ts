/**
 * ブラウザで MPEG-2 を解く WebAssembly を配る (ライブを生で送る道。docs/stream.md §5.5)。
 *
 * **static/ に置かないのは、組むのがイメージの中だから** (Dockerfile の `mpeg2wasm` 段。
 * emscripten で FFmpeg の復号器を組む)。git には入れない — 500KB の生成物を抱えると
 * FFmpeg を上げるたびに差し替えが要り、組んだ手順と中身が食い違っても気づけない。
 *
 * 配るのは2つだけ: 読み込み口 (`decoder.mjs`) と中身 (`decoder.wasm`)。**名前は決め打ち** —
 * 置き場の中を好きに読ませる口にはしない。
 *
 * 無ければ 404。画面はそれを見て焼いたものに戻る (`raw/player.ts`)
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { error } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import type { RequestHandler } from './$types';

const TYPES: Record<string, string> = {
    'decoder.mjs': 'text/javascript; charset=utf-8',
    // **これでないと `instantiateStreaming` が受け取らない** (読み込み口がそれを使う)
    'decoder.wasm': 'application/wasm',
};

export const GET: RequestHandler = ({ params, request }) => {
    const type = TYPES[params.file];
    if (type === undefined) error(404, '無い名前です');
    const path = join(config.mpeg2Dir, params.file);
    if (!existsSync(path)) error(404, 'MPEG-2 の復号器が入っていません');
    /*
     * **持たせてよいが、毎回確かめさせる** (`no-cache` + ETag)。イメージを入れ替えると
     * 中身が変わるのに URL は同じなので、長く持たせると mjs と wasm の版が食い違いうる
     */
    const stat = statSync(path);
    const tag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    if (request.headers.get('if-none-match') === tag) return new Response(null, { status: 304 });
    return new Response(Bun.file(path).stream(), {
        headers: { 'content-type': type, 'cache-control': 'no-cache', etag: tag },
    });
};
