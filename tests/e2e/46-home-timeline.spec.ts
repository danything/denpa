import { spawnSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, goto, homeFilter, syncEpg, test } from './helpers';

/**
 * ホームの1本の一覧 (予約 → 「いま」→ 録れたもの) と、右のサイドバー・狭い画面の絞り込みの一枚。
 * 並べ方そのものは単体テスト (`#lib/timeline.test.ts`)。ここでは画面の上で効いているかを見る。
 *
 * 行は DB に直に入れる (33 と同じ)。予約は 2100 年、録画は 2099 年にして、
 * 同じワーカーの他のスペックが残したものと混ざっても見分けが付くようにする
 */
const DAY = 86_400_000;
const BASE = new Date(2099, 2, 1, 21, 0).getTime();
const FUTURE = new Date(2100, 2, 1, 21, 0).getTime();

function sqlite(db: string, script: string): void {
    const done = spawnSync(
        'bun',
        [
            '-e',
            `import { Database } from 'bun:sqlite'; const db = new Database(process.env.SEED_DB); db.exec('PRAGMA busy_timeout = 5000'); ${script}`,
        ],
        { env: { ...process.env, SEED_DB: db }, encoding: 'utf8' },
    );
    if (done.status !== 0) throw new Error(`DB に書けませんでした: ${done.stderr}`);
}

/** 一覧の行 (予約・録画・録り逃し) */
function rows(page: Page) {
    return page
        .getByTestId('timeline')
        .locator(
            '[data-testid="reservation-row"], [data-testid="recording-row"], [data-testid="missed-row"]',
        );
}

/** 頭の1行の絞り込みのチップに添えた件数 */
async function countOf(page: Page, id: string): Promise<number> {
    const text = await page
        .getByTestId('timeline-toolbar')
        .locator(`[data-testid="filter-chip"][data-filter="${id}"] [data-testid="filter-count"]`)
        .innerText();
    return Number(text.trim());
}

