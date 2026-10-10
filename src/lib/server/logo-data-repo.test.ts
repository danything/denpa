import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 覚えたロゴ (`own-logo-*.bin`) の置き場まわり。
 *
 * 見るのは**覚えたかどうかの判断**と、**同じ絵を映している局の束ね方**。
 * 覚え方そのものは `ts/logo-detect.test.ts`。
 *
 * **DB には触らない。** 単体テストは1つのプロセスで走り、DB の繋ぎ先は最初に
 * 開いたものが使い回される。ここで開くと他のファイルが数えている行に混ざる
 * (実際に混ぜて3件落とした)。行を渡すだけで試せる形にしてある。
 */
const work = mkdtempSync(join(tmpdir(), 'denpa-logo-data-'));
const { config } = await import('./config');
config.cmLogoDir = join(work, 'cm');

const { learned, stations } = await import('./logo-data');

function service(id: number, name: string, networkId = 32391) {
    return { id, service_id: id % 100000, network_id: networkId, name, type: 'GR' as const, channel: 'T13' };
}

/** 覚えたことにする */
function remember(id: number) {
    const repo = join(config.cmLogoDir, String(id));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'own-logo-1440x1080.bin'), 'dummy');
}

describe('覚えたかどうか', () => {
    test('覚えたものがあれば覚えている', () => {
        remember(1);

        expect(learned(1)).toBe(true);
    });

    test('置き場が無ければ覚えていない', () => {
        expect(learned(2)).toBe(false);
    });

    test('覚えたもの以外しか無ければ覚えていない', () => {
        // 書きかけ (隣に書いてから差し替える。`logo-own.save`) を「覚えた」と数えない
        const repo = join(config.cmLogoDir, '3');
        mkdirSync(repo, { recursive: true });
        writeFileSync(join(repo, 'own-logo-1440x1080.bin.1-abc.tmp'), '');
        // logoframe が覚えていた頃の .lgd も数えない (もう使わない)
        writeFileSync(join(repo, 'TEST-v0001.lgd'), '');

        expect(learned(3)).toBe(false);
    });
});

describe('同じ絵を映している局を束ねる', () => {
    test('局名が同じものは1つにする', () => {
        const rows = [
            service(3239123608, 'TOKYO MX1'),
            service(3239123609, 'TOKYO MX1'),
            service(3239123610, 'TOKYO MX2'),
        ];

        expect(stations(rows).map((row) => row.id)).toEqual([3239123608, 3239123610]);
    });

    test('もう覚えている局を代表にする', () => {
        remember(31);
        const rows = [service(30, 'テレ東'), service(31, 'テレ東')];

        expect(stations(rows).map((row) => row.id)).toEqual([31]);
    });

    test('ネットワークが違えば別の局。たまたま同名なだけのことがある', () => {
        const rows = [service(40, 'サンテレビ', 32391), service(41, 'サンテレビ', 32400)];

        expect(stations(rows).map((row) => row.id)).toEqual([40, 41]);
    });
});
