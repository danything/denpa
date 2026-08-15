import { HW_CODECS, type HwAllow, type HwCodec, type HwKind } from '../hw';
import type { CmMode, VideoCodec } from '../types';
import { isCmMode } from './cm';
import { config } from './config';
import { database, now, queryOne } from './db';

/**
 * 画面から変えられる設定。
 *
 * コーデックとCMの扱いは、番組ごとに変えたくなることが実際にはほとんど無い。
 * ルールにも予約にも同じ選択肢を並べると、どこで決まったのか分からなくなるので
 * 全体で1つに寄せてある。環境変数は初期値として扱い、DBに値があればそちらが勝つ。
 */

export interface Settings {
    /**
     * 録画のエンコードに使う映像コーデック。`none` ならエンコードしない。
     * **主のほう** — 両方焼くときは AV1 (小さいので既定の再生に向く)
     */
    codec: VideoCodec;
    /**
     * 焼くコーデックの一覧。**両方選べる** (`['av1', 'h264']`)。
     *
     * 古いテレビは AV1 を解けないので、H.264 も一緒に焼いておくと同じ録画を
     * どちらの端末でも観られる (`server/encoder.ts`)。`none` (エンコードしない)
     * のときは空。AV1 を先頭に寄せる — 主 (`library_path`) はそちらにする
     */
    codecs: HwCodec[];
    /**
     * **GPU の口ごとに、GPU で焼いてよいコーデック** (`$lib/hw` の HwAllow)。使えるかは
     * 別 (`server/hwenc.ts`) で、焼くのは「使える かつ 許されている」もの。使えないものの
     * 印は画面から触れないので保存しても残る (GPU を挿し替えればそのまま効く)。JSON で1つの鍵
     */
    hwAllow: HwAllow;
    /** CMの扱い。off / chapter / cut */
    cmCut: CmMode;
    /**
     * エンコードするか。**コーデックの選択から決まる** (`none` 以外なら する)。
     * 別のチェックとして持っていた頃は、外したときにコーデックの選択だけが残り、
     * どちらが効いているのか画面から読めなかった
     */
    encode: boolean;
    /** エンコードしたあとも生TSを残すか */
    keepOriginal: boolean;
    /** 自動予約で無料放送だけを対象にするか */
    freeOnly: boolean;
    /**
     * CM検出のしかた。
     * jls     : ロゴが消えるかどうかまで見る。確かだが録画1本あたり数分かかる
     * silence : 無音とCM尺だけ。速いが本編の「間」を拾うことがある
     */
    cmDetector: 'jls' | 'silence';
    /**
     * コマ数 (30/60) を本編映像から実測して決めるか。
     *
     * 入り: 60p に起こして重複コマの割合を測り、同じ絵が並ぶ素材 (アニメ・
     *       フィルム) は 30コマで出す (`encoder.measureSmoothMotion`)。
     * 切り: 測らず**全部 60コマ**で出す。時間とサイズはかさむが、動きは絶対に落ちない
     */
    fpsDetect: boolean;
    /**
     * **ロゴをどれだけ当てにするか** (1〜8、既定 6)。
     *
     * join_logo_scp は無音・シーンチェンジと「ロゴが出ているか」を突き合わせて
     * 番組の構成を推測する。その推測でロゴ情報をどれだけ優先するかがこれ
     * (JL の `logo_level`)。ロゴが正しいのにCMを取り違えるなら上げる、
     * ロゴを覚え違えているようなら下げる。1 でロゴを使わなくなる
     */
    logoLevel: number;
    /**
     * データ放送に渡す郵便番号 (数字7桁。空なら渡さない)。
     *
     * **テレビの初期設定で必ず訊かれるあれ。** 放送のアプリは
     * `nvram://receiverinfo/zipcode` を読んで、天気・地域のニュース・
     * 防災情報をどこのものにするかを決める。入っていないと NHK なら
     * **「郵便番号が正しく設定されていません」**と出て、その欄が空のままになる。
     *
     * 受け取るのは端末の中 (localStorage) だが、置き場をここにしてあるのは
     * **端末ごとに訊き直さずに済ませる**ため — 家の場所は端末では変わらない
     */
    postalCode: string;
    /**
     * テレビの VLC (リモートアクセス) の居場所。`名前=ホスト:ポート` のカンマ区切り
     * (`リビング=192.168.10.20:8080`)。空なら「テレビで再生」は出ない (vlc.ts)
     */
    vlcTargets: string;
    /**
     * データ放送の双方向 (通信系コンテンツ) を使うか。**既定は切。**
     *
     * 入れると denpa のサーバが**放送局のサーバへ代理で取りに行き、送りもします**
     * (`server/bml-network.ts`)。取得 (GET) だけでなく、放送のアプリが組んだ
     * 応募・投票の送信 (POST = `transmitTextDataOverIP`) もそのまま中継します。
     * 切っている間は `isIPConnected` が 0 を返すので、放送のアプリは
     * 「インターネットに接続されていません」と正しく案内します
     */
    bmlNetwork: boolean;
}

