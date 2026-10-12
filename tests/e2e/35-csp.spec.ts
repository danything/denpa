import type { Page } from '@playwright/test';
import { expect, fakeDataBroadcast, goto, test, wakeControls } from './helpers';

/**
 * **画面で動いてよいスクリプトは、自分の束と SvelteKit の起動だけ**
 * (Content-Security-Policy。docs/auth.md の「画面で動いてよいもの」、設定は vite.config.ts の `csp`)。
 *
 * 狙いは放送の BML。データ放送の借りもの (web-bml) は `onclick` などを本物の属性のまま
 * DOM に入れるので、押されると放送が書いた文字列が denpa の origin で本物の JS として動く。
 * いまは器の `pointer-events: none` で押せないだけで、それは偶然 — ここでは外して押す。
 */

interface Seen {
    /** 出た CSP 違反 (`effectiveDirective blockedURI`) */
    __csp: string[];
}

/** 違反を控える。**ページのスクリプトより先に**付けたいので init script で */
async function watchViolations(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const seen = window as unknown as Seen;
        seen.__csp = [];
        document.addEventListener('securitypolicyviolation', (event) => {
            seen.__csp.push(`${event.effectiveDirective} ${event.blockedURI}`);
        });
    });
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as Seen).__csp);

test.describe('CSP', () => {
    test('画面に CSP が付き、ふだんの画面では何も止められない', async ({ page }) => {
        await watchViolations(page);
        /*
         * **設定とチューナーは load から Promise を返して後から流す** (ストリーミング)。
         * 流れてくる `<script>` にも nonce が要る (hash にしていたら、ここで止まる)。
         * `goto` は読み込みの終わり (= 流し終わり) まで待つ
         */
        for (const path of ['/', '/guide', '/live', '/rules', '/settings', '/tuners']) {
            const response = await page.goto(path);
            const policy = response?.headers()['content-security-policy'] ?? '';
            expect(policy, path).toContain("script-src-attr 'none'");
            expect(policy, path).toMatch(/script-src 'self' 'nonce-[^']+'/);
            expect(policy, path).not.toContain('unsafe-eval');
            await page.locator('[data-hydrated="true"]').waitFor();
            // app.html の色当て (インラインの1本) も nonce で通っている
            expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), path).toBe(
                'dark',
            );
            expect(await violations(page), path).toEqual([]);
        }
    });

    test('放送の BML の onclick は、押しても動かない', async ({ page }) => {
        await watchViolations(page);
        await page.addInitScript(() => {
            const seen = window as unknown as { __sockets: WebSocket[]; __roots: ShadowRoot[] };
            // 偽のデータ放送を流し込む口 (20-live と同じ)
            seen.__sockets = [];
            const Original = window.WebSocket;
            window.WebSocket = class extends Original {
                constructor(url: string | URL, protocols?: string | string[]) {
                    super(url, protocols);
                    seen.__sockets.push(this);
                }
            };
            // web-bml は閉じた影に描くので、中の要素へ届くよう影を控えておく
            seen.__roots = [];
            const attach = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function (init) {
                const root = attach.call(this, init);
                seen.__roots.push(root);
                return root;
            };
        });

        await goto(page, '/live');
        await page.getByTestId('live-channel').first().click();
        await expect(page.getByTestId('live-title')).toBeVisible();
        const overlay = page.getByTestId('live-data');
        await wakeControls(page, 'live-frame');
        await page.getByTestId('live-data-button').click();
        await expect(overlay).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
        await expect.poll(async () => Number(await overlay.getAttribute('data-handed'))).toBeGreaterThan(0);

        // 放送が書いたことにする罠。押されたら本物の window に印を立てる
        const trap =
            '<div id="trap" style="left:0px;top:0px;width:320px;height:180px;background-color:#ff0000;" onclick="window.__bmlPwned=1"/>';
        await page.evaluate((messages) => {
            const socket = (window as unknown as { __sockets: WebSocket[] }).__sockets.at(-1);
            for (const message of messages) {
                const body = new TextEncoder().encode(JSON.stringify(message));
                const data = new Uint8Array(9 + body.length);
                data[0] = 0x30;
                data.set(body, 9);
                socket?.dispatchEvent(new MessageEvent('message', { data: data.buffer }));
            }
        }, fakeDataBroadcast(trap));

        /*
         * **属性が本物のまま DOM に入っていること**を先に見る (前提)。借りものが名前を
         * 付け替えるようになったら、この確かめは CSP を見ていないことになる
         */
        await expect
            .poll(() =>
                page.evaluate(() =>
                    (window as unknown as { __roots: ShadowRoot[] }).__roots
                        .map((root) => root.querySelector('#trap')?.getAttribute('onclick'))
                        .find((value) => value != null),
                ),
            )
            .toBe('window.__bmlPwned=1');

        // 押せるようにして (器の pointer-events を外す)、罠の真ん中を本当に押す
        const box = await page.evaluate(() => {
            const seen = window as unknown as { __roots: ShadowRoot[]; __trapClicked: boolean };
            const trap = seen.__roots.map((root) => root.querySelector('#trap')).find((el) => el != null);
            if (!(trap instanceof HTMLElement)) return null;
            const host = document.querySelector<HTMLElement>('[data-testid="live-data"]');
            if (host !== null) host.style.pointerEvents = 'auto';
            // 押したことが届いたかの対照 (属性ではない聞き手は CSP に止められない)
            seen.__trapClicked = false;
            trap.addEventListener('click', () => {
                seen.__trapClicked = true;
            });
            const rect = trap.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        expect(box).not.toBeNull();
        await page.mouse.click(box!.x, box!.y);
        await expect
            .poll(() => page.evaluate(() => (window as unknown as { __trapClicked: boolean }).__trapClicked))
            .toBe(true);
        // 押し方を変えても同じ (`click()` もインラインのハンドラを呼ぶ)
        await page.evaluate(() => {
            const seen = window as unknown as { __roots: ShadowRoot[] };
            const trap = seen.__roots.map((root) => root.querySelector('#trap')).find((el) => el != null);
            (trap as HTMLElement).click();
        });

        // 動いていない。止めたのは CSP (`script-src-attr`)
        expect(
            await page.evaluate(() => (window as unknown as { __bmlPwned?: number }).__bmlPwned),
        ).toBeUndefined();
        await expect.poll(() => violations(page)).toContain('script-src-attr inline');
    });
});
