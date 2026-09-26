import { existsSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { bootClosed } from '../stack';
import { expect, goto, syncEpg, test, wakeControls } from './helpers';

/**
 * ライブを生で見る ([docs/stream.md](../../docs/stream.md) §5.5)。
 *
 * 焼く道の E2E (20-live) と違って、**ここは絵が出るところまで見る。** 偽エージェントは
 * 本当に解ける MPEG-2 と AAC を流していて (`src/lib/ts/synth-av.ts`)、ブラウザの中の
 * WASM の復号器 (`wasm/mpeg2`、Dockerfile の `mpeg2wasm` 段で組む) がそれを解く。
 * 復号器の置き場は `MPEG2_DIR` (CI は組んだものをランナーへ出して渡す)。
 *
 * 絵は worker の canvas に居て画面から画素を読めないので、**描いたコマ数と解けた音の
 * コマ数** (canvas の `data-shown` / `data-audio`) が進むこと、canvas を撮った絵が
 * 時間とともに変わることを見る。GPU の無いヘッドレス (SwiftShader) でも同じに動く。
 */

/** 設定画面のスイッチと同じ置き場 (`raw/setting.svelte.ts`) */
const RAW_KEY = 'denpa_live_raw';

async function rawOn(page: Page): Promise<void> {
    await page.addInitScript((key) => localStorage.setItem(key, '1'), RAW_KEY);
}

/** 偽 ffmpeg に渡された引数を、1回ぶんずつに切る (`tests/fake/ffmpeg.sh`) */
function ffmpegRuns(file: string): string[][] {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
        .split('---\n')
        .filter((run) => run.trim() !== '')
        .map((run) => run.split('\n'));
}

test.describe('ライブを生で見る', () => {
    test.beforeEach(async ({ request }) => {
        await syncEpg(request);
    });

    test('設定を入れると、焼かずに放送そのままを解いて描き、音も解く', async ({ page, stack }) => {
        await rawOn(page);
        const before = ffmpegRuns(stack.liveArgsFile).length;
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();

        const canvas = page.getByTestId('live-raw');
        await expect(canvas).toBeVisible({ timeout: 30_000 });
        // 焼き方の切り替えの代わりに「生」と出る
        await expect(page.getByTestId('live-raw-badge')).toBeVisible();
        await expect(page.getByTestId('live-codec')).toHaveCount(0);

        // **コマが進む。** 1秒に 60 枚 (フィールドごと) 描くので、数秒で数十は進む
        const shown = async () => Number((await canvas.getAttribute('data-shown')) ?? 0);
        await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(10);
        const first = await shown();
        await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(first + 10);

        // **音も解けている** (AudioDecoder が ADTS を受け取った)
        await expect
            .poll(async () => Number((await canvas.getAttribute('data-audio')) ?? 0), { timeout: 15_000 })
            .toBeGreaterThan(0);

        // **絵が動いている。** 縞が流れるので、時間をおいて撮った2枚は違う
        const one = await canvas.screenshot();
        await expect(async () => {
            const two = await canvas.screenshot();
            expect(two.equals(one)).toBe(false);
        }).toPass({ timeout: 10_000 });

        // 再生中になり、止める・再開するも繋がっている (再開は放送の今から)
        await expect(page.getByTestId('live-status')).toHaveCount(0);
        const play = page.getByTestId('live-play');
        // 操作列は触らないと引っ込む (`ControlBar`)。動かして出してから押す
        await wakeControls(page, 'live-frame');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '再生');
        await wakeControls(page, 'live-frame');
        await play.click();
        await expect(play).toHaveAttribute('aria-label', '一時停止');
        const resumed = await shown();
        await expect.poll(shown, { timeout: 15_000 }).toBeGreaterThan(resumed + 10);

        /*
         * **焼く ffmpeg は起こさない。** 起きるのは字幕だけを描く1本で、放送の時刻のまま
         * 出させる (`-copyts`。`server/captions.ts` の `rawCaptionArgs`)。
         *
         * 開いた瞬間の先回り (`server/live.ts` の `warm`) は焼く形で起きうる — 初めて開いた
         * 端末はまだ「前回は生」を覚えていない。見るのは**生で頼んだあと**に焼き始めていないこと
         */
        const runs = ffmpegRuns(stack.liveArgsFile).slice(before);
        const captions = runs.findIndex((run) => run.includes('-copyts'));
        expect(captions).toBeGreaterThanOrEqual(0);
        const baked = runs
            .slice(captions)
            .some((run) => run.includes('libx264') || run.includes('libsvtav1'));
        expect(baked).toBe(false);
    });

    test('局を変えても生のまま、新しい局の絵が出る', async ({ page }) => {
        await rawOn(page);
        await goto(page, '/live');
        const channels = page.getByTestId('live-channel');
        await channels.first().click();
        const canvas = page.getByTestId('live-raw');
        const shown = async () => Number((await canvas.getAttribute('data-shown')) ?? 0);
        await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(10);

        await channels.nth(1).click();
        await expect(channels.nth(1)).toHaveAttribute('data-current', 'true');
        // 器は作り直さない (同じ canvas のまま、数え続ける)
        const after = await shown();
        await expect.poll(shown, { timeout: 30_000 }).toBeGreaterThan(after + 10);
        await expect(page.getByTestId('live-raw-badge')).toBeVisible();
    });

    test('設定を入れていなければ、いつもどおり焼いたものを見る', async ({ page }) => {
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        await expect(page.getByTestId('live-codec').first()).toBeVisible();
        await expect(page.getByTestId('live-raw')).toHaveCount(0);
    });

    test('解けない端末では焼いたものに戻り、理由を出す', async ({ page }) => {
        await rawOn(page);
        // AAC を解く口が無い端末 (http で開いたときもこうなる)
        await page.addInitScript(() => {
            // biome-ignore lint/suspicious/noExplicitAny: 端末に無いことにする
            delete (globalThis as any).AudioDecoder;
        });
        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-warning')).toContainText('生では見られません');
        await expect(page.getByTestId('live-codec').first()).toBeVisible();
        await expect(page.getByTestId('live-raw')).toHaveCount(0);
    });

    test('設定画面で入り切りでき、この端末に覚える', async ({ page }) => {
        await goto(page, '/settings');
        const toggle = page.getByTestId('raw-toggle');
        await expect(toggle).not.toBeChecked();
        await toggle.check();
        await page.reload();
        await page.locator('[data-hydrated="true"]').waitFor();
        await expect(page.getByTestId('raw-toggle')).toBeChecked();
        expect(await page.evaluate((key) => localStorage.getItem(key), RAW_KEY)).toBe('1');
        await page.getByTestId('raw-toggle').uncheck();
        expect(await page.evaluate((key) => localStorage.getItem(key), RAW_KEY)).toBeNull();
    });
});

/*
 * **生で送るのは家の中からだけ。** 決めるのはサーバで、札を取ったときの住所を見る
 * (`auth.mayStreamRaw`)。`TRUSTED_NETWORKS` を全部開けていても、外の住所なら生にしない
 */
test.describe('生で送ってよい相手', () => {
    test('家の外の住所には、札で生を許さない', async ({ stack }) => {
        const open = await bootClosed(test.info().workerIndex, stack.root, {
            TRUSTED_NETWORKS: '0.0.0.0/0',
            ADDRESS_HEADER: 'x-forwarded-for',
        });
        try {
            const ask = async (from: string) => {
                const res = await fetch(`${open.appUrl}/api/live/ticket`, {
                    method: 'POST',
                    headers: { 'x-forwarded-for': from },
                });
                expect(res.status).toBe(200);
                return (await res.json()) as { ticket: string; raw: boolean };
            };
            expect((await ask('203.0.113.5')).raw).toBe(false);
            // VPN (CGNAT) で外から入ってきた住所も外とみなす
            expect((await ask('100.64.1.2')).raw).toBe(false);
            expect((await ask('192.168.1.10')).raw).toBe(true);
        } finally {
            await open.shutdown();
        }
    });
});
