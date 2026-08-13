import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chasePlan, fileSize, followFile } from './chase';
import { chunks } from './stream';

/**
 * 追っかけ再生の追い読み ([issue #16](https://github.com/danything/denpa/issues/16))。
 * 生TSに時間の索引は無いので、シークはバイト比例の当たりでよい —
 * ここで守るのは「188に揃う」「際に寄りすぎない」「録り終わるまで読み続ける」。
 */
describe('どこから読み始めるか (chasePlan)', () => {
    test('バイト比例で、TSパケットの頭に揃える', () => {
        // 600秒で 600 * 188 * 100 バイト → 1秒 = 188*100 バイト
        const plan = chasePlan(600 * 188 * 100, 600, 300);
        expect(plan.at).toBe(300);
        expect(plan.offset).toBe(300 * 188 * 100);
        expect(plan.offset % 188).toBe(0);
    });

    test('生の際 (いま書いているところ) の少し手前までしか行かない', () => {
        const plan = chasePlan(600 * 188 * 100, 600, 9999);
        expect(plan.at).toBe(595);
    });

    test('負の位置は頭に丸める', () => {
        expect(chasePlan(1_000_000, 60, -5).at).toBe(0);
        expect(chasePlan(1_000_000, 60, -5).offset).toBe(0);
    });

    test('送り込みは実測レートより速い (追い付けるように)', () => {
        const size = 600 * 2_000_000; // 2MB/s の10分
        const plan = chasePlan(size, 600, 0);
        expect(plan.paceBytesPerSec).toBeGreaterThan(size / 600);
    });
});

describe('伸びるファイルの追い読み (followFile)', () => {
    let dir: string | null = null;
    afterEach(() => {
        if (dir !== null) rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
        const parts: Uint8Array[] = [];
        for await (const chunk of chunks(stream)) parts.push(chunk);
        const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
        let offset = 0;
        for (const part of parts) {
            out.set(part, offset);
            offset += part.length;
        }
        return out;
    }

    test('書き足されたぶんも読んでから終わる', async () => {
        dir = mkdtempSync(join(tmpdir(), 'chase-'));
        const path = join(dir, 'rec.ts');
        writeFileSync(path, 'abcdef');

        // 尻に着いたら1回だけ書き足し、次に訊かれたとき「終わった」と答える
        let asked = 0;
        const stream = followFile(path, 0, 1e9, () => {
            asked++;
            if (asked === 1) {
                appendFileSync(path, 'ghij');
                return false;
            }
            return true;
        });
        const got = await readAll(stream);
        expect(new TextDecoder().decode(got)).toBe('abcdefghij');
    });

    test('途中 (offset) から読める', async () => {
        dir = mkdtempSync(join(tmpdir(), 'chase-'));
        const path = join(dir, 'rec.ts');
        writeFileSync(path, '0123456789');
        const got = await readAll(followFile(path, 4, 1e9, () => true));
        expect(new TextDecoder().decode(got)).toBe('456789');
    });

    test('無いファイルは転ぶ (エラーとして伝わる)', async () => {
        dir = mkdtempSync(join(tmpdir(), 'chase-'));
        const stream = followFile(join(dir, 'missing.ts'), 0, 1e9, () => true);
        expect(readAll(stream)).rejects.toThrow();
    });
});

describe('fileSize', () => {
    test('無ければ null', () => {
        expect(fileSize('/no/such/file.ts')).toBeNull();
    });
});
