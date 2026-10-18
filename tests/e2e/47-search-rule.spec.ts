import { BS11 } from '../fake/services';
import { cancelAllReservations, clearRules, expect, goto, syncEpg, test } from './helpers';

/**
 * **検索からルールを作る** (検索の画面の右の「ルールとして保存」)。探した言葉から始めて条件を詰め、
 * 結果の「これからの放送」の行ごとに「録る / 録らない (理由) / 予約済み」を見ながら保存する
 */
test.describe('検索からルールを作る', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await clearRules(page);
    });

    test('条件を変えると行の「録るか」が変わり、保存したルールを開いて直せる', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await goto(page, `/search?q=${encodeURIComponent('テストアニメ')}`);

        // 広い画面では右の列。キーワードは探した言葉から始まる
        const draft = page.getByTestId('rule-draft');
        await expect(draft).toBeVisible();
        await expect(page.getByTestId('rule-keyword')).toHaveValue('テストアニメ');
        await expect(page.getByTestId('rule-dedupe')).toBeChecked();
        const shape = await page.evaluate(() => {
            const box = document.querySelector('[data-testid="rule-draft"]')!.getBoundingClientRect();
            return { right: Math.round(window.innerWidth - box.right), top: Math.round(box.top) };
        });
        // 画面の右端に付き、ヘッダーのすぐ下から
        expect(shape.right).toBe(0);
        expect(shape.top).toBeLessThan(80);

        /*
         * 行ごとに「録る / 録らない」が付く。同じ回のどれを録るかは、前のテストが残した録画や
         * チューナー不足の予約で変わるので、ここでは決め打ちしない (rule-preview.test.ts が見る)
         */
        const verdict = (kind: string, station?: string) =>
            page
                .locator(`[data-testid="search-program"][data-verdict="${kind}"]`)
                .filter(station === undefined ? {} : { hasText: station })
                .first();
        await expect(page.getByTestId('search-verdict').first()).toHaveText(/^録(る|らない)$/);
        await expect(page.getByTestId('rule-submit')).toHaveText(/^(\d+ 件を録る)?ルールを保存$/);

        // 除外する言葉に当たる行は「除外」
        await page.getByTestId('rule-ignore').fill('決戦');
        await expect(page.locator('[data-testid="search-program"][data-verdict="record"]')).toHaveCount(0);
        await expect(
            page.getByTestId('search-verdict-reason').filter({ hasText: '除外' }).first(),
        ).toBeVisible();
        await page.getByTestId('rule-ignore').fill('');

        // 地上波だけにすると、BS の行は「局」
        await page.getByTestId('channel-summary').click();
        const gr = page.getByTestId('rule-types').locator('input[value="GR"]');
        await gr.check();
        await expect(verdict('skip', BS11.name).getByTestId('search-verdict-reason')).toHaveText('局');
        await gr.uncheck();

        // BS11 だけにして同じ回をまとめなければ、BS11 の行は「録る」
        await page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`).check();
        await expect(page.getByTestId('channel-summary')).toContainText(BS11.name);
        await page.getByTestId('rule-dedupe').uncheck();
        await expect(verdict('record', BS11.name).getByTestId('search-verdict')).toHaveText('録る');

        // 保存すると、そのルールへの入口が出る
        await page.getByTestId('rule-submit').click();
        const link = page.getByTestId('rule-saved-link');
        await expect(link).toHaveText('テストアニメ');
        // 予約が立ったので、録る行は「予約済み」になる
        await expect(verdict('reserved', BS11.name)).toBeVisible();

        // 開くと書く欄にそのルール。URL のまま開き直しても同じ
        await link.click();
        await page.waitForURL(/\/search\?rule=\d+$/);
        await expect(page.getByTestId('rule-mode')).toContainText('編集中: テストアニメ');
        await expect(page.getByTestId('rule-dedupe')).not.toBeChecked();
        await page.reload();
        await expect(page.getByTestId('rule-mode')).toContainText('編集中: テストアニメ');
        // 言葉なしで開いたら、結果の代わりにそのルールで録る番組を出す
        await expect(page.getByTestId('rule-preview').getByTestId('preview-row').first()).toBeVisible();

        // 直して更新
        await page.getByTestId('rule-priority').selectOption('3');
        await page.getByTestId('rule-update').click();
        await expect(page.getByTestId('rule-saved')).toContainText('更新しました');
        await page.reload();
        await expect(page.getByTestId('rule-priority')).toHaveValue('3');

        // 無効化・有効化
        await page.getByTestId('rule-toggle').click();
        await expect(page.getByTestId('rule-toggle')).toHaveText('有効化');
        await expect(page.getByTestId('rule-draft')).toContainText('無効');
        await page.getByTestId('rule-toggle').click();
        await expect(page.getByTestId('rule-toggle')).toHaveText('無効化');

        // 削除は2回押し。消したら `?rule=` を外して出直す
        await page.getByTestId('rule-delete').click();
        await page.getByTestId('rule-delete-confirm').click();
        await page.waitForURL((url) => !url.searchParams.has('rule'));
        await expect(page.getByTestId('rule-deleted')).toBeVisible();

        // 無いルールの `?rule=` は外して出直す (直すつもりで新しいルールを作らせない)
        await goto(page, '/search?rule=999999&q=x');
        await expect(page).toHaveURL(/\/search\?q=x$/);

        await cancelAllReservations(page);
    });

    test('条件が空のルールは作れない', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await goto(page, `/search?q=${encodeURIComponent('どこにも無い番組')}`);
        await page.getByTestId('rule-keyword').fill('');
        await expect(page.getByTestId('rule-submit')).toBeDisabled();
        await expect(page.getByTestId('rule-draft-status')).toContainText('キーワードか局を入れると');
    });

    /**
     * **狭い画面では下から出す。** 結果の一覧の下に貼り付いたボタンで開き、上半分の一覧は見えたまま
     */
    test('狭い画面ではボタンで下から出す', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await goto(page, `/search?q=${encodeURIComponent('どこにも無い番組')}`);
        const draft = page.getByTestId('rule-draft');
        await expect(draft).toBeHidden();
        await page.getByTestId('rule-draft-open').click();
        await expect(draft).toBeInViewport();
        await expect(page.getByTestId('rule-keyword')).toHaveValue('どこにも無い番組');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-saved-link')).toHaveText('どこにも無い番組');
        await page.getByTestId('rule-draft-close').click();
        await expect(draft).toBeHidden();
        // 横にはみ出さない
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(wide).toBe(false);
        await clearRules(page);
    });

    /**
     * 番組の詳細の「ルールを作る」は、シリーズ名を言葉にして検索の画面へ (`?from=program:<ID>`)
     */
    test('番組から来るとシリーズ名で始まる', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await goto(page, `/search?q=${encodeURIComponent('テストアニメ')}`);
        const id = await page.getByTestId('search-program').first().getAttribute('data-program-id');
        await goto(page, `/search?from=program:${id}`);
        await expect(page).toHaveURL(/q=%E3%83%86%E3%82%B9%E3%83%88%E3%82%A2%E3%83%8B%E3%83%A1/);
        await expect(page.getByTestId('rule-keyword')).toHaveValue('テストアニメ');
        await expect(page.getByTestId('rule-origin')).toContainText('シリーズ名から始めました');
    });
});
