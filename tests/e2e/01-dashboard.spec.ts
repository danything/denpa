import { cancelAllReservations, deleteRule, expect, goto, syncEpg, test } from './helpers';

test.describe('ダッシュボードと画面遷移', () => {
    test('データ放送のチャンネルは取り込まない', async ({ page, request }) => {
        await syncEpg(request);
        await goto(page, '/guide?type=GR');
        // 映像が入っていないので録っても中身が無い。番組表に出るとルールが引っかけて
        // 録画が失敗する
        await expect(page.locator('[data-testid="guide-grid"]')).not.toContainText('ＭＸデータ');
    });

    test('EPG取得後に局・番組が反映され、全ページを開ける', async ({ page, request }) => {
        await syncEpg(request);

        /*
         * 取り込めたかどうかは**表そのもの**で見る (件数のバッジは出していない —
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
         * **見出しは置いていない。** どの画面にいるかはナビの塗りとタブの名前で
         * 分かるので、同じ言葉をもう一度大きく出す意味が無かった。
         * ここで確かめるのもその2つ (`+layout.svelte` の `title`)
         */
        for (const [name, title] of [
            ['nav-guide', '番組表 - denpa'],
            ['nav-rules', 'ルール - denpa'],
            // 設定は広い画面では先頭のグループ (一般) が開き、グループの名前が前に付く
            ['nav-settings', '一般 - 設定 - denpa'],
            ['nav-home', '録画 - denpa'],
        ] as const) {
            await page.getByTestId(name).click();
            await expect(page).toHaveTitle(title);
            await expect(page.getByTestId(name)).toHaveAttribute('aria-current', 'page');
        }
    });

    /*
     * **設定は左にグループと節の一覧、右にグループの画面** (ルールと同じ一覧と詳細の形)。
     * グループごとに URL があり、節はその画面に積んで `#<節>` で飛ぶ。見えている節が一覧で塗られる。
     * 狭い画面では一覧 (グループだけ) を先に出し、押すと画面と「← 設定」・節へ飛ぶ行
     */
    test('設定はグループごとに開き、節へ飛べる。狭い画面では一覧から入る', async ({ page }) => {
        await goto(page, '/settings');
        // 広い画面では先頭のグループへ移る
        await page.waitForURL(/\/settings\/general$/);
        const nav = page.getByTestId('settings-nav');
        await expect(nav.getByTestId('settings-nav-general')).toHaveAttribute('aria-current', 'page');
        await expect(page.getByTestId('settings-back')).toBeHidden();
        // 素通しの一式なので、ログアウトの代わりにその旨の1行
        await expect(page.getByTestId('login-none')).toBeVisible();

        // 別のグループの節を押すと、その画面のその節へ
        await nav.getByTestId('settings-nav-channels').click();
        await page.waitForURL(/\/settings\/reception#channels$/);
        await expect(page.getByTestId('channel-card')).toBeInViewport();
        await expect(page).toHaveTitle('受信 - 設定 - denpa');
        await expect(nav.getByTestId('settings-nav-reception')).toHaveAttribute('aria-current', 'page');
        await expect(nav.getByTestId('settings-nav-channels')).toHaveAttribute('aria-current', 'location');

        // 同じ画面の中の節へ。見えている節の塗りも移る
        await nav.getByTestId('settings-nav-broadcast').click();
        await page.waitForURL(/\/settings\/reception#broadcast$/);
        await expect(page.getByTestId('postal-code')).toBeInViewport();
        await expect(nav.getByTestId('settings-nav-broadcast')).toHaveAttribute('aria-current', 'location');
        await expect(nav.getByTestId('settings-nav-channels')).not.toHaveAttribute(
            'aria-current',
            'location',
        );

        // 前の節ごとの画面と、前のチューナーの画面は、グループの画面のその節へずっと送る
        const moved = await page.request.get('/settings/logos', { maxRedirects: 0 });
        expect(moved.status()).toBe(308);
        expect(moved.headers()['location']).toBe('../settings/reception#logos');
        const old = await page.request.get('/tuners', { maxRedirects: 0 });
        expect(old.status()).toBe(308);
        await goto(page, '/tuners');
        await page.waitForURL(/\/settings\/reception#tuners$/);
        await expect(page.getByTestId('nav-tuners')).toHaveCount(0);
        await expect(page.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page');
        for (const path of ['/settings/nothing', '/settings/constructor']) {
            expect((await page.request.get(path, { maxRedirects: 0 })).status(), path).toBe(404);
        }

        await page.setViewportSize({ width: 390, height: 844 });
        await goto(page, '/settings');
        await expect(page.getByTestId('settings-nav')).toBeVisible();
        // 狭い画面の一覧はグループだけ
        await expect(page.getByTestId('settings-nav-tuners')).toBeHidden();
        await page.getByTestId('settings-nav-reception').click();
        await page.waitForURL(/\/settings\/reception$/);
        await expect(page.getByTestId('settings-nav')).toBeHidden();
        await expect(page.getByTestId('tuner-card')).toBeVisible();
        // 上の行から節へ飛ぶ。行は巻いてもヘッダーの下に残る
        await page.getByTestId('settings-jump-logos').click();
        await page.waitForURL(/\/settings\/reception#logos$/);
        await expect(page.getByTestId('logo-card')).toBeInViewport();
        await expect(page.getByTestId('settings-jump')).toBeInViewport();
        await page.getByTestId('settings-back').click();
        await page.waitForURL(/\/settings$/);
        await expect(page.getByTestId('settings-nav')).toBeVisible();
        await expect(page.getByTestId('tab-settings')).toHaveAttribute('aria-current', 'page');
    });

    test('地上波の局があれば、局が無いときの案内は出さない', async ({ page, request }) => {
        await syncEpg(request);
        for (const path of ['/', '/guide', '/live']) {
            await goto(page, path);
            await expect(page.getByTestId('channel-notice'), path).toHaveCount(0);
        }
    });

    test('設定のチューナーにカードリーダーの状態が出る', async ({ page }) => {
        await goto(page, '/settings/reception');
        /*
         * **「チューナーの空き」に並べてある。** 同じ機材の話なので、
         * わざわざ別の枠を作って見るところを増やさない
         * (エージェントの死活も、繋がらなければその枠に理由が出る)
         */
        const card = page.getByTestId('tuner-card');
        // 相手待ちなので後から流れてくる
        await expect(card.getByTestId('status-card-reader')).toHaveText('正常');
        /*
         * **リーダーごとに1行。** 使うのは1枚だけで、残りは予備。
         * チューナーは使用中の行にだけ並ぶ。読めているときは一言を出さない
         * (名前と番号を表と二重に出していた)
         */
        const rows = card.getByTestId('card-reader-row');
        await expect(rows).toHaveCount(2);
        /*
         * 挿さっている場所 (括弧の中) は名前と分けて2行目に出す。1行に詰めていた頃は
         * 狭い列で文字の途中から1文字ずつ折れて読めなかった
         */
        await expect(rows.nth(0).getByTestId('card-reader-name')).toHaveText('Fake Card Reader');
        await expect(rows.nth(0).getByTestId('card-reader-where')).toHaveText('usb 1-1');
        // 名前は1行に収まる (行の箱が1つ)。潰されて折れていないこと
        expect(
            await rows
                .nth(0)
                .getByTestId('card-reader-name')
                .evaluate((el) => el.getClientRects().length),
        ).toBe(1);
        await expect(rows.nth(0)).toContainText('0000000000000000');
        await expect(rows.nth(0)).toContainText('使用中');
        await expect(rows.nth(0)).toContainText('Fake-T1');
        await expect(rows.nth(1).getByTestId('card-reader-name')).toHaveText('Spare Card Reader');
        await expect(rows.nth(1).getByTestId('card-reader-where')).toHaveText('usb 1-2');
        await expect(rows.nth(1)).toContainText('予備');
        await expect(card.getByTestId('card-message')).toHaveCount(0);
        await expect(card.getByText('Fake Card Reader')).toHaveCount(1);
    });

    /**
     * **外枠は表を待たずに出す** (`+page.server.ts` の `gridOf`)。
     *
     * 種別のタブ・日送り・検索窓は URL だけで描けるのに、いちばん重い表を待って
     * いたせいで画面ごと出てこなかった。表だけ後から流すので、最初に届く HTML
     * には**外枠と骨組みが入っていて、番組はまだ入っていない**。
     *
     * ここを HTML で見るのは、**速さに左右されないため**。描き終わりを目で
     * 追うと、中身の少ない試験用の番組表では一瞬で埋まってしまう
     */
    test('番組表は外枠を先に返し、表のところだけ読み込み中にする', async ({ request }) => {
        const res = await request.get('/guide');
        expect(res.ok()).toBe(true);
        const html = await res.text();
        // 外枠 (種別タブ・日送り・検索窓) は最初の HTML に入っている
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
         * **見えているところにいること**だけを見る。**位置は決め打てない。**
         *
         * 置きたいのは画面の4分の1あたりだが、番組表は 4:00 から翌 4:00 までの
         * 範囲なので、**端では寄せきれない**:
         *
         *     4時台   … 「いま」がもともと上にあり、頭に貼り付く (offset ≒ 0)
         *     深夜1時 … 下端まで送られていて、それ以上は上がらない (offset が下へ寄る)
         *
         * どちらも正しい動きなので、**画面の中にあれば通す**。ここを
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
     * 前に足すのでボタンが横に伸び、行に並んだボタンが隣ごとずれる (`app.css`)
     */
    test('アクション中は押したボタンで回し、ボタンを押せなくする', async ({ page }) => {
        await goto(page, '/');

        // 照合は録画の数だけファイルを見に行くので実機では数秒かかる。
        // その間に二度押しできないことを確かめたいので遅らせる
        await page.route('**/?/reconcile', async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await route.continue();
        });

        // 照合はたまにしか押さないので「⋯」の中。送り終わるまでメニューは開いたまま
        await page.getByTestId('recordings-more').click();
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
         * 通知は右下に浮いていて、自分で閉じられる。
         * 本文の上に差し込んでいた頃は、出た分だけ表が下へずれていた
         */
        await page.getByTestId('reconcile-result-close').click();
        await expect(page.getByTestId('reconcile-result')).toHaveCount(0);
    });

    test('狭い幅では録画の見出しを1行に保ち、照合は「⋯」から押せる', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await goto(page, '/');

        /*
         * 並べていた頃は「ファイルと照合」が2行目に落ちていた。たまにしか押さない
         * ものは「⋯」に畳み、見出し・絞り込み・「⋯」が同じ行に並ぶ
         */
        const more = page.getByTestId('recordings-more');
        await expect(page.getByTestId('reconcile-button')).toBeHidden();
        await expect(more).toBeVisible();
        const heading = (await page.locator('.recordings h2').boundingBox())!;
        const trigger = (await more.boundingBox())!;
        expect(Math.abs(heading.y + heading.height / 2 - (trigger.y + trigger.height / 2))).toBeLessThan(
            trigger.height / 2,
        );

        await more.click();
        const menu = page.getByTestId('recordings-more-menu');
        await expect(menu).toBeVisible();
        /*
         * **下の行が透けて見えない** (#481)。iOS の Safari では包みの z-index が
         * `auto` のまま残り、後に続く録画の行が上に重なっていた。いまは popover で
         * 最前面 (top layer) に出す。塗りが不透明であることと、真ん中を指したとき
         * メニュー自身が当たる (ほかのものが上に重なっていない) ことを見る
         */
        const layer = await menu.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return {
                background: getComputedStyle(el).backgroundColor,
                top: el.matches(':popover-open'),
                front: hit !== null && el.contains(hit),
            };
        });
        expect(layer.background).toMatch(/^rgb\(/);
        expect(layer.top).toBe(true);
        expect(layer.front).toBe(true);
        await menu.getByTestId('reconcile-button').click();
        await expect(page.getByTestId('reconcile-result')).toBeVisible();
        // 送り終えたら閉じる
        await expect(menu).toBeHidden();
    });

    /*
     * **メニューはキーボードでも使える** (`Menu.svelte`)。Enter で開くと先頭の項目に入り、
     * ↑↓・Home・End で動き、Esc で閉じて引き金に戻る
     */
    test('「表示」はキーボードで開け閉めできる', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await goto(page, '/');
        const more = page.getByTestId('recordings-view');
        const menu = page.getByTestId('recordings-view-menu');
        await expect(more).toHaveAttribute('aria-expanded', 'false');

        await more.focus();
        await page.keyboard.press('Enter');
        await expect(menu).toBeVisible();
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        // 項目はオン・オフの印付き (まとめて表示・削除済みも表示)
        const items = menu.getByRole('menuitemcheckbox');
        await expect(items.first()).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(items.nth(1)).toBeFocused();
        await page.keyboard.press('Home');
        await expect(items.first()).toBeFocused();
        await page.keyboard.press('End');
        await expect(items.last()).toBeFocused();

        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(more).toBeFocused();
        await expect(more).toHaveAttribute('aria-expanded', 'false');

        // ↑ で開くと末尾から
        await page.keyboard.press('ArrowUp');
        await expect(menu).toBeVisible();
        await expect(items.last()).toBeFocused();
        // 外を押せば閉じる
        await page.locator('.recordings h2').click();
        await expect(menu).toBeHidden();
    });

    /**
     * **読み直しは、走っている遷移を畳んでしまう。**
     *
     * SvelteKit は遷移にも `invalidateAll` にも同じトークンを使っていて、後から来た
     * 読み直しがトークンを書き換えると、行き先を読み終えた遷移はそこで黙って降りる。
     * **押した先へ行かない** — 番組表を押したのにダッシュボードのまま、になる
     * (実機で「削除したあと画面が変わらないことがある」として出た。観る画面の
     * 削除は一覧へ戻る遷移を伴う)。
     *
     * 通知は録画が動いていれば勝手に飛んでくるので、重なるかどうかは運。
     * ここでは行き先の読み込みを遅らせて窓を作り、その間に通知を飛ばす
     * (`reconcile` は `emit('recordings')` する)
     */
    test('遷移中に通知が来ても、押した先へ着く', async ({ page, request }) => {
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
     * 遷移に重ねないよう持ち越す以上、流し忘れたら通知が一度死ぬ。
     * 遷移の終わりを `navigating` で見ていると**畳まれた遷移で真のまま残る**ので
     * 流れない。その遷移が持っている `complete` を見ているのはこのため
     * ([reload.svelte.ts](../../src/lib/reload.svelte.ts))。
     *
     * 番組表は通知を聞いていない画面なので、2回目の読み込みが来たならそれは
     * **持ち越しが流れた証拠**にしかならない。
     *
     * **サービスワーカーは止める。** 動いていると2回目から先の取得があちら経由に
     * なり、`page.route` に入ってこないので数えられない (実測: 1回しか数えられず、
     * 素通りしているのに落ちる)
     */
    test.describe('持ち越した読み直し', () => {
        test.use({ serviceWorkers: 'block' });

        test('遷移中に来た通知は、着いてから読み直される', async ({ page, request }) => {
            await syncEpg(request);
            await goto(page, '/');

            let loads = 0;
            await page.route('**/guide/__data.json*', async (route) => {
                // 前日・翌日の先読みは数に入れない (`type` が付く)。数えたいのは
                // 「いま出している番組表そのもの」の読み込み
                if (!route.request().url().includes('type=')) loads++;
                // 1回目だけ遅らせて、通知が遷移に重なる窓を作る
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
        await page.getByTestId('recordings-more').click();
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
        // 押すものは無く、そのまま数え直す。BS 以外の行が消えるのを待つ
        await expect(rows.filter({ hasNotText: 'ＢＳ１１イレブン' })).toHaveCount(0);
        await expect(rows.first()).toBeVisible();

        // そのまま保存できる
        await page.getByTestId('rule-submit').click();
        await expect(page.getByTestId('rule-row').first()).toContainText('テストアニメ');

        await deleteRule(page, page.getByTestId('rule-row').first());
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
