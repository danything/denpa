/**
 * 見本 (ホーム画面) の撮影。scripts/capture-docs.ts の seed を元に、偽の放送だけで撮る。
 *   bun scripts/mock-capture.ts <名前>
 * 出力: mock-shots/<名前>-<幅>x<高さ>-<theme>.png と counts.json
 */
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { boot } from '../tests/stack';

const NAME = process.argv[2] ?? 'main';
const OUT = 'mock-shots';
const FFMPEG = '/usr/bin/ffmpeg';
const FONT = '/usr/share/fonts/truetype/biz-ud/BIZUDPGothic-Bold.ttf';
process.env['FAKE_PROFILE'] = 'docs';

if (process.env['SKIP_BUILD'] !== '1') {
    const build = spawnSync('bun', ['run', 'build'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('build failed');
}
const { stack, shutdown } = await boot(0);
const BASE = stack.appUrl;

async function post(path: string, body: Record<string, string | string[]> | null): Promise<void> {
    const init: RequestInit = { method: 'POST', redirect: 'manual', headers: { Origin: BASE } };
    if (body !== null) {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
        init.body = form;
    } else (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, init);
    if (res.status >= 400) throw new Error(`${path} ${res.status}`);
}
function ffmpeg(args: string[]): void {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg failed');
}
const PALETTE: Record<number, [string, string]> = {
    0: ['0x16324f', '0x2f6690'], 1: ['0x1b4332', '0x52b788'], 2: ['0x3d2c52', '0x8e6bb8'],
    3: ['0x5b1a2e', '0xc0566f'], 4: ['0x3a1f5d', '0xc65bcf'], 5: ['0x6b3e00', '0xf4a259'],
    6: ['0x101820', '0x5a6f8c'], 7: ['0x0b3954', '0x37c8c3'], 8: ['0x283618', '0x8a9a5b'],
    10: ['0x5e3023', '0xd4a373'],
};
function poster(path: string, series: string, genre: number, key: string): void {
    const [c0, c1] = PALETTE[genre] ?? ['0x22223b', '0x4a4e69'];
    const title = series.match(/「(.+)」$/)?.[1] ?? series;
    const size = Math.min(56, Math.floor(440 / [...title].length));
    const tf = join(stack.root, 'txt', `${key}.txt`);
    mkdirSync(dirname(tf), { recursive: true });
    writeFileSync(tf, title);
    ffmpeg(['-f', 'lavfi', '-i', `gradients=s=480x270:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=480:y1=270:d=1`, '-vf',
        `drawtext=fontfile=${FONT}:textfile=${tf}:fontsize=${size}:fontcolor=white:x=(w-tw)/2:y=(h-th)/2`,
        '-frames:v', '1', '-q:v', '3', path]);
}
interface P { id: number; service_id: number; service_name: string; name: string; description: string;
    extended: string | null; genre_detail: string | null; audios: string | null; audio_type: number | null;
    start_at: number; end_at: number }
const seriesOf = (n: string) => { const m = n.match(/^(.*?) #\d+「(.*)」$/); return m ? { series: m[1]!, subtitle: m[2]! } : { series: n, subtitle: '' }; };
const stamp = (at: number) => { const d = new Date(at); const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} - ${p(d.getHours())}${p(d.getMinutes())}`; };

async function sweepLogos(): Promise<void> {
    await post('/tuners?/logoSweep', {});
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
        if ((await (await fetch(`${BASE}/tuners`)).text()).includes('data-testid="logo-sweep-done"')) return;
        await new Promise((r) => setTimeout(r, 2000));
    }
}

async function seed(): Promise<void> {
    await post('/api/sync', null);
    await sweepLogos();
    await post('/api/sync', null);
    await post('/rules?/create', { keyword: '星屑ステーション', dedupe: ['0', '1'] });
    await post('/rules?/create', { keyword: '鉄道でめぐる日本', dedupe: ['0', '1'] });
    await post('/rules?/create', { keyword: 'ひだまり荘', dedupe: ['0', '1'] });
    await post('/rules?/create', { keyword: '', genres: ['6'], serviceTypes: ['BS'], dedupe: ['0', '1'] });
    const db = new Database(join(stack.root, 'denpa.db'));
    const now = Date.now();
    const programs = db.query<P, []>(`SELECT p.id, p.service_id, s.name AS service_name, p.name, p.description, p.extended,
        p.genre_detail, p.audios, p.audio_type, p.start_at, p.end_at FROM programs p JOIN services s ON s.id = p.service_id
        WHERE s.service_type = 1 ORDER BY p.start_at`).all();
    const upcoming = programs.filter((p) => p.start_at > now + 60 * 60_000);
    for (const name of ['こども科学クラブ', '港町レシピ帖', 'サッカー中継']) {
        const t = upcoming.find((p) => p.name.startsWith(name));
        if (t) await post('/guide?/reserve', { programId: String(t.id) });
    }
    // 録画: 終わった番組を新しい順に40本まで (同じ時刻は3本まで)
    const slots = new Map<number, number>();
    const picked: P[] = [];
    for (const p of [...programs].reverse()) {
        if (p.end_at > now - 10 * 60_000 || p.end_at - p.start_at < 15 * 60_000) continue;
        if ((slots.get(p.start_at) ?? 0) >= 3) continue;
        slots.set(p.start_at, (slots.get(p.start_at) ?? 0) + 1);
        picked.push(p);
        if (picked.length === 40) break;
    }
    const master = join(stack.root, 'clip.mkv');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x0b3954:s=320x180:d=2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', master]);
    const genreOf = (p: P) => (JSON.parse(p.genre_detail ?? '[]') as { lv1: number }[])[0]?.lv1 ?? -1;
    const ins = db.prepare(`INSERT INTO recordings (program_id, service_id, service_name, name, series, subtitle, description,
        extended, start_at, end_at, audio_type, library_path, ts_size, finished_at, cm_ranges, genre_detail, audios, duration_ms,
        fps, encode_skip, resume_ms, watched_at, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`);
    for (const [i, p] of picked.entries()) {
        const { series, subtitle } = seriesOf(p.name);
        const failed = i === 5 || i === 17;
        let library: string | null = null;
        if (!failed) {
            library = join(stack.encodedDir, series, `${series} - ${stamp(p.start_at)}.mkv`);
            mkdirSync(dirname(library), { recursive: true });
            rmSync(library, { force: true });
            linkSync(master, library);
            poster(library.replace(/\.mkv$/, '-poster.jpg'), series, genreOf(p), `p${i}`);
        }
        ins.run(p.id, p.service_id, p.service_name, p.name, series, subtitle, p.description, p.extended, p.start_at, p.end_at,
            p.audio_type, library, failed ? 0 : Math.round((0.6 + ((i * 37) % 50) / 100) * 1024 ** 3), p.end_at + 5000,
            failed ? null : JSON.stringify([{ start: 300, end: 360 }]), p.genre_detail, p.audios,
            failed ? null : p.end_at - p.start_at, 30,
            i === 1 ? 11 * 60_000 : null,
            // 未視聴は新しい12本ほど (途中まで観た1本目と失敗を除く)
            i >= 13 ? p.end_at + 3600_000 : null,
            failed ? 'チューナーが見つかりませんでした' : null,
            p.end_at + 5000, p.end_at + 5000);
    }
    // 録画中: いま放送中の番組に予約と録画中の行を置く
    const airing = programs.filter((p) => p.start_at <= now && p.end_at > now + 10 * 60_000);
    for (const p of airing.slice(0, 1)) {
        db.run('DELETE FROM reservations WHERE program_id = ?', [p.id]);
        const r = db.query<{ id: number }, [number, number, string, number, number, number, number, number]>(
            `INSERT INTO reservations (program_id, service_id, name, start_at, end_at, manual, state, started_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 'scheduled', ?, ?, ?) RETURNING id`)
            .get(p.id, p.service_id, p.name, p.start_at, p.end_at, p.start_at, now, now)!;
        const { series, subtitle } = seriesOf(p.name);
        db.run(`INSERT INTO recordings (reservation_id, program_id, service_id, service_name, name, series, subtitle, description,
            start_at, end_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.id, p.id, p.service_id, p.service_name, p.name, series, subtitle, p.description, p.start_at, p.end_at, now, now]);
    }
    db.close();
}

await seed();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--disable-gpu'] });
const counts: Record<string, number> = {};
try {
    for (const [w, h] of [[1366, 768], [390, 844]] as const) {
        for (const theme of ['dark', 'light'] as const) {
            const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1,
                locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: theme });
            const page = await ctx.newPage();
            await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
            await page.goto(`${BASE}/`);
            await page.locator('[data-hydrated="true"]').waitFor();
            await page.evaluate(async () => { await document.fonts.ready; });
            await page.waitForTimeout(1500);
            const key = `${NAME}-${w}x${h}-${theme}`;
            await page.screenshot({ path: join(OUT, `${key}.png`) });
            // 全部見えている行 (画面と、スクロールする枠の両方に収まっているもの)
            counts[key] = await page.evaluate(() => {
                const vw = innerWidth, vh = innerHeight;
                let n = 0;
                for (const el of document.querySelectorAll<HTMLElement>('.row, .group-head')) {
                    const r = el.getBoundingClientRect();
                    if (r.height === 0) continue;
                    let top = 0, bottom = vh, left = 0, right = vw;
                    for (let p = el.parentElement; p; p = p.parentElement) {
                        const s = getComputedStyle(p);
                        if (/(auto|scroll|hidden)/.test(s.overflowY)) {
                            const pr = p.getBoundingClientRect();
                            top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom);
                            left = Math.max(left, pr.left); right = Math.min(right, pr.right);
                        }
                    }
                    // 被さる見出し (sticky / fixed) に隠れていないか
                    const x = Math.min(right, r.right) - 12;
                    const hit = (y: number) => { const e = document.elementFromPoint(x, y); return e !== null && el.contains(e); };
                    if (r.top >= top - 0.5 && r.bottom <= bottom + 0.5 && r.left >= left - 0.5 && r.right <= right + 0.5 && hit(r.top + 2) && hit(r.bottom - 2)) n++;
                }
                return n;
            });
            console.log(key, counts[key]);
            await ctx.close();
        }
    }
    writeFileSync(join(OUT, `${NAME}-counts.json`), JSON.stringify(counts, null, 2));
} finally {
    await browser.close();
    await shutdown();
}
