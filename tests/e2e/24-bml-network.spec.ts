import type { Page } from '@playwright/test';
import {
    captureSockets,
    dataElement,
    expect,
    fakeDataBroadcast,
    feedData,
    goto,
    test,
    wakeControls,
} from './helpers';

/**
 * データ放送の双方向 (通信系コンテンツ) の中継エンドポイント
 * ([stream.md](../../docs/stream.md#57-双方向通信系コンテンツプロキシ))。
 *
 * **既定はオンで、設定で切れます。** 切れば denpa のサーバは外へ出ません。
 * 危ないのは繋ぎ先ではなく**繋ぐ範囲**なので、内側を向いた住所を断ることを
 * ここで固定します — 通ってしまうと、denpa が宅内を覗く道具になります。
 *
 * 設定を切り替えるテストはこのファイルにまとめる (同じ組の 36-bml と並んで流れるので、
 * 双方向のオン/オフで答えが変わるテストを向こうに置かない)。
 */

/** 設定画面の「データ放送の双方向」を切り替えて、保存し終えるまで */
async function setNetwork(page: Page, on: boolean): Promise<void> {
    await goto(page, '/settings');
    await page.getByTestId('bml-network').setChecked(on);
    await page.getByTestId('save-broadcast').click();
    /*
     * **待つのは保存の完了。** チェック状態で待っていた頃は、自分で入れた
     * チェックに即座に当たってしまい、設定がサーバに書かれる前に次の
     * リクエストが飛んでいた (遅い CI ランナーでだけ出る)
     */
    await expect(page.getByTestId('saved-result')).toBeVisible();
}

test.describe('データ放送の双方向', () => {
    test('既定はオン。切ると中継しない', async ({ page, request }) => {
        await goto(page, '/settings');
        await expect(page.getByTestId('bml-network')).toBeChecked();
        await setNetwork(page, false);
        try {
            expect((await request.get('/api/bml/proxy?url=https://example.com/')).status()).toBe(403);
            // 疎通確認も同じ扱い。**切ったら外へ出ない**
            expect((await request.get('/api/bml/confirm?to=example.com')).status()).toBe(403);
            // 送るほうも同じ
            const post = await request.post('/api/bml/post?url=https%3A%2F%2Fexample.com%2F', {
                data: 'Denbun=x',
            });
            expect(post.status()).toBe(403);
        } finally {
            // 後片付け。既定 (オン) に戻す
            await setNetwork(page, true);
        }
    });

    test('通信の文書へ移って描く (中継の返りは合成)', async ({ page }) => {
        const url = 'https://www.example.com/denpa/menu.bml';
        const remote = [
            '<?xml version="1.0" encoding="EUC-JP" ?>',
            '<bml><head><title>remote</title></head>',
            '<body style="background-color:#000080;">',
            '<p style="left:0px;top:0px;width:400px;height:40px;color-index:7;">ok</p>',
            '</body></bml>',
        ].join('\n');
        const asked: string[] = [];
        // 外へは出さない。中継の返りを合成のものに差し替える (中継そのものは下のテストと単体で見る)
        await page.route('**/api/bml/proxy**', (route) => {
            const target = new URL(route.request().url()).searchParams.get('url') ?? '';
            asked.push(target);
            if (target !== url) return route.fulfill({ status: 502, body: 'refused' });
            return route.fulfill({
                status: 200,
                headers: { 'content-type': 'text/X-arib-bml; charset=EUC-JP', 'x-bml-relayed': '1' },
                body: remote,
            });
        });
        await captureSockets(page);
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        const overlay = page.getByTestId('live-data');
        await wakeControls(page, 'live-frame');
        await page.getByTestId('live-data-button').click();
        await expect(overlay).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
        await expect.poll(async () => Number(await overlay.getAttribute('data-handed'))).toBeGreaterThan(0);
        // 出す操作の d が届いたら、通信の文書へ移る
        await feedData(
            page,
            fakeDataBroadcast(
                [
                    `<script><![CDATA[function go() { browser.launchDocument("${url}", "cut"); }]]></script>`,
                    '<bevent><beitem type="DataButtonPressed" onoccur="go();" subscribe="subscribe"/></bevent>',
                ].join('\n'),
            ),
        );
        await expect
            .poll(async () => (await dataElement(page, 'span'))?.text, { timeout: 10_000 })
            .toBe('ok');
        expect(asked).toEqual([url]);
        await expect(overlay).toHaveAttribute('data-showing', 'true');
    });

    test('オンのとき、内側へは繋がない', async ({ request }) => {
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

        // **別の仕組みへ逃がす経路は塞ぐ** (http は通す — 放送がそう作られている)
        const file = await request.get('/api/bml/proxy?url=file%3A%2F%2F%2Fetc%2Fpasswd');
        expect(file.status()).toBe(502);

        /*
         * **送るほうも同じ枠で見る。**
         *
         * 応募・投票の窓口だが、放送のアプリはここへ投げてみて「繋がって
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
    });
});
