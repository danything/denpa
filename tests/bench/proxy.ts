/**
 * **測るときの入口** (`decoded-most.bench.ts`)。アプリへそのまま取り次ぎ、`/bench/<名前>` だけは作り物の映像
 * (`media.ts`) を返す。`probe.js` がページの `/stream` をここへ向ける。
 *
 * テストの一式 (`tests/stack.ts`) のアプリは 127.0.0.1 でしか待たないので、GPU のあるふだんの Chrome から
 * 測るときもここを通す (`0.0.0.0` で待つ。コンテナのポートを外へ出す)。
 *
 *     bun tests/bench/proxy.ts <アプリの URL> <映像の置き場> <ポート> <MPEG-2 の頭の PTS>
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const [app = '', dir = '', port = '4180', origin = '0'] = process.argv.slice(2);
const TYPES: Record<string, string> = {
    'mpeg2.m2ts': 'video/mp2t',
    'av1.mp4': 'video/mp4',
    'h264.mp4': 'video/mp4',
};

Bun.serve({
    hostname: '0.0.0.0',
    port: Number(port),
    idleTimeout: 0,
    async fetch(request) {
        const url = new URL(request.url);
        const name = url.pathname.match(/^\/bench\/([\w.]+)$/)?.[1];
        if (name !== undefined) {
            // ふだんの Chrome で測ったもの (`probe.js` の `__bench.send`)。1 回 1 行で足す。数えるのは report.ts
            if (name === 'result' && request.method === 'POST') {
                appendFileSync(join(dir, '..', 'chrome.jsonl'), `${JSON.stringify(await request.json())}\n`);
                return new Response(null, { status: 204 });
            }
            // ふだんの Chrome では `<script src="/bench/probe.js">` で読む (CSP は 'self' を通す)
            if (name === 'probe.js') {
                return new Response(Bun.file(join(import.meta.dir, name)), {
                    headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' },
                });
            }
            const type = TYPES[name];
            if (type === undefined) return new Response('not found', { status: 404 });
            return new Response(Bun.file(join(dir, name)), {
                headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Bench-Origin': origin },
            });
        }
        const target = new URL(url.pathname + url.search, app);
        const headers = new Headers(request.headers);
        headers.delete('host');
        const response = await fetch(target, {
            method: request.method,
            headers,
            body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
            redirect: 'manual',
            // 圧縮されたまま渡す (解いてしまうと Content-Encoding と食い違う)
            decompress: false,
        } as RequestInit);
        /*
         * **probe.js は書き換えた worker を Blob から起こす**ので、CSP の worker-src に blob: を足す。
         * Blob の worker はページの CSP を引き継ぐので、WASM を読めるよう script-src に 'wasm-unsafe-eval' も
         * (本来の worker は自分の応答の CSP で動く。vite.config.ts)
         */
        const policy = response.headers.get('content-security-policy');
        if (policy === null) return response;
        const answer = new Headers(response.headers);
        if (!/script-src /.test(policy) || !/worker-src /.test(policy)) {
            // 書き換える所が無い。Blob の worker が起こせず、測れないまま黙って終わらないように言っておく
            console.warn(`CSP に script-src か worker-src がありません (${request.url})`);
        }
        answer.set(
            'content-security-policy',
            policy
                .replace(/worker-src ([^;]*)/, 'worker-src $1 blob:')
                .replace(/script-src ([^;]*)/, "script-src $1 'wasm-unsafe-eval'"),
        );
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: answer,
        });
    },
});
console.log(`proxy http://0.0.0.0:${port} → ${app}`);
