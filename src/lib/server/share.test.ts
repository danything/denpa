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

    test('別の録画には使い回せない', () => {
        const { token } = mintShareToken(42, 0);
        expect(verifyShareToken(43, token, 0)).toBe(false);
    });

    test('期限だけ書き換えても署名が合わない', () => {
        const at = 1_000_000;
        const { token } = mintShareToken(42, at);
        const forged = `${at + SHARE_TTL * 2}.${token.split('.')[1]}`;
        expect(verifyShareToken(42, forged, at)).toBe(false);
    });

    test('形が壊れていても落ちずに断る', () => {
        expect(verifyShareToken(42, null, 0)).toBe(false);
        expect(verifyShareToken(42, '', 0)).toBe(false);
        expect(verifyShareToken(42, '署名なし', 0)).toBe(false);
        expect(verifyShareToken(42, 'x.y', 0)).toBe(false);
    });

    test('効くのはファイルの口だけ', () => {
        // hooks から呼ぶ入口は実時刻で見るので、作りたてのものを使う
        const params = new URLSearchParams({ token: mintShareToken(42).token });
        expect(shareTokenAllows('/api/recordings/42/file', params)).toBe(true);
        expect(shareTokenAllows('/api/recordings/43/file', params)).toBe(false);
        expect(shareTokenAllows('/api/recordings/42', params)).toBe(false);
        expect(shareTokenAllows('/settings', params)).toBe(false);
        expect(shareTokenAllows('/api/recordings/42/file', new URLSearchParams())).toBe(false);
    });
});
