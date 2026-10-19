import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { MX } from '../fake/services';
import {
    CAPTION_SCREENS,
    captureSockets,
    expect,
    expectSharpCaptions,
    expectSideAligned,
    feedCaption,
    goto,
    holdCaptions,
    leaveFullscreen,
    oneRowTroubles,
    syncEpg,
    test,
    wakeControls,
} from './helpers';

/**
 * 追っかけ再生の入口 (issue #16 の続き)。
 *
 * **追っかけは録っている最中だけ。** 録り終えたら、エンコードを待っている間も観る画面 (`/watch`) で
 * 観る (サーバが元の TS をその場で変換して流す。22-watch・39-watch-stream)。ここでは地上波の
 * いまの番組 (偽番組は30分) を録りはじめて、録っている最中に追っかけを開き、止めてエンコードが終わったら
 * 観る画面へ案内されるところまでを見る
 */

/** いま放送中の番組 (`/api/services` の `now.id`)。録画を止めるのに使う */
async function airingProgram(request: APIRequestContext): Promise<number> {
    const services = (await (await request.get('/api/services')).json()) as {
        id: number;
        now: { id: number } | null;
    }[];
    const now = services.find((s) => s.id === MX.id)?.now;
    expect(now, `${MX.name} にいま放送中の番組が要る`).toBeTruthy();
    return now!.id;
}

test.describe('追っかけ再生の入口', () => {
    test('録っている最中は追っかけで観られ、録り終えてエンコードが終わったら観る画面へ案内する', async ({
        browser,
        page,
        request,
    }) => {
        test.setTimeout(240_000);
        // 字幕を流す関数 (`feedCaption`)
        await captureSockets(page);
        await syncEpg(request);
        const programId = await airingProgram(request);
        // いまの番組を録る (ライブの録画ボタンと同じ API)
        expect((await request.post('/live?/record', { form: { service: String(MX.id) } })).ok()).toBe(true);
        let id = '';
        try {
            await expect(async () => {
                const list = (await (await request.get('/api/recordings')).json()) as {
                    id: number;
                    recording: boolean;
                }[];
                const rec = list.find((item) => item.recording);
                expect(rec).toBeDefined();
                id = String(rec!.id);
            }).toPass({ timeout: 60_000, intervals: [500] });

            // 録っている最中の観る画面は、追っかけへ送られる
            await goto(page, `/watch/${id}`);
            await expect(page).toHaveURL(new RegExp(`/chase/${id}$`));
            await expect(page.getByTestId('chase-title')).toBeVisible();
            // まだ録っているので、観る画面への案内は出ていない
            await expect(page.getByTestId('chase-encoded')).toHaveCount(0);
            await checkChase(page, browser, id);
        } finally {
            // 地上波の偽番組は30分あるので、止めないと次のテストまでチューナーを塞ぐ
            await request.post('/guide?/cancel', { form: { programId: String(programId) } });
        }

        // 録り終えてエンコードが終わると、追っかけの画面に案内が出る
        const notice = page.getByTestId('chase-encoded');
        await expect(notice).toBeVisible({ timeout: 90_000 });
        await notice.getByTestId('chase-to-watch').click();
        await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));

        // 録り終えた録画の追っかけを直接開くと、観る画面へ送られる
        await page.goto(`/chase/${id}`);
        await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));
    });
});

