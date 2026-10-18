import { cancelAllReservations, expect, goto, syncEpg, test } from './helpers';

/**
 * **サイト全体の検索** (`/search?q=`)。番組表・録画・予約・ルールを1つの言葉で探す。
 * 入口は広い画面ならヘッダーの欄 (`/` か Ctrl+K)、狭い画面なら下のタブの「検索」
 */
test.describe('検索', () => {
    test('ヘッダーの欄は / と Ctrl+K で入れ、打っている最中は取らない', async ({ page }) => {
        await goto(page, '/guide');
        const field = page.getByTestId('header-search-input');
        await expect(page.getByRole('search', { name: 'サイト内' })).toBeVisible();
        await expect(field).toHaveAccessibleName('番組・録画・予約・ルールを検索');

        await page.keyboard.press('/');
        await expect(field).toBeFocused();
        // 欄の中で打った / はそのまま字になる
        await page.keyboard.type('a/b');
        await expect(field).toHaveValue('a/b');

        await field.blur();
        await page.keyboard.press('Control+k');
        await expect(field).toBeFocused();

        // 送ると結果の画面へ。結果の画面でも同じヘッダーの欄で、探した言葉が入ったまま直して送れる
        await field.fill('テストアニメ');
        await field.press('Enter');
        await page.waitForURL(/\/search\?q=/);
        await expect(field).toHaveValue('テストアニメ');
        // 画面の中に別の欄は置かない (狭い幅の上の帯は広い幅では出さない)
        await expect(page.getByRole('search')).toHaveCount(1);
        await field.fill('ひとつめ');
        await field.press('Enter');
        await page.waitForURL((url) => url.searchParams.get('q') === 'ひとつめ');
        await expect(page.getByTestId('search-summary')).toContainText('ひとつめ');
        await expect(field).toHaveValue('ひとつめ');
        await expect(page).toHaveTitle('ひとつめ - 検索 - denpa');
    });

    test('結果は節ごとに見出しと件数を出し、番組はそのまま予約できる', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, `/search?q=${encodeURIComponent('テストアニメ')}`);

        for (const name of ['これからの放送', '録画', '予約', 'ルール']) {
            await expect(
                page.getByRole('heading', { level: 2, name: new RegExp(`^${name} \\d+$`) }),
            ).toBeVisible();
        }
        const programs = page.getByTestId('search-program');
        await expect(programs.first()).toBeVisible();
        for (const row of await programs.all()) {
            await expect(row).toContainText('テストアニメ');
        }
        // 先頭の5件だけ。残りは「もっと見る」で
        expect(await programs.count()).toBeLessThanOrEqual(5);
        const more = page.getByTestId('search-more-programs');
        if (await more.isVisible()) {
            await more.click();
            expect(await programs.count()).toBeGreaterThan(5);
        }

        // 予約すると、行は予約済みになり「予約」の節にも出る
        const first = programs.first();
        const programId = await first.getAttribute('data-program-id');
        await first.getByTestId('search-reserve').click();
        await expect(first.getByTestId('search-program-state')).toHaveText('予約済み');
        await expect(
            page.locator(`[data-testid="search-reservation"][data-program-id="${programId}"]`),
        ).toHaveCount(1);

        // 行を押すと番組の詳細
        await first.getByTestId('search-open').click();
        await expect(page.getByTestId('program-detail')).toBeVisible();
        await page.getByTestId('search-detail-cancel').click();
        await expect(page.getByTestId('program-detail')).toBeHidden();
        await expect(first.getByTestId('search-program-state')).toHaveCount(0);

        await cancelAllReservations(page);
    });

    test('言葉なしで開くと最近の検索を出し、消せる', async ({ page }) => {
        await goto(page, `/search?q=${encodeURIComponent('最近の言葉A')}`);
        await goto(page, '/search');
        await expect(page.getByTestId('header-search-input')).toBeFocused();
        const recent = page.getByTestId('recent-searches');
        await expect(recent.getByRole('link', { name: '最近の言葉A' })).toBeVisible();
        await page.getByTestId('recent-clear').click();
        await expect(recent).toHaveCount(0);
    });
});