/**
 * 数字7桁だけを残す。`123-4567` でも `1234567` でも同じに読む。
 *
 * **7桁でなければ空にする。** 途中まで入った番号を渡すと、放送側は
 * 「入っているが違う場所」として扱う — 入っていないほうがまだ分かりやすい
 */
export function normalizePostalCode(value: string): string {
    const digits = value.replace(/[^0-9]/g, '');
    return digits.length === 7 ? digits : '';
}

/** JL の logo_level。範囲の外は既定に倒す (規則ファイルに書き込む値なので) */
function logoLevel(value: string | undefined): number {
    const level = Number(value);
    return Number.isInteger(level) && level >= 1 && level <= 8 ? level : config.jlsLogoLevel;
}

function stored(key: string): string | undefined {
    return queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}

/**
 * コーデックの選択を読む。**カンマ区切りで、1つだけの古い値も読める。**
 *
 * `av1,h264` → `['av1', 'h264']`、`av1` → `['av1']`、`none` や空 → `[]`。
 * **AV1 を先頭に寄せる** — 主 (`library_path`) をそちらにするので、順序を固定する
 */
export function parseCodecs(value: string | undefined): HwCodec[] {
    const raw = (value ?? config.encodeCodec).split(',').map((s) => s.trim());
    return HW_CODECS.filter((codec) => raw.includes(codec));
}

/**
 * `hwAllow` を読む。壊れていれば空 (= 全部よい)。口ごとに `{ qsv: [...], vaapi: [...] }`
 */
export function parseHwAllow(value: string | undefined): HwAllow {
    if (value === undefined || value === '') return {};
    try {
        const raw = JSON.parse(value) as Record<string, Partial<Record<HwKind, unknown>>>;
        const out: HwAllow = {};
        for (const [device, entry] of Object.entries(raw)) {
            if (entry === null || typeof entry !== 'object') continue;
            const pick = (raw: unknown): HwCodec[] =>
                HW_CODECS.filter((codec) => Array.isArray(raw) && raw.includes(codec));
            out[device] = { qsv: pick(entry.qsv), vaapi: pick(entry.vaapi) };
        }
        return out;
    } catch {
        return {};
    }
}

export function settings(): Settings {
    const codec = stored('codec');
    const cmCut = stored('cmCut');
    const flag = (key: string, fallback: boolean) => {
        const value = stored(key);
        return value === undefined ? fallback : value === 'true';
    };
    /*
     * **コーデックはカンマ区切りで持つ** (`av1,h264`)。1つだけの古い値
     * (`av1` / `h264` / `none`) もそのまま読める。
     *
     * 「エンコードする」のチェックを持っていた頃のDBは `encode=false` が入って
     * いる。コーデックの選択に寄せたので、それを `none` として読む
     */
    const picked = parseCodecs(codec);
    const codecs = flag('encode', true) ? picked : [];
    // 主は先頭 (parseCodecs が AV1 を先頭に寄せている — 小さいので既定の再生に向く)
    const primary: VideoCodec = codecs.length === 0 ? 'none' : codecs[0];
    return {
        codec: primary,
        codecs,
        hwAllow: parseHwAllow(stored('hwAllow')),
        cmCut: isCmMode(cmCut) ? cmCut : config.cmCutDefault,
        encode: codecs.length > 0,
        keepOriginal: flag('keepOriginal', false),
        freeOnly: flag('freeOnly', true),
        cmDetector: stored('cmDetector') === 'silence' ? 'silence' : 'jls',
        fpsDetect: flag('fpsDetect', true),
        logoLevel: logoLevel(stored('logoLevel')),
        postalCode: normalizePostalCode(stored('postalCode') ?? ''),
        vlcTargets: stored('vlcTargets') ?? '',
        // **入れるまで外へ出ない。** 黙って通信が始まらないようにする
        bmlNetwork: flag('bmlNetwork', false),
    };
}

export function saveSettings(patch: Partial<Settings>): Settings {
    const upsert = database().prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const at = now();
    const tx = database().transaction(() => {
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            // 口ごとの GPU の設定だけ入れ子なので JSON。ほかは文字列で足りる
            upsert.run(
                key,
                typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : String(value),
                at,
            );
        }
    });
    tx();
    return settings();
}
