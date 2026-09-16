/**
 * README と docs の絵を**動いている denpa から撮る**。閲覧だけで、予約も削除も保存もしない。
 *
 *     ssh -N -L 3399:<denpa の ClusterIP>:3000 <ホスト>   # 手元から見えるところに繋ぐ
 *     bun scripts/capture-docs.ts                          # 全部撮る
 *     bun scripts/capture-docs.ts guide-bs live            # 名前を挙げると、そのぶんだけ
 *     python3 scripts/docs-webp.py                         # 動く絵を組み立てて docs/images へ
 *
 * **撮る条件はここに書いてある**(散らばると撮り直しのたびに絵の大きさが揃わない):
 * 1600×900 (20インチの画面と同じ 16:9)・暗いテーマ・ja-JP・Asia/Tokyo。
 * 動く絵も同じ広さで動かし、貼るときに 1120×630 まで縮める (組み立ての側)。
 *
 * 宛先は `BASE` (既定 http://localhost:3399)、置き場は `OUT` (既定 docs/images の隣の作業場)。
 * 本番は LAN (TRUSTED_NETWORKS) から来た人だけ素通しなので、x-forwarded-for に LAN の住所を付ける
 * (`XFF` で変えられる)。自分の値が入る欄と映像はぼかす (BLUR)。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://localhost:3399';
const OUT = process.env.OUT ?? 'docs/images/.capture';
const XFF = process.env.XFF ?? '10.10.0.99';
mkdirSync(OUT, { recursive: true });

// 自分の値の入る欄と、映像はぼかす
const BLUR = `
[data-testid="webhook-list"] .url, [data-testid="webhook-url"],
[data-testid="vlc-name"], [data-testid="vlc-ip"], [data-testid="postal-code"],
[data-testid="vlc-card"] .rows input { filter: blur(6px) !important; }
video, .media-stack canvas, [data-testid="live-video"], [data-testid="watch-video"] { filter: blur(16px) !important; }
`;

async function open(browser: Browser, width: number, height: number, scale: number): Promise<Page> {
    const ctx = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: scale,
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        colorScheme: 'dark',
        extraHTTPHeaders: { 'x-forwarded-for': XFF },
    });
    const page = await ctx.newPage();
    await page.addInitScript((css) => {
        localStorage.setItem('theme', 'dark');
        document.addEventListener('DOMContentLoaded', () => {
            const s = document.createElement('style');
            s.textContent = css;
            document.head.append(s);
        });
    }, BLUR);
    return page;
}

async function still(page: Page, name: string) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log('still', name);
}

/** 動かしながら撮る。fn の間ずっとコマを貯め、アニメ WebP にする */
async function anim(page: Page, name: string, fn: () => Promise<void>) {
    const frames: { buf: Buffer; t: number }[] = [];
    let running = true;
    const loop = (async () => {
        while (running) {
            frames.push({ buf: await page.screenshot({ type: 'png' }), t: Date.now() });
            await page.waitForTimeout(90);
        }
    })();
    await fn();
    running = false;
    await loop;
    // コマの間隔を実時間で。最後のコマは少し長く見せる。組み立ては Python (Pillow) で
    const dir = join(OUT, `${name}.frames`);
    mkdirSync(dir, { recursive: true });
    frames.forEach((f, i) => {
        writeFileSync(join(dir, `${String(i).padStart(4, '0')}.png`), f.buf);
    });
    const delays = frames.map((f, i) => (i + 1 < frames.length ? frames[i + 1]!.t - f.t : 1500));
    writeFileSync(join(dir, 'delays.json'), JSON.stringify(delays));
    console.log('anim', name, frames.length, 'frames');
}

