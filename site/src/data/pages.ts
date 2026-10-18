/*
 * 公開するページの並びと上書き。文書の中身は ../docs/*.md と ../README.md のまま持ち、
 * ここには「サイトでどう見せるか」だけを書く (scripts/import-docs.ts と astro.config.ts が読む)。
 *
 * キーは docs のファイル名から .md を外したもの。README はページにせず、節ごとにトップへ出す (topSections)。
 * 書かなかったものは、title は先頭の H1、description は最初の段落、URL はファイル名になる。
 */
export interface PageOverride {
    /** URL (base の下)。既定はファイル名 (`install` → /denpa/install/) */
    slug?: string;
    /** <title> とページの見出し。検索で出したい呼び名があれば書く */
    title?: string;
    /** 検索結果やリンクの下見に出る説明。既定は最初の段落を平文にして 120 字ほど */
    description?: string;
}

/**
 * 検索で出したい呼び名と説明。title は「<title> | denpa」の前半とページの見出しになる。
 * 型番・「録画サーバ」・乗り換え元の名前 (Mirakurun・EPGStation) のように、探す人が打つ言葉を入れる
 */
export const overrides: Record<string, PageOverride> = {
    install: {
        title: 'テレビ録画サーバ denpa を立てる',
        description:
            '自宅用のテレビ録画サーバ denpa の入れ方。1行で入れる方法、Compose・1コンテナ・Helm、誰を通すか、リバースプロキシの後ろに置くとき。Mirakurun や EPGStation は要りません。',
    },
    'install-mac': {
        title: 'Mac でテレビ録画サーバを立てる',
        description:
            'Apple Silicon の Mac に、テレビ録画サーバ denpa を1行で入れる方法。チューナーのエージェントは Mac の上で、denpa 本体は Docker で動かします。',
    },
    'install-windows': {
        title: 'Windows でテレビ録画サーバを立てる',
        description:
            'x64 の Windows に、PowerShell の1行でテレビ録画サーバ denpa を入れる方法。Docker Desktop は要らず、denpa 本体は WSL のコンテナで動かします。',
    },
    tuners: {
        title: '使えるチューナー (PT3・PX-Q3U4・PX-W3U4・PX-S1UD ほか)',
        description:
            'テレビ録画サーバ denpa で使えるチューナーの一覧と、カードリーダー・B-CASカード・うまく動かないときのこと。Mirakurun を立てなくても、挿せば自動で見つけます。',
    },
    'tuner-px4': {
        title: 'PX-Q3U4・PX-W3U4・PX-MLT で録画サーバを立てる',
        description:
            'PX-Q3U4・PX-W3U4・PX-MLT を、ホストにドライバ (px4_drv) を入れずに録画サーバで使う方法。px4-userland をエージェントに同梱していて、Mirakurun も要りません。',
    },
    'tuner-px-s1ud': {
        title: 'PX-S1UD で録画サーバを立てる',
        description:
            'PX-S1UD を、ホストに何も入れずに録画サーバで使う方法 (siano-userland)。カーネルのドライバ (smsusb) と取り合わないための blacklist も。',
    },
    migrate: {
        title: 'EPGStation から denpa に乗り換える',
        description:
            'EPGStation の録画・ルール・手動予約を denpa に引き継ぐ方法。設定画面から実行し、何度走らせても二重にはなりません。Mirakurun も要らなくなります。',
    },
    screens: {
        title: '画面 (スクリーンショット)',
    },
};

/**
 * トップ (src/pages/index.astro) に出す README の節。中身は README のまま取り込む (scripts/import-docs.ts)。
 * heading は README の見出しそのもの (id もそこから作る)、label はトップでの見出し (既定は heading)
 */
export const topSections: { key: string; heading: string; label?: string }[] = [
    { key: 'features', heading: 'できること' },
    { key: 'usage', heading: '使ってよい範囲' },
    { key: 'install', heading: '2. 入れる', label: '1行で入れる' },
];

/** トップの入口のカード。doc のページの説明を出し、more は下に並べるリンク。まだ無い文書は出さない */
export const topEntrances: { label: string; doc: string; more?: string[] }[] = [
    { label: '入れ方', doc: 'install', more: ['install-mac', 'install-windows'] },
    { label: 'チューナー', doc: 'tuners', more: ['tuner-px4', 'tuner-px-s1ud'] },
    { label: '乗り換え', doc: 'migrate' },
    { label: 'よくある質問', doc: 'faq' },
];

/** サイトの置き場 (GitHub Pages のリポジトリ名)。astro.config.ts の base と、リンクを組むところが使う */
export const base = '/denpa/';

/** サイトの URL (OGP・構造化データの元)。astro.config.ts の site + base */
export const siteUrl = `https://danything.github.io${base}`;

/** 全ページ共通の OGP の画像 (public/og.png、1200×630)。ロゴと名前と一言だけで、放送の映像は入れない */
export const ogImage = {
    url: `${siteUrl}og.png`,
    width: 1200,
    height: 630,
    alt: 'denpa — 自宅用のテレビ録画サーバ',
};

/** トップの見出しの下の一言 (OGP の画像にも同じ字を入れてある) */
export const tagline = '自宅用のテレビ録画サーバ';

/**
 * サイドバーの組と並び (README の「もっと詳しく」と同じ組)。ここに無いファイルは飛ばし、docs にあってここに無いものは
 * 最後の組の末尾に足す (docs を足しただけで消えることは無い)
 */
export const sidebarGroups: { label: string; items: string[] }[] = [
    { label: 'はじめる', items: ['install', 'install-mac', 'install-windows', 'screens', 'faq', 'v2'] },
    { label: 'チューナー', items: ['tuners', 'tuner-pt3', 'tuner-px4', 'tuner-px-s1ud'] },
    { label: '乗り換え', items: ['switch', 'migrate'] },
    { label: '使う', items: ['watch', 'offline', 'library'] },
    { label: '運用', items: ['config', 'auth'] },
    { label: '外から使う', items: ['api'] },
    {
        label: '仕組み',
        items: [
            'architecture',
            'app',
            'agent',
            'data',
            'stream',
            'stream-history',
            'player',
            'encode',
            'cm',
            'logo',
            'development',
            'writing',
            'licenses',
        ],
    },
];

/**
 * 放送の映像が映っている画像 (docs/images のファイル名)。偽の放送で撮ったものだと分かるよう、
 * 下に添え書きを付ける
 */
export const videoImages = [
    'dashboard.webp',
    'home-watch-anim.webp',
    'detail-anim.webp',
    'live.webp',
    'live-anim.webp',
    'watch.webp',
];

export const videoImageNote = '画面の映像は試験用に作った偽の放送です';

export const repoUrl = 'https://github.com/danything/denpa';

/**
 * トップの見出しの横に出す画面 (docs/images のファイル名)。映像が映っていない画面 (番組表など) を選ぶ。
 * 映像が映る画面 (videoImages) にしたときは、偽の放送の添え書きも付く
 */
export const heroImage = { file: 'guide-bs.webp', alt: 'BS の番組表' };
