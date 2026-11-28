/**
 * リリースの紹介の動画 (X に載せる短い画面録画) を撮る。**偽の放送 (作り物の局・番組・ロゴ) だけで撮る。**
 * 一式の立て方は `capture-docs.ts` と同じ (E2E の一式を `FAKE_PROFILE=docs` で立てる。`tests/fake/docs.ts`)。
 *
 *     docker compose run --rm docs bun scripts/capture-demo.ts hide-service   # 場面の名前を挙げる
 *     docker compose run --rm docs bun scripts/capture-demo.ts                # 名前が無ければ全部
 *
 * 出力は `docs/images/.capture/demo/<場面>.mp4` (コミットしない。`OUT` で置き場を変えられる)。
 *
 * **撮る条件はここに書いてある:** 画面は 1280×720 を deviceScaleFactor 1.5・暗いテーマ・ja-JP・Asia/Tokyo。
 * 録画のコマは 1280×720 で届くので、mp4 にするときに 1920×1080 へ拡大する。
 * Playwright の recordVideo で撮り、ffmpeg で H.264 High・yuv420p・30 fps・音声なし・faststart の mp4 にする
 * (X に上げられる形。長さは 140 秒まで)。
 *
 * 画面の無いブラウザにはマウスのカーソルが写らないので、ページに矢印を描き、マウスの動きに付いて動かす。
 * 押すときは要素の箱から座標を 1 つ決め、そこまでカーソルを滑らかに動かしてから同じ座標で押して離す
 * (`clickAt`)。Playwright の `click()` は要素の中心へマウスを一瞬で動かすので、押す瞬間にカーソルが飛んで写る
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  type Browser,
  chromium,
  type Locator,
  type Page,
} from "@playwright/test";

import { DOCS_SERVICES } from "../tests/fake/docs";
import { boot, type Stack } from "../tests/stack";
import { collect } from "./capture-stack";

const OUT = process.env["OUT"] ?? "docs/images/.capture/demo";
const FFMPEG = process.env["DOCS_FFMPEG"] ?? "/usr/bin/ffmpeg";
const FFPROBE = process.env["FFPROBE"] ?? "/usr/bin/ffprobe";
/** 画面の字 (`capture-docs.ts` と同じく、無いと別の字で写る) */
const FONT = "/usr/share/fonts/truetype/biz-ud/BIZUDPGothic-Regular.ttf";
const DENPA_FONT = "/usr/share/denpa-font/denpa-font.woff2";

/** 画面の広さ (CSS の px) と細かさ。動画は 1.5 倍に拡大して 1920×1080 にする */
const VIEW = { width: 1280, height: 720 };
const SCALE = 1.5;
const VIDEO = { width: VIEW.width * SCALE, height: VIEW.height * SCALE };
/** X に上げられる長さの上限 (秒) */
const MAX_SECONDS = 140;

/**
 * 1 つの場面。`prepare` で支度してから `start` を開き、落ち着いてから録り始め、`run` で操作する。
 * `prepare` の間も録画は回っているが、録り始めより前は mp4 にするときに切り落とす。
 * `prepare` が返した関数は、撮り終えたら (失敗しても) 呼ぶ
 */
interface Scene {
  start: string;
  prepare?: (page: Page, stack: Stack) => Promise<(() => void) | void>;
  run: (page: Page) => Promise<void>;
}

/** 隠して見せる局 (`tests/fake/docs.ts` の作り物の地上波) */
const WAKABA = DOCS_SERVICES.find((s) => s.name === "テレビわかば")!;
/** 実況のコメントを流す局 (作り物の地上波。局の番号が実況のチャンネルの表に当たる) */
const DENPA = DOCS_SERVICES.find((s) => s.name === "でんぱテレビ")!;
const DENPA_LIVE = `/live?service=${DENPA.id}`;

