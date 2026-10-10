import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyOrientation, encodeModel } from '../ts/logo-detect';

/**
 * 覚えたロゴ (`own-logo-<幅>x<高さ>.bin`) を絵にするところ。
 *
 * 覚えているものが絵になっていないことがあり (ロゴではない縁を拾った)、それを
 * 確かめる手立てが無いと「なぜ当たらないのか」が分からない。
 */
const { config } = await import('./config');
config.cmLogoDir = mkdtempSync(join(tmpdir(), 'denpa-cm-logo-'));

const { forgetLogoData, learnedAt, logoRepo, readLearnedLogo } = await import('./logo-data');

/**
 * 覚えたものを置く。`edges` の画素だけ向きが揃っている (毎コマ同じ向き) ことにする
 */
function write(
    serviceId: number,
    frame: { width: number; height: number },
    rect: { x: number; y: number; width: number; height: number },
    edges: number[],
): string {
    const orientation = emptyOrientation(rect.width, rect.height);
    orientation.count = 10;
    for (const at of edges) orientation.sx[at] = 10;
    const dir = logoRepo(serviceId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `own-logo-${frame.width}x${frame.height}.bin`);
    writeFileSync(
        path,
        encodeModel({ frameWidth: frame.width, frameHeight: frame.height, rect, orientation }),
    );
    return path;
}

const HD = { width: 1440, height: 1080 };

describe('readLearnedLogo', () => {
    test('覚えている枠を読み、揃い方を明るさにした白黒の PNG にする', () => {
        write(1, HD, { x: 1226, y: 58, width: 3, height: 2 }, [0, 4]);

        const logo = readLearnedLogo(1);
        expect(logo).toMatchObject({ x: 1226, y: 58, width: 3, height: 2 });

        // PNG の署名と IHDR の大きさ。中身までは見ない
        const png = logo!.png;
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
        expect(view.getUint32(16)).toBe(3);
        expect(view.getUint32(20)).toBe(2);
    });

    test('SD と HD を両方持っていれば、最後に書いたほうを出す', () => {
        const hd = write(2, HD, { x: 1300, y: 40, width: 4, height: 4 }, [5]);
        write(2, { width: 720, height: 480 }, { x: 600, y: 20, width: 2, height: 2 }, [1]);
        // HD のほうを後で書いたことにする
        const later = new Date(Date.now() + 60_000);
        utimesSync(hd, later, later);

        expect(readLearnedLogo(2)).toMatchObject({ x: 1300, y: 40, width: 4, height: 4 });
        expect(learnedAt(2)).toBe(later.getTime());
    });

    test('まだ覚えていない局は null', () => {
        expect(readLearnedLogo(999)).toBeNull();
        expect(learnedAt(999)).toBeNull();
    });

    test('捨てると読めなくなる。次の録画で一から覚え直す', () => {
        write(3, HD, { x: 0, y: 0, width: 1, height: 1 }, [0]);
        const dir = logoRepo(3);
        expect(existsSync(dir)).toBe(true);

        forgetLogoData(3);

        expect(existsSync(dir)).toBe(false);
        expect(readLearnedLogo(3)).toBeNull();
    });
});
