/**
 * README と docs の絵を撮るための**作り物の放送** (`FAKE_PROFILE=docs`。`scripts/capture-docs.ts`)。
 *
 * テストの偽放送は局名が本物で (局ごとの癖を試すため)、ロゴも実機から拾ったもの。
 * **絵に本物の局・番組・ロゴを出さない**ので、絵を撮るときだけ局も番組もロゴも全部ここの
 * 作り物に差し替える。並べ方 (中継・サービス種別・カルーセルの載り方) はテストと同じ道を通る
 */
import { deflateSync } from 'node:zlib';
import { captionMkv, encodeAribText, management, text } from '../../src/lib/ts/synth-caption';
import type { FakeService } from './services';

/** 地上波の局。ID の作り方は本物と同じ (network_id × 100000 + service_id) */
function gr(
    networkId: number,
    serviceId: number,
    name: string,
    channel: string,
    remoteKey: number,
): FakeService {
    return {
        id: networkId * 100000 + serviceId,
        serviceId,
        networkId,
        name,
        type: 'GR',
        channel,
        slotMs: 30 * 60_000,
        serviceType: 1,
        remoteKey,
    };
}

function sat(serviceId: number, name: string, type: 'BS' | 'CS' = 'BS'): FakeService {
    return {
        id: (type === 'BS' ? 4 : 6) * 100000 + serviceId,
        serviceId,
        networkId: type === 'BS' ? 4 : 6,
        name,
        type,
        /*
         * 衛星は種別ごとに1つの中継にまとめる。番組表は中継を1つ読めば全局ぶん揃う作り
         * (本物も他局の番組表が乗っている)。CS も置く — 無いと denpa が標準の表 (本物の局名) から入れる
         */
        channel: type === 'BS' ? 'BS01_0' : 'CS02',
        slotMs: 60 * 60_000,
        serviceType: 1,
        carousel: true,
    };
}

export const DOCS_SERVICES: FakeService[] = [
    gr(32737, 1024, 'でんぱテレビ', 'T20', 1),
    gr(32738, 1032, 'ソラ放送', 'T22', 3),
    gr(32739, 1040, 'みなとテレビ', 'T24', 4),
    gr(32740, 1048, 'テレビわかば', 'T26', 5),
    gr(32741, 1056, 'ほしぞら放送', 'T28', 7),
    gr(32742, 1064, 'あおばＴＶ', 'T30', 8),
    // データ放送。録画の対象にはならない (テストの ＭＸデータ１ と同じ)
    { ...gr(32737, 1025, 'でんぱデータ', 'T20', 1), serviceType: 192 },
    sat(151, 'ＢＳでんぱ'),
    sat(161, 'ＢＳソラ'),
    sat(171, 'ＢＳみなと'),
    sat(181, 'ＢＳシネマ'),
    sat(191, 'ＢＳわかば'),
    sat(296, 'でんぱシネマ', 'CS'),
    sat(297, 'アニメでんぱ', 'CS'),
    sat(298, 'ソラスポーツ', 'CS'),
];

/**
 * 番組。ジャンルは ARIB の大分類・中分類 (番組表のマスの色になる)。
 * 名前は**どれも作り物。** 実在の番組名と重なっていたら偶然
 */
interface Show {
    name: string;
    /** 続きもの。名前に回の番号と副題を付ける */
    episodes?: string[];
    genre: [number, number];
    description: string;
    cast: string;
}

