import { expect, goto, recordOne, test } from './helpers';

/**
 * テレビの VLC へ飛ばす口 (録画詳細) と、その居場所の設定。
 *
 * **実際には飛ばしません。** 飛ばすのは端末のブラウザのトップレベル遷移で、
 * 相手 (テレビの VLC) がいないと開いたタブが繋がらないだけ — ここで確かめるのは
 * **口の出方と覚え方**のほう: 設定の行編集 (名前+IP+ポート+コーデック) が
 * 読み書きできるか、並べたテレビが詳細のボタンになるか、途中まで観たものは
 * 続きの位置から指す XSPF を渡すか。ホスト表記の整え方や
 * 書式の往復は `vlc-host.test.ts` / `vlc.test.ts` が持っている。
 */
test.describe('テレビの VLC で再生', () => {
    test('設定に並べたテレビが詳細のボタンになる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        // まだテレビが無い: 「テレビで再生」はボタンごと出ない
        await goto(page, '/');
        const row = page.locator(`[data-testid="recording-row"][data-recording-id="${id}"]`);
        await row.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        await expect(detail.getByTestId('detail-close')).toBeVisible();
        await expect(detail.getByTestId('vlc-play-button')).toHaveCount(0);
        // 期限付きの再生リンクをコピーする口は「その他…」の中
        await detail.getByTestId('detail-more').click();
        await expect(detail.getByTestId('share-link-button')).toBeVisible();

        // テレビを1台足す。ポートを空にすると VLC の既定 (8080) が入る
        await goto(page, '/settings');
        await page.getByTestId('vlc-add').click();
        await page.getByTestId('vlc-name').fill('リビング');
        await page.getByTestId('vlc-ip').fill('192.168.1.99');
        await page.getByTestId('vlc-port').clear();
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('vlc-port')).toHaveValue('8080');

        // 2台目はポートとコーデックも指名する
        await page.getByTestId('vlc-add').click();
        await page.getByTestId('vlc-name').nth(1).fill('寝室');
        await page.getByTestId('vlc-ip').nth(1).fill('192.168.1.98');
        await page.getByTestId('vlc-port').nth(1).fill('9090');
        await page.getByTestId('vlc-codec').nth(1).selectOption('ts');
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('vlc-port').nth(1)).toHaveValue('9090');

        // 読み直しても行が同じに出る (書式の往復とコーデックの覚え)
        await goto(page, '/settings');
        await expect(page.getByTestId('vlc-ip').nth(1)).toHaveValue('192.168.1.98');
        await expect(page.getByTestId('vlc-codec').nth(1)).toHaveValue('ts');

        /*
         * **何も変えずに保存しても、入力欄が空に見えない。**
         * enhance の既定 reset がバインド済みの欄をデフォルト (空) に戻し、
         * サーバの一覧が変わらないと写し直しも走らないので、空のまま残っていた
         */
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();
        await expect(page.getByTestId('vlc-ip').nth(0)).toHaveValue('192.168.1.99');
        await expect(page.getByTestId('vlc-name').nth(0)).toHaveValue('リビング');

        // 2台になると、ボタンは名前で並ぶ
        await goto(page, '/');
        await row.getByTestId('detail-button').click();
        await expect(detail.getByTestId('vlc-play-button').nth(0)).toHaveText('▶ リビング');
        await expect(detail.getByTestId('vlc-play-button').nth(1)).toHaveText('▶ 寝室');

        /*
         * **スマホ幅でもボタンが箱から出ない。** フッターが一列固定だった頃は
         * 4 つ並ぶと縮められて、文字が縦に折れ・左端が枠の外に切れていた
         * (実機の Android)。折り返して並ぶので、どれも箱の中に収まり、
         * 高さは一行ぶんのまま
         */
        await page.setViewportSize({ width: 360, height: 740 });
        const box = (await detail.locator('.detail-box').boundingBox())!;
        for (const b of await detail
            .locator('.detail-actions')
            .locator('button, a')
            .filter({ visible: true })
            .all()) {
            const r = (await b.boundingBox())!;
            expect(r.x).toBeGreaterThanOrEqual(box.x);
            expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
            expect(r.height).toBeLessThan(60);
        }
        await page.setViewportSize({ width: 1280, height: 720 });

        /*
         * 押すと初回はペア設定のタブが開く — 相手は居ないので**開かせない**。
         * 行き先 (`http://192.168.1.99:8080/`) は誰も居ない住所で、本当に開くと
         * ブラウザが接続を諦めるまで (実測 133 秒) `popup` の解決も `close()` も
         * 帰ってこなかった。`window.open` を差し替えて、開こうとした先だけ見る
         */
        await page.evaluate(() => {
            (window as unknown as { __opened: string[] }).__opened = [];
            window.open = ((url: string | URL) => {
                (window as unknown as { __opened: string[] }).__opened.push(String(url));
                return null;
            }) as typeof window.open;
        });
        await detail.getByTestId('vlc-play-button').nth(0).click();
        await expect
            .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
            .toEqual(['http://192.168.1.99:8080/']);

        /*
         * **途中まで観たものは続きから。** ペア済みなら `/play?path=` に渡すのは
         * ファイルではなく、それを続きの位置から指す XSPF。VLC の `/play` に
         * 位置を渡す口が無いので (`server/playlist.ts`)。中身はテレビが取りに来る
         * 瞬間に作る — ここでは同じ資格 (`?token=`) で取って、位置と資格の写しを見る
         */
        const resumed = await request.post(`/api/recordings/${id}/resume`, {
            data: { at: 95, length: 0 },
        });
        expect(resumed.ok()).toBe(true);
        await goto(page, '/');
        await row.getByTestId('detail-button').click();
        await page.evaluate(() => {
            const opened: string[] = [];
            (window as unknown as { __opened: string[] }).__opened = opened;
            /*
             * 先に開く白い窓の代わり。`null` を返すとポップアップを塞がれた扱いで
             * **このタブごと**テレビへ遷移してしまう (戻れない)。行き先は窓の
             * `location.href` に入るので、そこだけ受け取る
             */
            window.open = (() =>
                ({
                    close() {},
                    location: {
                        set href(value: string) {
                            opened.push(value);
                        },
                    },
                }) as unknown as Window) as typeof window.open;
            localStorage.setItem('vlc-paired:192.168.1.99:8080', '1');
        });
        await detail.getByTestId('vlc-play-button').nth(0).click();
        await expect(page.getByText('テレビへ飛ばしました (2分 から)')).toBeVisible();
        const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
        expect(opened).toHaveLength(1);
        const path = new URL(opened[0] ?? '').searchParams.get('path') ?? '';
        expect(path).toMatch(new RegExp(`/api/recordings/${id}/playlist/.+\\.xspf\\?token=`));
        const xspf = await request.get(path);
        expect(xspf.headers()['content-type']).toContain('application/xspf+xml');
        const xml = await xspf.text();
        expect(xml).toContain('<vlc:option>start-time=95</vlc:option>');
        // 中のファイルの URL も同じトークンで開ける (XML なので & は &amp;)
        const token = new URL(path).searchParams.get('token');
        expect(xml).toContain(`/api/recordings/${id}/file/`);
        expect(xml).toContain(`?token=${token}</location>`);
        const file = (/<location>([^<]+)<\/location>/.exec(xml)?.[1] ?? '').replaceAll('&amp;', '&');
        expect((await request.head(file)).ok()).toBe(true);

        // 後片付け。全部外して保存すると行ごと消える (他のテストにボタンを残さない)
        await goto(page, '/settings');
        await page.getByTestId('vlc-remove').first().click();
        await page.getByTestId('vlc-remove').first().click();
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('vlc-ip')).toHaveCount(0);
    });
});