/** 追っかけの画面の作り (字幕の描き方・押し方・番組の中身)。録っている最中に見る */
async function checkChase(page: Page, browser: Browser, id: string): Promise<void> {
    // まだエンコードできていないので、観る画面への案内は出ていない
    await expect(page.getByTestId('chase-encoded')).toHaveCount(0);

    /*
     * **字幕は、見えている大きさ × 画面の画素で描く** (`CaptionPainter`。ライブと同じ係)。
     * 偽の放送に字幕は乗っていないので1枚流す。PC (DPR 1・2) とスマホの縦で
     */
    await holdCaptions(page, 'chase-captions');
    await feedCaption(page, 'chase');
    await expectSharpCaptions(page, '既定の画面');
    for (const [what, options] of CAPTION_SCREENS) {
        const context = await browser.newContext(options);
        const tab = await context.newPage();
        await captureSockets(tab);
        await goto(tab, `/chase/${id}`);
        await expect(tab.getByTestId('chase-title')).toBeAttached();
        await holdCaptions(tab, 'chase-captions');
        await feedCaption(tab, 'chase');
        await expectSharpCaptions(tab, what);
        await context.close();
    }

    /*
     * **スマホの縦 (360px・320px) でも、操作バーのボタンは1行** (観る画面・ライブと同じ)。
     * 残すのは再生・最新・読みもの・⚙・全画面だけで、畳んだ音は ⚙ の頭の行から押せる
     */
    for (const width of [360, 320]) {
        const context = await browser.newContext({
            viewport: { width, height: 780 },
            isMobile: true,
            hasTouch: true,
        });
        const tab = await context.newPage();
        await goto(tab, `/chase/${id}`);
        await expect(tab.getByTestId('chase-play')).toBeVisible();
        await leaveFullscreen(tab);
        await expect(tab.getByTestId('chase')).toHaveAttribute('data-narrow', '');

        expect(await oneRowTroubles(tab, 'chase-buttons'), `${width}px`).toEqual([]);
        await expect(tab.getByTestId('chase-edge')).toBeVisible();
        await expect(tab.getByTestId('chase-full')).toBeVisible();
        await tab.screenshot({ path: test.info().outputPath(`chase-${width}.png`) });

        // 畳んだ音は ⚙ の頭の「消音」の行。「ほか」(⋯) のボタンはもう無い
        const sound = tab.getByTestId('chase-sound');
        await expect(sound).toBeHidden();
        await expect(tab.getByTestId('chase-more')).toHaveCount(0);
        const label = (await sound.getAttribute('aria-label')) ?? '';
        await wakeControls(tab, 'chase');
        await tab.getByTestId('chase-settings').tap();
        const mute = tab.getByTestId('chase-mute');
        await expect(mute).toBeVisible();
        await expect(mute).toHaveAttribute('role', 'menuitemcheckbox');
        const muted = (await mute.getAttribute('aria-checked')) ?? '';
        await mute.tap();
        await expect(mute).not.toHaveAttribute('aria-checked', muted);
        await expect(sound).not.toHaveAttribute('aria-label', label);
        await tab.screenshot({ path: test.info().outputPath(`chase-${width}-more.png`) });

        // 閉じても1行のまま
        await tab.keyboard.press('Escape');
        await expect(tab.getByTestId('chase-settings-menu')).toBeHidden();
        expect(await oneRowTroubles(tab, 'chase-buttons'), `${width}px (閉じたあと)`).toEqual([]);
        await context.close();
    }

    /*
     * **押し方は観る画面と同じ** (`player/keys.ts` と `ts/watch.ts` の `tap`)。
     * エンコードする前だけ空白も画面内クリックも効かず、同じ録画なのに押し方が変わっていた。
     * 映像は出ない (偽 ffmpeg なので) が、止めた・動かしたはボタンの名前に出る
     */
    const play = page.getByTestId('chase-play');
    await expect(play).toHaveAttribute('aria-label', '一時停止');
    await page.keyboard.press('Space');
    await expect(play).toHaveAttribute('aria-label', '再生');
    // k でも同じ (観る画面と同じ割り当て)
    await page.keyboard.press('k');
    await expect(play).toHaveAttribute('aria-label', '一時停止');

    /*
     * 画面内クリックでも切り替わる。**押したときの処理が繋がっているかだけを見る** —
     * 偽 ffmpeg では映像が出ないので状態の幕 (`chase-status`) が映像を覆ったままで、
     * 本物のマウスの当たり判定はここでは通らない。押された位置の読み分け
     * (端2回で 10秒 など) は `ts/watch.ts` の試験が見ている
     */
    await page.getByTestId('chase-video').evaluate((el) => (el as HTMLElement).click());
    await expect(play).toHaveAttribute('aria-label', '再生');
    await page.keyboard.press('k');
    await expect(play).toHaveAttribute('aria-label', '一時停止');

    /*
     * **番組表に無い番組でも、ジャンルと音声のラベルは出る** (観る画面の 22 と同じ)。
     * 右の中身の種を組み直していた頃は、ここだけ行が持っている写しを落としていた。
     * 番組表から引き直すエンドポイントを 404 にして作る
     */
    await page.route('/api/programs/*', (route) => route.fulfill({ status: 404, body: '' }));
    // 開き直す (録っている最中なので追っかけのまま)
    await goto(page, `/chase/${id}`);
    const badges = page.getByTestId('chase-facts').getByTestId('detail-badges');
    // 映像の上端と右の列の最初のもの (番組名) の上端がそろう
    await expectSideAligned(
        page,
        '[data-testid="chase-video"]',
        '[data-testid="chase-facts"] > :first-child',
    );
    await expect(badges.getByTestId('detail-genre').first()).toHaveText('アニメ／特撮 > 国内アニメ');
    await expect(badges.getByTestId('detail-audio').first()).toBeVisible();
    await page.unroute('/api/programs/*');
}