const SHOWS: Show[] = [
    {
        name: 'でんぱニュース',
        genre: [0, 0],
        description: 'きょうの出来事を短くまとめてお伝えします。',
        cast: '青木一郎 井上春香',
    },
    {
        name: 'あさのひろば',
        genre: [2, 0],
        description: '暮らしの話題と天気、交通情報。',
        cast: '木村陽菜 佐藤健',
    },
    {
        name: '星屑ステーション',
        episodes: ['はじまりの駅', '迷子の流れ星', '月の時刻表', '終点のむこう'],
        genre: [7, 0],
        description: '小さな駅に流れ着いた星のかけらを、駅員見習いのミナが持ち主へ届けていく。',
        cast: '（声）春野ミナ 秋山ソウ',
    },
    {
        name: '港町レシピ帖',
        episodes: ['朝どれイワシのつみれ汁', '雨の日のポトフ', '灯台守のパン'],
        genre: [10, 0],
        description: '港の食堂で教わる、季節の魚と野菜の家庭料理。',
        cast: '渡辺みどり',
    },
    {
        name: '鉄道でめぐる日本',
        episodes: ['海沿いのローカル線', '雪国の終着駅', '高原列車の旅'],
        genre: [8, 0],
        description: '各駅停車に揺られて、車窓の風景と町の人を訪ねる紀行番組。',
        cast: '語り：中村一樹',
    },
    {
        name: '週末どうぶつ図鑑',
        genre: [8, 1],
        description: '身近な生きものの不思議な暮らしを、高感度カメラで追う。',
        cast: '語り：小林あかり',
    },
    {
        name: 'ドラマ「ひだまり荘の人々」',
        episodes: ['新しい住人', '屋上の約束', 'さよならの準備'],
        genre: [3, 0],
        description: '古いアパートに暮らす人たちの、少し不器用な日々を描くホームドラマ。',
        cast: '山本葵 高橋蓮 森田こずえ',
    },
    {
        name: 'ミュージック・ラボ',
        genre: [4, 0],
        description: '今週のゲストがスタジオで生演奏。',
        cast: '司会：岡田リク',
    },
    {
        name: 'わらってナイト',
        genre: [5, 0],
        description: '若手芸人がネタで勝負するバラエティ。',
        cast: '司会：松本ケンジ',
    },
    {
        name: 'サッカー中継 でんぱカップ 準決勝',
        genre: [1, 1],
        description: '準決勝の2試合目をスタジアムから中継。',
        cast: '実況：石井大輔',
    },
    {
        name: '日曜シネマ「月夜の灯台」',
        genre: [6, 0],
        description: '灯台守の老人と家出した少女が過ごす、ひと夏の物語。',
        cast: '藤田誠 早川ひかり',
    },
    {
        name: 'こども科学クラブ',
        episodes: ['空気の重さを量る', '光の通り道', '音が見える'],
        genre: [10, 4],
        description: '身近な道具でできる実験で、科学のしくみを楽しく学ぶ。',
        cast: '実験：前田博士',
    },
    {
        name: 'ゆうがたニュース',
        genre: [0, 0],
        description: '夕方の最新ニュースと各地の天気。',
        cast: '近藤里美',
    },
    { name: '名曲アルバム', genre: [4, 1], description: '名曲にのせて、各地の風景を届ける。', cast: '' },
    {
        name: '時代劇「風の街道」',
        episodes: ['旅立ちの朝', '峠の茶屋', '雪の関所'],
        genre: [3, 2],
        description: '街道をゆく若い飛脚が、行く先々の宿場で事件に出会う。',
        cast: '西村大和 川口結衣',
    },
    {
        name: 'まちかど散歩',
        genre: [5, 3],
        description: '気ままに歩いて、町の小さな名店を訪ねる。',
        cast: '大野カズオ',
    },
    {
        name: 'ドキュメント 灯りの仕事',
        genre: [8, 2],
        description: '夜の街を支える人たちの、一晩を追うドキュメンタリー。',
        cast: '語り：北川静',
    },
    {
        name: 'アニメ「ロボと博士の100日」',
        episodes: ['起動', 'はじめての雨', 'こわれた時計', '博士の宿題'],
        genre: [7, 0],
        description: '発明家の博士と、作られたばかりのロボットが過ごす100日間。',
        cast: '（声）星野コウ 宮下ユキ',
    },
];

/** 番組表に積む1本ぶん。枠番号から決まるので、取り直しても同じものが出る */
export function docsProgram(service: FakeService, slot: number) {
    const show = SHOWS[(slot * 7 + service.serviceId) % SHOWS.length]!;
    const episode =
        show.episodes === undefined
            ? null
            : { n: (slot % 24) + 1, title: show.episodes[slot % show.episodes.length]! };
    return {
        name: episode === null ? show.name : `${show.name} #${episode.n}「${episode.title}」`,
        description: show.description,
        extended: {
            ...(show.cast === '' ? {} : { 出演者: show.cast }),
            番組内容: `${show.description}${episode === null ? '' : `今回は「${episode.title}」。`}`,
        },
        genres: [show.genre] as [number, number][],
    };
}

/*
 * ロゴ。**放送と同じ形** (8bit のパレット PNG で、色の表を持たない。色は ARIB の
 * 決め打ちの表を受け取った側が入れる) で、局ごとに色を変えた作り物を組む
 */

/** ARIB の決め打ちの色の表 (STD-B24) の番号。0 黒 1 赤 2 緑 3 黄 4 青 5 マゼンタ 6 シアン 7 白 8 透明 */
const LOGO_COLORS = [1, 4, 2, 5, 6, 3, 1, 4, 2, 5, 6, 3];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): number[] {
    const body = Uint8Array.from([...type].map((c) => c.charCodeAt(0)).concat([...data]));
    const len = data.length;
    const crc = crc32(body);
    return [
        (len >>> 24) & 0xff,
        (len >>> 16) & 0xff,
        (len >>> 8) & 0xff,
        len & 0xff,
        ...body,
        (crc >>> 24) & 0xff,
        (crc >>> 16) & 0xff,
        (crc >>> 8) & 0xff,
        crc & 0xff,
    ];
}

