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
 * **ルールを直す** (検索の画面の `?rule=<ID>`)。一覧の行を押すとそのルールが書く欄に入る
 */
test.describe('ルールの編集', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await clearRules(page);
        await page.setViewportSize({ width: 1440, height: 900 });
    });

    /** 一覧の行を押して、そのルールを開く */
    async function open(page: import('@playwright/test').Page, name: string): Promise<void> {
        await goto(page, '/rules');
        await page.getByTestId('rule-row').filter({ hasText: name }).getByTestId('rule-open').click();
        await page.waitForURL(/\/search\?rule=\d+$/);
    }

    test('作ったルールの条件を後から変えられる', async ({ page }) => {
        // 偽の放送は同じタイトルを何度も流す。見たいのは予約が立つことなので、同じ回を1度にまとめない
        await makeRule(page, 'テストアニメ', { dedupe: false });
        await open(page, 'テストアニメ');

        // いまの内容が入っていること。空のフォームだと作り直しになってしまう
        await expect(page.getByTestId('rule-keyword')).toHaveValue('テストアニメ');
        await expect(page.getByTestId('rule-dedupe')).not.toBeChecked();

        await page.getByTestId('rule-keyword').fill('ニュース');
        await page.getByTestId('rule-ignore').fill('再放送');
        await page.getByTestId('channel-summary').click();
        await page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`).check();
        await page.getByTestId('rule-update').click();
        await expect(page.getByTestId('rule-saved')).toContainText('更新しました');
        await expect(page).toHaveURL(/\/search\?rule=\d+$/);

        // 増えずに書き換わること
        await goto(page, '/rules');
        const row = page.getByTestId('rule-row');
        await expect(row).toHaveCount(1);
        await expect(row.first()).toContainText('ニュース');

        // 開き直しても、変えた内容が入っている
        await open(page, 'ニュース');
        await expect(page.getByTestId('rule-ignore')).toHaveValue('再放送');
        await expect(page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`)).toBeChecked();

        await clearRules(page);
        await cancelAllReservations(page);
    });

    /*
     * **開いた直後も右の列は崩れない。** 開くとすぐ1回目の下見を数え、その間は列の下に `aria-busy` が付く。
     * Pico の `aria-busy` は字を1行にするので、案内の字が列の幅からはみ出して列が横にスクロールでき、
     * 数え終わると戻る (一瞬だけ崩れて見えた)。押した瞬間から毎フレーム測って、数え終わるまで見る
     */
    test('開いてから下見を数え終わるまで、右の列がはみ出さない', async ({ page }) => {
        await makeRule(page, 'テストアニメ');
        await goto(page, '/rules');
        await page.evaluate(() => {
            const w = window as unknown as { overflow: string[]; busy: boolean; done: boolean };
            w.overflow = [];
            w.busy = false;
            w.done = false;
            const started = performance.now();
            const frame = () => {
                const draft = document.querySelector<HTMLElement>('[data-testid="rule-draft"]');
                const foot = draft?.querySelector('[aria-busy]');
                if (draft !== null && draft !== undefined) {
                    if (draft.scrollWidth > draft.clientWidth || draft.scrollHeight > draft.clientHeight) {
                        w.overflow.push(
                            `${draft.scrollWidth}x${draft.scrollHeight} > ${draft.clientWidth}x${draft.clientHeight}`,
                        );
                    }
                    if (foot?.getAttribute('aria-busy') === 'true') w.busy = true;
                    else if (w.busy) w.done = true;
                }
                if (!w.done && performance.now() - started < 5000) requestAnimationFrame(frame);
                else w.done = true;
            };
            requestAnimationFrame(frame);
        });
        await page
            .getByTestId('rule-row')
            .filter({ hasText: 'テストアニメ' })
            .getByTestId('rule-open')
            .click();
        await page.waitForURL(/\/search\?rule=\d+$/);
        await page.waitForFunction(() => (window as unknown as { done: boolean }).done);
        expect(await page.evaluate(() => (window as unknown as { overflow: string[] }).overflow)).toEqual([]);
        await clearRules(page);
        await cancelAllReservations(page);
    });

    test('チェックを外したまま別のルールを開いても、そのルールの値が入る', async ({ page }) => {
        // どの番組にも当たらない語。予約を立てずに済む
        for (const keyword of ['当たらない語A', '当たらない語B']) {
            await makeRule(page, keyword, { fields: { searchFields: ['name', 'description'] } });
        }
        const description = page.getByTestId('rule-search-fields').locator('input[value="description"]');

        await open(page, '当たらない語A');
        await expect(page.getByTestId('rule-keyword')).toHaveValue('当たらない語A');
        await expect(description).toBeChecked();
        // 保存せずに外す
        await description.uncheck();

        await open(page, '当たらない語B');
        await expect(page.getByTestId('rule-keyword')).toHaveValue('当たらない語B');
        await expect(description).toBeChecked();

        await clearRules(page);
    });

    test('編集中に条件を変えると、その条件で数え直し、優先度も保存まで残る', async ({ page }) => {
        await makeRule(page, 'テストアニメ', { dedupe: false });
        await open(page, 'テストアニメ');
        // 言葉なしで開いたら、そのルールで録る番組を出す
        const rows = page.getByTestId('rule-preview').getByTestId('preview-row');
        await expect(rows.first()).toBeVisible();

        /*
         * 条件をいじると、押さずにその条件で数え直す。保存済みの条件ではなく、いま入っている条件での結果。
         * どこにも当たらない語にすると、このルールが立てた予約は「条件から外れました」として残って見える
         */
        await page.getByTestId('rule-keyword').fill('テストアニメ 当たらない語');
        await expect(rows.filter({ hasText: '条件から外れました' }).first()).toBeVisible();
        await expect(page.getByTestId('rule-update')).toBeVisible();
        await expect(page.getByTestId('rule-submit')).toHaveCount(0);
        await page.getByTestId('rule-keyword').fill('テストアニメ 決戦');

        await page.getByTestId('rule-priority').selectOption('5');
        await expect(rows.first()).toBeVisible();
        await expect(page.getByTestId('rule-priority')).toHaveValue('5');

        await page.getByTestId('rule-update').click();
        await expect(page.getByTestId('rule-saved')).toContainText('更新しました');
        await page.reload();
        await expect(page.getByTestId('rule-priority')).toHaveValue('5');
        await expect(page.getByTestId('rule-keyword')).toHaveValue('テストアニメ 決戦');

        await clearRules(page);
        await cancelAllReservations(page);
    });

    test('ルールが立てた予約を1件ずつ取り消せる', async ({ page }) => {
        /*
         * ここで立てた予約は取り消しで残る (ルールは作り直さないため)。
         * 他のテストが使う「テストアニメ」を消費すると、そちらで予約が
         * 立たなくなるので、このテストだけの番組名を使う
         */
        await makeRule(page, 'テスト番組C', { dedupe: false });

        /*
         * 結果の行から1件ずつ取り消す。**まとめてではなく1件ずつ**。押すたびにちょうど
         * 1件だけ減ることを見る
         */
        await page.getByTestId('search-more-programs').click();
        const cancels = page.getByTestId('search-cancel');
        await expect(cancels.first()).toBeVisible();
        const before = await cancels.count();
        expect(before).toBeGreaterThan(2);
        for (let left = before; left > before - 2; left--) {
            await cancels.first().click();
            // 送信中はボタンが無効になる。減るのを待たずに次を押すと空振りする
            await expect(cancels).toHaveCount(left - 1);
        }

        // 残りはルールごと畳む。まだ始まっていない予約は行ごと消える
        await goto(page, '/rules');
        await deleteRule(page.getByTestId('rule-row').first());
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
        await goto(page, '/');
        await expect(page.getByTestId('reservation-row').filter({ hasText: 'テスト番組C' })).toHaveCount(0);
    });
});

test.describe('ルールの作り直し', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await clearRules(page);
        await page.setViewportSize({ width: 1440, height: 900 });
    });

    test('同じルールを消して作り直すと、また予約が立つ', async ({ page }) => {
        // 消した予約を「取り消し」で残していた頃は、applyRules が
        // 「予約行が既にある」と見て飛ばすため、二度と予約が立たなかった
        for (const round of [1, 2]) {
            await makeRule(page, 'テストアニメ', { dedupe: false });

            await goto(page, '/');
            await expect(
                page.getByTestId('reservation-row').filter({ hasText: 'テストアニメ' }).first(),
                `${round} 回目`,
            ).toBeVisible();

            await goto(page, '/rules');
            await deleteRule(page.getByTestId('rule-row').first());
            await expect(page.getByTestId('rule-row')).toHaveCount(0);
        }
    });
});
