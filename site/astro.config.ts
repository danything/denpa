import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { sidebar } from "./src/data/docs.ts";
import { base, ogImage, repoUrl } from "./src/data/pages.ts";

// 文書サイト (https://danything.github.io/denpa/)。中身は ../docs と ../README.md から
// scripts/import-docs.ts が書き出したもの。公開は .github/workflows/pages.yml

// Search Console の所有権の確認。値は Actions の変数 (GOOGLE_SITE_VERIFICATION) から渡し、ここには書かない
const siteVerification = process.env["GOOGLE_SITE_VERIFICATION"]?.trim();

// サイトの中のページを、開かれる前にブラウザに読ませておく (Speculation Rules。JavaScript は要らない)。
// eager は、パソコンではリンクにマウスを乗せてすぐ、スマホでは画面に見えているリンク。
//   - prerender: 裏で描画まで済ませ、押したら待たずに切り替わる
//   - prefetch: prerender が数の上限で捨てられたときも、HTML は取ってある
// 対象は /denpa/ の下のページだけ (画像・検索の索引・サイトマップ・同じページの中への移動は外す)。
// 対応していないブラウザ (Firefox・Safari) では普通に移る
const speculationTargets = {
  source: "document",
  where: {
    and: [
      { href_matches: `${base}*` },
      {
        not: {
          href_matches: [`${base}_astro/*`, `${base}pagefind/*`, `${base}*.*`],
        },
      },
      { not: { selector_matches: ['[href^="#"]', "[target]", "[download]"] } },
    ],
  },
  eagerness: "eager",
};
const speculationRules = {
  prefetch: [speculationTargets],
  prerender: [speculationTargets],
};

export default defineConfig({
  site: "https://danything.github.io",
  base,
  trailingSlash: "always",
  // ルートの tsconfig.json まで探しに行かないように (理由は tsconfig.json)
  vite: { tsconfig: "tsconfig.json" },
  integrations: [
    starlight({
      title: "denpa",
      logo: { src: "./src/assets/logo.svg" },
      favicon: "/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: "/denpa/apple-touch-icon.png",
          },
        },
        {
          tag: "script",
          attrs: { type: "speculationrules" },
          content: JSON.stringify(speculationRules),
        },
        // 全ページ共通の画像 (ページごとには作らない)。twitter:card (summary_large_image) は Starlight が付ける
        { tag: "meta", attrs: { property: "og:image", content: ogImage.url } },
        {
          tag: "meta",
          attrs: { property: "og:image:width", content: String(ogImage.width) },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image:height",
            content: String(ogImage.height),
          },
        },
        {
          tag: "meta",
          attrs: { property: "og:image:alt", content: ogImage.alt },
        },
        ...(siteVerification
          ? [
              {
                tag: "meta" as const,
                attrs: {
                  name: "google-site-verification",
                  content: siteVerification,
                },
              },
            ]
          : []),
      ],
      locales: { root: { label: "日本語", lang: "ja" } },
      social: [{ icon: "github", label: "GitHub", href: repoUrl }],
      sidebar: sidebar(),
      customCss: ["./src/styles/site.css"],
      // 文書のページにパンくず (構造化データ) を足す
      routeMiddleware: "./src/routeData.ts",
      components: {
        // 全ページの下に「使ってよい範囲」の要約
        Footer: "./src/components/Footer.astro",
        // 検索ボタンの「Ctrl K」を読み上げから外す
        Search: "./src/components/Search.astro",
        // 横に長い表をキーボードでも動かせるように
        MarkdownContent: "./src/components/MarkdownContent.astro",
      },
      // コードの枠は飾らない。シェルのコードにも端末の窓の飾り (左上の ●●●) を付けず、ほかのコードと同じ箱にする
      expressiveCode: {
        styleOverrides: { borderRadius: "0.65rem" },
        defaultProps: { frame: "code" },
      },
    }),
  ],
});
