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

/** 広い画面はサイドバー、狭い画面は頭の1行の、その絞り込みに添えた件数 */
async function filterBox(page: Page) {
    const side = page.getByTestId('sidebar');
    return (await side.isVisible()) ? side : page.getByTestId('timeline-toolbar');
}
async function countOf(page: Page, id: string): Promise<number> {
    const text = await (await filterBox(page))
        .locator(`[data-filter="${id}"] [data-testid="filter-count"]`)
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
            await expect((await filterBox(page)).locator(`[data-filter="${id}"]`)).toHaveAttribute(
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

    /*
     * **行は一覧の幅いっぱいの2段。** 広い幅では右にサイドバー (今日のまとめもそこ)。
     * 行は 2 段で、2段目に局と尺と説明の頭が入る
     */
    test('一覧は幅いっぱいの2段の行で、まとめは右のサイドバーに出る', async ({ page }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await goto(page, '/');
        // 広い幅では右にサイドバー (絞り込み・見てほしいこと・表示・状態)。頭の1行は出さず、一覧はいちばん上から
        await expect(page.getByTestId('sidebar')).toBeVisible();
        await expect(page.getByTestId('timeline-toolbar')).toBeHidden();
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

    /*
     * **サイドバーの「見てほしいこと」は絞り込みと同じ仕組み。** 件数のあるものだけ出て、押すと一覧がそれで絞られ、
     * もう一度押すと「すべて」に戻る。「続きから観る」「録画中」はサイドバーに置かない
     */
    test('サイドバーの見てほしいことは一覧を絞り、もう一度押すと戻る', async ({ page }) => {
        await page.setViewportSize({ width: 1366, height: 768 });
        await goto(page, '/');
        const side = page.getByTestId('sidebar');
        await expect(side.getByTestId('continue-item')).toHaveCount(0);
        const failed = side.locator('[data-testid="attention-item"][data-filter="failed"]');
        await expect(failed).toContainText(/失敗\s*\d+/);
        await failed.click();
        await expect(failed).toHaveAttribute('aria-pressed', 'true');
        await expect(rows(page).filter({ hasText: '一覧試験の失敗' })).toHaveCount(1);
        await expect(rows(page).filter({ hasText: '一覧試験の未視聴' })).toHaveCount(0);
        await failed.click();
        await expect(side.locator('[data-testid="filter"][data-filter="all"]')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(rows(page).filter({ hasText: '一覧試験の未視聴' })).toHaveCount(1);
        // 状態 (次の録画・空き) はサイドバーのいちばん下
        await expect(side.getByTestId('summary')).toContainText('次の録画');
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
        // スマホでは下のタブのすぐ上に貼り付く (押すものは下に)。上には何も被さらない
        const bar = (await page.getByTestId('timeline-toolbar').boundingBox())!;
        const tabs = (await page.getByTestId('tabbar').boundingBox())!;
        expect(Math.abs(bar.y + bar.height - tabs.y)).toBeLessThanOrEqual(8);
        expect(bar.y).toBeGreaterThan(tabs.y - 100);
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
     * **「完了した予約も表示」で、終わった予約とその録画を 1 本にまとめる。** 同じ放送が予約の行と録画の行の
     * 2 本で並んでいた。録画の行が代わりに立ち、録画の名前に無い副題は予約の名前から持ってくる。
     * 録画の無い終わった予約 (取消など) は状態のバッジ付きで残る
     */
    test('完了した予約と、その録画は1本にまとめる', async ({ page, stack }) => {
        const now = Date.now();
        // 終わった予約にするため過去 (ほかの行と紛れないよう 2001 年)
        const at = new Date(2001, 5, 1, 21, 0).getTime();
        sqlite(
            `${stack.root}/denpa.db`,
            `db.run("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, started_at, created_at, updated_at) VALUES (970001, (SELECT id FROM services ORDER BY id LIMIT 1), 'まとめ試験 #3「エルマ」', ${at}, ${at + 1800000}, 1, 'done', ${at}, ${now}, ${now})");
            const id = db.query('SELECT last_insert_rowid() AS id').get().id;
            db.run("INSERT INTO recordings (reservation_id, program_id, service_id, service_name, name, series, start_at, end_at, finished_at, library_path, created_at, updated_at) VALUES (?, 970001, 211, 'BS11', 'まとめ試験', 'まとめ試験', ${at}, ${at + 1800000}, ${at + 1800000}, '/media/encoded/seed/m.mkv', ${now}, ${now})", [id]);
            db.run("INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, created_at, updated_at) VALUES (970002, (SELECT id FROM services ORDER BY id LIMIT 1), 'まとめ試験の取消', ${at - DAY}, ${at - DAY + 1800000}, 1, 'canceled', ${now}, ${now})");`,
        );
        try {
            await goto(page, '/?all=1');
            const same = rows(page).filter({ hasText: 'まとめ試験 #3' });
            await expect(same).toHaveCount(1);
            await expect(same).toHaveAttribute('data-testid', 'recording-row');
            await expect(same.getByTestId('row-open')).toContainText('まとめ試験 #3「エルマ」');
            const canceled = rows(page).filter({ hasText: 'まとめ試験の取消' });
            await expect(canceled).toHaveCount(1);
            await expect(canceled.getByTestId('reservation-state')).toHaveText('取り消し済み');
        } finally {
            sqlite(
                `${stack.root}/denpa.db`,
                `db.run("DELETE FROM recordings WHERE name LIKE 'まとめ試験%'"); db.run("DELETE FROM reservations WHERE name LIKE 'まとめ試験%'");`,
            );
        }
    });

    /*
     * **途中まで観た録画には、ポスターの下端に観たぶんのバーが見える** (4px。地は暗く透かし、観たぶんを主の色で)。
     * 3px の白く透かしたバーは明るいポスターや行の地に溶けて、無いように見えていた
     */
    test('途中まで観た録画は、ポスターの下端に観たぶんのバーが見える', async ({ page, stack }) => {
        const now = Date.now();
        const at = new Date(2098, 5, 1, 21, 0).getTime();
        sqlite(
            `${stack.root}/denpa.db`,
            `db.run("INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, library_path, duration_ms, resume_ms, created_at, updated_at) VALUES (211, 'BS11', '続き試験', '続き試験', ${at}, ${at + 1800000}, ${at + 1800000}, '/media/encoded/seed/r.mkv', 1800000, 660000, ${now}, ${now})");`,
        );
        try {
            await page.setViewportSize({ width: 1366, height: 768 });
            await goto(page, '/');
            const row = rows(page).filter({ hasText: '続き試験' });
            await row.scrollIntoViewIfNeeded();
            const bar = row.getByTestId('resume');
            await expect(bar).toBeVisible();
            const track = (await bar.boundingBox())!;
            const fill = (await bar.locator('.resume-fill').boundingBox())!;
            expect(track.height).toBeGreaterThanOrEqual(3);
            // 30 分のうち 11 分観た = 4 割ほど埋まっている
            expect(fill.width).toBeGreaterThan(0);
            expect(fill.width / track.width).toBeGreaterThan(0.3);
            expect(fill.width / track.width).toBeLessThan(0.5);
            await expect(row.locator('.row-meta')).toContainText('残り');
        } finally {
            sqlite(`${stack.root}/denpa.db`, `db.run("DELETE FROM recordings WHERE name = '続き試験'");`);
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
            await expect(page.getByTestId('sidebar')).toBeHidden();
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