async function slowScroll(page: Page, selector: string | null, steps = 40) {
    const total = await page.evaluate((sel) => {
        const el = sel ? document.querySelector(sel) : document.scrollingElement;
        return el ? el.scrollHeight - el.clientHeight : 0;
    }, selector);
    for (let i = 1; i <= steps; i++) {
        await page.evaluate(
            ([sel, y]) => {
                const el = sel ? document.querySelector(sel as string) : document.scrollingElement;
                el?.scrollTo({ top: y as number });
            },
            [selector, (total * i) / steps] as const,
        );
        await page.waitForTimeout(120);
    }
    await page.waitForTimeout(800);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const only = process.argv.slice(2);
const want = (n: string) => only.length === 0 || only.includes(n);

// 静止画 (1600×900。20インチの画面と同じ 16:9)
{
    const page = await open(browser, 1600, 900, 1);
    if (want('dashboard')) {
        await page.goto(`${BASE}/`);
        await still(page, 'dashboard');
    }
    if (want('guide-bs')) {
        await page.goto(`${BASE}/guide?type=BS`);
        await still(page, 'guide-bs');
    }
    if (want('watch')) {
        await page.goto(`${BASE}/`);
        const row = page.getByTestId('recording-row').first();
        const id = await row.getAttribute('data-recording-id');
        await page.goto(`${BASE}/watch/${id}`);
        await page.waitForTimeout(3000);
        await still(page, 'watch');
    }
    if (want('live')) {
        await page.goto(`${BASE}/live`);
        await page.waitForTimeout(8000);
        await still(page, 'live');
    }
    if (want('rules')) {
        await page.goto(`${BASE}/rules`);
        await still(page, 'rules');
    }
    await page.context().close();
}

// 動く絵 (静止画と同じ 1600×900 で動かす。貼るときの大きさは組み立てで縮める)
{
    const page = await open(browser, 1600, 900, 1);
    if (want('home-watch-anim')) {
        await page.goto(`${BASE}/`);
        await page.waitForTimeout(1500);
        await anim(page, 'home-watch-anim', async () => {
            await page.waitForTimeout(1200);
            const row = page.getByTestId('recording-row').first();
            await row.hover();
            await page.waitForTimeout(900);
            await row
                .locator('.row-name, [data-testid="recording-title"]')
                .first()
                .click({ timeout: 5000 })
                .catch(() => row.click());
            await page.waitForTimeout(6500);
        });
    }
    if (want('detail-anim')) {
        await page.goto(`${BASE}/`);
        await page.waitForTimeout(1500);
        await anim(page, 'detail-anim', async () => {
            await page.waitForTimeout(1000);
            await page.getByTestId('recording-row').first().getByRole('button', { name: '詳細' }).click();
            await page.waitForTimeout(2500);
            const more = page.getByTestId('program-detail').getByRole('button', { name: /その他/ });
            if (await more.count()) {
                await more.click();
                await page.waitForTimeout(2500);
                await page.keyboard.press('Escape');
                await page.waitForTimeout(800);
            }
            await page.getByTestId('detail-close').click();
            await page.waitForTimeout(1000);
        });
    }
    if (want('guide-anim')) {
        await page.goto(`${BASE}/guide?type=GR`);
        await page.waitForTimeout(2000);
        await anim(page, 'guide-anim', async () => {
            await page.waitForTimeout(1000);
            await page
                .getByTestId('guide-grid')
                .evaluate((el) => el.scrollBy({ top: 240, behavior: 'smooth' }));
            await page.waitForTimeout(1500);
            await page
                .getByTestId('guide-grid')
                .evaluate((el) => el.scrollBy({ left: 300, behavior: 'smooth' }));
            await page.waitForTimeout(1500);
            await page.getByTestId('program-button').nth(6).click();
            await page.waitForTimeout(3000);
            await page.getByTestId('detail-close').click();
            await page.waitForTimeout(1200);
        });
    }
    if (want('live-anim')) {
        await page.goto(`${BASE}/live`);
        await anim(page, 'live-anim', async () => {
            await page.waitForTimeout(9000);
        });
    }
    if (want('tuners-anim')) {
        await page.goto(`${BASE}/tuners`);
        await page.waitForTimeout(2000);
        await anim(page, 'tuners-anim', async () => {
            await page.waitForTimeout(1000);
            await slowScroll(page, null, 60);
        });
    }
    if (want('settings-anim')) {
        await page.goto(`${BASE}/settings`);
        await page.waitForTimeout(2000);
        await anim(page, 'settings-anim', async () => {
            await page.waitForTimeout(1000);
            await slowScroll(page, null, 50);
        });
    }
    await page.context().close();
}
await browser.close();
