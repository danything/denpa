import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-device-')), 'denpa.db');

const {
    approve,
    bearerToken,
    CODE_TTL_MS,
    issueCode,
    liveTokens,
    MAX_PENDING,
    newUserCode,
    normalizeUserCode,
    poll,
    POLL_INTERVAL_MS,
    pruneCodes,
    revokeToken,
    sha256,
    TOKEN_PREFIX,
    TokenCannotApprove,
    verifyToken,
    viewCode,
} = await import('./device-auth');
const { orm } = await import('./db');
const { apiTokens, deviceCodes } = await import('./schema');

/** 札を出して、テストの間だけ時計を進めて扱う */
function pair(name = '居間のテレビ', at = 1_000_000) {
    const issued = issueCode(name, at);
    if (issued === null) throw new Error('札が出ない');
    return issued;
}

describe('札', () => {
    test('人が見比べる札は見間違えない字だけで ABCD-EFGH の形', () => {
        for (let i = 0; i < 200; i++) {
            const code = newUserCode();
            expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
            expect(code).not.toMatch(/[01IO]/);
        }
    });

    test('打ち込まれた札は揃えて読む。形が違えば null', () => {
        expect(normalizeUserCode('abcd efgh')).toBe('ABCD-EFGH');
        expect(normalizeUserCode('ABCD-EFG')).toBeNull();
        // 0 と O は札に使わない字
        expect(normalizeUserCode('ABCD-EF0H')).toBeNull();
    });

    test('秘密そのものは DB に置かない (SHA-256 だけ)', () => {
        const { deviceCode, userCode } = pair('ハッシュ', 2_000_000);
        const row = orm()
            .select()
            .from(deviceCodes)
            .all()
            .find((r) => r.user_code === userCode);
        expect(row?.device_code_hash).toBe(sha256(deviceCode));
        expect(JSON.stringify(row)).not.toContain(deviceCode);
    });
});

describe('ペアリングの流れ', () => {
    test('許されるまでは待てと言い、許されたら鍵を1度だけ渡す', () => {
        const at = 3_000_000;
        const { deviceCode, userCode } = pair('居間', at);
        expect(poll(deviceCode, at)).toEqual({ error: 'authorization_pending' });

        expect(approve(userCode, 'trusted-network', false, at + 1)?.state).toBe('approved');
        const got = poll(deviceCode, at + POLL_INTERVAL_MS);
        expect('token' in got).toBe(true);
        const token = (got as { token: string }).token;
        expect(token.startsWith(TOKEN_PREFIX)).toBe(true);

        // 2度目は渡さない (使い終えた札)
        expect(poll(deviceCode, at + 2 * POLL_INTERVAL_MS)).toEqual({ error: 'invalid_grant' });
        expect(viewCode(userCode, at + 3 * POLL_INTERVAL_MS)?.state).toBe('consumed');

        // 鍵も DB には SHA-256 だけ
        const row = orm().select().from(apiTokens).all().at(-1);
        expect(row?.token_hash).toBe(sha256(token));
        expect(row?.name).toBe('居間');
        expect(row?.created_by).toBe('trusted-network');
    });

    test('許すのは何度呼んでも同じ (読み直しで鍵が2本にならない)', () => {
        const at = 4_000_000;
        const { deviceCode, userCode } = pair('二度押し', at);
        approve(userCode, 'trusted-network', false, at);
        approve(userCode, 'trusted-network', false, at + 1);
        expect('token' in poll(deviceCode, at + POLL_INTERVAL_MS)).toBe(true);
        expect(approve(userCode, 'trusted-network', false, at + 2 * POLL_INTERVAL_MS)?.state).toBe(
            'consumed',
        );
        expect(
            orm()
                .select()
                .from(apiTokens)
                .all()
                .filter((r) => r.name === '二度押し'),
        ).toHaveLength(1);
    });

    /*
     * 盗まれた鍵で別の鍵を作れると、元の鍵を取り消しても作った鍵が生き残る。
     * 許すのはブラウザ (信頼するネットワークか OIDC) だけ
     */
    test('アプリの鍵で入った相手は許せない', () => {
        const at = 4_500_000;
        const { deviceCode, userCode } = pair('鍵から', at);
        expect(() => approve(userCode, 'token:1', true, at)).toThrow(TokenCannotApprove);
        expect(viewCode(userCode, at)?.state).toBe('pending');
        expect(poll(deviceCode, at)).toEqual({ error: 'authorization_pending' });
    });

    test('急いで聞きに来たら slow_down', () => {
        const at = 5_000_000;
        const { deviceCode } = pair('せっかち', at);
        expect(poll(deviceCode, at)).toEqual({ error: 'authorization_pending' });
        expect(poll(deviceCode, at + 1000)).toEqual({ error: 'slow_down' });
        // タイマーのずれ (4.9秒) は許す
        expect(poll(deviceCode, at + 1000 + POLL_INTERVAL_MS - 100)).toEqual({
            error: 'authorization_pending',
        });
    });

    test('10分で切れる。切れた札は許せず、端末には expired_token', () => {
        const at = 6_000_000;
        const { deviceCode, userCode } = pair('遅刻', at);
        const later = at + CODE_TTL_MS;
        expect(approve(userCode, 'trusted-network', false, later)?.state).toBe('expired');
        expect(poll(deviceCode, later)).toEqual({ error: 'expired_token' });
        expect(pruneCodes(later)).toBeGreaterThan(0);
        expect(viewCode(userCode, later)).toBeNull();
    });

    test('知らない秘密には invalid_grant', () => {
        expect(poll('nope', 7_000_000)).toEqual({ error: 'invalid_grant' });
    });

    test('生きている札が上限に達したら、もう出さない (誰でも叩けるので)', () => {
        const at = 8_000_000_000;
        for (let i = 0; i < MAX_PENDING; i++) expect(issueCode(`満員${i}`, at)).not.toBeNull();
        expect(issueCode('あふれ', at)).toBeNull();
        // 切れれば、また出せる
        expect(issueCode('あふれ', at + CODE_TTL_MS)).not.toBeNull();
    });
});

