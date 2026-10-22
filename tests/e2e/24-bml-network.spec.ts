import type { Page } from '@playwright/test';
import { MX } from '../fake/services';
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
 * ([stream.md](../../docs/stream.md#双方向通信系コンテンツプロキシ))。
 *
 * **既定はオンで、設定で切れます。** 切れば denpa のサーバは外へ出ません。
 * 危ないのは繋ぎ先ではなく**繋ぐ範囲**なので、内側を向いたアドレスを断ることを
 * ここで固定します — 通ってしまうと、denpa が宅内を覗く道具になります。
 *
 * 設定を切り替えるテストはこのファイルにまとめる (同じ組の 36-bml と並んで流れるので、
 * 双方向のオン/オフで答えが変わるテストを向こうに置かない)。
 */

/** 設定画面の「データ放送の双方向」を切り替えて、保存し終えるまで (変えたらその場で保存する) */
async function setNetwork(page: Page, on: boolean): Promise<void> {
    await goto(page, '/settings/reception');
    await page.getByTestId('bml-network').setChecked(on);
    /*
     * **待つのは保存の完了。** チェック状態で待っていた頃は、自分で入れた
     * チェックに即座に当たってしまい、設定がサーバに書かれる前に次の
     * リクエストが飛んでいた (遅い CI ランナーでだけ出る)
     */
    await expect(page.getByTestId('saved-result')).toBeVisible();
}

test.describe('データ放送の双方向', () => {
    test('既定はオン。切ると中継しない', async ({ page, request }) => {
        await goto(page, '/settings/reception');
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

    /*
     * **http の Hybridcast のアプリの中継** (`server/hc-relay.ts`)。合言葉は http のアプリにだけ出し、
     * 中継は合言葉の配信元へだけ、`/api/bml/proxy` と同じ枠で繋ぐ (内側は断る)
     */
    test('http のアプリの中継は、合言葉の配信元へだけ、内側は断って繋ぐ', async ({ request }) => {
        const issue = async (url: string) => request.post('/api/bml/hc', { data: { url } });
        expect(await (await issue('https://hc.example.jp/p/')).json()).toEqual({ root: null });
        expect((await issue('file:///etc/passwd')).status()).toBe(400);

        const { root } = (await (await issue('http://127.0.0.1/p/index.html')).json()) as { root: string };
        expect(root).toMatch(/^api\/bml\/hc\/[0-9a-f]{32}\/$/);
        // 配信元が内側なので、中継しても断る (502)
        expect((await request.get(`/${root}p/index.js`)).status()).toBe(502);
        // 知らない合言葉は 404
        expect((await request.get('/api/bml/hc/0123456789abcdef0123456789abcdef/p/index.js')).status()).toBe(
            404,
        );
    });

    /*
     * **Hybridcast はデータ放送が起動を求めたときに開く** ([stream.md](../../docs/stream.md#hybridcast))。
     *
     * アプリは合成のもの (本物の放送局のアプリは入れない)。中継の返りを差し替えて、
     * 起動・アプリの通信が中継を通ること・denpa に触れないこと・受信機 API・戻るで閉じる、を見る
     */
    test('データ放送から Hybridcast を開き、戻るで閉じる', async ({ page, baseURL }) => {
        const appUrl = 'https://hybridcast.example.jp/app.html';
        const dataUrl = 'https://hybridcast.example.jp/api/data.json';
        // denpa 自身の API。アプリが中継で取ろうとしても、内側なので中継が断る
        const denpaUrl = new URL('/api/settings', baseURL).href;
        const app = `<!DOCTYPE html><html><head><title>hc</title></head><body>
<object id="v" type="video/broadcast" style="position:absolute;left:960px;top:0px;width:960px;height:540px"></object>
<p id="out" style="position:absolute;left:0;top:600px">-</p>
<button id="go" style="position:absolute;left:0;top:700px" onclick="location.href = 'https://' + location.hostname.split('.')[0] + '.example.jp/next.html'">次へ</button>
<script>
(async function () {
    var out = {};
    var channel = document.getElementById('v').bindToCurrentChannel();
    out.sid = channel && channel.sid;
    out.device = navigator.receiverDevice.getCurrentChannel().sid;
    out.receiverId = navigator.receiverDevice.getReceiverId();
    out.origin = self.origin;
    try { out.parent = parent.document.title; } catch (e) { out.parent = 'blocked'; }
    out.cookie = document.cookie;
    localStorage.setItem('n', '1');
    try { out.fetch = (await (await fetch('api/data.json')).json()).v; } catch (e) { out.fetch = 'failed'; }
    try { await fetch(${JSON.stringify(denpaUrl)}); out.denpa = 'reached'; } catch (e) { out.denpa = 'refused'; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'api/data.json');
    xhr.responseType = 'json';
    await new Promise(function (done) { xhr.onload = done; xhr.onerror = done; xhr.send(); });
    out.xhr = xhr.response && xhr.response.v;
    // 受信機を名乗り、データ放送の Greg と NVRAM を使える (NHK のアプリが当てにする)
    out.ua = navigator.userAgent.indexOf('Hybridcast/') >= 0;
    var pseudo = navigator.bmlCompat.browserPseudo;
    pseudo.Greg[55] = 'nhk:test';
    out.greg = pseudo.Greg[55];
    out.write = !isNaN(pseudo.writePersistentArray('nvram://00;group/14', 'U:1B,S:1V', [15, 'あ']));
    out.read = pseudo.readPersistentArray('nvram://00;group/14', 'U:1B,S:1V');
    out.onair = navigator.receiverDevice.streamEvent.sourceIs('onair');
    out.event = await new Promise(function (done) { navigator.receiverDevice.getCurrentEventInformation(function (e) { done(e && e.event_id); }); });
    document.getElementById('out').textContent = JSON.stringify(out);
})();
</script></body></html>`;
        // アプリの中のページ移動の行き先 (NHK のアプリと同じく、自分の名前の頭から組み立てる)
        const nextUrl = 'https://hybridcast.example.jp/next.html';
        const asked: string[] = [];
        await page.route('**/api/bml/proxy**', (route) => {
            const target = new URL(route.request().url()).searchParams.get('url') ?? '';
            asked.push(target);
            if (target === nextUrl)
                return route.fulfill({
                    status: 200,
                    headers: { 'x-bml-relayed': '1', 'content-type': 'text/html' },
                    // 前のページが書いた Greg は、データ放送を通って次のページにも見える
                    body: '<!DOCTYPE html><html><head></head><body><p id="next">-</p><script>document.getElementById("next").textContent = navigator.bmlCompat.browserPseudo.Greg[55];</script></body></html>',
                });
            if (target === appUrl)
                return route.fulfill({
                    status: 200,
                    headers: { 'x-bml-relayed': '1', 'content-type': 'text/html' },
                    body: app,
                });
            if (target === dataUrl)
                return route.fulfill({
                    status: 200,
                    headers: { 'x-bml-relayed': '1', 'content-type': 'application/json' },
                    body: '{"v":"relayed"}',
                });
            // ほか (denpa 自身) は本物の中継へ。内側なので断る
            return route.continue();
        });
        await captureSockets(page);
        await goto(page, '/live');
        await page.locator(`[data-testid=live-channel][data-service="${MX.id}"]`).click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        // AIT が届いてから (開けるアプリがあってから)
        await expect(page.getByTestId('live-hybridcast')).toBeVisible({ timeout: 15_000 });
        const overlay = page.getByTestId('live-data');
        await wakeControls(page, 'live-frame');
        await page.getByTestId('live-data-button').click();
        await expect(overlay).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
        await expect.poll(async () => Number(await overlay.getAttribute('data-handed'))).toBeGreaterThan(0);
        await feedData(page, [
            {
                type: 'programInfo',
                originalNetworkId: MX.networkId,
                transportStreamId: null,
                serviceId: MX.serviceId,
                eventId: 0x1234,
                eventName: 'テスト番組',
                startTimeUnixMillis: Date.now(),
                durationSeconds: 1800,
                indefiniteDuration: false,
                networkId: MX.networkId,
            },
            ...fakeDataBroadcast(START_APP),
        ]);
        await expect
            .poll(async () => (await dataElement(page, 'span'))?.text, { timeout: 10_000 })
            .toBe('s1r1');

        const frame = page.getByTestId('live-hybridcast-app');
        await expect(frame).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
        const out = page.frameLocator('[data-testid=live-hybridcast-app] iframe').locator('#out');
        await expect(out).not.toHaveText('-', { timeout: 10_000 });
        expect(JSON.parse((await out.textContent()) ?? '{}')).toEqual({
            sid: MX.serviceId,
            device: MX.serviceId,
            receiverId: null,
            // 使い捨てのオリジン。denpa の画面にも cookie にも触れない
            origin: 'null',
            parent: 'blocked',
            cookie: '',
            fetch: 'relayed',
            denpa: 'refused',
            xhr: 'relayed',
            ua: true,
            greg: 'nhk:test',
            write: true,
            read: [15, 'あ'],
            onair: true,
            event: 0x1234,
        });
        // アプリの通信は中継を通った
        expect(asked).toEqual(expect.arrayContaining([appUrl, dataUrl, denpaUrl]));
        // 映像はアプリの object の場所 (右上の 4 分の 1)
        await expect
            .poll(() =>
                page.evaluate(
                    () => document.querySelector<HTMLElement>('[data-bml-window]')?.style.left ?? null,
                ),
            )
            .toBe('50%');
        // 受信機の記憶はアプリごとの置き場に
        expect(await page.evaluate(() => localStorage.getItem('denpa_hybridcast_7e87_1'))).toBe('{"n":"1"}');
        // NVRAM はデータ放送と同じ置き場に
        expect(await page.evaluate(() => localStorage.getItem('denpa_bml_own_group:00:14'))).not.toBeNull();

        // アプリが別のページへ移る。iframe ごと移らせず、自分の元の名前で組み立てた住所を同じ手順で開き直す
        await page.frameLocator('[data-testid=live-hybridcast-app] iframe').locator('#go').click();
        await expect(frame).toHaveAttribute('data-url', nextUrl, { timeout: 10_000 });
        await expect(
            page.frameLocator('[data-testid=live-hybridcast-app] iframe').locator('#next'),
        ).toHaveText('nhk:test', {
            timeout: 10_000,
        });

        // 戻るで閉じて、データ放送へ戻る
        await page.frameLocator('[data-testid=live-hybridcast-app] iframe').locator('#next').click();
        await page.keyboard.press('Backspace');
        await expect(frame).toHaveCount(0);
        await expect(overlay).toHaveAttribute('data-showing', 'true');
    });

    test('双方向を切ってあれば、Hybridcast は起動しない', async ({ page }) => {
        await setNetwork(page, false);
        try {
            await captureSockets(page);
            await goto(page, '/live');
            await page.locator(`[data-testid=live-channel][data-service="${MX.id}"]`).click();
            await expect(page.getByTestId('live-title')).toBeVisible();
            // 行き先のボタンは出る (別のタブで開くだけ)
            await expect(page.getByTestId('live-hybridcast')).toBeVisible({ timeout: 15_000 });
            const overlay = page.getByTestId('live-data');
            await wakeControls(page, 'live-frame');
            await page.getByTestId('live-data-button').click();
            await expect(overlay).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
            await expect
                .poll(async () => Number(await overlay.getAttribute('data-handed')))
                .toBeGreaterThan(0);
            await feedData(page, fakeDataBroadcast(START_APP));
            // 問い合わせには「無い」、起動は失敗
            await expect
                .poll(async () => (await dataElement(page, 'span'))?.text, { timeout: 10_000 })
                .toBe('s0rNaN');
            await expect(page.getByTestId('live-hybridcast-app')).toHaveCount(0);
        } finally {
            await setNetwork(page, true);
        }
    });
});

/** d で Hybridcast に対応しているかを訊き、起動を求める BML (結果を画面に書く) */
const START_APP = [
    '<p id="hc" style="left:0px;top:0px;width:400px;height:40px;color-index:7;">-</p>',
    '<script><![CDATA[',
    'function go() {',
    '    var s = browser.getBrowserSupport("ARIB", "AITControlledAppEngineFunction", "IPTV-F", "HTML5_ph0");',
    '    var r = browser.startAITControlledApp(32391, 1);',
    '    document.getElementById("hc").firstChild.data = "s" + s + "r" + r;',
    '}',
    ']]></script>',
    '<bevent><beitem type="DataButtonPressed" onoccur="go();" subscribe="subscribe"/></bevent>',
].join('\n');
