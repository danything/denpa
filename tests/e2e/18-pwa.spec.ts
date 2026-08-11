import { expect, goto, test } from './helpers';

/**
 * ホーム画面に置いて、アプリのように開けること。
 *
 * 中身はキャッシュしない。録画一覧も番組表もサーバの今の状態が要るので、
 * 古いものを見せるくらいなら繋がらないと分かるほうがまし。
 */
test.describe('PWA', () => {
    test('マニフェストとアイコンが揃っている', async ({ page, request }) => {
        await goto(page, '/');
        await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');

        const res = await request.get('/manifest.webmanifest');
        expect(res.ok()).toBeTruthy();
        expect(res.headers()['content-type']).toContain('application/manifest+json');
        const manifest = await res.json();
        expect(manifest.name).toBe('denpa');
        // ホーム画面から開いたときにブラウザのUIを出さない
        expect(manifest.display).toBe('standalone');
        // 丸く切り抜かれる端末があるので、そのための版も要る
        expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBeTruthy();

        for (const icon of manifest.icons) {
            const image = await request.get(icon.src);
            expect(image.status(), icon.src).toBe(200);
        }
        // iOS はマニフェストのアイコンを使わない
        expect((await request.get('/apple-touch-icon.png')).status()).toBe(200);
    });

    /*
     * **画面の HTML を溜め込ませない。**
     *
     * SvelteKit が付けるのは中身の指紋 (`etag`) だけで、どれくらい持って
     * いてよいかは何も言わない。言われなかった端末は自分で決めるので、
     * ホーム画面から入れたアプリを開き直したときに**前に閉じたときの一覧**
     * が出ることがある。`no-cache` は「持ってよいが出す前に必ず聞く」で、
     * 指紋はそのままなので変わっていなければ 304 (中身は流れない)
     */
    test('画面の HTML は毎回聞き直させる', async ({ request }) => {
        for (const path of ['/', '/guide', '/settings']) {
            const res = await request.get(path);
            expect(res.status(), path).toBe(200);
            expect(res.headers()['cache-control'], path).toBe('no-cache');
            expect(res.headers().etag, path).toBeTruthy();
        }

        // 指紋が付いているものは、変わっていなければ中身を流さない
        const first = await request.get('/');
        const again = await request.get('/', {
            headers: { 'if-none-match': first.headers().etag },
        });
        expect(again.status()).toBe(304);

        /*
         * **名前に指紋が入っているものには口を出さない。** 永く持たせたい側で、
         * ここへ `no-cache` を撒くと毎回聞きに行くことになる
         */
        const chunk = await request.get('/');
        const asset = /\/_app\/immutable\/[^"']+\.js/.exec(await chunk.text())?.[0];
        expect(asset).toBeTruthy();
        const immutable = await request.get(asset as string);
        expect(immutable.headers()['cache-control']).toContain('immutable');
    });

    /*
     * **中だけ動かす画面は、ページごと動かない。**
     *
     * 土台は `100dvh` (いま見えている高さ) で採る。ここに `vh`
     * (アドレスバーが引っ込んだときの高さ) が混ざると、**中身のほうが土台より
     * 高くなり**、バーが出ている間ずっとページごと少し動く。実機の PWA で
     * 「リロードすると画面全体がスクロールできる」として出た。
     *
     * ブラウザの自動運転では引っ込むバーを作れないので、ここで見るのは
     * 「はみ出していないこと」。単位の食い違いはこの形で表に出る
     */
    test('二段組の画面はページごとスクロールしない', async ({ page }) => {
        for (const width of [768, 915, 1280]) {
            await page.setViewportSize({ width, height: 700 });
            for (const path of ['/', '/guide', '/rules']) {
                await goto(page, path);
                const doc = await page.evaluate(() => ({
                    scrollH: document.documentElement.scrollHeight,
                    clientH: document.documentElement.clientHeight,
                }));
                expect(doc.scrollH, `${path} が ${width}px で縦に流れる`).toBeLessThanOrEqual(
                    doc.clientH + 1,
                );
            }
        }
    });

    /*
     * **端末でしか出ない縦のはみ出しを、その端末で読むための札。**
     *
     * 自動運転のブラウザには引っ込むアドレスバーが作れないので、
     * 「手元では出ないが実機では出る」を追う手が要る。ここで見るのは
     * 「付けたときだけ出る」ことと「数がそろっている」ことまで
     */
    test('?measure を付けたときだけ高さの札が出る', async ({ page }) => {
        await goto(page, '/guide');
        await expect(page.getByTestId('measure')).toHaveCount(0);

        await goto(page, '/guide?measure');
        const badge = page.getByTestId('measure');
        await expect(badge).toBeVisible();
        await expect(badge).toContainText('はみ出し');
        await expect(badge).toContainText('dvh');

        // 読むための札が、下のものを触れなくしては本末転倒
        expect(await badge.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

        // **URL には居座らせない。** 1回だけ見たいときの手なので、外せば消える
        await goto(page, '/guide');
        await expect(page.getByTestId('measure')).toHaveCount(0);
    });

    /*
     * **PWA にはアドレスバーが無い。**
     *
     * `?measure` を打つところがないので、設定画面から入れられないと
     * ホーム画面から開いたアプリでは一生出せない (実機で詰まった)。
     * 覚えるので、**リロードしても消えない** — 見たいのはまさにその後
     */
    test('高さの札は設定から入れられて、リロードしても消えない', async ({ page }) => {
        await goto(page, '/settings');
        await page.getByTestId('measure-toggle').check();
        await expect(page.getByTestId('measure')).toBeVisible();

        // アドレスバーを使わずに別の画面へ行っても付いてくる
        await goto(page, '/guide');
        await expect(page.getByTestId('measure')).toBeVisible();
        await page.reload();
        await expect(page.getByTestId('measure')).toBeVisible();

        // 後片付け。**入れっぱなしにしない**
        await goto(page, '/settings');
        await page.getByTestId('measure-toggle').uncheck();
        await expect(page.getByTestId('measure')).toHaveCount(0);
    });

    test('サービスワーカーが登録され、APIは横取りしない', async ({ page }) => {
        await goto(page, '/');
        const registered = await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            return registration !== undefined;
        });
        expect(registered).toBeTruthy();

        // 録画の配信は数十GB、通知は繋ぎっぱなしのSSE。載せると壊れる
        const cached = await page.evaluate(async () => {
            const keys = await caches.keys();
            const entries = await Promise.all(
                keys.map(async (key) => (await (await caches.open(key)).keys()).map((r) => r.url)),
            );
            return entries.flat();
        });
        expect(cached.some((url) => url.includes('/api/'))).toBeFalsy();
    });

    test('狭い画面ではナビを畳んで、ページが横にはみ出さない', async ({ page }) => {
        /*
         * 項目を横に並べると、スマートフォンの幅ではヘッダーのほうが画面より
         * 広くなり、ページ全体が横にスクロールしていた。番組表を横に流すのと
         * 混ざって扱いにくいので、狭い画面ではハンバーガーに畳む
         */
        for (const width of [390, 430, 768, 1280]) {
            await page.setViewportSize({ width, height: 780 });
            await goto(page, '/guide?type=GR');
            const doc = await page.evaluate(() => ({
                scrollW: document.documentElement.scrollWidth,
                clientW: document.documentElement.clientWidth,
            }));
            expect(doc.scrollW).toBeLessThanOrEqual(doc.clientW);
        }

        /*
         * **番組表以外の画面も同じ。**
         *
         * ルール・チューナー・設定は表を並べていて、それが画面より広い。
         * 表が枠の中で横に流れるのは構わないが、**ページごと流れると**
         * ヘッダーも本文も一緒に動いて読めなくなる。
         *
         * 起きていたのはグリッドの列が縮まないため。列の既定は
         * `min-width: auto` なので、中の表が広いと列ごと広がり、
         * 中の `overflow-x-auto` は出番が来ない
         */
        for (const width of [390, 430, 768]) {
            await page.setViewportSize({ width, height: 780 });
            for (const path of ['/', '/rules', '/tuners', '/settings']) {
                await goto(page, path);
                const doc = await page.evaluate(() => ({
                    scrollW: document.documentElement.scrollWidth,
                    clientW: document.documentElement.clientWidth,
                }));
                expect(doc.scrollW, `${path} が ${width}px で横に流れる`).toBeLessThanOrEqual(doc.clientW);
            }
        }

        // 畳んだメニューからも行けること
        await page.setViewportSize({ width: 390, height: 780 });
        await goto(page, '/');
        const menu = page.getByTestId('nav-menu');

        /*
         * テーマの切り替えはハンバーガーの**横**に置く。`<details>` は行を
         * 占める箱なので、並べる指定が抜けていると切り替えが上の行へ押し出され、
         * ヘッダーが2段ぶんの厚さになっていた
         */
        const theme = (await page.getByTestId('theme-toggle').boundingBox())!;
        const burger = (await menu.locator('summary').boundingBox())!;
        expect(Math.abs(theme.y - burger.y)).toBeLessThan(theme.height);
        expect(theme.x).toBeLessThan(burger.x);

        await menu.locator('summary').click();
        await menu.getByRole('link', { name: '番組表' }).click();
        await page.waitForURL(/guide/);
    });
});
