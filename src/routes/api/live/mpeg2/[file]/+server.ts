/**
 * ブラウザで MPEG-2 と AAC を解く WebAssembly を配る (ライブを生で送る道。docs/stream.md §5.5)。
 *
 * **static/ に置かないのは、組むのがイメージの中だから** (Dockerfile の `mpeg2wasm` 段。
 * emscripten で FFmpeg の復号器を組む)。git には入れない — 850KB ほどの生成物を抱えると
 * FFmpeg を上げるたびに差し替えが要り、組んだ手順と中身が食い違っても気づけない。
 *
 * 配るのは2つだけ: 読み込み口 (`decoder.mjs`) と中身 (`decoder.wasm`)。**名前は決め打ち** —
 * 置き場の中を好きに読ませる口にはしない。
 *
 * 無ければ 404。画面はそれを見て焼いたものに戻る (`raw/worker.ts`)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { error } from '@sveltejs/kit';
import { config } from '#lib/server/config.js';
import type { RequestHandler } from './$types';

const TYPES: Record<string, string> = {
    'decoder.mjs': 'text/javascript; charset=utf-8',
    // **これでないと `instantiateStreaming` が受け取らない** (読み込み口がそれを使う)
    'decoder.wasm': 'application/wasm',
};

/**
 * **縮めて配る。** wasm は AAC の復号器を足して 855KB になり、縮めれば 3 分の 1 になる
 * (brotli 292KB / gzip 364KB。docs/stream.md §5.5)。前段に縮める proxy が無い家が多いので
 * ここで縮める。縮めるのは中身が変わったとき (ETag が変わったとき) の1度だけで、あとは覚えたものを返す
 */
const packed = new Map<string, { tag: string; br: Buffer<ArrayBuffer>; gzip: Buffer<ArrayBuffer> }>();

function pack(path: string, tag: string) {
    const hit = packed.get(path);
    if (hit?.tag === tag) return hit;
    const raw = readFileSync(path);
    const entry = {
        tag,
        br: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        gzip: gzipSync(raw, { level: 9 }),
    };
    packed.set(path, entry);
    return entry;
}

export const GET: RequestHandler = ({ params, request }) => {
    // `constructor` などの継いだ名前を拾わない
    const type = Object.hasOwn(TYPES, params.file) ? TYPES[params.file] : undefined;
    if (type === undefined) error(404, '無い名前です');
    const path = join(config.mpeg2Dir, params.file);
    if (!existsSync(path)) error(404, 'MPEG-2 の復号器が入っていません');
    /*
     * **持たせてよいが、毎回確かめさせる** (`no-cache` + ETag)。イメージを入れ替えると
     * 中身が変わるのに URL は同じなので、長く持たせると mjs と wasm の版が食い違いうる
     */
    const stat = statSync(path);
    const tag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    const headers: Record<string, string> = {
        'content-type': type,
        'cache-control': 'no-cache',
        etag: tag,
        vary: 'Accept-Encoding',
    };
    if (request.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers });
    const accept = request.headers.get('accept-encoding') ?? '';
    const encoding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    if (encoding === null) return new Response(Bun.file(path).stream(), { headers });
    const body = pack(path, tag)[encoding];
    return new Response(body, { headers: { ...headers, 'content-encoding': encoding } });
};
