import { BS11 } from '../fake/services';
import {
    cancelAllReservations,
    clearRules,
    deleteRule,
    expect,
    goto,
    makeRule,
    syncEpg,
    test,
} from './helpers';

/**
 * **ルールの一覧と管理** (`/rules`)。並べて見比べ、スイッチで止める・戻す、2回押しで消す。
 * 作る・直すのは検索の画面の「ルールとして保存」(行を押すと `/search?rule=<ID>`。47-search-rule)
 */
test.describe('ルールの一覧', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await clearRules(page);
    });

    test('1件も無いときは、検索から作れると案内する', async ({ page }) => {
        await goto(page, '/rules');
        await expect(page.getByTestId('rule-empty')).toContainText('ルールとして保存');
        await page.getByTestId('rule-new').click();
        await page.waitForURL(/\/search$/);
    });

    test('行に条件・次の放送・予約の数を出し、スイッチで止め、2回押しで消す', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        // 偽の放送は同じタイトルを何度も流す。見たいのは予約が立つことなので、同じ回を1度にまとめない
        await makeRule(page, 'テストアニメ', { dedupe: false, fields: { serviceIds: String(BS11.id) } });
        await makeRule(page, 'どこにも無い番組', { fields: { ignoreKeyword: '再放送' } });

        await goto(page, '/rules');
        const rows = page.getByTestId('rule-row');
        await expect(rows).toHaveCount(2);
        const anime = rows.filter({ hasText: 'テストアニメ' });
        const none = rows.filter({ hasText: 'どこにも無い番組' });
        // 条件は1行で。局の名前・同じ回・除外
        await expect(anime).toContainText(`番組名 ・ ${BS11.name}`);
        await expect(none).toContainText('全局 ・ 同じ回は1度 ・ 除外: 再放送');
        // 次の放送と予約の数。当たらないルールは「予定なし」
        await expect(anime.getByTestId('rule-next')).toContainText(BS11.name);
        await expect(anime.getByTestId('rule-reservations')).not.toHaveText('0');
        await expect(none.getByTestId('rule-next')).toHaveText('予定なし');
        await expect(page.getByTestId('rule-summary')).toContainText(/これから7日の予約 \d+ 件/);

        // 既定は次の放送が近い順 (予定なしは下)
        await expect(rows.first()).toContainText('テストアニメ');
        await page.getByTestId('rule-sort').selectOption('new');
        await expect(rows.first()).toContainText('どこにも無い番組');

        // 絞り込みは件数つき
        await expect(page.getByTestId('rule-filter-idle')).toContainText('次の放送なし 1');
        await page.getByTestId('rule-filter-idle').click();
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toContainText('どこにも無い番組');
        await page.getByTestId('rule-filter-all').click();

        // スイッチは開かずに切り替える (行はリンクだが、スイッチはその外)
        const toggle = anime.getByTestId('rule-switch');
        await expect(toggle).toHaveAccessibleName('「テストアニメ」を有効にする');
        await toggle.click();
        await expect(anime).toContainText('無効');
        await expect(toggle).not.toBeChecked();
        await expect(page).toHaveURL(/\/rules$/);
        await expect(page.getByTestId('rule-filter-off')).toContainText('無効 1');
        // 止めたルールの予約は引っ込む
        await expect(anime.getByTestId('rule-reservations')).toHaveText('0');
        await toggle.click();
        await expect(toggle).toBeChecked();

        // 行を押すと検索の画面でそのルールを直す
        await anime.getByTestId('rule-open').click();
        await page.waitForURL(/\/search\?rule=\d+$/);
        await expect(page.getByTestId('rule-mode')).toContainText('テストアニメ');

        // 削除は2回押し
        await goto(page, '/rules');
        await deleteRule(none);
        await expect(rows).toHaveCount(1);
        await expect(page.getByTestId('rule-deleted')).toBeVisible();

        await clearRules(page);
        await cancelAllReservations(page);
    });

    /**
     * **狭い画面では2段の行。** 1段目に名前とスイッチ・削除、2段目に次の放送と予約・録画の数。横にはみ出さない
     */
    test('狭い画面では2段の行にする', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await makeRule(page, 'どこにも無い番組');
        await goto(page, '/rules');
        const row = page.getByTestId('rule-row').first();
        await expect(row).toContainText('予約 0 ・ 録画 0');
        await expect(row.getByTestId('rule-switch')).toBeInViewport();
        await expect(row.getByTestId('rule-delete')).toBeInViewport();
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(wide).toBe(false);
        await clearRules(page);
    });

    /**
     * **前の URL は検索の画面へ送る。** ブックマーク・ホームの「ルールを作る」・ルール名のリンクがそのまま効く
     */
    test('前のルールの画面の URL は検索の画面へ送る', async ({ page }) => {
        await goto(page, `/rules?keyword=${encodeURIComponent('どこにも無い番組')}&dedupe=0`);
        await expect(page).toHaveURL(/\/search\?q=/);
        await expect(page.getByTestId('rule-keyword')).toHaveValue('どこにも無い番組');
        await expect(page.getByTestId('rule-dedupe')).not.toBeChecked();

        await goto(page, '/rules?new');
        await expect(page).toHaveURL(/\/search$/);

        await goto(page, '/rules?edit=999999');
        await expect(page).toHaveURL(/\/search$/);
    });
});

