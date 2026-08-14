import { expect, goto, recordOne, test } from './helpers';

/**
 * テレビの VLC へ飛ばす口 (録画詳細) と、その居場所の設定。
 *
 * **実際には飛ばしません。** 飛ばすのは端末のブラウザのトップレベル遷移で、
 * 相手 (テレビの VLC) がいないと開いたタブが繋がらないだけ — ここで確かめるのは
 * **口の出方**のほう: 設定に書いたテレビがボタンになるか、書かなければ出ないか、
 * 出先用のIP入力が開くか。ホスト表記の整え方そのものは `vlc-host.test.ts` /
 * `vlc.test.ts` が持っている。
 */
test.describe('テレビの VLC で再生', () => {
    test('設定に書いたテレビが録画詳細のボタンになる', async ({ page, request }) => {
        test.setTimeout(180_000);
        const { id } = await recordOne(page, request);

        // まだテレビを書いていない: 名指しのボタンは無く、出先用の口だけが出る
        await goto(page, '/');
        const row = page.locator(`[data-testid="recording-row"][data-recording-id="${id}"]`);
        await row.getByTestId('detail-button').click();
        const detail = page.getByTestId('program-detail');
        await expect(detail.getByTestId('vlc-play-button')).toHaveCount(0);
        await expect(detail.getByTestId('vlc-other-open')).toHaveText('▶ テレビで再生…');
        // 期限付きの再生リンクをコピーする口は「その他…」の中
        await detail.getByTestId('detail-more').click();
        await expect(detail.getByTestId('share-link-button')).toBeVisible();

        // 居場所を書く。http:// 付きで貼っても剥がして読めること (設定画面の復唱で確かめる)
        await goto(page, '/settings');
        await page.getByTestId('vlc-targets').fill('リビング=http://192.168.1.50');
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();
        await expect(page.getByTestId('vlc-card')).toContainText('リビング (192.168.1.50:8080)');

        // 書いたテレビがボタンになる。1台だけなら名前より用が分かる文字を出す
        await goto(page, '/');
        await row.getByTestId('detail-button').click();
        await expect(detail.getByTestId('vlc-play-button')).toHaveText('▶ テレビで再生');

        // 出先用: テレビを書いてあるときは「その他…」の中。押すとIP入力に変わる
        await detail.getByTestId('detail-more').click();
        await detail.getByTestId('vlc-other-open').click();
        const otherPlay = detail.getByTestId('vlc-other-play');
        await expect(otherPlay).toBeDisabled();
        await detail.getByTestId('vlc-other-host').fill('192.168.1.99');
        await expect(otherPlay).toBeEnabled();

        // 後片付け。テレビの設定を残すと他のテストの詳細にもボタンが出る
        await goto(page, '/settings');
        await page.getByTestId('vlc-targets').fill('');
        await page.getByTestId('save-vlc').click();
        await expect(page.getByTestId('saved-result')).toBeVisible();
    });
});