/** 実況の場面で流すコメント。どれも作った文で、実在の人や作品の名前を出さない。`mail` は色のコマンド */
const JIKKYO_LINES: { text: string; mail?: string }[] = [
  { text: "こんばんは" },
  { text: "始まった" },
  { text: "待ってました", mail: "184 yellow" },
  { text: "今日もよろしく" },
  { text: "画面きれい" },
  { text: "88888888", mail: "184 cyan" },
  { text: "カラーバーだ" },
  { text: "この時間が楽しみ" },
  { text: "おつかれさまです" },
  { text: "音もいい感じ" },
  { text: "きたきた" },
  { text: "ここ好き", mail: "184 pink" },
  { text: "今週も見てる" },
  { text: "わかる" },
  { text: "色が鮮やか" },
  { text: "なるほど" },
  { text: "いい流れ", mail: "184 green" },
  { text: "ちょうど帰ってきた" },
  { text: "まだ間に合った" },
  { text: "おお" },
  { text: "ナイス" },
  { text: "すごい" },
  { text: "明日も早いけど見る", mail: "184 orange" },
  { text: "いいね" },
];
/** 実況の場面で書き込む 1 行 (作った文) */
const JIKKYO_POST = "denpa から書き込んでみました";

const SCENES: Record<string, Scene> = {
  /**
   * 局を非表示にする (v2.63.0)。番組表のテレビわかばの列を指し、設定の「受信」の「チャンネル」で「非表示」を押し、
   * 番組表に戻って列が消えているところで止める
   */
  "hide-service": {
    start: "/guide?type=GR",
    run: async (page) => {
      const column = (name: string) =>
        page.locator(`[data-testid="guide-service"][title="${name}"]`);
      await page.waitForTimeout(1200);
      await glideTo(page, column(WAKABA.name));
      await page.waitForTimeout(2000);

      await clickAt(page, page.getByTestId("nav-settings"));
      await page.getByTestId("settings-nav-channels").waitFor();
      await page.waitForTimeout(1200);
      await clickAt(page, page.getByTestId("settings-nav-channels"));
      await page.waitForURL(/\/settings\/reception/);
      await settle(page, 1200);

      const row = page.locator(
        `[data-testid="channel-row"][data-service-id="${WAKABA.id}"]`,
      );
      await scrollToCenter(page, row, 1200);
      await page.waitForTimeout(700);
      await clickAt(page, row.getByTestId("service-hide"));
      await page.getByTestId("tuner-done").waitFor();
      await page.waitForTimeout(2800);

      await clickAt(page, page.getByTestId("nav-guide"));
      await page.waitForURL(/\/guide/);
      await column("みなとテレビ").waitFor();
      await settle(page, 600);
      // 消えた列のあった所 (みなとテレビとほしぞら放送の間) を指す
      const left = await column("みなとテレビ").boundingBox();
      if (left !== null)
        await glide(page, left.x + left.width, left.y + left.height / 2);
      await page.waitForTimeout(3200);
    },
  },

  /**
   * 実況のコメント (v2.64.0)。denpa のサーバが偽の denpa-hub (`tests/fake/denpa-hub.ts`) からコメントを受けて端末へ渡す。
   * 世帯はニコニコと連携しておく (偽の hub が中継する)。でんぱテレビのライブで映像の上にコメントが流れ、
   * 右端の列の「コメントの一覧」を開いて一覧に並ぶのを見せ、書き込みの欄から 1 行送り、自分の書き込み (縦線の印) が流れるところで止める
   */
  "jikkyo-comments": {
    start: DENPA_LIVE,
    prepare: async (page, stack) => {
      // 勢いは denpa のサーバが NX-Jikkyo から読むので、画面からの呼び出しに作り物の数を返す (外へ繋がない)
      const forces = [240, 85, 60, 42, 30, 18];
      await page.route("**/api/jikkyo/ranking", (route) =>
        route.fulfill({
          json: {
            at: Date.now(),
            channels: DOCS_SERVICES.filter((s) => s.type === "GR").map(
              (s, i) => ({ serviceId: s.id, force: forces[i] ?? 10 }),
            ),
          },
        }),
      );
      // 偽の hub が決まった本文を流し続けないようにする (下で 1 件ずつ流す)
      const control = await fetch(`${stack.hubUrl}/__control/jikkyo`, {
        method: "POST",
        body: JSON.stringify({ quiet: true }),
      });
      if (!control.ok) throw new Error(`偽の denpa-hub: ${control.status}`);

      // 世帯の設定の「実況」をオンにし、ニコニコと連携する (偽の hub は人を出さずに連携を返す)
      await page.goto(`${stack.appUrl}/settings/integrations`);
      await settle(page, 300);
      await page.getByTestId("jikkyo-setting").setChecked(true);
      await page.getByTestId("saved-result").waitFor();
      await page.goto(`${stack.appUrl}/settings/integrations#jikkyo`);
      await settle(page, 300);
      await page.getByTestId("niconico-link").click();
      await page.waitForURL(/\/settings\/integrations#jikkyo$/);
      await page
        .getByTestId("niconico-state")
        .filter({ hasText: "連携中" })
        .waitFor();

      // 端末の ⚙ の「実況」をオンにし、ライブは放送のまま (MPEG-2) で観る (変換する経路は偽 ffmpeg が映像を作らない)
      await page.evaluate(() => localStorage.setItem("player-jikkyo", "1"));
      await page.goto(`${stack.appUrl}${DENPA_LIVE}`);
      await settle(page, 500);
      await wake(page);
      await page.getByTestId("live-settings").click();
      await page.getByTestId("live-codec").click();
      await page
        .locator('[data-testid="live-codec-option"][data-codec="mpeg2"]')
        .click();

      const services = (await (
        await page.request.get(`${stack.appUrl}/api/services`)
      ).json()) as { id: number; jikkyo: string | null }[];
      const channel = services.find((s) => s.id === DENPA.id)?.jikkyo;
      if (typeof channel !== "string")
        throw new Error(`${DENPA.name} に実況のチャンネルが当たっていません`);
      // 0.4〜0.9 秒おきに 1 件ずつ、書かれた時刻を今にして流す。出どころは公式 (NX-Jikkyo が取り込んだもの)
      let next = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const emit = () => {
        const line = JIKKYO_LINES[next++ % JIKKYO_LINES.length]!;
        const comment = {
          at: Date.now(),
          text: line.text,
          mail: line.mail ?? "184",
          src: "nicolive",
        };
        fetch(`${stack.hubUrl}/__control/jikkyo/emit`, {
          method: "POST",
          body: JSON.stringify({ channel, comments: [comment] }),
        }).catch(() => {});
        timer = setTimeout(emit, 400 + Math.random() * 500);
      };
      emit();
      return () => {
        if (timer !== null) clearTimeout(timer);
      };
    },
    run: async (page) => {
      // 映像の上にコメントが流れる
      await page.getByTestId("jikkyo-comment").first().waitFor();
      await page.waitForTimeout(4000);

      // 右端の列の「コメントの一覧」を開く
      await wake(page);
      await clickAt(page, page.getByTestId("live-jikkyo-list"));
      await page
        .getByTestId("jikkyo-compose-line")
        .filter({ hasText: "ニコニコ実況に書きます" })
        .waitFor({ timeout: 20_000 });
      await page.waitForTimeout(2500);

      // 書き込みの欄に 1 行書いて送る
      await clickAt(page, page.getByTestId("jikkyo-compose-input"));
      await page.waitForTimeout(400);
      await page.keyboard.type(JIKKYO_POST, { delay: 120 });
      await page.waitForTimeout(800);
      await clickAt(page, page.getByTestId("jikkyo-compose-send"));
      await page
        .locator('[data-testid="jikkyo-comment"].mine-line')
        .first()
        .waitFor();
      await page.waitForTimeout(1500);
      // 一覧の自分の書き込みを指す
      await glideTo(
        page,
        page
          .getByTestId("jikkyo-list-row")
          .filter({ hasText: JIKKYO_POST })
          .last(),
      );
      await page.waitForTimeout(3500);
    },
  },
};

for (const [path, what] of [
  [FFMPEG, "ffmpeg"],
  [FFPROBE, "ffprobe"],
  [FONT, "BIZ UDPゴシック"],
  [DENPA_FONT, "Denpa Font"],
] as const) {
  if (!existsSync(path)) {
    throw new Error(
      `${what} がありません (${path})。イメージの docs 段で撮ってください`,
    );
  }
}

const only = process.argv.slice(2);
const unknown = only.filter((name) => !(name in SCENES));
if (unknown.length > 0)
  throw new Error(
    `場面 ${unknown.join("・")} はありません。撮れる場面: ${Object.keys(SCENES).join("・")}`,
  );
const scenes = only.length === 0 ? Object.keys(SCENES) : only;

// 偽エージェントは子プロセスなので、環境変数で作り物の局に切り替える
process.env["FAKE_PROFILE"] = "docs";

if (process.env["SKIP_BUILD"] !== "1") {
  const build = spawnSync("bun", ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("ビルドに失敗しました");
}

/**
 * **DB の局名が `tests/fake/docs.ts` の作り物だけであることを確かめる。** 違えば撮らずに止める
 * (本物の放送の局名・番組名を動画に写さないため。`FAKE_PROFILE` が効いていないときに当たる)
 */
function onlyDocsServices(stack: Stack): void {
  const allowed = new Set(DOCS_SERVICES.map((s) => s.name));
  const db = new Database(join(stack.root, "denpa.db"), { readonly: true });
  const names = db
    .query<{ name: string }, []>("SELECT name FROM services")
    .all()
    .map((row) => row.name);
  db.close();
  if (names.length === 0) throw new Error("局が 1 つもありません");
  const strange = names.filter((name) => !allowed.has(name));
  if (strange.length > 0)
    throw new Error(
      `偽の放送に無い局が DB にあります (${strange.join("・")})。撮らずに止めます`,
    );
}

/**
 * ページに描くカーソル (矢印)。マウスの動きに付いて動き、押すと波紋を出す。
 * ページを読み直しても同じ位置から描く (位置は sessionStorage に持つ)
 */
function cursorScript(): void {
  const KEY = "demo-cursor";
  let x = Number(sessionStorage.getItem(`${KEY}-x`) ?? innerWidth / 2);
  let y = Number(sessionStorage.getItem(`${KEY}-y`) ?? innerHeight / 2);
  let arrow: HTMLElement | null = null;
  const place = () => {
    if (arrow !== null) arrow.style.transform = `translate(${x}px, ${y}px)`;
  };
  const install = () => {
    if (document.getElementById(KEY) !== null) return;
    arrow = document.createElement("div");
    arrow.id = KEY;
    arrow.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d="M3 2v19l4.8-4.5 3.1 7 3.3-1.4-3-6.9H18z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    Object.assign(arrow.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "26px",
      height: "26px",
      pointerEvents: "none",
      zIndex: "2147483647",
      filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.5))",
    });
    // body の中身は SvelteKit が描き替えるので、その外 (html の直下) に置く
    document.documentElement.append(arrow);
    place();
  };
  window.addEventListener(
    "mousemove",
    (event) => {
      x = event.clientX;
      y = event.clientY;
      sessionStorage.setItem(`${KEY}-x`, String(x));
      sessionStorage.setItem(`${KEY}-y`, String(y));
      place();
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "mousedown",
    (event) => {
      const ring = document.createElement("div");
      Object.assign(ring.style, {
        position: "fixed",
        left: `${event.clientX - 18}px`,
        top: `${event.clientY - 18}px`,
        width: "36px",
        height: "36px",
        borderRadius: "50%",
        border: "3px solid rgb(255 255 255 / 0.9)",
        boxShadow: "0 0 6px rgb(0 0 0 / 0.4)",
        pointerEvents: "none",
        zIndex: "2147483646",
      });
      document.documentElement.append(ring);
      ring
        .animate(
          [
            { transform: "scale(0.3)", opacity: 1 },
            { transform: "scale(1.4)", opacity: 0 },
          ],
          { duration: 500, easing: "ease-out" },
        )
        .finished.then(
          () => ring.remove(),
          () => ring.remove(),
        );
    },
    { capture: true, passive: true },
  );
  if (document.readyState === "loading")
    window.addEventListener("DOMContentLoaded", install);
  else install();
}

