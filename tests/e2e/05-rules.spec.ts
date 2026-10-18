import { BS11 } from '../fake/services';
import { cancelAllReservations, clearRules, deleteRule, expect, goto, syncEpg, test } from './helpers';

test.describe('自動予約ルール', () => {
    /**
     * **左に一覧、右に書く欄** (一覧と詳細の形)。左の列は画面の左端とヘッダーの下まで寄せ、
     * 境目は線だけ。行を押せば右でそのまま直せる。
     *
     * 横に並べはじめる幅は**全画面で 768px** (`+layout.svelte` の `FILLED`)。
     * 並べたらページごとは動かさず、左右がそれぞれ自分で巻き取る
     */
    test('広い画面では左に一覧、右に書く欄を並べる', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await goto(page, '/rules');

        const shape = await page.evaluate(() => {
            const form = document.querySelector('[data-testid="rule-form"]');
            const list = document.querySelector('[data-testid="rule-list"]');
            const side = list?.closest('aside');
            const root = document.documentElement;
            return {
                横に並ぶ:
                    form !== null && list !== null
                        ? list.getBoundingClientRect().right <= form.getBoundingClientRect().left + 1
                        : false,
                左端に付く: side !== null && side !== undefined ? side.getBoundingClientRect().left : -1,
                縦に動く: root.scrollHeight > root.clientHeight + 1,
            };
        });
        expect(shape.横に並ぶ).toBe(true);
        expect(shape.左端に付く).toBe(0);
        expect(shape.縦に動く).toBe(false);
        // 押すもの (追加) は条件が長くても画面の中にある
        await expect(page.getByTestId('rule-submit')).toBeInViewport();

        // 無いルールの `?edit=` は一覧へ (編集のつもりで新しいルールを作らせない)
        await goto(page, '/rules?edit=999999');
        await expect(page).toHaveURL(/\/rules$/);
    });

    /**
     * **狭い画面では一覧と書く欄を切り替える。** 縦に積むと書く欄が先に来て、
     * 390×844 では登録済みのルールが1行も見えなかった。どちらを出すかは URL で決めるので、
     * ブラウザの戻るで一覧に戻れる
     */
    test('狭い画面では一覧を先に出し、押すと書く欄に切り替わる', async ({ page }) => {
        await clearRules(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await goto(page, '/rules');
        const keyword = page.getByTestId('rule-keyword');
        await expect(page.getByTestId('rule-new')).toBeVisible();
        await expect(keyword).toBeHidden();

        // 新しいルール → 書く欄。戻るで一覧へ
        await page.getByTestId('rule-new').click();
        await page.waitForURL(/\/rules\?new/);
        await expect(keyword).toBeVisible();
        await expect(page.getByTestId('rule-list')).toBeHidden();
        await page.goBack();
        await expect(page.getByTestId('rule-new')).toBeVisible();
        await expect(keyword).toBeHidden();

        // 当たる番組の無い語にしておく (予約を立てない)
        await page.getByTestId('rule-new').click();
        await keyword.fill('どこにも無い番組');
        // 下見のあとも書く欄のまま
        await page.getByTestId('rule-preview').click();
        await page.waitForURL(/\/rules\?.*keyword=/);
        await expect(page.getByTestId('preview')).toBeVisible();
        // 足したら一覧に戻り、足したルールが最初の画面に見える
        await page.getByTestId('rule-submit').click();
        const row = page.getByTestId('rule-row').filter({ hasText: 'どこにも無い番組' });
        await expect(row).toBeInViewport();
        await expect(keyword).toBeHidden();

        // 行を押すとそのルールの書く欄。「← ルール一覧」で戻る
        await row.click();
        await page.waitForURL(/\/rules\?edit=\d+$/);
        await expect(keyword).toHaveValue('どこにも無い番組');
        await page.getByTestId('rule-back').click();
        await page.waitForURL(/\/rules$/);
        await expect(row).toBeVisible();

        // 広い画面では戻るものを出さない (一覧と書く欄が並んでいる)
        await page.setViewportSize({ width: 1280, height: 720 });
        await row.click();
        await expect(page.getByTestId('rule-back')).toBeHidden();
        await expect(page.getByTestId('rule-list')).toBeVisible();

        await clearRules(page);
    });

    test('条件が空のルールは作れない', async ({ page }) => {
        await goto(page, '/rules');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-error')).toContainText(
            'キーワード・局・ジャンルのいずれかを指定してください',
        );
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
        // 1件も無いときは、次にすることまで出す
        await expect(page.getByTestId('rule-empty')).toContainText('「追加」すると');
    });

    test('キーワードルールを作ると予約が自動で立ち、削除できる', async ({ page, request }) => {
        await syncEpg(request);

        await goto(page, '/rules');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        // 偽の放送は同じタイトルを何度も流す。見たいのは予約が立つことなので、同じ回を1度にまとめない
        await page.getByTestId('rule-dedupe').uncheck();
        // チャンネルは既定で畳んである
        await page.getByTestId('channel-summary').click();
        await page.getByTestId('rule-services').locator(`input[value="${BS11.id}"]`).check();
        await page.getByTestId('rule-submit').click();

        // ルール名はキーワードから付く
        const rule = page.getByTestId('rule-row').first();
        await expect(rule).toContainText('テストアニメ');
        await expect(page.getByTestId('rule-switch').first()).toBeChecked();
        // 足したら書く欄は初めの状態に戻る (reset でチェックが全部外れていた)
        await expect(page.getByTestId('rule-keyword')).toHaveValue('');
        await expect(page.getByTestId('rule-search-fields').locator('input[value="name"]')).toBeChecked();
        await expect(page.getByTestId('rule-dedupe')).toBeChecked();

        // 偽エージェントは同じ番組名を周期的に返すので、ルール作成と同時に予約が立つ
        await goto(page, '/');
        const fromRule = page.getByTestId('reservation-row').filter({ hasText: 'テストアニメ' });
        // ルールで立ったものは、どのルールから来たかを番組名の下に出す
        await expect(fromRule.first().getByTestId('rule-name')).toContainText('テストアニメ');
        await expect(fromRule.first()).toBeVisible();

        // 無効化しても既存の予約は残る(意図せず録り逃さないため)
        // 一覧の行のスイッチで、開かずに切り替えられる
        await goto(page, '/rules');
        const toggle = page.getByTestId('rule-switch').first();
        await expect(toggle).toHaveAccessibleName(/^「テストアニメ.*」を有効にする$/);
        await toggle.click();
        await expect(rule).toContainText('無効');
        await expect(toggle).not.toBeChecked();
        await expect(page).toHaveURL(/\/rules$/);
        // 開いた書く欄の下でも切り替えられる。選んだまま
        await rule.click();
        await expect(page.getByTestId('rule-toggle')).toHaveText('有効化');
        await page.getByTestId('rule-toggle').click();
        await expect(page.getByTestId('rule-toggle')).toHaveText('無効化');
        await expect(rule).toHaveAttribute('aria-current', 'true');
        await expect(toggle).toBeChecked();

        await deleteRule(page, page.getByTestId('rule-row').first());
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
     * **この条件で本当にこれを録りたいのか**は、タイトルと局と時刻だけでは決められない。
     * 同じタイトルの再放送、傍題の違い、番組の中身は詳細にしか無く、確かめるには
     * 番組表を別に開いて探し直すことになっていた。予約一覧と同じ詳細をここでも出す
     */
    test('プレビューの行を押すと、番組詳細が出る', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/rules');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        await page.getByTestId('rule-preview').click();

        /*
         * **同じ回は最初の放送だけ** (新しいルールは入った状態)。偽の放送は同じ回 (#12) を
         * 何度も流すので、2回目以降は「録らない」と、どの放送で録るのかが行に出る
         */
        await expect(page.getByTestId('rule-dedupe')).toBeChecked();
        await expect(page.getByTestId('preview-skipped')).toBeVisible();
        await expect(page.getByTestId('preview-skip-reason').first()).toContainText(
            /同じ回を .+ で録ります|同じ回は録画済みです/,
        );

        const row = page.getByTestId('preview-row').first();
        await expect(row).toBeVisible();
        await row.getByTestId('preview-open').click();

        // 行が持っているのはタイトル・局・時刻だけ。EPG から引いた中身まで出ること
        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail).toContainText('ゲスト太郎');

        // 取り消しは行のほうに置いてある。押すものが増えたり減ったりしないように
        await expect(detail.getByTestId('rule-pending-cancel')).toHaveCount(0);
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);
    });

    /*
     * **条件を詰めている途中で「これは録っておきたい」に行き当たる。** 詳細から
     * 予約できなかった頃は、番組表を開いて同じ番組を探し直すことになっていた。
     * ルールに任せるかどうかとは別の話なので、その番組そのものに予約ボタンを出す
     */
    test('番組詳細から、その1本だけ予約できる', async ({ page, request }) => {
        await syncEpg(request);
        await clearRules(page);
        await goto(page, '/rules');
        await page.getByTestId('rule-keyword').fill('テストアニメ');
        await page.getByTestId('rule-preview').click();

        const row = page.getByTestId('preview-row').first();
        await expect(row).toBeVisible();
        const programId = await row.getAttribute('data-program-id');
        await row.getByTestId('preview-open').click();

        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await detail.getByTestId('rule-detail-reserve').click();

        // 押すと閉じ、その行に予約の状態が出る
        await expect(detail).toHaveCount(0);
        const same = page.locator(`[data-testid="preview-row"][data-program-id="${programId}"]`);
        await expect(same.getByTestId('preview-state')).toBeVisible();

        // もう予約は立っているので、開き直しても予約ボタンは出ない (状態のバッジが出る)
        await same.getByTestId('preview-open').click();
        await expect(detail.getByTestId('rule-detail-reserve')).toHaveCount(0);
        await expect(detail.getByTestId('rule-detail-state')).toBeVisible();
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
