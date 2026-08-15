import { expect, goto, recordOne, test } from './helpers';

/**
 * テレビの VLC へ飛ばす口 (録画詳細) と、その居場所の設定。
 *
 * **実際には飛ばしません。** 飛ばすのは端末のブラウザのトップレベル遷移で、
 * 相手 (テレビの VLC) がいないと開いたタブが繋がらないだけ — ここで確かめるのは
 * **口の出方と覚え方**のほう: 設定の行編集 (名前+IP+ポート+コーデック) が
 * 読み書きできるか、並べたテレビが詳細のボタンになるか。ホスト表記の整え方や
 * 書式の往復は `vlc-host.test.ts` / `vlc.test.ts` が持っている。
 */
test.describe('テレビの VLC で再生', () => {
    test('設定に並べたテレビが詳細のボタンになる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const t0 = Date.now();
        const lap = (w: string) => console.log(`[vlc-probe] +${((Date.now() - t0) / 1000).toFixed(1)}s ${w}`);
        const { id } = await recordOne(page, request);

        // まだテレビが無い: 「テレビで再生」はボタンごと出ない
        lap("await goto(page, '/');");
        await goto(page, '/');
        const row = page.locator(`[data-testid="recording-row"][data-recording-id="${id}"]`);
        lap("await row.getByTestId('detail-button').click();");
        await row.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        lap("await expect(detail.getByTestId('detail-close')).toBeVisible();");
        await expect(detail.getByTestId('detail-close')).toBeVisible();
        lap("await expect(detail.getByTestId('vlc-play-button')).toHaveCount(0);");
        await expect(detail.getByTestId('vlc-play-button')).toHaveCount(0);
        // 期限付きの再生リンクをコピーする口は「その他…」の中
        lap("await detail.getByTestId('detail-more').click();");
        await detail.getByTestId('detail-more').click();
        lap("await expect(detail.getByTestId('share-link-button')).toBeVisible();");
        await expect(detail.getByTestId('share-link-button')).toBeVisible();

        // テレビを1台足す。ポートを空にすると VLC の既定 (8080) が入る
        lap("await goto(page, '/settings');");
        await goto(page, '/settings');
        lap("await page.getByTestId('vlc-add').click();");
        await page.getByTestId('vlc-add').click();
        lap("await page.getByTestId('vlc-name').fill('リビング');");
        await page.getByTestId('vlc-name').fill('リビング');
        lap("await page.getByTestId('vlc-ip').fill('192.168.1.99');");
        await page.getByTestId('vlc-ip').fill('192.168.1.99');
        lap("await page.getByTestId('vlc-port').clear();");
        await page.getByTestId('vlc-port').clear();
        lap("await page.getByTestId('save-vlc').click();");
        await page.getByTestId('save-vlc').click();
        lap("await expect(page.getByTestId('vlc-port')).toHaveValue('8080');");
        await expect(page.getByTestId('vlc-port')).toHaveValue('8080');

        // 2台目はポートとコーデックも指名する
        lap("await page.getByTestId('vlc-add').click();");
        await page.getByTestId('vlc-add').click();
        lap("await page.getByTestId('vlc-name').nth(1).fill('寝室');");
        await page.getByTestId('vlc-name').nth(1).fill('寝室');
        lap("await page.getByTestId('vlc-ip').nth(1).fill('192.168.1.98');");
        await page.getByTestId('vlc-ip').nth(1).fill('192.168.1.98');
        lap("await page.getByTestId('vlc-port').nth(1).fill('9090');");
        await page.getByTestId('vlc-port').nth(1).fill('9090');
        lap("await page.getByTestId('vlc-codec').nth(1).selectOption('ts');");
        await page.getByTestId('vlc-codec').nth(1).selectOption('ts');
        lap("await page.getByTestId('save-vlc').click();");
        await page.getByTestId('save-vlc').click();
        lap("await expect(page.getByTestId('vlc-port').nth(1)).toHaveValue('9090');");
        await expect(page.getByTestId('vlc-port').nth(1)).toHaveValue('9090');

        // 読み直しても行が同じに出る (書式の往復とコーデックの覚え)
        lap("await goto(page, '/settings');");
        await goto(page, '/settings');
        lap("await expect(page.getByTestId('vlc-ip').nth(1)).toHaveValue('192.168.1");
        await expect(page.getByTestId('vlc-ip').nth(1)).toHaveValue('192.168.1.98');
        lap("await expect(page.getByTestId('vlc-codec').nth(1)).toHaveValue('ts');");
        await expect(page.getByTestId('vlc-codec').nth(1)).toHaveValue('ts');

        /*
         * **何も変えずに保存しても、入力欄が空に見えない。**
         * enhance の既定 reset がバインド済みの欄をデフォルト (空) に戻し、
         * サーバの一覧が変わらないと写し直しも走らないので、空のまま残っていた
         */
        lap("await page.getByTestId('save-vlc').click();");
        await page.getByTestId('save-vlc').click();
        lap("await expect(page.getByTestId('saved-result')).toBeVisible();");
        await expect(page.getByTestId('saved-result')).toBeVisible();
        lap("await expect(page.getByTestId('vlc-ip').nth(0)).toHaveValue('192.168.1");
        await expect(page.getByTestId('vlc-ip').nth(0)).toHaveValue('192.168.1.99');
        lap("await expect(page.getByTestId('vlc-name').nth(0)).toHaveValue('リビング');");
        await expect(page.getByTestId('vlc-name').nth(0)).toHaveValue('リビング');

        // 2台になると、ボタンは名前で並ぶ
        lap("await goto(page, '/');");
        await goto(page, '/');
        lap("await row.getByTestId('detail-button').click();");
        await row.getByTestId('detail-button').click();
        lap("await expect(detail.getByTestId('vlc-play-button').nth(0)).toHaveText(");
        await expect(detail.getByTestId('vlc-play-button').nth(0)).toHaveText('▶ リビング');
        lap("await expect(detail.getByTestId('vlc-play-button').nth(1)).toHaveText(");
        await expect(detail.getByTestId('vlc-play-button').nth(1)).toHaveText('▶ 寝室');

        // 押すと初回はペア設定のタブが開く — 相手は居ないので畳んで進む
        const popup = page.waitForEvent('popup');
        lap("await detail.getByTestId('vlc-play-button').nth(0).click();");
        await detail.getByTestId('vlc-play-button').nth(0).click();
        lap('await (await popup).close();');
        await (await popup).close();

        // 後片付け。全部外して保存すると行ごと消える (他のテストにボタンを残さない)
        lap("await goto(page, '/settings');");
        await goto(page, '/settings');
        lap("await page.getByTestId('vlc-remove').first().click();");
        await page.getByTestId('vlc-remove').first().click();
        lap("await page.getByTestId('vlc-remove').first().click();");
        await page.getByTestId('vlc-remove').first().click();
        lap("await page.getByTestId('save-vlc').click();");
        await page.getByTestId('save-vlc').click();
        lap("await expect(page.getByTestId('vlc-ip')).toHaveCount(0);");
        await expect(page.getByTestId('vlc-ip')).toHaveCount(0);
    });
});
