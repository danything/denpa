import { describe, expect, test } from 'bun:test';
import { run } from './stream';

/**
 * 外の道具を起こして読み切るところ (`run`)。
 *
 * ここで見るのは**読み切った中身の形**。`stdout` は `Uint8Array` だと
 * 名乗っているので、**大きさによらずそうであること**を確かめる。
 */
describe('run の標準出力', () => {
    test('小さい出力はそのまま読める', async () => {
        const { code, stdout } = await run(['echo', '-n', 'PG'], { stdout: true });
        expect(code).toBe(0);
        expect(stdout).toBeInstanceOf(Uint8Array);
        expect(stdout.length).toBe(2);
    });

    /**
     * **1MB を跨いでも Uint8Array のまま。**
     *
     * Bun 1.3.14 の `Response.bytes()` は 1MB を境に ArrayBuffer を返し、
     * `.length` が `undefined` になっていた。型は Uint8Array のままなので
     * 型検査では気付けず、`captions.sup` が `Content-Length: undefined` を
     * 送って**本文ごと落ちていた** (6.4MB の字幕を持つ録画で字幕が出ない)。
     * `.length` を見るのはそれが壊れていた値だから
     */
    test('1MB を超える出力でも Uint8Array で、長さが取れる', async () => {
        const size = 4 * 1024 * 1024;
        const { code, stdout } = await run(['head', '-c', String(size), '/dev/zero'], { stdout: true });
        expect(code).toBe(0);
        expect(stdout).toBeInstanceOf(Uint8Array);
        expect(stdout.length).toBe(size);
        expect(stdout.byteLength).toBe(size);
        // Content-Length に載る値。ここが "undefined" になっていた
        expect(String(stdout.length)).toBe(String(size));
    });

    test('起こせない道具は投げずに 127 で返る', async () => {
        const { code } = await run(['denpa-such-command-does-not-exist'], { stdout: true });
        expect(code).toBe(127);
    });
});
