/**
 * README と docs の絵を撮る。**偽の放送 (作り物の局・番組・ロゴ) だけで撮る** —
 * 本物の放送・ロゴ・本番の画面は絵に出さない。
 *
 *     docker compose run --rm docs                                          # 全部撮って docs/images へ
 *     docker compose run --rm docs bun scripts/capture-docs.ts watch live   # 名前を挙げるとそのぶんだけ
 *
 * CI でも撮れる (`.github/workflows/screenshots.yml`。手で走らせると絵を artifact に上げる)。
 *
 * 中でやること:
 *
 * 1. アプリを組み、E2E と同じ一式 (denpa + 偽エージェント + 偽通知先。`tests/stack.ts`) を
 *    `FAKE_PROFILE=docs` で立てる。局も番組もロゴも作り物に替わる (`tests/fake/docs.ts`)
 * 2. 番組表を集め、ルールと予約を画面と同じ口から入れる
 * 3. 録画は**DB に直接置く** (偽の放送の録画は数秒の作り物で、一覧に並べると尺が嘘になる)。
 *    中身は本物の ffmpeg で組んだ作り物の映像 (色が流れるだけ。台詞は作り物の字幕) とサムネ、CM のチャプター
 * 4. 撮って、`scripts/docs-webp.py` で webp にして docs/images に置く
 *
 * **撮る条件はここに書いてある** (散らばると撮り直しのたびに絵の大きさが揃わない):
 * 1600×900 (20インチの画面と同じ 16:9)・暗いテーマ・ja-JP・Asia/Tokyo。
 * 動く絵も同じ広さで動かし、貼るときに 1120×630 まで縮める (組み立ての側)。
 *
 * 字は本番と同じものを使う (イメージの `docs` 段): 画面は BIZ UDPゴシック、放送の字は
 * Denpa Font (`/api/font/denpa-font.woff2`)。どちらも無いと絵の字が別物になるので、
 * 無ければ撮らずに止まる
 */

import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';
import { docsCaptions } from '../tests/fake/docs';
import { boot } from '../tests/stack';

const OUT = process.env['OUT'] ?? 'docs/images/.capture';
const FFMPEG = process.env['DOCS_FFMPEG'] ?? '/usr/bin/ffmpeg';
/** 作り物の映像とサムネに書く字 (画面と同じ BIZ UDPゴシック) */
const FONT = '/usr/share/fonts/truetype/biz-ud/BIZUDPGothic-Bold.ttf';
const DENPA_FONT = '/usr/share/denpa-font/denpa-font.woff2';

for (const [path, what] of [
    [FFMPEG, 'ffmpeg'],
    [FONT, 'BIZ UDPゴシック'],
    [DENPA_FONT, 'Denpa Font'],
] as const) {
    if (!existsSync(path)) {
        throw new Error(`${what} がありません (${path})。イメージの docs 段で撮ってください`);
    }
}

const only = process.argv.slice(2);
const want = (n: string) => only.length === 0 || only.includes(n);

// 偽エージェントは子プロセスなので、環境変数で作り物の局に切り替える
process.env['FAKE_PROFILE'] = 'docs';
// 観る画面の字幕も作り物の台詞に (偽 ffmpeg が返す。tests/fake/ffmpeg.sh)
const CAPTIONS = '/tmp/denpa-docs-captions.mkv';
writeFileSync(CAPTIONS, docsCaptions());
process.env['FAKE_FFMPEG_CAPTIONS'] = CAPTIONS;

