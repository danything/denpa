import type { Locator } from '@playwright/test';
import { expect, goto, syncEpg, test } from './helpers';

/**
 * **ボタンの見た目は `app.css` のトークン (`--dp-btn-*`) だけで決まる。** 画面ごとの上書きが
 * 戻ってきて形や大きさがばらつかないように、代表の画面で確かめる。
 * 主は色を塗らない (字の色で塗る)・控えは枠を引かない・角は丸い (高さの半分)・
 * 指で押す端末では小さいボタンも 40px 以上・アイコンのボタンは円
 */
async function look(button: Locator) {
    return await button.evaluate((el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return {
            width: box.width,
            height: box.height,
            radius: Number.parseFloat(style.borderTopLeftRadius),
            background: style.backgroundColor,
            border: style.borderTopColor,
        };
    });
}

test.describe('ボタンの見た目', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('主は色を塗らず、控えは枠を引かない。角は高さの半分', async ({ page }) => {
        await goto(page, '/guide?type=GR');
        // 主の色 (azure) で塗っていない。主の色の計算値を同じ画面で採って比べる
        const primary = await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.style.backgroundColor = 'var(--pico-primary-background)';
            document.body.append(probe);
            const color = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return color;
        });
        const submit = await look(page.getByTestId('guide-filter').getByRole('button', { name: '検索' }));
        expect(submit.background).not.toBe(primary);

        const prev = await look(page.getByTestId('prev-day'));
        expect(prev.border).toBe('rgba(0, 0, 0, 0)');
        expect(prev.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(prev.radius).toBeGreaterThanOrEqual(prev.height / 2);
    });

    test.describe('指で押す端末', () => {
        test.use({ hasTouch: true, isMobile: true, viewport: { width: 1180, height: 820 } });

        test('小さいボタンも高さ 40px 以上、アイコンのボタンは円', async ({ page }) => {
            await goto(page, '/guide?type=GR');
            for (const id of ['prev-day', 'next-day', 'type-GR', 'type-BS']) {
                expect((await look(page.getByTestId(id))).height).toBeGreaterThanOrEqual(40);
            }
            const toggle = await look(page.getByTestId('theme-toggle'));
            expect(toggle.height).toBeGreaterThanOrEqual(40);
            expect(Math.abs(toggle.width - toggle.height)).toBeLessThan(1);
            expect(toggle.radius).toBeGreaterThanOrEqual(toggle.height / 2);
        });
    });
});
