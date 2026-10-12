/**
 * データ放送に渡す都道府県 (`nvram://receiverinfo/prefecture`。U:1B)。
 *
 * **番号は JIS の都道府県コードではない。** ARIB STD-B10 付録G 表G-2 (県域指定) の
 * ビットの位置で、北海道は東西に、東京都と鹿児島県は島部を分けて 50 ある
 * (東京都 (島部を除く) が 14。TR-B39 の例と同じ)。未設定は 255。
 *
 * 地上波の地域符号 (`receiverinfo/regioncode`。12 ビット) は別の値で、
 * 北海道の東西・島部の有無では変わらない (県ごとに1つ)。denpa はいまは渡さない。
 *
 * 並びは画面に出す順 (島部は本土のすぐ後)。番号の順ではない
 */
export const PREFECTURES: readonly { code: number; name: string }[] = [
    { code: 1, name: '北海道 (東部)' },
    { code: 2, name: '北海道 (西部)' },
    { code: 3, name: '青森県' },
    { code: 4, name: '岩手県' },
    { code: 5, name: '宮城県' },
    { code: 6, name: '秋田県' },
    { code: 7, name: '山形県' },
    { code: 8, name: '福島県' },
    { code: 9, name: '茨城県' },
    { code: 10, name: '栃木県' },
    { code: 11, name: '群馬県' },
    { code: 12, name: '埼玉県' },
    { code: 13, name: '千葉県' },
    { code: 14, name: '東京都' },
    { code: 49, name: '東京都 (伊豆・小笠原諸島)' },
    { code: 15, name: '神奈川県' },
    { code: 16, name: '新潟県' },
    { code: 17, name: '富山県' },
    { code: 18, name: '石川県' },
    { code: 19, name: '福井県' },
    { code: 20, name: '山梨県' },
    { code: 21, name: '長野県' },
    { code: 22, name: '岐阜県' },
    { code: 23, name: '静岡県' },
    { code: 24, name: '愛知県' },
    { code: 25, name: '三重県' },
    { code: 26, name: '滋賀県' },
    { code: 27, name: '京都府' },
    { code: 28, name: '大阪府' },
    { code: 29, name: '兵庫県' },
    { code: 30, name: '奈良県' },
    { code: 31, name: '和歌山県' },
    { code: 32, name: '鳥取県' },
    { code: 33, name: '島根県' },
    { code: 34, name: '岡山県' },
    { code: 35, name: '広島県' },
    { code: 36, name: '山口県' },
    { code: 37, name: '徳島県' },
    { code: 38, name: '香川県' },
    { code: 39, name: '愛媛県' },
    { code: 40, name: '高知県' },
    { code: 41, name: '福岡県' },
    { code: 42, name: '佐賀県' },
    { code: 43, name: '長崎県' },
    { code: 44, name: '熊本県' },
    { code: 45, name: '大分県' },
    { code: 46, name: '宮崎県' },
    { code: 47, name: '鹿児島県' },
    { code: 50, name: '鹿児島県 (南西諸島)' },
    { code: 48, name: '沖縄県' },
];

/** 未設定 (TR-B14 の受信機の設定で「設定されていない」) */
export const PREFECTURE_UNSET = 255;

/** 表にある番号ならそのまま、ほかは未設定 (255)。空や数字でないものも未設定 */
export function normalizePrefecture(value: string | number | undefined): number {
    const code = typeof value === 'number' ? value : /^\d+$/.test(value?.trim() ?? '') ? Number(value) : NaN;
    return PREFECTURES.some((p) => p.code === code) ? code : PREFECTURE_UNSET;
}

/**
 * 設定画面の選ぶ欄から来た値を読む。**表の番号か 255 だけを受け、ほかは null** (断る)。
 *
 * 選ぶ欄なので、表に無い番号や `014` のような書き方は画面の外から来たもの。
 * 黙って未設定にすると、保存したつもりの値が消える。欄が無ければ未設定
 */
export function parsePrefectureField(value: string | null): number | null {
    const raw = (value ?? String(PREFECTURE_UNSET)).trim();
    const code = normalizePrefecture(raw);
    return String(code) === raw ? code : null;
}