describe('鍵', () => {
    function mint(name: string, at: number): string {
        const { deviceCode, userCode } = pair(name, at);
        approve(userCode, 'trusted-network', false, at);
        const got = poll(deviceCode, at);
        if (!('token' in got)) throw new Error('鍵が出ない');
        return got.token;
    }

    test('Authorization から denpa の鍵だけを取り出す (ほかの Bearer は見ない)', () => {
        expect(bearerToken(`Bearer ${TOKEN_PREFIX}abc`)).toBe(`${TOKEN_PREFIX}abc`);
        expect(bearerToken(`bearer   ${TOKEN_PREFIX}abc`)).toBe(`${TOKEN_PREFIX}abc`);
        expect(bearerToken('Bearer eyJhbGciOi.someone-elses')).toBeNull();
        expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
        expect(bearerToken(null)).toBeNull();
    });

    test('生きている鍵は持ち主を返し、止めた鍵は通さない', () => {
        const at = 9_000_000_000;
        const token = mint('寝室', at);
        const owner = verifyToken(token, at);
        expect(owner?.name).toBe('寝室');
        expect(liveTokens().some((t) => t.id === owner?.id)).toBe(true);

        expect(revokeToken(owner!.id, at)).toBe(true);
        expect(verifyToken(token, at)).toBeNull();
        expect(liveTokens().some((t) => t.id === owner?.id)).toBe(false);
        expect(verifyToken(`${TOKEN_PREFIX}forged`, at)).toBeNull();
    });

    test('最後に使った時刻は1分に1度だけ書く', () => {
        const at = 10_000_000_000;
        const token = mint('書斎', at);
        const id = verifyToken(token, at)!.id;
        const used = () =>
            orm()
                .select()
                .from(apiTokens)
                .all()
                .find((r) => r.id === id)?.last_used_at;
        expect(used()).toBe(at);
        verifyToken(token, at + 30_000);
        expect(used()).toBe(at);
        verifyToken(token, at + 60_000);
        expect(used()).toBe(at + 60_000);
    });
});
