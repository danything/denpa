import { spawnSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, goto, test } from './helpers';

/**
 * 録画一覧の「まとめて表示」(issue #480)。
 *
 * **録画は DB に直に入れる。** 番組ごとに何本も要るので、本当に録ると偽の放送の
 * 番組の巡り (5秒ずつ・題名は数本の使い回し) を何周も待つことになる。並べ方を
 * 見たいだけなので、録り終えた行 (`finished_at` だけある = 「録画済み」) を足す。
 * Playwright は CI では node で動くので、`bun:sqlite` は bun を1回起こして使う
 *
 * 放送日は 2099 年にして、同じワーカーの他のスペックが残した録画より必ず新しく
 * (= 一覧の頭に) 来るようにする
 */
const DAY = 86_400_000;
const BASE = new Date(2099, 0, 1, 21, 0).getTime();

interface Seed {
    name: string;
    series: string;
    at: number;
}

const SEEDS: Seed[] = [
    // 3本の番組。いちばん新しい回がいちばん新しい → 先頭の見出し
    { name: 'グループ試験アニメ #1', series: 'グループ試験アニメ', at: BASE + 1 * DAY },
    { name: 'グループ試験アニメ #2', series: 'グループ試験アニメ', at: BASE + 2 * DAY },
    { name: 'グループ試験アニメ #3', series: 'グループ試験アニメ', at: BASE + 3 * DAY },
    // 1本だけの番組。まとめずに、日付の位置 (アニメとニュースの間) にふつうの行で出る
    { name: 'グループ試験ドラマ', series: 'グループ試験ドラマ', at: BASE + 2.5 * DAY },
    // 2本の番組。シリーズ名を持たない行は番組名から切り出してまとめる
    { name: 'グループ試験ニュース 第1回', series: '', at: BASE + 0.5 * DAY },
    { name: 'グループ試験ニュース 第2回', series: '', at: BASE + 1.5 * DAY },
    // 枠をスクロールさせるための1本ものの番組 (上の番組より古い)
    ...Array.from({ length: 14 }, (_, i) => ({
        name: `グループ試験単発${i + 1}`,
        series: `グループ試験単発${i + 1}`,
        at: BASE - (i + 1) * DAY,
    })),
];

function seed(db: string, rows: Seed[]): void {
    const script = `
        import { Database } from 'bun:sqlite';
        const db = new Database(process.env.SEED_DB);
        db.exec('PRAGMA busy_timeout = 5000');
        const insert = db.prepare(
            'INSERT INTO recordings (service_id, service_name, name, series, start_at, end_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const row of JSON.parse(process.env.SEED_ROWS)) {
            insert.run(211, 'BS11', row.name, row.series, row.at, row.at + 1800000, row.at + 1800000, Date.now(), Date.now());
        }
    `;
    const done = spawnSync('bun', ['-e', script], {
        env: { ...process.env, SEED_DB: db, SEED_ROWS: JSON.stringify(rows) },
        encoding: 'utf8',
    });
    if (done.status !== 0) throw new Error(`録画を入れられませんでした: ${done.stderr}`);
}

/** 一覧に並んでいるもの (見出しは `group:名前`、行は番組名) を上から */
async function listed(page: Page): Promise<string[]> {
    return await page
        .getByTestId('recording-list')
        .locator(':scope > [data-testid="recording-group"], :scope > [data-testid="recording-row"]')
        .evaluateAll((nodes) =>
            nodes.map((node) =>
                node.getAttribute('data-testid') === 'recording-group'
                    ? `group:${node.querySelector('[data-testid="recording-group-name"]')?.textContent?.trim()}`
                    : (node.querySelector('.row-name')?.textContent?.trim() ?? ''),
            ),
        );
}

/**
 * 録画の枠のスクロール位置。`top` は上の端から、`rest` は下の端までの残り。
 * **`scrollTop` では見ない** — まとめないときの枠は下から積む (`column-reverse`) ので、
 * 0 が一番下になる。一覧と枠の見えている所の差で測る
 */
async function scroll(page: Page): Promise<{ top: number; rest: number; scrollable: boolean }> {
    return await page.getByTestId('recording-list').evaluate((list) => {
        const box = list.parentElement!;
        const shown = box.getBoundingClientRect();
        const inner = {
            top: shown.top + box.clientTop,
            bottom: shown.top + box.clientTop + box.clientHeight,
        };
        const rows = list.getBoundingClientRect();
        return {
            top: Math.round(inner.top - rows.top),
            rest: Math.round(rows.bottom - inner.bottom),
            scrollable: box.scrollHeight > box.clientHeight + 1,
        };
    });
}

