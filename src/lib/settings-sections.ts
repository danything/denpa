/**
 * **設定のグループと節の並び。** グループごとに1つの画面 (`/settings/<グループ>`) があり、
 * 節はその画面に上から積む。節へは `#<節>` で飛ぶ。左の一覧 (`routes/settings/+layout.svelte`) はこの順に
 * グループと、その下に節を出す。フォームと保存 (actions) はグループの画面が持つ。
 *
 * 並びは 録画 → 受信 (入れたときと困ったとき) → 連携 → その他 (この端末・ログイン・バージョン。めったに開かないので下に置く。URL は前のまま `general`)。
 * 広い画面で `/settings` を開くと先頭のグループへ移る (`FIRST_GROUP`)。
 *
 * **節の名前 (`slug`) は前の画面の URL と同じにしてある** (`/settings/tuners` → `/settings/reception#tuners`)。
 * 前の URL は `MOVED_SECTIONS` で送る
 */
export const SETTINGS_GROUPS = [
  {
    slug: "recording",
    label: "録画",
    sections: [
      { slug: "encoding", label: "エンコード" },
      { slug: "cm", label: "CM" },
      { slug: "reserve", label: "自動予約" },
    ],
  },
  {
    slug: "reception",
    label: "受信",
    sections: [
      { slug: "tuners", label: "チューナー" },
      { slug: "channels", label: "チャンネル" },
      { slug: "broadcast", label: "データ放送" },
    ],
  },
  {
    slug: "integrations",
    label: "連携",
    sections: [
      { slug: "notifications", label: "通知" },
      { slug: "tv", label: "テレビのアプリ" },
      { slug: "migrate", label: "EPGStation からの引き継ぎ" },
    ],
  },
  {
    slug: "general",
    label: "その他",
    sections: [
      { slug: "browser", label: "この端末" },
      { slug: "login", label: "ログイン" },
      { slug: "version", label: "バージョン" },
    ],
  },
] as const satisfies readonly {
  slug: string;
  label: string;
  sections: readonly { slug: string; label: string }[];
}[];

export const FIRST_GROUP = "recording";

/**
 * **前の節ごとの画面の URL** (`/settings/<節>`) → 移った先 (`<グループ>#<節>`)。
 * ブックマークや説明書のリンクを切らないため (`routes/settings/[moved]/+server.ts` が 308 で送る)。
 * `general` と `recording` はグループの画面の URL と同じなので要らない
 */
export const MOVED_SECTIONS: Readonly<Record<string, string>> = {
  browser: "general#browser",
  tuners: "reception#tuners",
  channels: "reception#channels",
  // ロゴの節は受信できるチャンネルの表に入った (局ロゴ・CMロゴの列)
  logos: "reception#channels",
  broadcast: "reception#broadcast",
  notifications: "integrations#notifications",
  tv: "integrations#tv",
  migrate: "integrations#migrate",
};

/** グループの名前。画面のタイトルに使う */
export function groupLabel(slug: string): string | null {
  return SETTINGS_GROUPS.find((group) => group.slug === slug)?.label ?? null;
}

/**
 * **なくなった節の名前** → 入った先の節。前のリンク (`/settings/reception#logos`) で来たら、
 * その節へ飛んで URL も書き換える (`routes/settings/+layout.svelte`)。`#` は手元にしか来ないので、サーバでは送れない
 */
export const SECTION_ALIASES: Readonly<Record<string, string>> = {
  logos: "channels",
};
