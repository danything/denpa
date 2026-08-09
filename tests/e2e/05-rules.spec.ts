import { BS11 } from '../fake/services';
import { cancelAllReservations, clearRules, expect, goto, syncEpg, test } from './helpers';

test.describe('自動予約ルール', () => {
    /**
     * **左に書く欄、右に一覧。** 縦に積んでいた頃は、条件をいじるたびに一覧まで
     * 押し下げられて、**何が録れるようになったかを見るのに毎回スクロールで戻る**
     * ことになっていた。
     *
     * 横に並べはじめる幅は**全画面で 768px** (`+layout.svelte` の `FILLED`)。
     * 並べたらページごとは動かさず、左右がそれぞれ自分で巻き取る
     */
    test('広い画面では左に書く欄、右に一覧を並べる', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await goto(page, '/rules');

        const shape = await page.evaluate(() => {
            const form = document.querySelector('[data-testid="rule-form"]');
            const table = document.querySelector('[data-testid="rule-row"], table');
            const add = document.querySelector('[data-testid="rule-submit"]');
            const root = document.documentElement;
            return {
                横に並ぶ:
                    form !== null && table !== null
                        ? form.getBoundingClientRect().right <= table.getBoundingClientRect().left + 1
                        : false,
                // 押すものは巻き取られる中身の外。条件がどれだけ長くても見えている
                押すものは外: form !== null && add !== null && !form.contains(add),
                縦に動く: root.scrollHeight > root.clientHeight + 1,
            };
        });
        expect(shape.横に並ぶ).toBe(true);
        expect(shape.押すものは外).toBe(true);
        expect(shape.縦に動く).toBe(false);
    });

    test('条件が空のルールは作れない', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-error')).toContainText(
            'キーワード・チャンネル・ジャンルのどれかは指定してください',
        );
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
    });

    test('キーワードルールを作ると予約が自動で立ち、削除できる', async ({ page, request }) => {
        await syncEpg(request);

        await goto(page, '/rules');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        // チャンネルは既定で畳んである
        await page.getByTestId('channel-summary').click();
        await page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`).check();
        await page.getByTestId('rule-submit').click();

        // ルール名はキーワードから付く
        const rule = page.getByTestId('rule-row').first();
        await expect(rule).toContainText('テストアニメ');
        await expect(rule).toContainText('有効');

        // 偽エージェントは同じ番組名を周期的に返すので、ルール作成と同時に予約が立つ
        await goto(page, '/');
        const fromRule = page.getByTestId('reservation-row').filter({ hasText: 'テストアニメ' });
        // ルールで立ったものは、どのルールから来たかを番組名の下に出す
        await expect(fromRule.first().getByTestId('rule-name')).toContainText('テストアニメ');
        await expect(fromRule.first()).toBeVisible();

        // 無効化しても既存の予約は残る(意図せず録り逃さないため)
        await goto(page, '/rules');
        await rule.getByTestId('rule-toggle').click();
        await expect(page.getByTestId('rule-row').first()).toContainText('無効');

        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);

        // 後続に影響しないよう、このルールが作った予約は片付ける
        await cancelAllReservations(page);
    });
});

test.describe('キーワードを当てる範囲', () => {
    /*
     * 偽エージェントの番組は、番組名にも概要にも出てこない語を詳細に持たせてある。
     * 既定(番組名だけ)では当たらず、詳細まで広げると当たる、という差を見る。
     */
    test('既定は番組名だけで、詳細まで広げると出演者でも当たる', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/rules');

        await page.getByTestId('rule-keyword').fill('ゲスト太郎');
        await page.getByTestId('rule-preview').click();
        await expect(page.getByTestId('preview')).toContainText('0 件');

        // 詳細にチェックを入れると同じキーワードで当たる
        await page.getByTestId('rule-keyword').fill('ゲスト太郎');
        await page.getByTestId('rule-search-fields').locator('input[value="extended"]').check();
        await page.getByTestId('rule-preview').click();
        await expect(page.getByTestId('preview-row').first()).toBeVisible();
        // 選んだ範囲は結果と一緒に残る。押し直すたびに戻ると使えない
        await expect(page.getByTestId('rule-search-fields').locator('input[value="extended"]')).toBeChecked();
    });

    /*
     * **この条件で本当にこれを録りたいのか**は、題名と局と時刻だけでは決められない。
     * 同じ題名の再放送、傍題の違い、番組の中身は詳細にしか無く、確かめるには
     * 番組表を別に開いて探し直すことになっていた。予約一覧と同じ詳細をここでも出す
     */
    test('プレビューの行を押すと、番組詳細が出る', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/rules');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        await page.getByTestId('rule-preview').click();

        const row = page.getByTestId('preview-row').first();
        await expect(row).toBeVisible();
        await row.getByTestId('preview-open').click();

        // 行が持っているのは題名・局・時刻だけ。EPG から引いた中身まで出ること
        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail).toContainText('ゲスト太郎');

        // 予約する口は出さない。足すかどうかを決めるのはルールの条件のほう
        await expect(detail.getByTestId('detail-reserve')).toHaveCount(0);
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);
    });
});

test.describe('ジャンル指定', () => {
    test.beforeEach(async ({ page, request }) => {
        await syncEpg(request);
        await clearRules(page);
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
    });

    test('ジャンルだけでもルールを作れる', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('genre-summary').click();
        // 偽エージェントの番組は全部「アニメ／特撮」(lv1=7)
        await page.getByTestId('rule-genres').locator('input[value="7"]').check();
        await page.getByTestId('rule-submit').click();

        // キーワードが無いときはジャンル名がルール名になる
        const rule = page.getByTestId('rule-row').first();
        await expect(rule).toContainText('アニメ／特撮');

        // ジャンルだけで予約が立つ
        await goto(page, '/');
        await expect(page.getByTestId('reservation-row').first()).toBeVisible();
    });

    test('合わないジャンルなら何も録らない', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('genre-summary').click();
        // スポーツ(lv1=1)。偽エージェントはアニメしか流さない
        await page.getByTestId('rule-genres').locator('input[value="1"]').check();
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(1);

        await goto(page, '/');
        await expect(page.getByTestId('reservation-row')).toHaveCount(0);
    });
});
