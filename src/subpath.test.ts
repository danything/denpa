import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **画面の中の URL は `resolve` (`$app/paths`) で頭を付ける** (前段の接頭辞の下でも動くように。server/paths.ts)。
 *
 * 根から書いた URL (`href="/guide"`・`` fetch(`/api/…`) ``) を1つ足すと、接頭辞の下で
 * その先だけが壊れる。根で動かしている限り気付けないので、ここで落とす。
 * サーバの中 (転送は相対・外に渡す URL は publicBase) と、コメントの中は見ない
 */
const ROOT = join(import.meta.dir);
const SERVER =
    /(^|\/)(lib\/server\/|hooks\.server\.ts$|.*\+server\.ts$|.*\+page\.server\.ts$|.*\+layout\.server\.ts$)/;
// `href={x ? '/' : '/?deleted=1'}` のように、式の中に根から書いた文字列があるものも拾う
const ABSOLUTE =
    /(?:href|src|action|formaction)="\/|(?:href|src|action)=\{[^}]*['"`]\/(?!\/)|['"`]\/api\/|goto\(['`]\//;
/** 頭を呼ぶ側が付けるもの (Service Worker からも読まれる。offline-db.ts の downloadRequests) */
const PREFIXED_BY_CALLER = /^lib\/offline-db\.ts$/;
/** 接頭辞を後から足して使う定数 (live.ts の SOCKET_PATH・raw/engine.ts の DECODER) */
const ALLOWED = [
    /export const SOCKET_PATH = '\/api\/live\/socket';/,
    /const DECODER = '\/api\/live\/mpeg2';/,
];

function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isDirectory()) return files(path);
        return /\.(svelte|ts|html)$/.test(e.name) && !e.name.endsWith('.test.ts') ? [path] : [];
    });
}

describe('画面の中の URL', () => {
    test('根から書いていない', () => {
        const found: string[] = [];
        for (const path of files(ROOT)) {
            const rel = path.slice(ROOT.length + 1);
            if (SERVER.test(rel) || PREFIXED_BY_CALLER.test(rel)) continue;
            // コメント (`<!-- -->`・`/* */`) は行を保ったまま消す
            const blank = (m: string) => m.replace(/[^\n]/g, ' ');
            readFileSync(path, 'utf8')
                .replace(/<!--[\s\S]*?-->/g, blank)
                .replace(/\/\*[\s\S]*?\*\//g, blank)
                .split('\n')
                .forEach((line, i) => {
                    const code = line.trim();
                    if (code.startsWith('//')) return;
                    if (!ABSOLUTE.test(line) || ALLOWED.some((ok) => ok.test(line))) return;
                    found.push(`${rel}:${i + 1}: ${code}`);
                });
        }
        expect(found).toEqual([]);
    });
});
