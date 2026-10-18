import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 「ロゴをいますぐ集める」で取得できた局の数 (`logoStamps` / `writtenSince`)。
 *
 * 開いた中継で減った数で数えていた頃は、他の中継から来たロゴや選局の共有で取得したものが
 * 入らず、画面の「14 / 14 局」の下に「12 局のロゴを取得しました」と出ていた。
 * 取得の前に控えた書き込み時刻より新しいロゴを持つ局を数える
 */
const { config } = await import('./config');
config.dataDir = mkdtempSync(join(tmpdir(), 'denpa-logo-'));
const dir = join(config.dataDir, 'logos');
mkdirSync(dir, { recursive: true });

const { countFree, logoStamps, writtenSince } = await import('./logo');

/** 局のロゴを置き、書き込み時刻を `at` (秒) にする */
function put(serviceId: number, at: number): void {
    const path = join(dir, `${serviceId}.png`);
    writeFileSync(path, 'png');
    utimesSync(path, at, at);
}

describe('取得できたロゴの数', () => {
    test('控えたあとに書き込まれた局だけ数える。前から持っていて変わらない局は数えない', () => {
        put(1, 1000);
        put(2, 1000);
        const stamps = logoStamps([1, 2, 3]);
        expect(stamps.get(3)).toBe(0);

        put(2, 2000);
        put(3, 2000);
        expect(writtenSince(stamps, [1, 2, 3])).toBe(2);
    });

    test('控えたときに無かった局 (取得の途中で取り込まれた局) も、ロゴが来れば数える', () => {
        const stamps = logoStamps([10]);
        put(11, 3000);
        expect(writtenSince(stamps, [10, 11])).toBe(1);
        // ロゴがまだ無ければ数えない
        expect(writtenSince(stamps, [10, 12])).toBe(0);
    });

    test('控えにだけあって今は無い局は数えない', () => {
        put(20, 1000);
        const stamps = logoStamps([20, 21]);
        put(21, 4000);
        expect(writtenSince(stamps, [20])).toBe(0);
    });
});

/**
 * 「ロゴをいますぐ集める」が数える空きチューナー (`countFree`)。
 *
 * 閉じたことがエージェントに届くのは非同期なので、閉じた直後の一覧には自分の選局が残っている。
 * 衛星の外れの中継を閉じた直後に CS の空きを訊いて0と見え、残りの CS を諦めていた
 */
describe('空きチューナーの数', () => {
    const tuner = (types: string[], users: string[] = []) => ({
        disabled: false,
        types: types as ('GR' | 'BS' | 'CS')[],
        channel: users.length === 0 ? null : { type: types[0] as 'GR' | 'BS' | 'CS', channel: 'X' },
        users: users.map((use) => ({ use, priority: 1 })),
    });

    test('閉じたばかりの自分の選局しかいないチューナーは空きとして数える', () => {
        const tuners = [tuner(['BS', 'CS'], ['logo BS/BS11_0']), tuner(['BS', 'CS'], ['logo BS/BS03_0'])];
        expect(countFree(tuners, 'CS')).toBe(0);
        expect(countFree(tuners, 'CS', ['logo BS/BS03_0'])).toBe(1);
    });

    test('ほかの利用者が同じ選局にいれば空きではない。種別の合わないチューナーと無効なチューナーも数えない', () => {
        const tuners = [
            tuner(['BS', 'CS'], ['logo BS/BS03_0', 'epg BS03_0']),
            tuner(['GR']),
            { ...tuner(['BS', 'CS']), disabled: true },
        ];
        expect(countFree(tuners, 'CS', ['logo BS/BS03_0'])).toBe(0);
        expect(countFree(tuners, 'GR')).toBe(1);
    });
});
