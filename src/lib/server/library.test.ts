import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 保存先での名前の付け方。
 *
 * 環境変数ではなく設定そのものを書き換えている (理由は files.test.ts と同じ)。
 */
const { config } = await import('./config');
config.encodedDir = mkdtempSync(join(tmpdir(), 'denpa-lib-'));

const { libraryPath, encodedPath, libraryFamily, seriesFolder } = await import('./library');

/** 2026-08-03 22:30 開始の録画 */
function recording(overrides: { library_path?: string | null; alt_path?: string | null } = {}) {
    return {
        id: 39,
        series: '番組',
        subtitle: '',
        start_at: new Date(2026, 7, 3, 22, 30).getTime(),
        ...overrides,
    };
}

const PLAIN = '番組/番組 - 2026-08-03 - 2230.mkv';
const WITH_ID = '番組/番組 - 2026-08-03 - 2230 [39].mkv';

function place(rel: string): string {
    const path = join(config.encodedDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'x');
    return path;
}

describe('保存先での名前', () => {
    test('空いていれば素の名前', () => {
        expect(libraryPath(recording(), '.mkv')).toBe(join(config.encodedDir, PLAIN));
    });

    /*
     * **焼き直しで名前が入れ替わらないこと。**
     *
     * `existsSync` だけで決めていた頃は、焼き直すたびに素の名前と `[39]` 付きを
     * 行き来していた (置き換えたあと古いほうを消すので、次はまた素の名前が空く)。
     * 中身は無事だが、プレイヤー側の見え方が毎回崩れる
     */
    test('いま置いてある自分のファイルは衝突ではない', () => {
        const mine = place(PLAIN);
        expect(libraryPath(recording({ library_path: mine }), '.mkv')).toBe(mine);
    });

    test('別の録画のファイルとぶつかったら録画IDを足す', () => {
        place(PLAIN);
        // 自分はまだどこにも置いていない (初回) / 置き場が違う
        expect(libraryPath(recording({ library_path: null }), '.mkv')).toBe(join(config.encodedDir, WITH_ID));
    });

    /*
     * **コーデックごとに名前を分ける。** 両方焼くと同じフォルダに2本並ぶので、
     * H.264 のほうに印を付けて衝突を避ける。どちらも Matroska (mp4 は PGS 字幕を
     * 持てない)。テレビでどちらを選べばよいかも名前で分かる
     */
    test('AV1 は素の .mkv、H.264 は [H264] 付き', () => {
        // 他のテストが置いた PLAIN と衝突しないよう、別のシリーズで見る
        const rec = { id: 7, series: '別番組', subtitle: '', start_at: recording().start_at };
        expect(encodedPath(rec, 'av1')).toBe(
            join(config.encodedDir, '別番組/別番組 - 2026-08-03 - 2230.mkv'),
        );
        expect(encodedPath(rec, 'h264')).toBe(
            join(config.encodedDir, '別番組/別番組 - 2026-08-03 - 2230 [H264].mkv'),
        );
    });

    test('いま置いてある2本 (主・もう一方) はどちらも衝突ではない', () => {
        const av1 = place(PLAIN);
        const h264 = place('番組/番組 - 2026-08-03 - 2230 [H264].mkv');
        const rec = recording({ library_path: av1, alt_path: h264 });
        expect(encodedPath(rec, 'av1')).toBe(av1);
        expect(encodedPath(rec, 'h264')).toBe(h264);
    });

    /*
     * **焼き直す前の掃除が拾うべき候補。** コーデック (素/[H264]) × 録画IDの有無で
     * 4通り。命名規則が変わる前の素名ファイルまで含めて片付けるために、この一覧を
     * 使う (encoder.ts のはぐれ掃除)
     */
    test('取りうる置き場所4通りを列挙する', () => {
        const dir = config.encodedDir;
        expect(new Set(libraryFamily(recording()))).toEqual(
            new Set([
                join(dir, '番組/番組 - 2026-08-03 - 2230.mkv'),
                join(dir, '番組/番組 - 2026-08-03 - 2230 [39].mkv'),
                join(dir, '番組/番組 - 2026-08-03 - 2230 [H264].mkv'),
                join(dir, '番組/番組 - 2026-08-03 - 2230 [39] [H264].mkv'),
            ]),
        );
    });
});

describe('シリーズのフォルダ名 (一覧の「まとめて表示」も同じ名前でまとめる)', () => {
    test('焼いたものを置くフォルダと同じ名前になる', () => {
        const rec = recording();
        expect(dirname(libraryPath(rec, '.mkv'))).toBe(join(config.encodedDir, seriesFolder(rec.series, '')));
    });

    test('ファイル名に使えない文字は焼くときと同じに落とす', () => {
        expect(seriesFolder('番組: 特別編', '')).toBe('番組 特別編');
    });

    test('シリーズ名が無ければ番組名から切り出す (話数・副題・記号を落とす)', () => {
        expect(seriesFolder('', '【新】テストアニメ #12 決戦[字]')).toBe('テストアニメ');
        expect(seriesFolder('', 'テストアニメ 第3話「出会い」')).toBe('テストアニメ');
    });
});
