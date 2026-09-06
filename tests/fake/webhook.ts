/**
 * 偽の通知先。
 *
 * denpa が Webhook を投げる相手。テストで「何が届いたか」を確かめるためだけのもので、
 * Discord や Slack の Incoming Webhook の代わりに立てる。
 */
const PORT = Number(process.env['FAKE_WEBHOOK_PORT'] ?? 8096);

const calls: Record<string, unknown>[] = [];

/**
 * 偽の GitHub (最新のリリース)。denpa が新しい版を見比べに来る先 (`server/update.ts`)。
 * **既定は「リリースが 1 つも無い」(404)** — 置くのはそれを見る試験だけ。
 * 置きっぱなしだとヘッダーに札が出て、他の試験の幅の測りが狂う
 */
let release: unknown = null;

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

Bun.serve({
    port: PORT,
    hostname: '0.0.0.0',
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/releases/latest') {
            return release === null ? new Response('not found', { status: 404 }) : json(release);
        }
        // 動いているコミットから見た前後。置いたリリースの `status` をそのまま返す (既定は先)。
        // 変わったファイルは denpa の中身 (触っていないと知らせが出ない)
        if (url.pathname.startsWith('/compare/')) {
            const status = (release as { status?: string } | null)?.status ?? 'ahead';
            return json({ status, files: [{ filename: 'src/app.html' }] });
        }
        if (url.pathname === '/__control/release' && request.method === 'POST') {
            release = await request.json();
            return json({ ok: true });
        }
        if (url.pathname === '/__control/state') return json({ webhookCalls: calls });
        if (url.pathname === '/__control/reset' && request.method === 'POST') {
            calls.length = 0;
            return json({ ok: true });
        }
        if (url.pathname === '/__control/webhook' && request.method === 'POST') {
            calls.push((await request.json()) as Record<string, unknown>);
            return json({ ok: true });
        }
        return new Response('not found', { status: 404 });
    },
});

console.log(`fake webhook listening on :${PORT}`);