/** 角を落とした色の札に、白い丸と電波の弧を2本。どの局も同じ形で、色だけ違う */
export function docsLogo(service: FakeService, width: number, height: number): Uint8Array {
    const index = DOCS_SERVICES.indexOf(service);
    const color = LOGO_COLORS[(index < 0 ? 0 : index) % LOGO_COLORS.length]!;
    const r = Math.round(height / 5);
    const cx = width * 0.3;
    const cy = height / 2;
    const raw: number[] = [];
    for (let y = 0; y < height; y++) {
        raw.push(0);
        for (let x = 0; x < width; x++) {
            const dx = Math.max(r - x, 0, x - (width - 1 - r));
            const dy = Math.max(r - y, 0, y - (height - 1 - r));
            if (dx * dx + dy * dy > r * r) {
                raw.push(8);
                continue;
            }
            const d = Math.hypot(x - cx, y - cy);
            const right = x > cx;
            const wave =
                right &&
                (Math.abs(d - height * 0.28) < height * 0.06 || Math.abs(d - height * 0.4) < height * 0.06);
            raw.push(d < height * 0.14 || wave ? 7 : color);
        }
    }
    const ihdr = Uint8Array.from([
        0,
        0,
        0,
        width,
        0,
        0,
        0,
        height,
        8, // bit depth
        3, // パレット
        0,
        0,
        0,
    ]);
    return Uint8Array.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...chunk('IHDR', ihdr),
        ...chunk('IDAT', deflateSync(Uint8Array.from(raw))),
        ...chunk('IEND', new Uint8Array(0)),
    ]);
}

/*
 * ライブの絵。偽の放送の映像はマクロブロック (16x16) ごとに1色の MPEG-2 (`synth-av.ts`) なので、
 * 16x9 個の升で色帯 (75% のカラーバー) を描く。下の2段の灰色の階段だけ流して、動いているのが分かるようにする
 */
const BARS: [number, number, number][] = [
    [180, 128, 128], // 白
    [162, 44, 142], // 黄
    [131, 156, 44], // シアン
    [112, 72, 58], // 緑
    [84, 184, 198], // マゼンタ
    [65, 100, 212], // 赤
    [35, 212, 114], // 青
    [16, 128, 128], // 黒
];

export function docsColor(col: number, row: number, n: number): [number, number, number] {
    const bar = Math.floor(col / 2);
    if (row < 6) return BARS[bar]!;
    if (row === 6) return BARS[(BARS.length - 1 - bar) % BARS.length]!;
    return [16 + ((col * 14 + n * 2) % 220), 128, 128];
}

/*
 * 録画の字幕。**作り物の台詞**を ARIB の字幕 (STD-B24) にして、ffmpeg が書くのと同じ形の
 * Matroska に入れる (`synth-caption.ts`)。偽 ffmpeg が観る画面にこれを返す
 * (`FAKE_FFMPEG_CAPTIONS`。テストの `captions.mkv` の代わり)
 */
const csi = (params: string, final: number) => [
    0x9b,
    ...[...params].map((c) => c.charCodeAt(0)),
    0x20,
    final,
];
/** 960x540・表示区画 620x480 を (170,30) に・36ドット・字間4・行間24 (放送でよく見る頭) */
const CAPTION_HEAD = [
    ...csi('7', 0x53),
    ...csi('620;480', 0x56),
    ...csi('170;30', 0x5f),
    ...csi('36;36', 0x57),
    ...csi('4', 0x58),
    ...csi('24', 0x59),
];
/** 1行に入る字の数 (区画 620 ÷ 字の枠 40) */
const CAPTION_COLUMNS = 15;
/** 字幕の色。白 / 黄 (話している人の名前) */
const WHITE = 0x87;
const YELLOW = 0x83;

const LINES: [color: number, text: string][][] = [
    [[WHITE, '♪～']],
    [
        [YELLOW, '（ナレーター）'],
        [WHITE, '朝の光が　町を照らします。'],
    ],
    [
        [WHITE, 'きょうは　この町の'],
        [WHITE, '小さなお店を　訪ねます。'],
    ],
    [
        [YELLOW, '（店主）'],
        [WHITE, 'いらっしゃいませ！'],
    ],
    [[WHITE, 'わあ　いい香り！']],
    [
        [YELLOW, '（店主）'],
        [WHITE, '朝どれの魚を使っているんです。'],
    ],
];

export function docsCaptions(): Uint8Array {
    const frames: [number, Uint8Array][] = [[0, management()]];
    // 時刻は 65 秒まで (captionMkv の決まり)。4 秒ごとに次の台詞へ
    for (let at = 1000, i = 0; at <= 61_000; at += 4000, i++) {
        const lines = LINES[i % LINES.length]!;
        const body: number[] = [0x0c, ...CAPTION_HEAD];
        lines.forEach(([color, line], index) => {
            // 下から2行目まで (いちばん下は観る画面の操作の帯と重なる)
            const row = 7 - lines.length + index;
            const col = Math.max(0, Math.floor((CAPTION_COLUMNS - [...line].length) / 2));
            body.push(0x1c, 0x40 | row, 0x40 | col, color, ...encodeAribText(line));
        });
        frames.push([at, text(body)]);
    }
    return captionMkv(frames);
}