if (process.env['SKIP_BUILD'] !== '1') {
    const build = spawnSync('bun', ['run', 'build'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('ビルドに失敗しました');
}

const { stack, shutdown } = await boot(0);
const BASE = stack.appUrl;

/** 画面と同じ口へ投げる。SvelteKit は Origin の無いフォームを断る */
async function post(path: string, body: Record<string, string | string[]> | null): Promise<void> {
    const init: RequestInit = { method: 'POST', redirect: 'manual', headers: { Origin: BASE } };
    if (body !== null) {
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(body)) {
            for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
        }
        init.body = form;
    } else {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${BASE}${path}`, init);
    if (res.status >= 400) throw new Error(`${path} が ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

function ffmpeg(args: string[]): void {
    const run = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
        stdio: 'inherit',
    });
    if (run.status !== 0) throw new Error(`ffmpeg が失敗しました: ${args.join(' ')}`);
}

/** drawtext に渡す字はファイル越しに (引用符や記号を逃がさずに済む) */
function textFile(name: string, text: string): string {
    const path = join(stack.root, 'docs-text', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
}

/** 番組ごとの色 (グラデーションの2色)。ジャンルで決める */
const PALETTE: Record<number, [string, string]> = {
    0: ['0x16324f', '0x2f6690'],
    1: ['0x1b4332', '0x52b788'],
    2: ['0x3d2c52', '0x8e6bb8'],
    3: ['0x5b1a2e', '0xc0566f'],
    4: ['0x3a1f5d', '0xc65bcf'],
    5: ['0x6b3e00', '0xf4a259'],
    6: ['0x101820', '0x5a6f8c'],
    7: ['0x0b3954', '0x37c8c3'],
    8: ['0x283618', '0x8a9a5b'],
    10: ['0x5e3023', '0xd4a373'],
};

function colorsOf(genre: number): [string, string] {
    return PALETTE[genre] ?? ['0x22223b', '0x4a4e69'];
}

/** サムネ (480 幅)。色の流れに番組名。録画の詳細と一覧に出る */
function poster(path: string, series: string, genre: number, key: string): void {
    const [c0, c1] = colorsOf(genre);
    // 「ドラマ「…」」の括弧の中だけを大きく書く (小さい絵なので長いと読めない)
    const title = series.match(/「(.+)」$/)?.[1] ?? series;
    const size = Math.min(56, Math.floor(440 / [...title].length));
    ffmpeg([
        '-f',
        'lavfi',
        '-i',
        `gradients=s=480x270:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=480:y1=270:d=1`,
        '-vf',
        `drawtext=fontfile=${FONT}:textfile=${textFile(`${key}.txt`, title)}:fontsize=${size}:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:shadowcolor=black@0.4:shadowx=2:shadowy=2`,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        path,
    ]);
}

/**
 * 観る画面で流す作り物の映像 (30分・10コマ/秒・無音)。色が流れるだけで、左上に「サンプル映像」。
 * 録画はどれもこれを使い回す (番組の中身は字幕で出る。`docsCaptions`)。
 * 5分から1分だけ「ＣＭ」の札が出て、そこが CM のチャプターになる (本物の焼き上がりと同じ入れ方。`cm.chapterMetadata`)
 */
const CLIP_SECONDS = 30 * 60;
const CM = { start: 300, end: 360 };
function clip(path: string): void {
    const [c0, c1] = colorsOf(7);
    const chapters = join(stack.root, 'docs-text', 'chapters.txt');
    mkdirSync(dirname(chapters), { recursive: true });
    const chapter = (start: number, end: number, name: string) =>
        `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${start * 1000}\nEND=${end * 1000}\ntitle=${name}\n`;
    writeFileSync(
        chapters,
        `;FFMETADATA1\n${chapter(0, CM.start, '本編')}${chapter(CM.start, CM.end, 'CM')}${chapter(CM.end, CLIP_SECONDS, '本編')}`,
    );
    const text = textFile('clip.txt', 'サンプル映像');
    const cm = textFile('cm.txt', 'ＣＭ');
    ffmpeg([
        '-f',
        'lavfi',
        '-i',
        `gradients=s=1280x720:c0=${c0}:c1=${c1}:n=2:speed=0.003:r=10:d=${CLIP_SECONDS}`,
        '-f',
        'lavfi',
        '-i',
        `anullsrc=r=48000:cl=stereo:d=${CLIP_SECONDS}`,
        '-i',
        chapters,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map_chapters',
        '2',
        '-vf',
        [
            `drawtext=fontfile=${FONT}:textfile=${text}:fontsize=28:fontcolor=white@0.7:x=40:y=32:enable='not(between(t,${CM.start},${CM.end}))'`,
            `drawtext=fontfile=${FONT}:textfile=${cm}:fontsize=120:fontcolor=white:x=(w-tw)/2:y=(h-th)/2:enable='between(t,${CM.start},${CM.end})'`,
        ].join(','),
        '-t',
        String(CLIP_SECONDS),
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-row-mt',
        '1',
        '-b:v',
        '300k',
        '-g',
        '100',
        '-c:a',
        'libopus',
        '-b:a',
        '24k',
        path,
    ]);
}

interface ProgramRow {
    id: number;
    service_id: number;
    service_name: string;
    type: string;
    name: string;
    description: string;
    extended: string | null;
    genre_detail: string | null;
    audios: string | null;
    audio_type: number | null;
    start_at: number;
    end_at: number;
}

/** `星屑ステーション #3「月の時刻表」` → 番組名と副題 */
function seriesOf(name: string): { series: string; subtitle: string } {
    const m = name.match(/^(.*?) #\d+「(.*)」$/);
    return m === null ? { series: name, subtitle: '' } : { series: m[1]!, subtitle: m[2]! };
}

function stamp(at: number): string {
    const d = new Date(at);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} - ${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 局ロゴを集める (チューナー画面の「今すぐ取得」と同じ口)。番組表とライブの局の列に出る。
 * 終わるまで待つ — 集めている間はチューナーが塞がり、ライブが映らない
 */
async function sweepLogos(): Promise<void> {
    await post('/tuners?/logoSweep', {});
    const until = Date.now() + 180_000;
    while (Date.now() < until) {
        const html = await (await fetch(`${BASE}/tuners`)).text();
        if (html.includes('data-testid="logo-sweep-done"')) return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('局ロゴの取得が3分で終わりませんでした');
}

async function seed(): Promise<void> {
    // 番組表。偽エージェントから集める (画面の「今すぐ集める」と同じ口)
    await post('/api/sync', null);
    await sweepLogos();
    // 1回目で取りこぼした局 (チューナーの取り合いで待ちきれなかったもの) を集め直す
    await post('/api/sync', null);

    // GPU (偽物。置いたファイルを偽 ffmpeg が「ある」と答える) と、EPGStation の引き継ぎ元。
    // 無いと設定画面に作業場の住所入りの「見つかりません」が出る
    writeFileSync(join(stack.hwDir, 'renderD128'), '');
    await post('/settings?/probeHw', {});
    mkdirSync(stack.epgstationDir, { recursive: true });

    // ルール (画面のフォームと同じものを投げる)。当てると予約が立つ
    await post('/rules?/create', { keyword: '星屑ステーション', dedupe: ['0', '1'] });
    await post('/rules?/create', { keyword: '鉄道でめぐる日本', dedupe: ['0', '1'] });
    await post('/rules?/create', { keyword: 'ひだまり荘', dedupe: ['0', '1'] });
    await post('/rules?/create', { keyword: '', genres: ['6'], serviceTypes: ['BS'], dedupe: ['0', '1'] });

    const db = new Database(join(stack.root, 'denpa.db'));
    const now = Date.now();
    const programs = db
        .query<ProgramRow, []>(
            `SELECT p.id, p.service_id, s.name AS service_name, s.type, p.name, p.description, p.extended,
                    p.genre_detail, p.audios, p.audio_type, p.start_at, p.end_at
               FROM programs p JOIN services s ON s.id = p.service_id
              WHERE s.service_type = 1
              ORDER BY p.start_at`,
        )
        .all();
    if (programs.length === 0) throw new Error('番組表が空です');

    // 手で入れた予約。これから始まる番組をいくつか (番組表の「予約」と同じ口)
    const upcoming = programs.filter((p) => p.start_at > now + 60 * 60_000);
    for (const name of ['こども科学クラブ', '港町レシピ帖', 'サッカー中継']) {
        const target = upcoming.find((p) => p.name.startsWith(name));
        if (target !== undefined) await post('/guide?/reserve', { programId: String(target.id) });
    }

    /*
     * 録画。終わった番組から、番組名が重ならないように新しい順に拾う。同じ時刻の番組は
     * 2本まで (並んだ録画の時刻がばらけるように)。中身は1本の作り物を全部で使い回す
     */
    const seen = new Set<string>();
    const slots = new Map<number, number>();
    const picked: ProgramRow[] = [];
    for (const p of [...programs].reverse()) {
        if (p.end_at > now || p.end_at - p.start_at !== 30 * 60_000) continue;
        const { series } = seriesOf(p.name);
        if (seen.has(series) || (slots.get(p.start_at) ?? 0) >= 2) continue;
        seen.add(series);
        slots.set(p.start_at, (slots.get(p.start_at) ?? 0) + 1);
        picked.push(p);
        if (picked.length === 12) break;
    }
    if (picked.length === 0) throw new Error('録画にできる終わった番組がありません');

    const genreOf = (p: ProgramRow) =>
        (JSON.parse(p.genre_detail ?? '[]') as { lv1: number }[])[0]?.lv1 ?? -1;
    const master = join(stack.root, 'docs-clip.mkv');
    console.log('作り物の映像を組んでいます…');
    clip(master);

    const insert = db.prepare(
        `INSERT INTO recordings (program_id, service_id, service_name, name, series, subtitle, description,
            extended, start_at, end_at, audio_type, library_path, ts_size, finished_at, cm_ranges, genre_detail,
            audios, duration_ms, fps, cm_note, encode_skip, resume_ms, watched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [i, p] of picked.entries()) {
        const { series, subtitle } = seriesOf(p.name);
        const library = join(stack.encodedDir, series, `${series} - ${stamp(p.start_at)}.mkv`);
        mkdirSync(dirname(library), { recursive: true });
        rmSync(library, { force: true });
        linkSync(master, library);
        poster(library.replace(/\.mkv$/, '-poster.jpg'), series, genreOf(p), `poster-${i}`);
        insert.run(
            p.id,
            p.service_id,
            p.service_name,
            p.name,
            series,
            subtitle,
            p.description,
            p.extended,
            p.start_at,
            p.end_at,
            p.audio_type,
            library,
            // 大きさは本物の30分ものくらい (AV1 で 0.6〜1.1 GB)。置いたファイルは小さい作り物
            Math.round((0.6 + ((i * 37) % 50) / 100) * 1024 ** 3),
            p.end_at + 5_000,
            JSON.stringify([CM]),
            p.genre_detail,
            p.audios,
            CLIP_SECONDS * 1000,
            30,
            null,
            0,
            // 2本目は途中まで観たもの、4本目から先は観終えたもの (一覧の印が揃わないように)
            i === 1 ? 11 * 60_000 : null,
            i >= 3 ? p.end_at + 60 * 60_000 : null,
            p.end_at + 5_000,
            p.end_at + 5_000,
        );
    }

    // 通知先と、繋いだテレビ (設定画面に並ぶもの)。どちらも作り物の値
    db.run(
        `INSERT INTO webhooks (url, events, enabled, last_status, last_sent_at, created_at)
         VALUES ('https://hooks.example.com/denpa', '[]', 1, '204', ?, ?)`,
        [now - 3 * 60 * 60_000, now - 7 * 24 * 60 * 60_000],
    );
    db.run(
        `INSERT INTO api_tokens (name, token_hash, created_at, last_used_at, created_by)
         VALUES ('居間のテレビ', 'docs-sample', ?, ?, 'trusted-network')`,
        [now - 5 * 24 * 60 * 60_000, now - 20 * 60_000],
    );
    db.close();
}

async function open(browser: Browser, width: number, height: number): Promise<Page> {
    const ctx = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        colorScheme: 'dark',
    });
    const page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    return page;
}

/** 字が届いてから撮る (Denpa Font は後から届く。届く前に撮ると放送の字だけ別の字になる) */
async function settle(page: Page, ms = 1500): Promise<void> {
    await page.locator('[data-hydrated="true"]').waitFor();
    await page.evaluate(async () => {
        await document.fonts.ready;
    });
    await page.waitForTimeout(ms);
}

async function still(page: Page, name: string): Promise<void> {
    await settle(page);
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log('still', name);
}

/** 動かしながら撮る。fn の間ずっとコマを貯め、アニメ WebP の材料にする */
async function anim(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
    const frames: { buf: Buffer; t: number }[] = [];
    let running = true;
    const loop = (async () => {
        while (running) {
            frames.push({ buf: await page.screenshot({ type: 'png' }), t: Date.now() });
            await page.waitForTimeout(90);
        }
    })();
    await fn();
    running = false;
    await loop;
    // コマの間隔を実時間で。最後のコマは少し長く見せる。組み立ては Python (Pillow) で
    const dir = join(OUT, `${name}.frames`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    frames.forEach((f, i) => {
        writeFileSync(join(dir, `${String(i).padStart(4, '0')}.png`), f.buf);
    });
    const delays = frames.map((f, i) => (i + 1 < frames.length ? frames[i + 1]!.t - f.t : 1500));
    writeFileSync(join(dir, 'delays.json'), JSON.stringify(delays));
    console.log('anim', name, frames.length, 'frames');
}

async function slowScroll(page: Page, steps = 40): Promise<void> {
    const total = await page.evaluate(() => {
        const el = document.scrollingElement;
        return el ? el.scrollHeight - el.clientHeight : 0;
    });
    for (let i = 1; i <= steps; i++) {
        await page.evaluate((y) => document.scrollingElement?.scrollTo({ top: y }), (total * i) / steps);
        await page.waitForTimeout(120);
    }
    await page.waitForTimeout(800);
}

/** 観る画面を「観ている途中」にする。字幕の出る位置へ送り、速さを ×1.25 に */
async function watching(page: Page): Promise<void> {
    const video = page.getByTestId('watch-video');
    await video.waitFor();
    await page.waitForFunction(() => {
        const v = document.querySelector<HTMLVideoElement>('[data-testid="watch-video"]');
        return v !== null && v.readyState >= 2;
    });
    // 2行の台詞が出ているところ (docsCaptions は 1 秒から 4 秒ごと)
    await video.evaluate((v: HTMLVideoElement) => {
        v.currentTime = 9.5;
        void v.play();
    });
    await page.getByTestId('watch-speed').click();
    await page.getByTestId('watch-speed-option').filter({ hasText: '×1.25' }).click();
}

/**
 * ライブを「生で見る」(MPEG-2 をブラウザで解く) にする。焼く道は偽 ffmpeg が素通しするだけで
 * 絵にならないが、生の道は偽の放送の映像 (色帯) をそのまま解いて描ける。選んだものは端末に覚える
 */
async function liveRaw(page: Page): Promise<void> {
    await page.goto(`${BASE}/live`);
    await settle(page, 500);
    await wake(page, 'live-frame');
    await page.getByTestId('live-codec').click();
    await page.locator('[data-testid="live-codec-option"][data-codec="mpeg2"]').click();
}

/** 一覧のうち、いま画面に全部見えている最初の録画の行 (下から積む枠なので、頭の行は切れている) */
async function visibleRow(page: Page) {
    const rows = page.getByTestId('recording-row');
    for (let i = 0; i < (await rows.count()); i++) {
        const box = await rows.nth(i).boundingBox();
        if (box !== null && box.y > 140 && box.y + box.height < 880) return rows.nth(i);
    }
    return rows.first();
}

async function wake(page: Page, stage: string): Promise<void> {
    const box = await page.getByTestId(stage).boundingBox();
    if (box === null) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 4);
}

let browser: Browser | null = null;
try {
    await seed();
    mkdirSync(OUT, { recursive: true });
    browser = await chromium.launch({
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-gpu'],
    });
    /** 観る画面に出す録画。一覧の動く絵で押すのと同じ行 */
    const watched = async (page: Page) => {
        await page.goto(`${BASE}/`);
        await settle(page, 300);
        return await (await visibleRow(page)).getAttribute('data-recording-id');
    };

    // 静止画 (1600×900。20インチの画面と同じ 16:9)
    {
        const page = await open(browser, 1600, 900);
        if (want('dashboard')) {
            await page.goto(`${BASE}/`);
            await still(page, 'dashboard');
        }
        if (want('guide-bs')) {
            await page.goto(`${BASE}/guide?type=BS`);
            await still(page, 'guide-bs');
        }
        if (want('watch')) {
            await page.goto(`${BASE}/watch/${await watched(page)}`);
            await settle(page, 500);
            await watching(page);
            await page.waitForTimeout(4000);
            await wake(page, 'watch-stage');
            await page.waitForTimeout(600);
            await page.screenshot({ path: join(OUT, 'watch.png') });
            console.log('still watch');
        }
        if (want('live')) {
            await liveRaw(page);
            await page.waitForTimeout(8000);
            await still(page, 'live');
        }
        if (want('rules')) {
            // 書きかけのルール。右に「いま何が引っかかるか」が出る
            await page.goto(`${BASE}/rules`);
            await settle(page, 300);
            await page.locator('input[name="keyword"]').first().fill('ニュース');
            await page.getByRole('button', { name: '何が録れるか見る' }).click();
            await still(page, 'rules');
        }
        await page.context().close();
    }

    // 動く絵 (静止画と同じ 1600×900 で動かす。貼るときの大きさは組み立てで縮める)
    {
        const page = await open(browser, 1600, 900);
        if (want('home-watch-anim')) {
            await page.goto(`${BASE}/`);
            await settle(page);
            await anim(page, 'home-watch-anim', async () => {
                await page.waitForTimeout(1200);
                const row = await visibleRow(page);
                await row.hover();
                await page.waitForTimeout(900);
                await row.click();
                await page.waitForTimeout(6500);
            });
        }
        if (want('detail-anim')) {
            await page.goto(`${BASE}/`);
            await settle(page);
            await anim(page, 'detail-anim', async () => {
                await page.waitForTimeout(1000);
                await (await visibleRow(page)).getByRole('button', { name: '詳細' }).click();
                await page.waitForTimeout(2500);
                const more = page.getByTestId('program-detail').getByRole('button', { name: /その他/ });
                if (await more.count()) {
                    await more.click();
                    await page.waitForTimeout(2500);
                    await page.keyboard.press('Escape');
                    await page.waitForTimeout(800);
                }
                await page.getByTestId('detail-close').click();
                await page.waitForTimeout(1000);
            });
        }
        if (want('guide-anim')) {
            await page.goto(`${BASE}/guide?type=GR`);
            await settle(page, 2000);
            await anim(page, 'guide-anim', async () => {
                await page.waitForTimeout(1000);
                await page
                    .getByTestId('guide-grid')
                    .evaluate((el) => el.scrollBy({ top: 240, behavior: 'smooth' }));
                await page.waitForTimeout(1500);
                await page
                    .getByTestId('guide-grid')
                    .evaluate((el) => el.scrollBy({ left: 300, behavior: 'smooth' }));
                await page.waitForTimeout(1500);
                await page.getByTestId('program-button').nth(6).click();
                await page.waitForTimeout(3000);
                await page.getByTestId('detail-close').click();
                await page.waitForTimeout(1200);
            });
        }
        if (want('live-anim')) {
            await liveRaw(page);
            await page.goto(`${BASE}/live`);
            await anim(page, 'live-anim', async () => {
                await page.waitForTimeout(9000);
            });
        }
        if (want('tuners-anim')) {
            await page.goto(`${BASE}/tuners`);
            await settle(page, 2000);
            await anim(page, 'tuners-anim', async () => {
                await page.waitForTimeout(1000);
                await slowScroll(page, 60);
            });
        }
        if (want('settings-anim')) {
            await page.goto(`${BASE}/settings`);
            await settle(page, 2000);
            await anim(page, 'settings-anim', async () => {
                await page.waitForTimeout(1000);
                await slowScroll(page, 50);
            });
        }
        await page.context().close();
    }
} finally {
    await browser?.close();
    await shutdown();
}

// 組み立てて docs/images へ (動く絵は縮め、同じコマはまとめる)
const webp = spawnSync('python3', ['scripts/docs-webp.py', ...only], { stdio: 'inherit' });
if (webp.status !== 0) throw new Error('webp の組み立てに失敗しました');
