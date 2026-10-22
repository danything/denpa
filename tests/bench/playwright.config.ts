import { defineConfig } from "@playwright/test";

/**
 * **測るだけの Playwright** (CI では流さない。docs/stream.md#デコードしたフレームを持つ数)。E2E と同じ一式
 * (`tests/stack.ts`) を1つだけ立て、1本ずつ順に流す。並べると互いの CPU を取り合って、測りたいものが混ざる。
 *
 *     docker compose --profile docs run --rm docs bunx playwright test -c tests/bench
 *
 * ffmpeg で作り物の映像を組むので、ffmpeg の入った `docs` のイメージで流す。ブラウザの設定は E2E
 * (`playwright.config.ts`) と同じ (GPU 無し・ダーク・動きを止める)
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.bench.ts",
  globalSetup: "../global-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 0,
  reporter: "list",
  use: {
    colorScheme: "dark",
    reducedMotion: "reduce",
    launchOptions: { args: ["--disable-gpu"] },
    // service worker の手元の写しを使わず、毎回アプリから読む
    serviceWorkers: "block",
  },
});
