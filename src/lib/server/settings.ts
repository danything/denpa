import type { CmMode, VideoCodec } from '../types';
import { isCmMode } from './cm';
import { config } from './config';
import { database, now, queryOne } from './db';
import { isVideoCodec } from './encoder';

/**
 * 画面から変えられる設定。
 *
 * コーデックとCMの扱いは、番組ごとに変えたくなることが実際にはほとんど無い。
 * ルールにも予約にも同じ選択肢を並べると、どこで決まったのか分からなくなるので
 * 全体で1つに寄せてある。環境変数は初期値として扱い、DBに値があればそちらが勝つ。
 */

export interface Settings {
    /** 録画のエンコードに使う映像コーデック。`none` ならエンコードしない */
    codec: VideoCodec;
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
     * **ロゴをどれだけ当てにするか** (1〜8、既定 6)。
     *
     * join_logo_scp は無音・シーンチェンジと「ロゴが出ているか」を突き合わせて
     * 番組の構成を推測する。その推測でロゴ情報をどれだけ優先するかがこれ
     * (JL の `logo_level`)。ロゴが正しいのにCMを取り違えるなら上げる、
     * ロゴを覚え違えているようなら下げる。1 でロゴを使わなくなる
     */
    logoLevel: number;
    /**
     * ベーシック認証。両方入っているときだけ有効で、**起動時に無ければ作る**
     * (`auth.ensureBasicAuth`)。掛かる範囲は選べない — 掛けたら全部に掛かる
     */
    basicAuthUser: string;
    basicAuthPassword: string;
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
     * データ放送の双方向 (通信系コンテンツ) を使うか。**既定は切。**
     *
     * 入れると denpa のサーバが**放送局のサーバへ代理で取りに行きます**
     * (`server/bml-network.ts`)。取ってくるだけ (GET) で、応募・投票の送信は
     * しません。切っている間は `isIPConnected` が 0 を返すので、放送のアプリは
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

export function settings(): Settings {
    const codec = stored('codec');
    const cmCut = stored('cmCut');
    const flag = (key: string, fallback: boolean) => {
        const value = stored(key);
        return value === undefined ? fallback : value === 'true';
    };
    /*
     * 「エンコードする」のチェックを持っていた頃のDBは、そこに false が入っている。
     * コーデックの選択に寄せたので、それを `none` として読む
     */
    const chosen = isVideoCodec(codec) ? codec : config.encodeCodec;
    const resolved = flag('encode', true) ? chosen : 'none';
    return {
        codec: resolved,
        cmCut: isCmMode(cmCut) ? cmCut : config.cmCutDefault,
        encode: resolved !== 'none',
        keepOriginal: flag('keepOriginal', false),
        freeOnly: flag('freeOnly', true),
        cmDetector: stored('cmDetector') === 'silence' ? 'silence' : 'jls',
        logoLevel: logoLevel(stored('logoLevel')),
        basicAuthUser: stored('basicAuthUser') ?? config.basicAuthUser,
        basicAuthPassword: stored('basicAuthPassword') ?? config.basicAuthPassword,
        postalCode: normalizePostalCode(stored('postalCode') ?? ''),
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
            upsert.run(key, String(value), at);
        }
    });
    tx();
    return settings();
}
