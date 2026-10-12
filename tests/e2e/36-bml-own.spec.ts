import type { Page } from '@playwright/test';
import {
    captionsSeenInDataWindow,
    expect,
    fakeDataBroadcast,
    goto,
    holdMedia,
    test,
    wakeControls,
} from './helpers';

/**
 * **自前のデータ放送エンジン** (`src/lib/bml/`。`?bml=own` で選ぶ。既定はまだ web-bml)。
 *
 * 偽の放送にはデータ放送が載っていないので、手で書いた小さな BML (`fakeDataBroadcast`) を
 * WebSocket に流して確かめる。見るのは:
 * - 出る (文書を描き、映像の object の場所を教え、denpa が映像の入れ物をそこへ寄せる)
 * - 字幕が映像と一緒に小窓へ縮んで見える (映像は影の中へ移さない)
 * - d とリモコンが文書のスクリプトに届く (自前の VM で動く)
 * - 放送の on* はページに出ない (CSP が止める前に、そもそも写さない)
 */

interface Seen {
    __sockets: WebSocket[];
    __csp: string[];
}

/** 流し込む口を控え、CSP の違反も数える (ページのスクリプトより先に) */
async function prepare(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const seen = window as unknown as Seen;
        seen.__sockets = [];
        seen.__csp = [];
        document.addEventListener('securitypolicyviolation', (event) => {
            seen.__csp.push(`${event.effectiveDirective} ${event.blockedURI}`);
        });
        const Original = window.WebSocket;
        window.WebSocket = class extends Original {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                seen.__sockets.push(this);
            }
        };
    });
}

/** 局を選んで d を押し、自前のエンジンが立つまで */
async function openData(page: Page): Promise<void> {
    await goto(page, '/live?bml=own');
    await page.getByTestId('live-channel').first().click();
    await expect(page.getByTestId('live-title')).toBeVisible();
    await holdMedia(page, 'live-video', 'live-captions', 'live-frame');
    await page.getByTestId('live-captions').evaluate((el) => el.setAttribute('data-ink', '0.8000,0.9700'));
    const overlay = page.getByTestId('live-data');
    await wakeControls(page, 'live-frame');
    await page.getByTestId('live-data-button').click();
    await expect(overlay).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
    await expect(overlay).toHaveAttribute('data-engine', 'own');
    await expect.poll(async () => Number(await overlay.getAttribute('data-handed'))).toBeGreaterThan(0);
}

/** 作った BML を流す (0x30 + 多重化の頭 8 バイト + JSON。20-live と同じ) */
async function feed(page: Page, extra: string): Promise<void> {
    await page.evaluate((messages) => {
        const socket = (window as unknown as Seen).__sockets.at(-1);
        for (const message of messages) {
            const body = new TextEncoder().encode(JSON.stringify(message));
            const data = new Uint8Array(9 + body.length);
            data[0] = 0x30;
            data.set(body, 9);
            socket?.dispatchEvent(new MessageEvent('message', { data: data.buffer }));
        }
    }, fakeDataBroadcast(extra));
}

/** 影の中から探す (自前のエンジンは開いた影に描く) */
function shadow(page: Page, selector: string) {
    return page.evaluate((query) => {
        for (const host of document.querySelectorAll('[data-testid="live-data"] div')) {
            const found = host.shadowRoot?.querySelector(query);
            if (found)
                return { text: found.textContent, attributes: [...found.attributes].map((a) => a.name) };
        }
        return null;
    }, selector);
}

/** 文書のスクリプトが書く札。d と、押されたキーを数える */
const SCRIPTED = [
    '<script><![CDATA[',
    'var pressed = 0;',
    'function onData() { pressed++; show("d" + pressed); }',
    'function onKey() { show("key" + document.currentEvent.keyCode); }',
    'function show(text) { document.getElementById("msg").firstChild.data = text; }',
    ']]></script>',
    '<bevent><beitem type="DataButtonPressed" onoccur="onData();" subscribe="subscribe"/></bevent>',
    '<p id="msg" style="left:0px;top:0px;width:400px;height:40px;nav-index:0;color-index:7;" onkeydown="onKey();">init</p>',
].join('\n');

test.describe('自前のデータ放送エンジン', () => {
    test('出して、字幕が映像と一緒に小窓へ縮んで見えている', async ({ page }) => {
        await prepare(page);
        await openData(page);
        await feed(page, '');
        await captionsSeenInDataWindow(page, { moved: false });
        expect(await page.evaluate(() => (window as unknown as Seen).__csp)).toEqual([]);
    });

    test('d とリモコンが文書のスクリプトに届く', async ({ page }) => {
        await prepare(page);
        await openData(page);
        await feed(page, SCRIPTED);
        // 出す操作は文書への d の 1 押し (聞いている文書が出てきたら届ける)
        await expect.poll(async () => (await shadow(page, 'span'))?.text, { timeout: 10_000 }).toBe('d1');
        // 出ている間の画面の d は、聞いている文書に渡す (器は閉じない)
        await wakeControls(page, 'live-frame');
        await page.getByTestId('live-data-button').click();
        await expect.poll(async () => (await shadow(page, 'span'))?.text).toBe('d2');
        await expect(page.getByTestId('live-data')).toHaveAttribute('data-state', 'ready');
        // 指のリモコンの赤 (22) は、フォーカスのある要素の onkeydown へ
        await page.getByTestId('live-remote-22').click();
        await expect.poll(async () => (await shadow(page, 'span'))?.text).toBe('key22');
        // キーボードの青も同じ
        await page.keyboard.press('b');
        await expect.poll(async () => (await shadow(page, 'span'))?.text).toBe('key21');
    });

    test('放送の on* はページに出ない', async ({ page }) => {
        await prepare(page);
        await openData(page);
        await feed(
            page,
            '<div id="trap" style="left:0px;top:0px;width:320px;height:180px;" onclick="window.__bmlPwned=1"><p style="left:0px;top:0px;width:320px;height:40px;">trap</p></div>',
        );
        await expect.poll(async () => (await shadow(page, 'span'))?.text).toBe('trap');
        // 描いた要素に属性は無い (style だけ)
        const attributes = await page.evaluate(() => {
            const names = new Set<string>();
            for (const host of document.querySelectorAll('[data-testid="live-data"] div')) {
                for (const element of host.shadowRoot?.querySelectorAll('*') ?? []) {
                    for (const attribute of element.attributes) names.add(attribute.name);
                }
            }
            return [...names];
        });
        expect(attributes.filter((name) => name !== 'style' && name !== 'src' && name !== 'alt')).toEqual([]);
        expect(
            await page.evaluate(() => (window as unknown as { __bmlPwned?: number }).__bmlPwned),
        ).toBeUndefined();
        expect(await page.evaluate(() => (window as unknown as Seen).__csp)).toEqual([]);
    });
});