/**
 * 開き直す。**一覧を全部描かせる `goto` は使わない** — 続きを足す印を画面に
 * 入れるために枠を送るので、開いたときの位置が分からなくなる
 */
async function open(page: Page): Promise<void> {
    await page.goto('/');
    await page.locator('[data-hydrated="true"]').waitFor();
}

test.describe('録画一覧のまとめて表示', () => {
    test.beforeAll(({ stack }) => {
        seed(`${stack.root}/denpa.db`, SEEDS);
    });

    test('番組ごとにまとまり、番組は新しい順・中は放送順、1本だけの番組はふつうの行', async ({ page }) => {
        await goto(page, '/');
        const toggle = page.getByTestId('recordings-group-toggle');
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await expect(toggle).toHaveAccessibleName('まとめて表示');
        // 入っていないときは枠だけの灰色
        await expect(toggle).toHaveClass(/\bsecondary\b/);

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        /*
         * **入っているときは主の色で塗る** (ライブの種別の切り替えと同じ)。灰色の塗りと
         * 灰色の枠で分けていた頃は、入っているのか見分けが付かなかった
         */
        await expect(toggle).not.toHaveClass(/\bsecondary\b/);
        await expect(toggle).not.toHaveClass(/\boutline\b/);

        // 閉じた見出しと1本ものが、いちばん新しい回の日付で並ぶ
        expect((await listed(page)).slice(0, 4)).toEqual([
            'group:グループ試験アニメ',
            'グループ試験ドラマ',
            'group:グループ試験ニュース',
            'グループ試験単発1',
        ]);

        const anime = page.locator('[data-testid="recording-group"][data-group="グループ試験アニメ"]');
        await expect(anime).toHaveAttribute('aria-expanded', 'false');
        await expect(anime.getByTestId('recording-group-count')).toHaveText('3本');

        // 押すと見出しのすぐ下に、第1話から順に開く
        await anime.click();
        await expect(anime).toHaveAttribute('aria-expanded', 'true');
        expect((await listed(page)).slice(0, 5)).toEqual([
            'group:グループ試験アニメ',
            'グループ試験アニメ #1',
            'グループ試験アニメ #2',
            'グループ試験アニメ #3',
            'グループ試験ドラマ',
        ]);

        // キーボードでも開ける (本物の button なので Enter で押せる)
        const news = page.locator('[data-testid="recording-group"][data-group="グループ試験ニュース"]');
        await news.focus();
        await page.keyboard.press('Enter');
        await expect(news).toHaveAttribute('aria-expanded', 'true');
        expect(await listed(page)).toContain('グループ試験ニュース 第1回');

        // もう一度押せば閉じる
        await anime.click();
        await expect(anime).toHaveAttribute('aria-expanded', 'false');
        expect(await listed(page)).not.toContain('グループ試験アニメ #1');
    });

    test('まとめて表示は一番上から、まとめないときは一番下から開く。切り替えは端末に覚える', async ({
        page,
    }) => {
        // まとめないとき: 今までどおり一番下 (いちばん古い録画) を見せて開く
        await open(page);
        await expect.poll(async () => (await scroll(page)).scrollable).toBe(true);
        await expect.poll(async () => (await scroll(page)).rest).toBeLessThanOrEqual(1);

        // まとめると一番上 (最近の番組) へ置き直す
        await page.getByTestId('recordings-group-toggle').click();
        await expect.poll(async () => (await scroll(page)).top).toBe(0);

        // 開き直してもまとめたまま、一番上から
        await open(page);
        await expect(page.getByTestId('recordings-group-toggle')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('recording-group').first()).toBeVisible();
        expect((await scroll(page)).scrollable).toBe(true);
        expect((await scroll(page)).top).toBe(0);
        // 覚えはサーバが読む (cookie)。描いた時点でもうまとまっている
        expect(await page.context().cookies()).toContainEqual(
            expect.objectContaining({ name: 'denpa_recordings_grouped', value: '1' }),
        );

        // 絞っている間は、当たった番組を開いて出す
        await page.getByLabel('録画を絞り込む').fill('グループ試験ニュース');
        const news = page.locator('[data-testid="recording-group"][data-group="グループ試験ニュース"]');
        await expect(news).toHaveAttribute('aria-expanded', 'true');
        expect(await listed(page)).toEqual([
            'group:グループ試験ニュース',
            'グループ試験ニュース 第1回',
            'グループ試験ニュース 第2回',
        ]);
        // 絞っている間も見出しで閉じられる。閉じたことは絞り込みを消すと忘れる (元の閉じた状態に戻る)
        await news.click();
        await expect(news).toHaveAttribute('aria-expanded', 'false');
        expect(await listed(page)).toEqual(['group:グループ試験ニュース']);
        await page.getByLabel('録画を絞り込む').fill('');
        await expect(news).toHaveAttribute('aria-expanded', 'false');

        // 戻すと一番下へ。次に開いたときもまとめない
        await page.getByTestId('recordings-group-toggle').click();
        await expect(page.getByTestId('recordings-group-toggle')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId('recording-group')).toHaveCount(0);
        await expect.poll(async () => (await scroll(page)).rest).toBeLessThanOrEqual(1);
        await open(page);
        await expect(page.getByTestId('recordings-group-toggle')).toHaveAttribute('aria-pressed', 'false');
    });

    /**
     * **置き方は JS を待たない。** 送り終わるまで枠を隠していた頃は、4倍遅い CPU で
     * 枠が出るまで 2 秒かかっていた。サーバが描いた時点で正しい所が映っていること
     */
    test('JS が無くても、まとめないときは一番下、まとめたときは一番上が映る', async ({ browser, stack }) => {
        const context = await browser.newContext({ baseURL: stack.appUrl, javaScriptEnabled: false });
        try {
            const page = await context.newPage();
            await page.goto('/');
            await expect.poll(async () => (await scroll(page)).scrollable).toBe(true);
            expect((await scroll(page)).rest).toBeLessThanOrEqual(1);

            await context.addCookies([{ name: 'denpa_recordings_grouped', value: '1', url: stack.appUrl }]);
            await page.goto('/');
            await expect(page.getByTestId('recordings-group-toggle')).toHaveAttribute('aria-pressed', 'true');
            await expect(page.getByTestId('recording-group').first()).toBeVisible();
            expect((await scroll(page)).top).toBe(0);
        } finally {
            await context.close();
        }
    });

    /**
     * **録画からルールを作る。** シリーズ名を入れた下書きを持ってルールの画面へ行き、
     * 確かめてから保存する。作ったあとに同じ番組から来れば、作らずにそのルールを案内する
     */
    test('番組の見出しと録画の詳細から、その番組のルールを作れる', async ({ page }) => {
        await goto(page, '/');
        await page.getByTestId('recordings-group-toggle').click();
        const anime = page.locator('[data-testid="recording-group"][data-group="グループ試験アニメ"]');
        // 閉じている番組には出さない (見出しが並ぶだけの一覧を押すもので埋めない)
        await expect(page.getByTestId('group-rule')).toHaveCount(0);
        await anime.click();
        await page.getByTestId('group-rule').click();

        // 下書きは URL に載る (「何が録れるか見る」と同じ形)。同じ回は最初の放送だけ、が入っている
        await expect(page).toHaveURL(/\/rules\?.*keyword=/);
        await page.locator('[data-hydrated="true"]').waitFor();
        await expect(page.getByTestId('rule-keyword')).toHaveValue('グループ試験アニメ');
        await expect(page.getByTestId('rule-dedupe')).toBeChecked();
        await expect(page.getByTestId('rule-origin')).toContainText('条件を入れました');

        try {
            await page.getByTestId('rule-submit').click();
            // 作ったら、この番組はそのルールで録っていると出る
            await expect(page.getByTestId('rule-origin')).toContainText('で録っています');
            await expect(page.getByTestId('rule-origin-link')).toHaveText('グループ試験アニメ');

            // 録画の詳細からも同じ入口。もうルールがあるので、作らずにそちらを案内する
            await goto(page, '/');
            await anime.click();
            await page.getByTestId('recording-list').getByText('グループ試験アニメ #2').click();
            const detail = page.getByTestId('program-detail');
            await detail.getByTestId('detail-more').click();
            await detail.getByTestId('rule-from-recording').click();
            await expect(page).toHaveURL(/\/rules\?from=\d+$/);
            await expect(page.getByTestId('rule-origin')).toContainText('で録っています');
            await expect(page.getByTestId('rule-keyword')).toHaveValue('');
        } finally {
            // 後続に残さない
            await goto(page, '/rules');
            const made = page.getByTestId('rule-row').filter({ hasText: 'グループ試験アニメ' });
            if ((await made.count()) > 0) {
                await made.first().getByTestId('rule-delete').click();
                await expect(made).toHaveCount(0);
            }
        }
    });
});
