import { expect, goto, test } from './helpers';

/**
 * データ放送の双方向 (通信系コンテンツ) の中継口
 * ([stream.md](../../docs/stream.md#57-双方向通信系コンテンツプロキシ))。
 *
 * **既定では動きません。** 入れるまで denpa のサーバは外へ出ません。
 * 危ないのは繋ぎ先ではなく**繋ぐ範囲**なので、内側を向いた住所を断ることを
 * ここで固定します — 通ってしまうと、denpa が宅内を覗く道具になります。
 */
test.describe('データ放送の双方向', () => {
    test('既定では中継しない', async ({ request }) => {
        const res = await request.get('/api/bml/proxy?url=https://example.com/');
        expect(res.status()).toBe(403);
    });

    test('入れると口が開くが、内側へは繋がない', async ({ page, request }) => {
        await goto(page, '/settings');
        await page.getByTestId('bml-network').check();
        await page.getByTestId('save-broadcast').click();
        await expect(page.getByTestId('bml-network')).toBeChecked();

        // **内側は断る。** 通ると宅内を覗く道具になる
        for (const url of [
            'https://127.0.0.1/',
            'https://localhost/',
            'https://169.254.169.254/latest/meta-data/', // 雲のメタデータ
            'https://192.168.1.1/',
        ]) {
            const res = await request.get(`/api/bml/proxy?url=${encodeURIComponent(url)}`);
            expect(res.status(), url).toBe(502);
        }

        // **https だけ。** 中身を覗かれる道は開けない
        const plain = await request.get('/api/bml/proxy?url=http%3A%2F%2Fexample.com%2F');
        expect(plain.status()).toBe(502);

        // 後片付け。**入れっぱなしにしない** (他のテストと本番の既定を揃える)
        await goto(page, '/settings');
        await page.getByTestId('bml-network').uncheck();
        await page.getByTestId('save-broadcast').click();
        await expect(page.getByTestId('bml-network')).not.toBeChecked();
    });
});
