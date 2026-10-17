import { defineConfig, devices } from '@playwright/test';

// アクセシビリティの検査 (tests/a11y.spec.ts)。ビルドした dist を astro preview で配って調べる:
//   bun run build && bun run test:a11y
export default defineConfig({
    testDir: 'tests',
    fullyParallel: true,
    retries: process.env['CI'] ? 1 : 0,
    reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
    use: {
        baseURL: 'http://127.0.0.1:4321',
        reducedMotion: 'reduce',
    },
    webServer: {
        command: 'bunx --bun astro preview --host 127.0.0.1 --port 4321',
        url: 'http://127.0.0.1:4321/denpa/',
        reuseExistingServer: !process.env['CI'],
    },
    projects: [
        { name: 'desktop-light', use: { viewport: { width: 1280, height: 900 }, colorScheme: 'light' } },
        { name: 'desktop-dark', use: { viewport: { width: 1280, height: 900 }, colorScheme: 'dark' } },
        { name: 'mobile', use: { ...devices['Pixel 7'] } },
    ],
});
