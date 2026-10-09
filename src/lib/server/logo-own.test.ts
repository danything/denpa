import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyOrientation, type LogoModel } from '../ts/logo-detect';
import { load, MODEL_FILE, save } from './logo-own';

/**
 * 自前のロゴ判定の、覚えたものの置き場 (`logo-own.ts` の `save`/`load`)。
 * コマを抜く所は ffmpeg が要るので、ここでは試さない (実機での突き合わせは docs/encode.md)
 */

function model(fill: number): LogoModel {
    const orientation = emptyOrientation(8, 4);
    orientation.count = 10;
    orientation.sx.fill(fill);
    orientation.sy.fill(-fill);
    return {
        frameWidth: 1440,
        frameHeight: 1080,
        rect: { x: 1300, y: 30, width: 8, height: 4 },
        orientation,
    };
}

/** 使い捨ての置き場で試す */
function withRepo(body: (repo: string) => void): void {
    const repo = mkdtempSync(join(tmpdir(), 'own-logo-'));
    try {
        body(repo);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
}

describe('覚えたものの置き場', () => {
    test('書いて読むと同じもの。隣に書いたものは残らない', () => {
        withRepo((repo) => {
            save(repo, model(3));
            save(repo, model(5));
            const back = load(repo);
            expect(back?.rect).toEqual({ x: 1300, y: 30, width: 8, height: 4 });
            expect(back?.orientation.sx[0]).toBe(5);
            expect(readdirSync(repo)).toEqual([MODEL_FILE]);
        });
    });

    test('無い・壊れているなら null', () => {
        withRepo((repo) => {
            expect(load(repo)).toBeNull();
            writeFileSync(join(repo, MODEL_FILE), 'broken');
            expect(load(repo)).toBeNull();
        });
    });

    /** 覚えたものは次の録画を速くするだけ。書けなくても検出は続ける */
    test('書けなくても投げない', () => {
        withRepo((repo) => {
            // 置き場の名前がファイルで塞がれている
            const blocked = join(repo, 'blocked');
            writeFileSync(blocked, '');
            expect(() => save(blocked, model(1))).not.toThrow();
        });
    });
});
