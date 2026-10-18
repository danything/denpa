import { BS11 } from '../fake/services';
import { cancelAllReservations, clearRules, deleteRule, expect, goto, syncEpg, test } from './helpers';

test.describe('自動予約ルール', () => {
    /**
     * **左に一覧、真ん中に書く欄、右に録れる番組** (一覧と詳細の形)。列は画面の端とヘッダーの下まで寄せ、
     * 境目は線だけ。行を押せば真ん中でそのまま直せる。
     *
     * 横に並べはじめる幅は**全画面で 768px** (`+layout.svelte` の `FILLED`)。768px からは2列で、
     * 下見は書く欄の下。**1280px からは下見を右の列に出す** (書く欄の下では、広い画面でも画面の外だった)。
     * 並べたらページごとは動かさず、列がそれぞれ自分で巻き取る
     */
    test('広い画面では一覧・書く欄・下見を横に並べる', async ({ page }) => {
        const shape = () =>
            page.evaluate(() => {
                const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
                const form = box('[data-testid="rule-form"]');
                const list = box('[data-testid="rule-list"]');
                const side = document.querySelector('[data-testid="rule-list"]')?.closest('aside');
                const preview = box('.preview-pane');
                const root = document.documentElement;
                return {
                    横に並ぶ: form !== undefined && list !== undefined && list.right <= form.left + 1,
                    下見が右: form !== undefined && preview !== undefined && form.right <= preview.left + 1,
                    下見が下: form !== undefined && preview !== undefined && form.bottom <= preview.top + 1,
                    左端に付く: side?.getBoundingClientRect().left ?? -1,
                    縦に動く: root.scrollHeight > root.clientHeight + 1,
                };
            });

        await page.setViewportSize({ width: 1280, height: 720 });
        await goto(page, '/rules');
        const wide = await shape();
        expect(wide.横に並ぶ).toBe(true);
        expect(wide.下見が右).toBe(true);
        expect(wide.左端に付く).toBe(0);
        expect(wide.縦に動く).toBe(false);
        // 押すもの (追加) は条件が長くても画面の中にある
        await expect(page.getByTestId('rule-submit')).toBeInViewport();
        // 条件が空なら数えず、何を入れればよいかを出す
        await expect(page.getByTestId('preview-blank')).toBeVisible();

        // 1280px より狭いと、下見は書く欄の下に続く
        await page.setViewportSize({ width: 1024, height: 720 });
        const middle = await shape();
        expect(middle.横に並ぶ).toBe(true);
        expect(middle.下見が下).toBe(true);
        expect(middle.縦に動く).toBe(false);

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

        // 当たる番組の無い語にしておく (予約を立てない)。検索の「ルールを作る」と同じ URL で来る
        await goto(page, `/rules?new&keyword=${encodeURIComponent('どこにも無い番組')}`);
        await expect(keyword).toHaveValue('どこにも無い番組');
        // 下見は打った語でそのまま出る
        await expect(page.getByTestId('preview')).toContainText('0 件');
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
        await expect(page.getByTestId('rule-empty')).toContainText('「＋ 新しいルール」から');
    });

    /**
     * **ルールの一覧には探す欄を置かない。** 探すのはサイト全体の検索の「ルール」で、
     * そこから押せばそのルールの書く欄が開く。言葉から作るのは検索の「ルールを作る」(`?new&keyword=`)
     */
    test('ルールは検索で探して開ける', async ({ page }) => {
        await clearRules(page);
        await goto(page, `/rules?new&keyword=${encodeURIComponent('どこにも無い番組')}`);
        await expect(page.getByTestId('rule-keyword')).toHaveValue('どこにも無い番組');
        await expect(page.getByTestId('preview')).toContainText('0 件');
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(1);
        await expect(page.getByTestId('rule-search')).toHaveCount(0);

        await goto(page, `/search?q=${encodeURIComponent('どこにも無い')}`);
        const hit = page.getByTestId('search-rule');
        await expect(hit).toHaveCount(1);
        await hit.getByRole('link').click();
        await page.waitForURL(/\/rules\?edit=\d+$/);
        await expect(page.getByTestId('rule-mode')).toContainText('どこにも無い番組');

        await clearRules(page);
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
        // 広い画面では書く欄の下に有効/無効を出さない (行のスイッチが同時に見えている)。
        // 狭い画面の書く欄では一覧を隠すので、そちらでは書く欄の下で切り替える。選んだまま
        await rule.click();
        await expect(rule).toHaveAttribute('aria-current', 'true');
        await expect(page.getByTestId('rule-toggle')).toBeHidden();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByTestId('rule-toggle')).toHaveText('有効化');
        await page.getByTestId('rule-toggle').click();
        await expect(page.getByTestId('rule-toggle')).toHaveText('無効化');
        // 狭い画面では「編集をやめる」は出さない (「← ルール一覧」と同じ行き先)
        await expect(page.getByTestId('rule-cancel-edit')).toBeHidden();
        await expect(page.getByTestId('rule-back')).toBeVisible();
        await page.setViewportSize({ width: 1280, height: 720 });
        await expect(rule).toHaveAttribute('aria-current', 'true');
        await expect(toggle).toBeChecked();
        await expect(page.getByTestId('rule-cancel-edit')).toBeVisible();

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
        await expect(page.getByTestId('preview')).toContainText('0 件');

        // 詳細にチェックを入れると同じキーワードで当たる。押すものは無く、そのまま数え直す
        await page.getByTestId('rule-search-fields').locator('input[value="extended"]').check();
        await expect(page.getByTestId('preview-row').first()).toBeVisible();
        // 数え直しても選んだ範囲はそのまま (打つたびに書く欄を描き直さない)
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
        // 読み直しても打ちかけの書く欄はそのまま (初期値に戻らない)
        await expect(page.getByTestId('rule-keyword')).toHaveValue('テストアニメ');

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

    /**
     * **局とジャンルの並びは中でスクロールさせない。** 書く欄の列がもうスクロールするので、
     * 開いた並びは丸ごとの高さで列に入る (入れ子にすると、どちらが動くのか分かりにくい)
     */
    test('局とジャンルを開くと、並びは中でスクロールせず丸ごと出る', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await goto(page, '/rules');
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
        // 最後のジャンルまで、列のスクロールだけで届く
        const last = page.getByTestId('rule-genres').locator('input[name="genres"]').last();
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
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
