import { bootClosed } from '../stack';
import { expect, goto, test } from './helpers';

/**
 * **テレビのアプリのペアリング** (docs/auth.md「アプリのペアリング」、device-auth.ts)。
 *
 * テレビが札を貰い、スマホで QR (`device?code=…`) を開くとそのまま済み、テレビは鍵を受け取って
 * `Authorization: Bearer` で API に入る。普段のスタックはローカルを信頼しているので、
 * スマホ役のブラウザはログインなしで `/device` に入れる (家の LAN と同じ)
 */
test.describe('テレビのペアリング', () => {
    test('札を貰い、QR の画面を開くと済み、鍵で API に入れる。取り消すと 401', async ({ page, request }) => {
        const issued = await request.post('/api/device/code', { data: { name: 'E2E のテレビ' } });
        expect(issued.status()).toBe(200);
        const code = await issued.json();
        expect(code).toMatchObject({
            deviceCode: expect.any(String),
            userCode: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
            verificationUri: 'device',
            expiresIn: 600,
            interval: 5,
        });
        expect(code.verificationUriComplete).toBe(`device?code=${code.userCode}`);

        // 開く前は待てと言われる
        const early = await request.post('/api/device/token', { data: { deviceCode: code.deviceCode } });
        expect(early.status()).toBe(400);
        expect(await early.json()).toEqual({ error: 'authorization_pending' });

        // スマホで QR を開く。開いたら自分で送って済む (許す / 断るは聞かない)
        await goto(page, `/${code.verificationUriComplete}`);
        await expect(page.getByTestId('device-done')).toContainText('E2E のテレビ とペアリングしました');

        // 間隔を守って聞き直すと、鍵を1度だけ受け取れる
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        const got = await request.post('/api/device/token', { data: { deviceCode: code.deviceCode } });
        expect(got.status()).toBe(200);
        const { token, tokenType } = await got.json();
        expect(tokenType).toBe('Bearer');
        expect(token).toMatch(/^denpa_/);

        const again = await request.post('/api/device/token', { data: { deviceCode: code.deviceCode } });
        expect(await again.json()).toEqual({ error: 'invalid_grant' });

        const auth = { authorization: `Bearer ${token}` };
        expect((await request.get('/api/recordings', { headers: auth })).status()).toBe(200);

        // アプリの鍵では、別の札を済ませられない (盗まれた鍵で鍵を増やせないように)
        const other = await (await request.post('/api/device/code', { data: { name: '鍵から' } })).json();
        const viaToken = await request.get(`/${other.verificationUriComplete}`, { headers: auth });
        expect(await viaToken.text()).toContain('アプリの鍵ではペアリングできません');
        const posted = await request.post(`/${other.verificationUriComplete}`, {
            headers: { ...auth, origin: new URL(viaToken.url()).origin },
            form: { code: other.userCode },
        });
        expect(posted.status()).toBe(403);
        const stillPending = await request.post('/api/device/token', {
            data: { deviceCode: other.deviceCode },
        });
        expect(await stillPending.json()).toEqual({ error: 'authorization_pending' });

        // 設定画面に並ぶ
        await goto(page, '/settings');
        await expect(page.getByTestId('device-row').filter({ hasText: 'E2E のテレビ' })).toBeVisible();

        // アプリが自分で外す。止めた鍵は信頼するネットワークからでも 401 (ペアリングし直しと分かるように)
        expect((await request.post('/api/device/logout', { headers: auth })).status()).toBe(204);
        const revoked = await request.get('/api/recordings', { headers: auth });
        expect(revoked.status()).toBe(401);
        expect(await revoked.json()).toEqual({ error: 'invalid_token' });
    });

    test('知らない札の画面は、そうと言う', async ({ page }) => {
        await goto(page, '/device?code=ZZZZ-ZZZZ');
        await expect(page.getByTestId('device-card')).toContainText('見つかりません');
    });
});

/*
 * テレビは鍵を持たずにまず API を叩き、401 の JSON ならペアリングに進む
 * (信頼するネットワークの中なら通るので、ペアリングは要らない)。ログイン画面の HTML に回さない
 */
test.describe('信頼するネットワークの外から鍵なしで', () => {
    test('API は 401 の JSON。札の口は資格なしで開いている', async ({ stack }) => {
        const closed = await bootClosed(test.info().workerIndex, stack.root, {
            TRUSTED_NETWORKS: '10.10.0.0/16',
        });
        try {
            const res = await fetch(`${closed.appUrl}/api/services`);
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: 'unauthorized' });

            const issued = await fetch(`${closed.appUrl}/api/device/code`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: '外のテレビ' }),
            });
            expect(issued.status).toBe(200);

            // QR の画面は守られている (ここで OIDC か信頼するネットワークを通る)
            expect((await fetch(`${closed.appUrl}/device?code=ABCD-EFGH`)).status).toBe(403);
        } finally {
            await closed.shutdown();
        }
    });
});
