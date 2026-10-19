import type { Page } from '@playwright/test';
import { expect, flipSetting, goto, pickCodec, syncEpg, test, wakeControls } from './helpers';

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
    await pickCodec(page, 'live', 'mpeg2');
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

/** 操作バーのボタンを押す (畳まれないもの) */
async function press(page: Page, testid: string): Promise<void> {
    await wakeControls(page, 'live-frame');
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
            // 見出しと右の列は地の色と区切りの線を外し、窓全体に敷いた色の上に載る
            await expect(page.locator('html')).toHaveAttribute('data-ambient', '');
            const aside = await page.locator('[data-player-layout] > aside').evaluate((el) => ({
                position: getComputedStyle(el).position,
                image: getComputedStyle(el).backgroundImage,
            }));
            expect(aside).toEqual({ position: 'relative', image: 'none' });
            const surfaces = await page.evaluate(() => {
                const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
                const aside = style('[data-player-layout] > aside');
                const header = style('.navbar');
                return [
                    aside.backgroundColor,
                    aside.borderLeftWidth,
                    header.backgroundColor,
                    header.borderBottomColor,
                ];
            });
            expect(surfaces).toEqual(['rgba(0, 0, 0, 0)', '0px', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
            // 色は見出しの所 (窓の上の端) まで敷く
            expect((await glow.boundingBox())!.y).toBeLessThanOrEqual(0);
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
            await wakeControls(page, 'live-frame');
            await flipSetting(page, 'live', 'ambient');
            await expect(glow).toHaveAttribute('data-plan', 'off');
            await expect(glow).toBeHidden();
            await expect(page.locator('html')).not.toHaveAttribute('data-ambient');
            // オフでも区切りの線は出さない (色が出るまでの間に線がちらつかないように)
            const lines = await page.evaluate(() => [
                getComputedStyle(document.querySelector('[data-player-layout] > aside')!).borderLeftWidth,
                getComputedStyle(document.querySelector('.navbar')!).borderBottomColor,
            ]);
            expect(lines).toEqual(['0px', 'rgba(0, 0, 0, 0)']);
            await page.reload();
            await expect(page.getByTestId('live-frame-ambient')).toHaveAttribute('data-plan', 'off');
            expect(await page.evaluate(() => localStorage.getItem('player-ambient'))).toBe('0');
        });

        test('縦に積むと、映像の下の番組の中身に色を敷く', async ({ page }) => {
            // 選局と MPEG-2 の切り替えは広い画面で済ませ、それから縦に積む幅へ
            await watchRaw(page);
            await page.setViewportSize({ width: 390, height: 844 });
            const glow = page.getByTestId('live-frame-ambient');
            await expect(glow).toHaveAttribute('data-plan', 'watch');
            await expect.poll(updates(page), { timeout: 15_000 }).toBeGreaterThan(2);
            const stage = (await page.getByTestId('live-frame').boundingBox())!;
            const below = [];
            for (const band of await glow.locator('.band:not([hidden])').all()) {
                const box = (await band.boundingBox())!;
                if (box.y >= stage.y + (stage.width * 9) / 16 - 1) below.push(box);
            }
            // 映像の下の端から (操作バーの段の下にも)、画面の幅いっぱい・240px 以上
            expect(below[0]?.y).toBeLessThan(stage.y + stage.height - 1);
            expect(below).toHaveLength(1);
            expect(below[0]!.width).toBeGreaterThanOrEqual(389);
            expect(below[0]!.height).toBeGreaterThanOrEqual(240);
            // 操作バーの段は黒く塗らず、色が透ける
            expect(
                await page.getByTestId('live-frame').evaluate((el) => getComputedStyle(el).backgroundColor),
            ).toBe('rgba(0, 0, 0, 0)');
        });

        test('明るいテーマでも出し、帯は地に掛ける (multiply)', async ({ page }) => {
            await page.addInitScript(() => localStorage.setItem('theme', 'light'));
            await watchRaw(page);
            const glow = page.getByTestId('live-frame-ambient');
            await expect(glow).toHaveAttribute('data-plan', 'watch');
            await expect.poll(updates(page), { timeout: 15_000 }).toBeGreaterThan(3);
            const blend = await glow
                .locator('.band:not([hidden])')
                .first()
                .evaluate((el) => getComputedStyle(el).mixBlendMode);
            expect(blend).toBe('multiply');
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
