import type { Page } from '@playwright/test';
import { expect, goto, syncEpg, test, wakeControls } from './helpers';

/**
 * アンビエントモード (`AmbientGlow.svelte`)。映像の色を枠の周りへぼかして広げる。
 *
 * 映像が本当に出るのは MPEG-2 のまま見るライブだけ (偽 ffmpeg のエンコードしたものには中身が無い。
 * `28-live-raw`) なので、ここで見る。写した回数 (`data-updates`) が進むか・止まるかを見る —
 * 光の色そのものは、GPU の無いヘッドレスでも同じに出るが、比べる意味が薄い
 */

/** 画質の切り替えで MPEG-2 を選ぶ (`28-live-raw` と同じ) */
async function watchRaw(page: Page): Promise<void> {
    await goto(page, '/live');
    await page.getByTestId('live-channel').first().click();
    await expect(page.getByTestId('live-title')).toBeVisible();
    await wakeControls(page, 'live-frame');
    await page.getByTestId('live-codec').click();
    await page.locator('[data-testid="live-codec-option"][data-codec="mpeg2"]').click();
    await expect
        .poll(async () => Number((await page.getByTestId('live-raw').getAttribute('data-shown')) ?? 0), {
            timeout: 30_000,
        })
        .toBeGreaterThan(10);
}

/** 写した回数 */
function updates(page: Page): () => Promise<number> {
    return async () =>
        Number((await page.getByTestId('live-frame-ambient').getAttribute('data-updates')) ?? 0);
}

/** 操作バーのボタンを押す。畳んでいれば「ほか」(⋯) を開いてから */
async function press(page: Page, testid: string): Promise<void> {
    await wakeControls(page, 'live-frame');
    const more = page.getByTestId('live-more');
    if (await more.isVisible()) await more.click();
    await page.getByTestId(testid).click();
}

test.describe('アンビエントモード', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test.describe('動かしてよい端末', () => {
        test.use({ reducedMotion: 'no-preference' });

        test('既定はオンで、映像の色を写し続ける。止めたら写さず、オフにしたら消えて覚えている', async ({
            page,
        }) => {
            await watchRaw(page);
            const glow = page.getByTestId('live-frame-ambient');
            await expect(glow).toBeVisible();
            await expect(glow).toHaveAttribute('data-plan', 'watch');
            // 1秒に5回まで。数秒で何回も進む
            await expect.poll(updates(page), { timeout: 15_000 }).toBeGreaterThan(5);
            const before = await updates(page)();
            await expect.poll(updates(page), { timeout: 10_000 }).toBeGreaterThan(before + 5);
            // 光は枠の外 (帯) にだけ描く。枠に重なる帯は無い
            const stage = (await page.getByTestId('live-frame').boundingBox())!;
            for (const band of await glow.locator('.band:not([hidden])').all()) {
                const box = (await band.boundingBox())!;
                const overlaps =
                    box.x < stage.x + stage.width - 1 &&
                    box.x + box.width > stage.x + 1 &&
                    box.y < stage.y + stage.height - 1 &&
                    box.y + box.height > stage.y + 1;
                expect(overlaps, JSON.stringify({ box, stage })).toBe(false);
            }

            // 止めている間は写さない (光は残す)
            await press(page, 'live-play');
            await expect(glow).toHaveAttribute('data-plan', 'hold');
            const paused = await updates(page)();
            await page.waitForTimeout(1500);
            expect(await updates(page)()).toBe(paused);
            await expect(glow).toBeVisible();
            await press(page, 'live-play');
            await expect(glow).toHaveAttribute('data-plan', 'watch');

            // オフにすると消える。端末に覚えるので、開き直してもオフのまま
            await press(page, 'live-ambient');
            await expect(glow).toHaveAttribute('data-plan', 'off');
            await expect(glow).toBeHidden();
            await page.reload();
            await expect(page.getByTestId('live-frame-ambient')).toHaveAttribute('data-plan', 'off');
            expect(await page.evaluate(() => localStorage.getItem('player-ambient'))).toBe('0');
        });

        test('明るいテーマでは出さない', async ({ page }) => {
            await page.addInitScript(() => localStorage.setItem('theme', 'light'));
            await watchRaw(page);
            await expect(page.getByTestId('live-frame-ambient')).toHaveAttribute('data-plan', 'off');
            await expect(page.getByTestId('live-frame-ambient')).toBeHidden();
        });
    });

    // E2E の既定は動かさない設定 (`playwright.config.ts` の `reducedMotion: 'reduce'`)
    test('動かさない設定の端末では、1枚だけ写して止める', async ({ page }) => {
        await watchRaw(page);
        const glow = page.getByTestId('live-frame-ambient');
        await expect(glow).toHaveAttribute('data-plan', 'hold');
        await expect(glow).toHaveAttribute('data-updates', '1');
        await page.waitForTimeout(1500);
        await expect(glow).toHaveAttribute('data-updates', '1');
    });
});
