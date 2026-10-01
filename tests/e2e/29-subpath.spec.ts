import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { cellOf, expect, syncEpg, test, upcoming } from './helpers';

/**
 * **前段の接頭辞の下でも動く** (server/paths.ts)。
 *
 * Home Assistant の Ingress や k8s の Ingress と同じく、`/sub/denpa` を**剥がしてから**
 * 渡す前段を立てて、その下で主な道を通す。denpa には接頭辞を教えない。
 * 画面の中の URL は `base` (SvelteKit がブラウザの居る URL から求める)、転送は相対。
 * どれか1つでも根から書いてあれば、その先で前段の外 (`/guide` など) へ出て 404 になる
 */
const PREFIX = '/sub/denpa';

let proxy: Server;
let origin = '';

test.describe('接頭辞の下で', () => {
    test.beforeAll(async ({ stack }) => {
        const app = new URL(stack.appUrl);
        const strip = (path: string) => (path.startsWith(`${PREFIX}/`) ? path.slice(PREFIX.length) : null);
        proxy = createServer((req, res) => {
            const path = strip(req.url ?? '');
            if (path === null) {
                // 前段の外。ここへ来たら、どこかが根から書いてある
                res.writeHead(404).end(`outside of ${PREFIX}: ${req.url}`);
                return;
            }
            /*
             * **Origin は本体のものに直して渡す。** このスタックは ORIGIN を本体の URL に固定して
             * あるので、別のポートに立てたこの前段からのフォーム送信は、SvelteKit に
             * 「よそからの送信」として断られる。本物の前段 (Home Assistant の Ingress など) は
             * Host をそのまま渡し、denpa は ORIGIN を付けないので、こうはならない
             */
            const headers = { ...req.headers };
            if (headers.origin !== undefined) headers.origin = app.origin;
            const upstream = httpRequest(
                { host: app.hostname, port: app.port, path, method: req.method, headers },
                (up) => {
                    res.writeHead(up.statusCode ?? 502, up.headers);
                    up.pipe(res);
                },
            );
            upstream.on('error', () => res.destroy());
            req.pipe(upstream);
        });
        // ライブの WebSocket も同じく剥がして繋ぐ
        proxy.on('upgrade', (req, socket, head) => {
            const path = strip(req.url ?? '');
            if (path === null) return socket.destroy();
            const up = connect(Number(app.port), app.hostname, () => {
                const lines = [`${req.method} ${path} HTTP/1.1`];
                for (let i = 0; i < req.rawHeaders.length; i += 2) {
                    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
                }
                up.write(`${lines.join('\r\n')}\r\n\r\n`);
                up.write(head);
                up.pipe(socket).pipe(up);
            });
            up.on('error', () => socket.destroy());
            socket.on('error', () => up.destroy());
        });
        await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    });

    test.afterAll(async () => {
        await new Promise((resolve) => proxy.close(resolve));
    });

    test('ナビ・番組表・詳細・ルールの転送・ライブが、接頭辞の中で完結する', async ({ page, request }) => {
        test.setTimeout(120_000);
        await syncEpg(request);
        const outside: string[] = [];
        page.on('response', (res) => {
            if (
                res.url().startsWith(origin) &&
                res.status() === 404 &&
                !new URL(res.url()).pathname.startsWith(PREFIX)
            ) {
                outside.push(res.url());
            }
        });

        await page.goto(`${origin}${PREFIX}/`);
        await page.locator('[data-hydrated="true"]').waitFor();

        // ナビ: 接頭辞の中の番組表へ
        await page.getByTestId('nav-guide').click();
        await expect(page).toHaveURL(`${origin}${PREFIX}/guide`);
        await expect(page.getByTestId('grid-program').first()).toBeVisible();
        await expect(page.getByTestId('nav-guide')).toHaveAttribute('aria-current', 'page');

        // 詳細は fetch で取る (`/api/programs/<id>`)
        // これから始まるマスを、見える所まで送ってから押す (先頭は終わった番組で、見出しに隠れうる)
        const [target] = await upcoming(page);
        await cellOf(page, target.programId).scrollIntoViewIfNeeded();
        await cellOf(page, target.programId).click();
        await expect(page.getByTestId('program-detail')).toBeVisible();
        await page.getByTestId('detail-close').click();

        // ルール: 作って、編集して保存すると一覧へ転送される (転送は相対)
        await page.getByTestId('nav-rules').click();
        await expect(page).toHaveURL(`${origin}${PREFIX}/rules`);
        await page.getByTestId('rule-keyword').fill('接頭辞のテスト');
        await page.getByTestId('rule-submit').click();
        const row = page.getByTestId('rule-row').filter({ hasText: '接頭辞のテスト' });
        await expect(row).toBeVisible();
        await row.getByTestId('rule-edit').click();
        await expect(page).toHaveURL(new RegExp(`^${origin}${PREFIX}/rules\\?edit=\\d+$`));
        await page.getByTestId('rule-update').click();
        await expect(page).toHaveURL(`${origin}${PREFIX}/rules`);
        await row.getByTestId('rule-delete').click();
        await expect(row).toHaveCount(0);

        // ライブ: 札 (fetch) を取って、接頭辞の中の WebSocket に繋ぎ、TS が届く
        let frames = 0;
        let socketUrl = '';
        page.on('websocket', (ws) => {
            socketUrl = ws.url();
            ws.on('framereceived', () => {
                frames++;
            });
        });
        await page.getByTestId('nav-live').click();
        await expect(page).toHaveURL(`${origin}${PREFIX}/live`);
        await page.getByTestId('live-channel').first().click();
        await expect
            .poll(() => frames, { timeout: 60_000, message: 'ライブの TS が届かない' })
            .toBeGreaterThan(0);
        expect(new URL(socketUrl).pathname.startsWith(`${PREFIX}/api/live/socket`)).toBe(true);

        expect(outside, '接頭辞の外へ出た要求').toEqual([]);
    });
});
