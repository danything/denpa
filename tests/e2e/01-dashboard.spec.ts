import { cancelAllReservations, expect, goto, syncEpg, test } from './helpers';

test.describe('ダッシュボードと画面遷移', () => {
    test('データ放送のチャンネルは取り込まない', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/guide?type=GR');
        // 映像が入っていないので録っても中身が無い。番組表に出るとルールが引っかけて
        // 録画が失敗する
        await expect(page.locator('[data-testid="guide-grid"]')).not.toContainText('MXデータ');
    });

    test('EPG取得後に局・番組が反映され、全ページを開ける', async ({ page, request }) => {
        await syncEpg(request);

        /*
         * 取り込めたかどうかは**表そのもの**で見る (件数の札は出していない —
         * 表を見れば分かることなので)。**表は種別ごと**なので、両方を見る。
         *
         * 偽の局は5つで、出るのは 地上波2 + BS1。**データ放送の局**は録画対象に
         * ならないので取り込まれず、**番組がまだ1本も無い BS の局**は列を出さない
         * (`epg.airing`)。まだ集め終えていない局は本物でも普通にあるので、
         * それでも表が出ることを一緒に見ておく
         */
        for (const [type, count] of [
            ['GR', 2],
            ['BS', 1],
        ] as const) {
            await goto(page, `/guide?type=${type}`);
            await expect(page.getByTestId('guide-service')).toHaveCount(count);
        }

        /*
         * **見出しは置いていない。** どの画面に居るかはナビの塗りとタブの名前で
         * 分かるので、同じ言葉をもう一度大きく出す意味が無かった。
         * ここで確かめるのもその2つ (`+layout.svelte` の `title`)
         */
        for (const [name, label] of [
            ['nav-guide', '番組表'],
            ['nav-rules', 'ルール'],
            ['nav-tuners', 'チューナー'],
            ['nav-settings', '設定'],
            ['nav-home', '予約と録画'],
        ] as const) {
            await page.getByTestId(name).click();
            await expect(page).toHaveTitle(`${label} - denpa`);
            await expect(page.getByTestId(name)).toHaveAttribute('aria-current', 'page');
        }
    });

    test('チューナー画面にカードリーダーの状態が出る', async ({ page }) => {
        await goto(page, '/tuners');
        /*
         * **「チューナーの空き」に並べてある。** 同じ機材の話なので、
         * わざわざ別の枠を作って見るところを増やさない
         * (エージェントの生死も、繋がらなければその枠に理由が出る)
         */
        const card = page.getByTestId('tuner-card');
        // 相手待ちなので後から流れてくる
        await expect(card.getByTestId('status-card-reader')).toHaveText('OK');
        await expect(card).toContainText('Fake Card Reader');
    });

    /**
     * **器は表を待たずに出す** (`+page.server.ts` の `gridOf`)。
     *
     * 種別のタブ・日送り・検索窓は URL だけで描けるのに、いちばん重い表を待って
     * いたせいで画面ごと出てこなかった。表だけ後から流すので、最初に届く HTML
     * には**器と骨組みが入っていて、番組はまだ入っていない**。
     *
     * ここを HTML で見るのは、**速さに左右されないため**。描き終わりを目で
     * 追うと、中身の少ない試験用の番組表では一瞬で埋まってしまう
     */
    test('番組表は器を先に返し、表のところだけ読み込み中にする', async ({ request }) => {
        const res = await request.get('/guide');
        expect(res.ok()).toBe(true);
        const html = await res.text();
        // 器 (種別タブ・日送り・検索窓) は最初の HTML に入っている
        expect(html).toContain('data-testid="type-tabs"');
        expect(html).toContain('data-testid="guide-filter"');
        // 表のところは骨組み。本物の枠はまだ無い
        expect(html.indexOf('data-testid="guide-skeleton"')).toBeGreaterThan(-1);
        expect(html.indexOf('data-testid="guide-skeleton"')).toBeLessThan(
            html.indexOf('data-testid="guide-rows"') === -1
                ? Number.POSITIVE_INFINITY
                : html.indexOf('data-testid="guide-rows"'),
        );
    });

    test('番組表はグリッドで出て、キーワード検索ではリストになる', async ({ page }) => {
        await goto(page, '/guide');

        // 既定は地上波のグリッド。時間×チャンネルで並ぶ
        await expect(page.getByTestId('guide-grid')).toBeVisible();
        await expect(page.getByTestId('grid-program').first()).toBeVisible();

        // 種別で切り替えられる
        await page.getByTestId('type-BS').click();
        await expect(page.getByTestId('grid-program').first()).toBeVisible();
        await page.getByTestId('type-GR').click();

        // いまが何時かの線が出て、開いた時点でそこが見えているところまで動いている。
        // 位置を offsetTop で測っていた頃は、ナビや見出しの高さまで足し込まれて
        // その分だけ行き過ぎ、線が上に流れて見えなくなっていた
        await expect(page.getByTestId('now-line')).toBeVisible();
        const view = await page.getByTestId('guide-grid').evaluate((el) => {
            const grid = el as HTMLElement;
            const line = grid.querySelector('[data-testid="now-line"]') as HTMLElement;
            return {
                scrollTop: grid.scrollTop,
                // グリッドの上端から見た「いま」の線の位置
                offset: line.getBoundingClientRect().top - grid.getBoundingClientRect().top,
                height: grid.clientHeight,
            };
        });
        /*
         * **見えているところに居ること**だけを見る。**位置は決め打てない。**
         *
         * 置きたいのは画面の4分の1あたりだが、番組表は 4:00 から翌 4:00 までの
         * 帯なので、**端では寄せきれない**:
         *
         *     4時台   … 「いま」がもともと上にあり、頭に貼り付く (offset ≒ 0)
         *     深夜1時 … 下端まで送られていて、それ以上は上がらない (offset が下へ寄る)
         *
         * どちらも正しい動きなので、**画面の中に居れば通す**。ここを
         * 「4分の1まで」で見ていた頃は 01:37 に走って落ち、その前は
         * 「`scrollTop > 0`」で見ていて 4時台に落ちた。**2回とも時計で落ちた。**
         *
         * 行き過ぎ (offset が負) も、動かさない不具合 (画面より下) もこれで出る
         */
        expect(view.offset).toBeGreaterThanOrEqual(0);
        expect(view.offset).toBeLessThan(view.height);

        // 番組をクリックすると詳細が出る。ここで予約するかどうか決める
        await page.getByTestId('program-button').first().click();
        const detail = page.getByTestId('program-detail');
        await expect(detail).toBeVisible();
        await expect(detail).toContainText('のテスト番組');
        await page.getByTestId('detail-close').click();
        await expect(detail).toHaveCount(0);
    });

    test('テーマはダーク/ライト/端末に合わせるを切り替えられ、再読み込みしても残る', async ({ page }) => {
        await goto(page, '/');
        const html = page.locator('html');
        const toggle = page.getByTestId('theme-toggle');

        // 既定はダーク (映像を観るものはダークが基本)。端末の設定には従わない
        await expect(toggle).toHaveAttribute('data-mode', 'dark');
        await expect(html).toHaveAttribute('data-theme', 'dark');

        await toggle.click();
        await expect(html).toHaveAttribute('data-theme', 'light');
        await expect(toggle).toHaveAttribute('data-mode', 'light');

        // 明示した設定は再読み込みしても残る(ちらつかないようハイドレーション前に当てている)
        await goto(page, '/guide');
        await expect(html).toHaveAttribute('data-theme', 'light');
        await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-mode', 'light');

        // 端末に合わせる。テストはダークの端末として動かしている。これも選んだ印として残る
        await page.getByTestId('theme-toggle').click();
        await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-mode', 'system');
        await expect(html).toHaveAttribute('data-theme', 'dark');
        await goto(page, '/');
        await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-mode', 'system');

        // 一周してダークへ戻る
        await page.getByTestId('theme-toggle').click();
        await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-mode', 'dark');
    });

    /**
     * **待ち時間は押したボタンの上に出す。** 画面上端のバーは画面遷移専用
     * (`actions.ts` の `submitting`)。
     *
     * **幅が変わらない**ことも一緒に見る。Pico の `aria-busy` は回るものを文字の
     * 前に足すのでボタンが横に伸び、行に並んだボタンが隣ごとずれる (`app.scss`)
     */
    test('アクション中は押したボタンで回し、ボタンを押せなくする', async ({ page }) => {
        await goto(page, '/');

        // 照合は録画の数だけファイルを見に行くので実機では数秒かかる。
        // その間に二度押しできないことを確かめたいので遅らせる
        await page.route('**/?/reconcile', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await route.continue();
        });

        const button = page.getByTestId('reconcile-button');
        const before = await button.boundingBox();
        await button.click();

        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute('aria-busy', 'true');
        expect((await button.boundingBox())?.width).toBeCloseTo(before?.width ?? 0, 1);

        await expect(page.getByTestId('reconcile-result')).toBeVisible();
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveAttribute('aria-busy', 'true');

        /*
         * 知らせは右下に浮いていて、自分で閉じられる。
         * 本文の上に差し込んでいた頃は、出た分だけ表が下へずれていた
         */
        await page.getByTestId('reconcile-result-close').click();
        await expect(page.getByTestId('reconcile-result')).toHaveCount(0);
    });

    /**
     * **読み直しは、走っている遷移を畳んでしまう。**
     *
     * SvelteKit は遷移にも `invalidateAll` にも同じ札を使っていて、後から来た
     * 読み直しが札を書き換えると、行き先を読み終えた遷移はそこで黙って降りる。
     * **押した先へ行かない** — 番組表を押したのにダッシュボードのまま、になる
     * (実機で「削除したあと画面が変わらないことがある」として出た。観る画面の
     * 削除は一覧へ戻る遷移を伴う)。
     *
     * 知らせは録画が動いていれば勝手に飛んでくるので、重なるかどうかは運。
     * ここでは行き先の読み込みを遅らせて窓を作り、その間に知らせを飛ばす
     * (`reconcile` は `emit('recordings')` する)
     */
    test('遷移中に知らせが来ても、押した先へ着く', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/');

        await page.route('**/guide/__data.json*', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            await route.continue();
        });

        await page.getByTestId('nav-guide').click();
        await request.post('/?/reconcile', { form: {} });

        // 畳まれていなければ番組表に着く
        await expect(page).toHaveURL(/\/guide/);
        await expect(page.getByTestId('guide-grid')).toBeVisible();
    });

    /**
     * **持ち越した読み直しは、遷移が終わったら流れる。**
     *
     * 遷移に重ねないよう持ち越す以上、流し忘れたら知らせが一度死ぬ。
     * 遷移の終わりを `navigating` で見ていると**畳まれた遷移で真のまま残る**ので
     * 流れない。その遷移が持っている `complete` を見ているのはこのため
     * ([reload.svelte.ts](../../src/lib/reload.svelte.ts))。
     *
     * 番組表は知らせを聞いていない画面なので、2回目の読み込みが来たならそれは
     * **持ち越しが流れた証拠**にしかならない。
     *
     * **サービスワーカーは止める。** 動いていると2回目から先の取得があちら経由に
     * なり、`page.route` に入ってこないので数えられない (実測: 1回しか数えられず、
     * 素通りしているのに落ちる)
     */
    test.describe('持ち越した読み直し', () => {
        test.use({ serviceWorkers: 'block' });

        test('遷移中に来た知らせは、着いてから読み直される', async ({ page, request }) => {
            await syncEpg(request);
            await goto(page, '/');

            let loads = 0;
            await page.route('**/guide/__data.json*', async (route) => {
                // 前日・翌日の先読みは数に入れない (`type` が付く)。数えたいのは
                // 「いま出している番組表そのもの」の読み込み
                if (!route.request().url().includes('type=')) loads++;
                // 1回目だけ遅らせて、知らせが遷移に重なる窓を作る
                if (loads === 1) await new Promise((resolve) => setTimeout(resolve, 3000));
                await route.continue();
            });

            await page.getByTestId('nav-guide').click();
            await request.post('/?/reconcile', { form: {} });

            await expect(page).toHaveURL(/\/guide/);
            await expect(page.getByTestId('guide-grid')).toBeVisible();
            // 着いたあとに、持ち越した読み直しが流れる
            await expect.poll(() => loads).toBeGreaterThanOrEqual(2);
        });
    });

    test('サーバ側の変化が通知で届く', async ({ page }) => {
        await goto(page, '/');

        // 受け取ったイベントを溜める。ポーリングではなく push で届くことを確かめる
        await page.evaluate(() => {
            const seen: string[] = [];
            (window as unknown as { seen: string[] }).seen = seen;
            const source = new EventSource('/api/events');
            for (const name of ['recordings', 'reservations', 'live']) {
                source.addEventListener(name, () => seen.push(name));
            }
        });

        // 実体と照合すると recordings が飛ぶ
        await page.getByTestId('reconcile-button').click();

        await expect
            .poll(async () => await page.evaluate(() => (window as unknown as { seen: string[] }).seen))
            .toContain('recordings');
    });

    test('番組表の検索窓はルール画面で結果を出し、そのままルールにできる', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/guide');

        // 条件を書く場所は1箇所。番組表からはキーワードを渡すだけ
        await page.getByTestId('filter-keyword').fill('テストアニメ');
        await page.getByRole('button', { name: '検索' }).click();
        await page.waitForURL(/\/rules\?/);

        await expect(page.getByTestId('preview')).toContainText('録れる番組は');
        const rows = page.getByTestId('preview-row');
        await expect(rows.first()).toBeVisible();
        for (const row of await rows.all()) {
            await expect(row).toContainText('テストアニメ');
        }

        // 種別で絞り込める(ルールの条件そのもの)
        await page.getByTestId('channel-summary').click();
        await page.getByTestId('rule-types').locator('input[value="BS"]').check();
        await page.getByTestId('rule-preview').click();
        await page.waitForURL(/serviceTypes=BS/);
        for (const row of await page.getByTestId('preview-row').all()) {
            await expect(row).toContainText('BS11イレブン');
        }

        // そのまま保存できる
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row').first()).toContainText('テストアニメ');

        await page.getByTestId('rule-row').first().getByTestId('rule-delete').click();
        await expect(page.getByTestId('rule-row')).toHaveCount(0);
        await cancelAllReservations(page);
    });

    /*
     * **新しい版が出ていたら、ヘッダーで知らせる。** サーバが GitHub の最新の
     * リリースを見比べる (`server/update.ts`。ここでは偽通知先が GitHub の代わり)。
     * 出ること・押せばリリースのページなこと・**リリースが消えれば引っ込むこと**を見る。
     * 動いている版は v1.0.0 (tests/stack.ts)、見比べは 1 秒おき
     */
    test('新しい版が出ていればヘッダーに出て、リリースが消えれば引っ込む', async ({
        page,
        request,
        stack,
    }) => {
        const release = (body: unknown) =>
            fetch(`${stack.webhookUrl}/__control/release`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        const badge = page.getByTestId('update-available');
        // 動いている版は環境変数から (tests/stack.ts)。外からも読める
        expect((await (await request.get('/api/health')).json()).version).toBe('v1.0.0');
        try {
            await release({
                tag_name: 'v9.9.9',
                html_url: 'https://github.com/danything/denpa/releases/tag/v9.9.9',
            });
            // サーバが気付く (1 秒おき)。外からは /api/health で見える
            await expect
                .poll(async () => (await (await request.get('/api/health')).json()).update?.version, {
                    timeout: 15_000,
                })
                .toBe('v9.9.9');
            await goto(page, '/');
            await expect(badge).toContainText('v9.9.9');
            await expect(badge).toHaveAttribute('href', /releases\/tag\/v9\.9\.9$/);

            // 最新が古い版になった (新しいほうのリリースを消した) → 引っ込む
            await release({
                tag_name: 'v0.9.0',
                html_url: 'https://github.com/danything/denpa/releases/tag/v0.9.0',
            });
            await expect
                .poll(async () => (await (await request.get('/api/health')).json()).update, {
                    timeout: 15_000,
                })
                .toBeNull();
            await goto(page, '/');
            await expect(badge).toHaveCount(0);
        } finally {
            // 置きっぱなしにしない。他の試験はヘッダーの幅を測る
            await release(null);
        }
    });
});