test.describe('ホームの1本の一覧', () => {
    test.beforeAll(async ({ playwright, stack }) => {
        // 予約は局が要る (一覧は局と突き合わせて出す)。番組表を集めて局を作っておく
        const request = await playwright.request.newContext({
            baseURL: stack.appUrl,
            extraHTTPHeaders: { Origin: stack.appUrl },
        });
        await syncEpg(request);
        await request.dispose();
        const now = Date.now();
        sqlite(
            `${stack.root}/denpa.db`,
            `
            db.run("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, created_at, updated_at) VALUES (980001, (SELECT id FROM services ORDER BY id LIMIT 1), '一覧試験の予約', ${FUTURE}, ${FUTURE + 1800000}, 1, 'scheduled', ${now}, ${now})");
            const rec = db.prepare('INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, error, watched_at, created_at, updated_at) VALUES (211, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now}, ${now})');
            rec.run('BS11', '一覧試験の未視聴', '一覧試験の未視聴', ${BASE}, ${BASE + 1800000}, ${BASE + 1800000}, '/media/encoded/seed/a.mkv', null, null);
            rec.run('BS11', '一覧試験の視聴済み', '一覧試験の視聴済み', ${BASE - DAY}, ${BASE - DAY + 1800000}, ${BASE - DAY + 1800000}, '/media/encoded/seed/b.mkv', null, ${now});
            rec.run('BS11', '一覧試験の失敗', '一覧試験の失敗', ${BASE - 2 * DAY}, ${BASE - 2 * DAY + 1800000}, ${BASE - 2 * DAY + 1800000}, null, 'チューナーが見つかりませんでした', null);
            `,
        );
    });
    test.afterAll(({ stack }) => {
        sqlite(
            `${stack.root}/denpa.db`,
            `db.run("DELETE FROM reservations WHERE program_id = 980001"); db.run("DELETE FROM recordings WHERE name LIKE '一覧試験%'");`,
        );
    });

    test('予約は「いま」の線の上、録れたものは下に、日付の見出しを挟んで並ぶ', async ({ page }) => {
        await goto(page, '/');
        const names = await rows(page).locator('.row-name').allInnerTexts();
        const order = ['一覧試験の予約', '一覧試験の未視聴', '一覧試験の視聴済み', '一覧試験の失敗'].map(
            (n) => names.findIndex((name) => name.trim() === n),
        );
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);

        // 予約と「いま」の線の上下
        const now = await page.getByTestId('timeline-now').boundingBox();
        const reservation = await rows(page).filter({ hasText: '一覧試験の予約' }).boundingBox();
        const recording = await rows(page).filter({ hasText: '一覧試験の未視聴' }).boundingBox();
        expect(reservation!.y).toBeLessThan(now!.y);
        expect(recording!.y).toBeGreaterThan(now!.y);

        // 「いま」の線と日付の見出しは見出しなので、読み上げの見出し移動で辿れる
        await expect(page.getByRole('heading', { name: /^いま \d{1,2}:\d{2}$/ })).toHaveCount(1);
        await expect(page.getByTestId('timeline-day').first()).toHaveRole('heading');

        // 行は指で押せる高さ (48px) がある
        const box = await rows(page).filter({ hasText: '一覧試験の視聴済み' }).boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(47.5);
    });

    test('絞り込みのボタンは件数どおりの行に絞る', async ({ page }) => {
        await goto(page, '/');
        for (const id of ['reservations', 'unfinished', 'failed']) {
            const count = await countOf(page, id);
            await homeFilter(page, id);
            await expect(
                page.getByTestId('timeline-toolbar').locator(`[data-filter="${id}"]`),
            ).toHaveAttribute('aria-pressed', 'true');
            await expect(rows(page)).toHaveCount(count);
        }
        // 入れた行がそれぞれの絞り込みに入る
        await homeFilter(page, 'unfinished');
        await expect(rows(page).filter({ hasText: '一覧試験の未視聴' })).toHaveCount(1);
        await expect(rows(page).filter({ hasText: '一覧試験の視聴済み' })).toHaveCount(0);
        await homeFilter(page, 'failed');
        await expect(rows(page).filter({ hasText: '一覧試験の失敗' })).toHaveCount(1);
        await homeFilter(page, 'reservations');
        await expect(rows(page).filter({ hasText: '一覧試験の予約' })).toHaveCount(1);
        await expect(page.getByTestId('timeline-matched')).toBeVisible();
        await homeFilter(page, 'all');
        await expect(page.getByTestId('timeline-matched')).toHaveCount(0);
    });

    /*
     * **右のサイドバーは無く、一覧が幅を全部使う。** 今日のまとめ (次の録画・空き) は頭の1行の右に。
     * 行は 2 段で、2段目に局と尺と説明の頭が入る
     */
    test('一覧は幅いっぱいの2段の行で、頭の1行にまとめが出る', async ({ page }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await goto(page, '/');
        await expect(page.getByTestId('sidebar')).toHaveCount(0);
        await expect(page.getByTestId('summary')).toContainText('次の録画');

        const row = rows(page).filter({ hasText: '一覧試験の視聴済み' });
        await row.scrollIntoViewIfNeeded();
        const list = (await page.getByTestId('timeline').boundingBox())!;
        const box = (await row.boundingBox())!;
        // 一覧の幅のほとんどを行が使う (右に欄が並んでいない)
        expect(box.width).toBeGreaterThan(list.width * 0.9);
        expect(box.height).toBeGreaterThanOrEqual(63.5);
        // 1段目に時刻と番組名、2段目に局
        await expect(row.locator('.t-time')).toHaveText(/\d{1,2}:\d{2}–\d{1,2}:\d{2}/);
        await expect(row.locator('.row-meta')).toContainText('BS11');
        // 行を押すと再生、詳細は ⓘ から
        await expect(row.getByTestId('row-open')).toHaveAttribute('href', /\/watch\/\d+$/);
        await expect(row.getByTestId('detail-button')).toBeVisible();
    });

    test('狭い画面は頭の細い1行のチップで1回で絞る', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await goto(page, '/');
        await homeFilter(page, 'failed');
        await expect(rows(page).filter({ hasText: '一覧試験の失敗' })).toHaveCount(1);
        await expect(rows(page).filter({ hasText: '一覧試験の未視聴' })).toHaveCount(0);
        // 選んだチップが押された印になる。頭の1行は 44px に収まる
        await expect(page.locator('[data-testid="filter-chip"][data-filter="failed"]')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect((await page.getByTestId('timeline-toolbar').boundingBox())!.height).toBeLessThanOrEqual(44);
        await homeFilter(page, 'all');

        // 番組名で探す欄はホームには無い (全体の検索)
        await expect(page.getByTestId('timeline-toolbar').getByRole('searchbox')).toHaveCount(0);
        // チップに件数が出る
        await expect(page.locator('[data-testid="filter-chip"][data-filter="all"]')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.locator('[data-testid="filter-chip"][data-filter="failed"]')).toContainText(
            /失敗\s*\d+/,
        );
    });

    /*
     * **狭い画面では録画の行の操作を「⋯」1つにまとめる。** 詳細と削除のアイコンを並べると番組名が数文字で切れた。
     * 中身は詳細と削除 (削除は1回目で聞き返す)
     */
    test('狭い画面の録画の行は「⋯」から詳細と削除', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await goto(page, '/');
        const row = rows(page).filter({ hasText: '一覧試験の視聴済み' });
        await row.scrollIntoViewIfNeeded();
        await expect(row.getByTestId('detail-button')).toBeHidden();
        await expect(row.getByTestId('delete-button')).toBeHidden();

        await row.getByTestId('row-more').click();
        const menu = row.getByTestId('row-menu');
        await expect(menu).toBeVisible();
        await menu.getByTestId('row-menu-delete').click();
        // 1回目は聞き返すだけ。メニューは開いたまま
        await expect(menu.getByTestId('row-menu-delete-confirm')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();

        await row.getByTestId('row-more').click();
        await menu.getByTestId('row-menu-detail').click();
        await expect(page.getByTestId('program-detail')).toContainText('一覧試験の視聴済み');
    });

    /*
     * **絞り込みを替えても、見ていた行はその場に残る。** 「すべて」に戻したとき一覧の頭まで跳んでいた。
     * 途中まで送り、未視聴に絞って「すべて」に戻すと、同じ行が同じあたりに見えている
     */
    test('絞り込みを外しても、見ていた行のところに留まる', async ({ page, stack }) => {
        const now = Date.now();
        const at = (i: number) => new Date(2098, 0, 1, 21, 0).getTime() - i * DAY;
        sqlite(
            `${stack.root}/denpa.db`,
            `const rec = db.prepare('INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, watched_at, created_at, updated_at) VALUES (211, ?, ?, ?, ?, ?, ?, ?, NULL, ${now}, ${now})');
            for (let i = 0; i < 30; i++) rec.run('BS11', 'ずれ試験' + i, 'ずれ試験' + i, ${at(0)} - i * ${DAY}, ${at(0)} - i * ${DAY} + 1800000, ${at(0)} - i * ${DAY} + 1800000, '/media/encoded/seed/p' + i + '.mkv');`,
        );
        try {
            await page.setViewportSize({ width: 1366, height: 768 });
            await goto(page, '/');
            const target = rows(page).filter({ hasText: /^.*ずれ試験15(?!\d)/ });
            await target.scrollIntoViewIfNeeded();
            await page.getByTestId('timeline').evaluate((list, name) => {
                const row = [...list.querySelectorAll<HTMLElement>('[data-key]')].find((r) =>
                    (r.textContent ?? '').includes(name),
                );
                if (row)
                    list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 80;
            }, 'ずれ試験15');
            const before = (await target.boundingBox())!.y;

            await homeFilter(page, 'unfinished');
            await expect(target).toBeInViewport();
            await homeFilter(page, 'all');
            await expect(target).toBeInViewport();
            expect(Math.abs((await target.boundingBox())!.y - before)).toBeLessThan(80);
        } finally {
            sqlite(`${stack.root}/denpa.db`, `db.run("DELETE FROM recordings WHERE name LIKE 'ずれ試験%'");`);
        }
    });

    /*
     * **指で押す端末は行を高くする。** 低い行は押したつもりの隣が開いた。行は 72px 以上、
     * 行の操作は 44px 四方以上。タブレットの縦でも右に欄は出さず、同じ形の行
     */
    test.describe('タブレットの縦', () => {
        test.use({ hasTouch: true, isMobile: true, viewport: { width: 820, height: 1180 } });

        test('行は幅いっぱいで、行と押すものは指の大きさ', async ({ page }) => {
            await goto(page, '/');
            await expect(page.getByTestId('sidebar')).toHaveCount(0);
            const row = rows(page).filter({ hasText: '一覧試験の視聴済み' });
            await row.scrollIntoViewIfNeeded();
            expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(71.5);
            for (const id of ['detail-button', 'delete-button']) {
                const box = (await row.getByTestId(id).boundingBox())!;
                expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
            }
        });
    });
});
