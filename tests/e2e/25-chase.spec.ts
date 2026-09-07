import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { expect, goto, reserveSoon, syncEpg, test } from './helpers';

/**
 * 追っかけ再生の入口 (issue #16 の続き)。
 *
 * **焼き上がる前でも観られる。** 録っている最中はもちろん、録り終えて CM検出や
 * エンコードを待っている間も、生TSはあるので追っかけの器で頭から観られる。
 * 以前は焼き上がるまで録画の行が押せず、「観られるのに観られない」時間があった。
 *
 * 「焼けていない」状態は偽 ffmpeg を失敗させて作る (12 と同じ仕掛け)。録り終えて
 * 焼けていない、という点では CM検出中・エンコード中と同じ形。焼き上がる瞬間は、
 * 失敗を解いて焼き直させて作る
 */
test.describe('追っかけ再生の入口', () => {
    test.afterAll(({ stack }) => {
        if (existsSync(stack.failFile)) rmSync(stack.failFile);
    });

    test('焼き上がる前の行は追っかけへ行き、焼き上がったら観る画面へ案内する', async ({
        page,
        request,
        stack,
    }) => {
        test.setTimeout(180_000);
        await syncEpg(request);
        writeFileSync(stack.failFile, '1');
        const programId = await reserveSoon(page, request, 'BS');
        const row = page.locator(`[data-testid="recording-row"][data-program-id="${programId}"]`);

        // 録り終えて焼けていない (ここでは失敗させたので、状態は「エンコード失敗」)
        await expect(async () => {
            await goto(page, '/');
            await expect(row.getByTestId('recording-state')).toHaveText('エンコード失敗', { timeout: 1_000 });
        }).toPass({ timeout: 120_000, intervals: [500] });

        // **行が押せる** (再生の印が出る)。押すと追っかけの器
        await expect(row.getByTestId('play-hint')).toBeVisible();
        const id = await row.getAttribute('data-recording-id');
        await row.click();
        await expect(page).toHaveURL(new RegExp(`/chase/${id}$`));
        await expect(page.getByTestId('chase-title')).toBeVisible();
        // まだ焼けていないので、観る画面への案内は出ていない
        await expect(page.getByTestId('chase-encoded')).toHaveCount(0);

        /*
         * **押し方は観る画面と同じ** (`player/keys.ts` と `ts/watch.ts` の `tap`)。
         * 焼く前だけ空白も画面内クリックも効かず、同じ録画なのに押し方が変わっていた。
         * 絵は出ない (偽 ffmpeg なので) が、止めた・動かしたはボタンの名前に出る
         */
        const play = page.getByTestId('chase-play');
        await expect(play).toHaveAttribute('aria-label', '一時停止');
        await page.keyboard.press('Space');
        await expect(play).toHaveAttribute('aria-label', '再生');
        // k でも同じ (観る画面と同じ割り当て)
        await page.keyboard.press('k');
        await expect(play).toHaveAttribute('aria-label', '一時停止');

        /*
         * 画面内クリックでも切り替わる。**押す口が繋がっているかだけを見る** —
         * 偽 ffmpeg では絵が出ないので状態の幕 (`chase-status`) が絵を覆ったままで、
         * 本物のマウスの当たり判定はここでは通らない。押された位置の読み分け
         * (端2回で 10秒 など) は `ts/watch.ts` の試験が見ている
         */
        await page.getByTestId('chase-video').evaluate((el) => (el as HTMLElement).click());
        await expect(play).toHaveAttribute('aria-label', '再生');
        await page.keyboard.press('k');

        // 焼き直させる (失敗を解いてから)。焼き上がると、追っかけの画面に案内が出る
        rmSync(stack.failFile);
        const res = await request.post('/?/reencode', { form: { id: String(id) } });
        expect(res.ok()).toBe(true);
        const notice = page.getByTestId('chase-encoded');
        await expect(notice).toBeVisible({ timeout: 90_000 });
        await notice.getByTestId('chase-to-watch').click();
        await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));

        // 焼き上がったあとに追っかけを直接開くと、観る画面へ送られる
        await page.goto(`/chase/${id}`);
        await expect(page).toHaveURL(new RegExp(`/watch/${id}$`));
    });
});
