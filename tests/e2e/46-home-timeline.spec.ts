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

/** サイドバー (狭い画面では一枚) の絞り込みのボタンに添えた件数 */
async function countOf(page: Page, id: string): Promise<number> {
    const text = await page
        .getByTestId('sidebar')
        .locator(`[data-testid="filter"][data-filter="${id}"] [data-testid="filter-count"]`)
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
            await expect(page.getByTestId('sidebar').locator(`[data-filter="${id}"]`)).toHaveAttribute(
                'aria-pressed',
                'true',
            );
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

    test('サイドバーに今日のまとめと、指を乗せた行の中身が出る', async ({ page }) => {
        await goto(page, '/');
        const side = page.getByTestId('sidebar');
        await expect(side.getByTestId('summary')).toContainText('次の録画');
        await expect(side.getByTestId('summary')).toContainText('未視聴');

        const watched = rows(page).filter({ hasText: '一覧試験の未視聴' });
        await watched.scrollIntoViewIfNeeded();
        await watched.hover();
        const detail = side.getByTestId('selected-detail');
        await expect(detail).toContainText('一覧試験の未視聴');
        // 観られる録画はその場で再生できる
        await expect(detail.getByTestId('selected-play')).toHaveAttribute('href', /\/watch\/\d+$/);

        const reservation = rows(page).filter({ hasText: '一覧試験の予約' });
        await reservation.scrollIntoViewIfNeeded();
        await reservation.hover();
        await expect(detail).toContainText('一覧試験の予約');
        await expect(detail.getByTestId('selected-cancel')).toBeVisible();
    });

    test('狭い画面は頭のボタンから下からの一枚を開いて絞る', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await goto(page, '/');
        await homeFilter(page, 'failed');
        await expect(rows(page).filter({ hasText: '一覧試験の失敗' })).toHaveCount(1);
        await expect(rows(page).filter({ hasText: '一覧試験の未視聴' })).toHaveCount(0);
        // 絞っている間は、一枚を開くボタンに点が付く
        await expect(page.getByTestId('filter-open').locator('.view-dot')).toHaveCount(1);
        await homeFilter(page, 'all');

        // 番組名で探す欄はホームには無い (全体の検索)
        await expect(page.getByTestId('timeline-toolbar').getByRole('searchbox')).toHaveCount(0);
        // 一枚を開くボタンに、いま効いている絞り込みと件数が出る
        await expect(page.getByTestId('filter-open')).toContainText('すべて');
    });
});
