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
        expect((await request.get('/api/bml/proxy?url=https://example.com/')).status()).toBe(403);
        // 疎通確認も同じ扱い。**入れるまで外へ出ない**
        expect((await request.get('/api/bml/confirm?to=example.com')).status()).toBe(403);
        // 送るほうも同じ
        const post = await request.post('/api/bml/post?url=https%3A%2F%2Fexample.com%2F', {
            data: 'Denbun=x',
        });
        expect(post.status()).toBe(403);
    });

    test('入れると口が開くが、内側へは繋がない', async ({ page, request }) => {
        await goto(page, '/settings');
        await page.getByTestId('bml-network').check();
        await page.getByTestId('save-broadcast').click();
        /*
         * **待つのは保存の完了。** チェック状態で待っていた頃は、自分で入れた
         * チェックに即座に当たってしまい、設定がサーバに書かれる前に下の
         * リクエストが飛んで 403 (既定の「入れるまで外へ出ない」) を踏んでいた
         * (遅い CI ランナーでだけ出る)
         */
        await expect(page.getByTestId('saved-result')).toBeVisible();

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

        // **別の仕組みへ逃がす道は塞ぐ** (http は通す — 放送がそう作られている)
        const file = await request.get('/api/bml/proxy?url=file%3A%2F%2F%2Fetc%2Fpasswd');
        expect(file.status()).toBe(502);

        /*
         * **送るほうも同じ枠で見る。**
         *
         * 応募・投票の口だが、放送のアプリはここへ投げてみて「繋がって
         * いるか」を決めることがある (NHK がそう)。だからといって内側へ
         * 投げてよいことにはならない
         */
        for (const url of ['https://127.0.0.1/', 'http://192.168.1.1/']) {
            const res = await request.post(`/api/bml/post?url=${encodeURIComponent(url)}`, {
                data: 'Denbun=x',
            });
            expect(res.status(), url).toBe(502);
        }

        /*
         * **疎通確認は、届かなくても失敗ではない。**
         *
         * 放送のアプリはこの答えを見て「繋がっているか」を出し分ける。
         * 断られた (403/502) のと「届かなかった」は別のことなので、
         * 200 で `success: false` を返す
         */
        const confirm = await request.get('/api/bml/confirm?to=192.168.1.1&wait=1000');
        expect(confirm.status()).toBe(200);
        expect(await confirm.json()).toEqual({
            success: false,
            ipAddress: null,
            responseTimeMillis: null,
        });

        // 後片付け。**入れっぱなしにしない** (他のテストと本番の既定を揃える)
        await goto(page, '/settings');
        await page.getByTestId('bml-network').uncheck();
        await page.getByTestId('save-broadcast').click();
        await expect(page.getByTestId('bml-network')).not.toBeChecked();
    });
});
