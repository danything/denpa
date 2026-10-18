/**
 * ブラウザで MPEG-2 と AAC をデコードする WebAssembly を配る (ライブを変換せずに送る経路。docs/stream.md#放送そのままmpeg-2を送る)。
 *
 * **static/ に置かないのは、組むのがイメージの中だから** (Dockerfile の `mpeg2wasm` 段。
 * emscripten で FFmpeg のデコーダを組む)。git には入れない — 870KB ほど (wasm 855KB + mjs 14KB) の
 * 生成物を抱えると FFmpeg を上げるたびに差し替えが要り、組んだ手順と中身が食い違っても気づけない。
 *
 * 配るのは2つだけ: ローダー (`decoder.mjs`) と中身 (`decoder.wasm`)。**名前は決め打ち** —
 * 置き場の中を好きに読ませるエンドポイントにはしない。
 *
 * 無ければ 404。画面はそれを見てエンコードしたものに戻る (`raw/worker.ts`)
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { error } from '@sveltejs/kit';
import { config } from '#lib/server/config.js';
import type { RequestHandler } from './$types';

const TYPES: Record<string, string> = {
    'decoder.mjs': 'text/javascript; charset=utf-8',
    // **これでないと `instantiateStreaming` が受け取らない** (ローダーがそれを使う)
    'decoder.wasm': 'application/wasm',
};

/**
 * **縮めて配る。** wasm は AAC のデコーダを足して 855KB になり、縮めれば 3 分の 1 になる
 * (brotli 292KB / gzip 364KB。docs/stream.md#放送そのままmpeg-2を送る)。前段に縮める proxy が無い家が多いので
 * ここで縮める。縮めるのは中身が変わったとき (ETag が変わったとき) の1度だけで、あとは覚えたものを返す
 *
 * **縮め終えるまでは縮めずに返す。** brotli の 11 は wasm 1つで 2 秒ほど掛かる (実測 2079ms)。
 * 同期で縮めていた頃はその間サーバ全体が止まり、デコーダの読み込みも遅れて、互換モードの観る画面が
 * 1コマも描けなかった (E2E の 40-watch-compat・41-watch-compat-local。adapter-node の中継が
 * `Accept-Encoding` を外していた間はここを通らず、表に出ていなかった)。縮めるのは別のスレッドに任せる
 */
/** zlib が返すのは自分の ArrayBuffer を持つ Buffer (共有メモリではない) */
type Packed = { br: Buffer<ArrayBuffer>; gzip: Buffer<ArrayBuffer> };
const packed = new Map<string, { tag: string; ready: Packed | null }>();

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/** 縮めたもの。**まだなら null** (縮めはじめるので、今回は縮めずに返す) */
function pack(path: string, tag: string): Packed | null {
    const hit = packed.get(path);
    if (hit?.tag === tag) return hit.ready;
    const entry: { tag: string; ready: Packed | null } = { tag, ready: null };
    packed.set(path, entry);
    void (async () => {
        const raw = await readFile(path);
        const [br, gz] = await Promise.all([
            brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
            gzipped(raw, { level: 9 }),
        ]);
        entry.ready = { br: br as Buffer<ArrayBuffer>, gzip: gz as Buffer<ArrayBuffer> };
    })().catch((failure) => {
        // 縮められなくても配れる。次にリクエストされたときにもう一度試す
        console.warn(`[mpeg2] ${path} を縮められません: ${failure}`);
        if (packed.get(path) === entry) packed.delete(path);
    });
    return null;
}

export const GET: RequestHandler = ({ params, request }) => {
    // `constructor` などの継いだ名前に当たらない
    const type = Object.hasOwn(TYPES, params.file) ? TYPES[params.file] : undefined;
    if (type === undefined) error(404, 'ファイルが見つかりません');
    const path = join(config.mpeg2Dir, params.file);
    if (!existsSync(path)) error(404, 'MPEG-2 の再生に必要なファイルが入っていません');
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
    const ready = encoding === null ? null : pack(path, tag);
    if (encoding === null || ready === null) return new Response(Bun.file(path).stream(), { headers });
    return new Response(ready[encoding], { headers: { ...headers, 'content-encoding': encoding } });
};
