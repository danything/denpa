/*
 * 公開するページの並びと上書き。文書の中身は ../docs/*.md と ../README.md のまま持ち、
 * ここには「サイトでどう見せるか」だけを書く (scripts/import-docs.ts と astro.config.ts が読む)。
 *
 * キーは docs のファイル名から .md を外したもの。README は `README` で、URL はトップ。
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

export const overrides: Record<string, PageOverride> = {};

/**
 * サイドバーの組と並び (README の「もっと詳しく」と同じ組)。ここに無いファイルは飛ばし、docs にあってここに無いものは
 * 最後の組の末尾に足す (docs を足しただけで消えることは無い)
 */
export const sidebarGroups: { label: string; items: string[] }[] = [
    { label: 'はじめる', items: ['install', 'install-mac', 'install-windows', 'screens'] },
    { label: 'チューナー', items: ['tuners', 'tuner-px4', 'tuner-px-s1ud'] },
    { label: '乗り換え', items: ['migrate'] },
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
