import type { Locator, Page } from '@playwright/test';
import { expect, goto, makeRule, syncEpg, test } from './helpers';

/**
 * **リンクと、リンクのように字で見せるボタンは、指を乗せても読める。** 字の色と、その下に実際に
 * 見えている地の色を計算値から採り、コントラストが 4.5:1 以上あるかを、乗せる前と後の両方で確かめる。
 * 地は祖先の背景を下から重ねて求める (行の地・ガラスの面のような半透明も混ぜる)。
 *
 * 字で見せるボタンは「確かめ直す」「詳しく」(`.text-button`)・説明の ⓘ (`Lead`)・検索の「もっと見る」(`.link-button`)。
 * ボタンの規則は `--pico-color` を主のボタンの字 (= 地の色) にするので、乗せたときにそれを指すと字が消えていた。
 * ボタンの形のもの (`a.button`・ふつうのボタン) は `45-buttons` が見る
 */
const MIN = 4.5;
const TEXTLIKE = [
    'a[href]:not(.button):not([role="button"])',
    'button:is(.text-button, .link-button)',
    '.lead button.info',
].join(', ');

interface Seen {
    text: string;
    color: string;
    background: string;
    ratio: number;
}

/** 字の色と、その下に見えている地の色。どちらも不透明の rgb に直してから比べる */
async function contrastOf(link: Locator): Promise<Seen> {
    return await link.evaluate((el) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        const rgba = (css: string): [number, number, number, number] => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = '#000';
            ctx.fillStyle = css;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return [r!, g!, b!, a! / 255];
        };
        const over = (top: [number, number, number, number], under: [number, number, number]) =>
            [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as [number, number, number];
        // 地は根から順に重ねる。いちばん下は白 (ブラウザの既定の地)
        const chain: Element[] = [];
        for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
        let ground: [number, number, number] = [255, 255, 255];
        for (const e of chain) ground = over(rgba(getComputedStyle(e).backgroundColor), ground);
        const text = over(rgba(getComputedStyle(el).color), ground);
        const lum = ([r, g, b]: [number, number, number]) => {
            const ch = (v: number) => {
                const s = v / 255;
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
        };
        const [hi, lo] = [lum(text), lum(ground)].sort((a, b) => b - a) as [number, number];
        const css = (c: number[]) => `rgb(${c.map(Math.round).join(', ')})`;
        return {
            text: (el.textContent ?? '').trim().slice(0, 20),
            color: css(text),
            background: css(ground),
            ratio: (hi + 0.05) / (lo + 0.05),
        };
    });
}

/** 画面に見えている字のリンク・字で見せるボタンに1つずつ指を乗せ、乗せる前と後のコントラストを確かめる */
async function hoverAll(page: Page, scope: Locator, where: string): Promise<number> {
    const links = scope.locator(TEXTLIKE);
    let checked = 0;
    for (const link of await links.all()) {
        // 同じ形のリンクが何十も並ぶ (ホームの行) ので、見えている頭の 12 本まで
        if (checked >= 12) break;
        if (!(await link.isVisible())) continue;
        await page.mouse.move(0, 0);
        const before = await contrastOf(link);
        await link.hover();
        // 色は動いて変わる (Pico の transition)。動き終わるまで待つ
        await expect.poll(async () => await link.evaluate((el) => el.getAnimations().length)).toBe(0);
        const after = await contrastOf(link);
        expect(
            before.ratio,
            `${where}「${before.text}」 ${before.color} / ${before.background}`,
        ).toBeGreaterThanOrEqual(MIN);
        expect(
            after.ratio,
            `${where}「${after.text}」に乗せた ${after.color} / ${after.background}`,
        ).toBeGreaterThanOrEqual(MIN);
        checked++;
    }
    return checked;
}

for (const theme of ['dark', 'light'] as const) {
    test.describe(`字のリンクの色 (${theme})`, () => {
        test.use({ reducedMotion: 'no-preference' });

        test('指を乗せても、地に対して 4.5:1 以上', async ({ page, request }) => {
            await syncEpg(request);
            await makeRule(page, 'ニュース');
            await page.addInitScript((t) => localStorage.setItem('theme', t), theme);

            let total = 0;
            // ホームの行のルール名・設定の説明と ⓘ・検索の説明と「もっと見る」・ルールの一覧
            for (const url of [
                '/',
                '/settings/general',
                '/settings/recording',
                `/search?q=${encodeURIComponent('ニュース')}`,
                '/rules',
            ]) {
                await goto(page, url);
                expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe(theme);
                total += await hoverAll(page, page.locator('main'), url);
            }
            // エンコードの GPU の行の「確かめ直す」は名指しでも見る (乗せると字が地の色になって消えていた)
            await goto(page, '/settings/recording');
            await expect(page.getByTestId('hw-probe')).toBeVisible();
            expect(
                await hoverAll(page, page.getByTestId('hw-probe').locator('..'), '確かめ直す'),
            ).toBeGreaterThan(0);
            // 番組表の詳細 (浮かぶ箱)
            await goto(page, '/guide?type=GR');
            await page.getByTestId('program-button').first().click();
            const detail = page.getByTestId('program-detail');
            await expect(detail).toBeVisible();
            total += await hoverAll(page, detail, '番組の詳細');

            // ホームの行のルール名と検索の「設定」は必ず見ている
            expect(total).toBeGreaterThan(2);
        });
    });
}
