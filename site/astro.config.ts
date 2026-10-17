import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { sidebar } from './src/data/docs.ts';
import { repoUrl } from './src/data/pages.ts';

// 文書サイト (https://danything.github.io/denpa/)。中身は ../docs と ../README.md から
// scripts/import-docs.ts が書き出したもの。公開は .github/workflows/pages.yml
export default defineConfig({
    site: 'https://danything.github.io',
    base: '/denpa/',
    trailingSlash: 'always',
    // ルートの tsconfig.json まで探しに行かないように (理由は tsconfig.json)
    vite: { tsconfig: 'tsconfig.json' },
    integrations: [
        starlight({
            title: 'denpa',
            logo: { src: './src/assets/logo.svg' },
            favicon: '/favicon.svg',
            head: [{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/denpa/apple-touch-icon.png' } }],
            locales: { root: { label: '日本語', lang: 'ja' } },
            social: [{ icon: 'github', label: 'GitHub', href: repoUrl }],
            sidebar: sidebar(),
            customCss: ['./src/styles/site.css'],
            components: {
                // 既定のテーマを明るいほうに (切り替えは残す)
                ThemeProvider: './src/components/ThemeProvider.astro',
                // 全ページの下に「使ってよい範囲」の要約
                Footer: './src/components/Footer.astro',
                // 検索ボタンの「Ctrl K」を読み上げから外す
                Search: './src/components/Search.astro',
                // 横に長い表をキーボードでも動かせるように
                MarkdownContent: './src/components/MarkdownContent.astro',
            },
            expressiveCode: { styleOverrides: { borderRadius: '0.65rem' } },
        }),
    ],
});