test.describe('キーワードを当てる範囲', () => {
    /*
     * 偽エージェントの番組は、番組名にも概要にも出てこない語を詳細に持たせてある。
     * 既定(番組名だけ)では当たらず、詳細まで広げると当たる、という差を見る。
     */
    test('既定は番組名だけで、詳細まで広げると出演者でも当たる', async ({ page, request }) => {
        await syncEpg(request);
        await page.setViewportSize({ width: 1440, height: 900 });
        await goto(page, `/search?q=${encodeURIComponent('テストアニメ')}`);

        await page.getByTestId('rule-keyword').fill('ゲスト太郎');
        await expect(
            page.getByTestId('search-verdict-reason').filter({ hasText: 'キーワード' }).first(),
        ).toBeVisible();

        // 詳細を入れると同じキーワードで当たる (「キーワード」で外れる行が無くなる)。押すものは無く、そのまま数え直す
        await page.getByTestId('rule-search-fields').locator('input[value="extended"]').check();
        await expect(page.getByTestId('search-verdict-reason').filter({ hasText: 'キーワード' })).toHaveCount(
            0,
        );
        await expect(page.getByTestId('rule-search-fields').locator('input[value="extended"]')).toBeChecked();
    });
});

test.describe('ジャンル指定', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await clearRules(page);
    });

    test('ジャンルだけでもルールを作れる', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        // 偽エージェントの番組は全部「アニメ／特撮」(lv1=7)
        await makeRule(page, '', { fields: { genres: '7' } });
        // キーワードが無いときはジャンル名がルール名になる
        await goto(page, '/rules');
        await expect(page.getByTestId('rule-row').first()).toContainText('アニメ／特撮');

        // ジャンルだけで予約が立つ
        await goto(page, '/');
        await expect(page.getByTestId('reservation-row').first()).toBeVisible();
        await clearRules(page);
        await cancelAllReservations(page);
    });

    /**
     * **ジャンルは畳んだ行。** 開くと並びは中でスクロールせず丸ごと出る (書く欄の列がもうスクロールする)
     */
    test('ジャンルは畳んであり、開くと並びは丸ごと出る', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await goto(page, `/search?q=${encodeURIComponent('テストアニメ')}`);
        await expect(page.getByTestId('genre-summary')).toContainText('すべて');
        await expect(page.getByTestId('rule-genres')).toBeHidden();
        await page.getByTestId('channel-summary').click();
        await page.getByTestId('genre-summary').click();
        for (const id of ['rule-services', 'rule-genres']) {
            const list = page.getByTestId(id);
            await expect(list).toBeVisible();
            const shape = await list.evaluate((el) => ({
                overflow: getComputedStyle(el).overflowY,
                cut: el.scrollHeight > el.clientHeight + 1,
            }));
            expect(shape, id).toEqual({ overflow: 'visible', cut: false });
        }
    });

    test('合わないジャンルなら何も録らない', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        // スポーツ(lv1=1)。偽エージェントはアニメしか流さない
        await makeRule(page, '', { fields: { genres: '1' } });
        await goto(page, '/rules');
        await expect(page.getByTestId('rule-row')).toHaveCount(1);
        await goto(page, '/');
        await expect(page.getByTestId('reservation-row')).toHaveCount(0);
        await clearRules(page);
    });
});
