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

    /**
     * **押された後の合図でも起こさない。** `abort` の聞き耳は押された瞬間にしか
     * 鳴らないので、押された後に起こした道具は最後まで走っていた (中止を押した
     * あとの無音検出・字幕づくり)。殺されたときと同じ 143 で、すぐ返る
     */
    test('もう押されている中止の合図なら、起こさずに 143 で返る', async () => {
        const controller = new AbortController();
        controller.abort();
        const started = Date.now();
        const { code } = await run(['sleep', '5'], { signal: controller.signal });
        expect(code).toBe(143);
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});

describe('run の標準出力を流して受ける (onStdout)', () => {
    test('溜めずに来たそばから渡し、stdout は空で返る', async () => {
        let total = 0;
        const size = 4 * 1024 * 1024;
        const { code, stdout } = await run(['head', '-c', String(size), '/dev/zero'], {
            onStdout: (chunk) => {
                total += chunk.length;
            },
        });
        expect(code).toBe(0);
        expect(total).toBe(size);
        expect(stdout.length).toBe(0);
    });

    /** 受け手が投げたら道具を止める。止めないと誰も読まない管が詰まり、時間切れまで居座る */
    test('受け手が投げたら、道具を止めて投げ直す', async () => {
        const started = Date.now();
        const failing = run(['cat', '/dev/zero'], {
            onStdout: () => {
                throw new Error('壊れた');
            },
        });
        await expect(failing).rejects.toThrow('壊れた');
        expect(Date.now() - started).toBeLessThan(5_000);
    });
});
