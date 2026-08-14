import { expect, goto, recordOne, test } from './helpers';

/**
 * テレビの VLC へ飛ばす口 (録画詳細) と、その居場所の設定。
 *
 * **実際には飛ばしません。** 飛ばすのは端末のブラウザのトップレベル遷移で、
 * 相手 (テレビの VLC) がいないと開いたタブが繋がらないだけ — ここで確かめるのは
 * **口の出方と覚え方**のほう: 入れたIPがサーバの一覧に載って全端末のボタンに
 * なるか、設定の行編集 (名前+IP) が読み書きできるか。ホスト表記の整え方
 * そのものは `vlc-host.test.ts` / `vlc.test.ts` が持っている。
 */
test.describe('テレビの VLC で再生', () => {
    test('出先で入れたIPが設定に載り、名前を付けてボタンにできる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        // まだテレビが無い: 名指しのボタンは無く、IP入力の入口だけが出る
        await goto(page, '/');
        const row = page.locator(`[data-testid="recording-row"][data-recording-id="${id}"]`);
        await row.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        await expect(detail.getByTestId('vlc-play-button')).toHaveCount(0);
        await expect(detail.getByTestId('vlc-other-open')).toHaveText('▶ テレビで再生…');
        // 期限付きの再生リンクをコピーする口は「その他…」の中
        await detail.getByTestId('detail-more').click();
        await expect(detail.getByTestId('share-link-button')).toBeVisible();

        /*
         * 出先の入力から飛ばすと、**サーバの一覧にも載って**ボタンが生える。
         * `http://` 付きで貼っても剥がして読む (アドレス欄からの貼り付けで
         * 一番よくある形)。相手は居ないので、開いた白いタブは畳んで進む
         */
        await detail.getByTestId('vlc-other-open').click();
        await detail.getByTestId('vlc-other-host').fill('http://192.168.1.99');
        const popup = page.waitForEvent('popup');
        await detail.getByTestId('vlc-other-play').click();
        await (await popup).close();
        await expect(detail.getByTestId('vlc-play-button')).toHaveText('▶ テレビで再生');

        // 設定にはホストだけが載っている (名前はまだ無い)。名前を付けられる
        await goto(page, '/settings');
        await expect(page.getByTestId('vlc-host')).toHaveValue('192.168.1.99:8080');
        await expect(page.getByTestId('vlc-name')).toHaveValue('');
        await page.getByTestId('vlc-name').fill('リビング');
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();

        // 2台目を足す。保存されたことは、読み直しでポートが補われた値で確かめる
        await page.getByTestId('vlc-add').click();
        await page.getByTestId('vlc-name').nth(1).fill('寝室');
        await page.getByTestId('vlc-host').nth(1).fill('192.168.1.98');
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('vlc-host').nth(1)).toHaveValue('192.168.1.98:8080');

        // 2台になると、ボタンは名前で並ぶ。出先の入口は「その他…」の中へ
        await goto(page, '/');
        await row.getByTestId('detail-button').click();
        await expect(detail.getByTestId('vlc-play-button').nth(0)).toHaveText('▶ リビング');
        await expect(detail.getByTestId('vlc-play-button').nth(1)).toHaveText('▶ 寝室');
        await detail.getByTestId('detail-more').click();
        await expect(detail.getByTestId('vlc-other-open')).toHaveText('別のテレビへ飛ばす…');

        // 後片付け。全部外して保存すると行ごと消える (他のテストにボタンを残さない)
        await goto(page, '/settings');
        await page.getByTestId('vlc-remove').first().click();
        await page.getByTestId('vlc-remove').first().click();
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('vlc-host')).toHaveCount(0);
    });
});
