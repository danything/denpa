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
        // 打ちかけを覚えないよう、言葉が少しの間変わらなかったら覚える
        await expect
            .poll(() => page.evaluate(() => localStorage.getItem('denpa.recent-searches')))
            .toContain('最近の言葉A');
        await goto(page, '/search');
        await expect(page.getByTestId('header-search-input')).toBeFocused();
        const recent = page.getByTestId('recent-searches');
        await expect(recent.getByRole('link', { name: '最近の言葉A' })).toBeVisible();
        await page.getByTestId('recent-clear').click();
        await expect(recent).toHaveCount(0);
    });

    /**
     * **打つそばから候補を出す** (ヘッダーの欄。combobox と listbox)。↑/↓ で選び、Enter で開く。
     * 何も選んでいなければ Enter で結果の画面。Esc で閉じる
     */
    test('ヘッダーの欄に打つと候補が出て、選んで Enter で開ける', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/guide');
        const field = page.getByTestId('header-search-input');
        const suggest = page.getByTestId('header-search-suggest');
        await expect(field).toHaveAttribute('role', 'combobox');
        await expect(field).toHaveAttribute('aria-expanded', 'false');

        await field.click();
        await field.pressSequentially('テストアニメ');
        await expect(suggest).toBeVisible();
        await expect(field).toHaveAttribute('aria-expanded', 'true');
        const listbox = page.getByRole('listbox', { name: '検索の候補' });
        await expect(listbox.getByRole('group', { name: 'これからの放送' })).toBeVisible();
        const options = listbox.getByRole('option');
        await expect(options.first()).toContainText('テストアニメ');
        await expect(page.getByTestId('header-search-all')).toContainText(
            '「テストアニメ」のすべての結果を見る',
        );

        // Esc で閉じ、↓ でまた開く
        await field.press('Escape');
        await expect(suggest).toBeHidden();
        await field.press('ArrowDown');
        await expect(suggest).toBeVisible();

        // ↓ で先頭の候補を選び、Enter でその番組の詳細を結果の画面で開く
        await field.press('ArrowDown');
        const first = page.getByTestId('header-search-option').first();
        await expect(first).toHaveAttribute('aria-selected', 'true');
        await expect(field).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
        await field.press('Enter');
        await page.waitForURL((url) => url.pathname.endsWith('/search') && url.searchParams.has('program'));
        await expect(page.getByTestId('program-detail')).toBeVisible();
        await page.getByTestId('detail-close').click();
        await expect(page).not.toHaveURL(/program=/);

        // 何も選ばずに Enter なら結果の画面
        await goto(page, '/guide');
        await field.click();
        await field.pressSequentially('テストアニメ');
        await expect(suggest).toBeVisible();
        await field.press('Enter');
        await page.waitForURL(
            (url) => url.searchParams.get('q') === 'テストアニメ' && !url.searchParams.has('program'),
        );
        await expect(page.getByTestId('search-summary')).toContainText('テストアニメ');
    });

    test('結果の画面では打つそばから結果が変わり、履歴は積まない', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/guide');
        await goto(page, '/search');
        const field = page.getByTestId('header-search-input');
        await expect(field).toBeFocused();
        await field.pressSequentially('テストアニメ');
        // Enter を押さずに結果が出る。候補の箱は出さない
        await page.waitForURL((url) => url.searchParams.get('q') === 'テストアニメ');
        await expect(page.getByTestId('search-summary')).toContainText('テストアニメ');
        await expect(page.getByTestId('header-search-suggest')).toBeHidden();
        await expect(field).toBeFocused();
        await expect(field).toHaveValue('テストアニメ');
        // 置き換えなので、戻ると検索の画面より前 (番組表) へ
        await page.goBack();
        await page.waitForURL((url) => url.pathname.endsWith('/guide'));
    });
});
