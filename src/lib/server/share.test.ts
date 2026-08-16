import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-share-')), 'denpa.db');

const { mintShareToken, verifyShareToken, shareTokenAllows, SHARE_TTL } = await import('./share');

describe('期限付きの再生リンク', () => {
    test('作ったものは期限まで通る', () => {
        const at = 1_000_000;
        const { token, expiresAt } = mintShareToken(42, at);
        expect(expiresAt).toBe(at + SHARE_TTL);
        expect(verifyShareToken(42, token, at)).toBe(true);
        expect(verifyShareToken(42, token, expiresAt - 1)).toBe(true);
    });

    test('期限が切れたら通らない', () => {
        const at = 1_000_000;
        const { token, expiresAt } = mintShareToken(42, at);
        expect(verifyShareToken(42, token, expiresAt)).toBe(false);
    });

    /*
     * テレビの履歴に残ったURLがそのまま生き続けるように、生きているうちに
     * もう一度発行すると**同じトークンのまま期限だけ延びる**
     */
    test('期限内にもう一度作ると、同じリンクで期限が延びる', () => {
        const at = 1_000_000;
        const first = mintShareToken(43, at);
        const second = mintShareToken(43, at + SHARE_TTL / 2);
        expect(second.token).toBe(first.token);
        expect(second.expiresAt).toBe(at + SHARE_TTL / 2 + SHARE_TTL);
        // 最初の期限を過ぎても、延ばした期限までは通る
        expect(verifyShareToken(43, first.token, first.expiresAt + 1)).toBe(true);
        expect(verifyShareToken(43, first.token, second.expiresAt)).toBe(false);
    });

    test('切れたあとに作ると、新しいリンクになる', () => {
        const at = 1_000_000;
        const first = mintShareToken(44, at);
        const second = mintShareToken(44, first.expiresAt + 1);
        expect(second.token).not.toBe(first.token);
        expect(verifyShareToken(44, first.token, first.expiresAt + 2)).toBe(false);
        expect(verifyShareToken(44, second.token, first.expiresAt + 2)).toBe(true);
    });

    test('別の録画には使い回せない', () => {
        const { token } = mintShareToken(42, 0);
        expect(verifyShareToken(45, token, 0)).toBe(false);
    });

    test('形が壊れていても落ちずに断る', () => {
        mintShareToken(42, 0);
        expect(verifyShareToken(42, null, 0)).toBe(false);
        expect(verifyShareToken(42, '', 0)).toBe(false);
        expect(verifyShareToken(42, '署名なし', 0)).toBe(false);
        expect(verifyShareToken(42, 'x.y', 0)).toBe(false);
    });

    test('効くのはファイルの口だけ', () => {
        // hooks から呼ぶ入口は実時刻で見るので、作りたてのものを使う
        const params = new URLSearchParams({ token: mintShareToken(46).token });
        expect(shareTokenAllows('/api/recordings/46/file', params)).toBe(true);
        expect(shareTokenAllows('/api/recordings/46/file/name.mkv', params)).toBe(true);
        expect(shareTokenAllows('/api/recordings/47/file/name.mkv', params)).toBe(false);
        expect(shareTokenAllows('/api/recordings/47/file', params)).toBe(false);
        expect(shareTokenAllows('/api/recordings/46', params)).toBe(false);
        expect(shareTokenAllows('/settings', params)).toBe(false);
        expect(shareTokenAllows('/api/recordings/46/file', new URLSearchParams())).toBe(false);
    });
});