/** Playwright はマウスの位置を返さないので、ページごとに持つ */
const pointer = new WeakMap<Page, { x: number; y: number }>();
/** 押した時刻 (撮り終えたら、動画の中の秒にして出す。押す瞬間のコマを確かめるのに使う) */
const clicks: number[] = [];

/**
 * カーソルを (x, y) まで滑らかに動かす。始めと終わりをゆっくりにし (ease-in-out)、
 * 遠いほど長くかける。1 コマぶんずつ `page.mouse.move` を送る。
 * 位置は経った時間から決める (マシンが混んでいて 1 回の送信が遅れても、かかる時間が延びない)
 */
async function glide(page: Page, x: number, y: number): Promise<void> {
  const from = pointer.get(page) ?? { x: VIEW.width / 2, y: VIEW.height / 2 };
  const distance = Math.hypot(x - from.x, y - from.y);
  const ms = Math.min(1100, 350 + distance * 0.7);
  const start = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - start) / ms);
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(
      from.x + (x - from.x) * ease,
      from.y + (y - from.y) * ease,
    );
    if (t === 1) break;
    await page.waitForTimeout(16);
  }
  pointer.set(page, { x, y });
}

/** 要素の箱の真ん中の座標。見えていなければ止める */
async function centerOf(target: Locator): Promise<{ x: number; y: number }> {
  await target.waitFor({ state: "visible" });
  const box = await target.boundingBox();
  if (box === null) throw new Error(`${target} の位置が取れません`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 要素を指す (押さない) */
async function glideTo(page: Page, target: Locator): Promise<void> {
  const { x, y } = await centerOf(target);
  await glide(page, x, y);
}

/** ライブの映像の上でカーソルを少し動かし、操作バーと右端の列を出す */
async function wake(page: Page): Promise<void> {
  const box = await page.getByTestId("live-frame").boundingBox();
  if (box === null) throw new Error("ライブの映像の位置が取れません");
  const from = pointer.get(page);
  const x = box.x + box.width * 0.6;
  const y = box.y + box.height * 0.45;
  await glide(page, from !== undefined && from.x === x ? x - 24 : x, y);
}

/**
 * **要素へカーソルを動かして押す。** 座標は動かす前に 1 つだけ決め、押すのも離すのも同じ座標
 * (押す瞬間にカーソルが動かない)。画面の外にある要素は、先に `scrollToCenter` で見えるところへ動かしておく
 */
async function clickAt(
  page: Page,
  target: Locator,
  { hover = 350 } = {},
): Promise<void> {
  const { x, y } = await centerOf(target);
  if (x < 0 || y < 0 || x > VIEW.width || y > VIEW.height)
    throw new Error(`${target} が画面の外にあります`);
  await glide(page, x, y);
  await page.waitForTimeout(hover);
  clicks.push(Date.now());
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
}

/** 窓ごと、要素が画面の真ん中に来るまで ms かけてゆっくりスクロールする */
async function scrollToCenter(
  page: Page,
  target: Locator,
  ms: number,
): Promise<void> {
  await target.waitFor();
  await target.evaluate(async (el, ms) => {
    const box = el.getBoundingClientRect();
    const from = scrollY;
    const to = Math.max(0, from + box.top - (innerHeight / 2 - box.height / 2));
    const start = performance.now();
    await new Promise<void>((done) => {
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms);
        const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        scrollTo({ top: from + (to - from) * ease, behavior: "instant" });
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  }, ms);
}

/** 字が届いて描き終わるまで待つ (Denpa Font は後から届く) */
async function settle(page: Page, ms: number): Promise<void> {
  await page.locator('[data-hydrated="true"]').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(ms);
}

/** 1 つの場面を録って mp4 にする */
async function shoot(
  browser: Browser,
  stack: Stack,
  name: string,
  scene: Scene,
): Promise<void> {
  const base = stack.appUrl;
  const raw = join(OUT, `${name}.raw`);
  rmSync(raw, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    colorScheme: "dark",
    // 録画のコマは CSS の px の大きさで届く (Chromium の画面配信。deviceScaleFactor を上げても 1280×720)。
    // その大きさで録り、mp4 にするときに 1920×1080 へ拡大する
    recordVideo: { dir: raw, size: VIEW },
  });
  await ctx.addInitScript(() => localStorage.setItem("theme", "dark"));
  await ctx.addInitScript(cursorScript);
  const opened = Date.now();
  const page = await ctx.newPage();
  const cleanup = await scene.prepare?.(page, stack);
  // 録画はページを作ったとき (`opened`) から始まる。支度と読み込みの間は切り落とす
  let begun: number;
  try {
    await page.goto(`${base}${scene.start}`);
    await settle(page, 1500);
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2);
    pointer.set(page, { x: VIEW.width / 2, y: VIEW.height / 2 });
    begun = Date.now();
    clicks.length = 0;
    await scene.run(page);
  } finally {
    cleanup?.();
  }
  const skip = (begun - opened) / 1000;
  const video = page.video();
  await ctx.close();
  if (video === null) throw new Error("録画がありません");
  const webm = await video.path();

  const mp4 = join(OUT, `${name}.mp4`);
  const made = spawnSync(
    FFMPEG,
    [
      ..."-hide_banner -loglevel error -y -ss".split(" "),
      skip.toFixed(2),
      "-i",
      webm,
      "-vf",
      `fps=30,scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos,format=yuv420p`,
      ..."-c:v libx264 -profile:v high -preset slow -crf 18 -an -movflags +faststart".split(
        " ",
      ),
      mp4,
    ],
    { stdio: "inherit" },
  );
  if (made.status !== 0) throw new Error(`${name} を mp4 にできませんでした`);
  rmSync(raw, { recursive: true, force: true });

  const probe = spawnSync(
    FFPROBE,
    [..."-v error -show_entries format=duration -of csv=p=0".split(" "), mp4],
    { encoding: "utf8" },
  );
  const seconds = Number(probe.stdout.trim());
  if (!(seconds > 0)) throw new Error(`${mp4} の長さが読めません`);
  if (seconds > MAX_SECONDS)
    throw new Error(
      `${name} が ${seconds.toFixed(1)} 秒あります (X に上げられるのは ${MAX_SECONDS} 秒まで)`,
    );
  console.log("demo", name, `${seconds.toFixed(1)} 秒`, mp4);
  console.log(
    "押した時刻 (秒)",
    clicks.map((at) => ((at - begun) / 1000).toFixed(2)).join(" "),
  );
}

const { stack, shutdown } = await boot(0);
let browser: Browser | null = null;
try {
  await collect(stack);
  onlyDocsServices(stack);
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ args: ["--disable-gpu"] });
  for (const name of scenes) await shoot(browser, stack, name, SCENES[name]!);
} finally {
  await browser?.close();
  await shutdown();
}
