import { areaText, type Frame, findLogoArea } from '../ts/logo-area';
import { probeVideo } from './cm';
import { config } from './config';
import { database, queryAll } from './db';
import { run } from './stream';

/**
 * **ロゴの在り処を絵から割り出して、`services.logo_area` に入れる。**
 *
 * 割り出し方そのものは [logo-area.ts](../ts/logo-area.ts) にあります (絵だけを見る
 * 純粋な計算)。ここはその手前 — **録れたものからコマを抜いて渡すところ**です。
 *
 * これが要るのは、logoframe の自動検出が**画面全体**を見るからです。テレ東の
 * ような半透明の細いロゴだと、本物より強い縁を画面の別の場所で掴んで
 * `too few active pixels` で降ります (実測でロゴではなく家具の縁 `1004,216`)。
 * 隅だけを見れば当てられるので、**位置だけこちらで出して `-logo-area` で渡します。**
 */

/**
 * 何コマ見るか。**多いほど中身が滲んで消えます** が、そのぶん抜くのに掛かる。
 * 実測では 83 コマ (30分から) で当てられました
 */
const FRAMES = 60;

/**
 * コマを抜く間隔の下限 (秒)。
 *
 * ふだんは**丸ごとの長さを `FRAMES` で割って**決めます — 頭から等間隔に
 * 抜くと最初の数分しか見ないことになり、**その場面の輪郭をロゴと取り違えます**
 * (試作で 90 秒ぶんだけ渡して実際に外した)。短い録画のときだけこちらが効く
 */
const EVERY_LEAST = 2;

/** 抜くのに掛けてよい時間。壊れたファイルで居座らせない */
const TIMEOUT = 120_000;

/**
 * その局の枠を、これから割り出してよいか。
 *
 * **持っているなら触りません。** 画面から手で教わったものが入っていることが
 * あり、こちらの推測で上書きすると教え直しても戻らなくなります。
 *
 * **一度外した局では、二度と割り出しません。** 外れた枠を捨てるだけにすると、
 * 次のエンコードでまた同じ絵から同じ枠を出して同じところで転びます
 * (実機の TOKYO MX1。窓枠の縁を掴んでいた)。そのときは logoframe の自動検出に
 * 任せるほうが当たる — こちらが割り出す前は当たっていたのだから
 */
export function mayDetect(serviceId: number): boolean {
    const { area, auto } = row(serviceId);
    return area === '' && auto !== AUTO_MISSED;
}

/**
 * 当たらなかった枠を捨てて、**もう割り出さない**印を付ける。
 *
 * **誰が入れた枠かは問いません。** 枠を渡すと転び、渡さないと通るのなら、
 * その枠は誰が入れたものでも間違っています。人が教えたものだったときは
 * 画面が「自動」に戻るので、**囲い直せます** (捨てたことはログにも出す)
 */
export function forgetArea(serviceId: number): void {
    database()
        .prepare('UPDATE services SET logo_area = NULL, logo_area_auto = ? WHERE id = ?')
        .run(AUTO_MISSED, serviceId);
}

/** `logo_area_auto` の値。schema.ts に説明がある */
const AUTO_GUESSED = 1;
const AUTO_MISSED = 2;

function row(serviceId: number): { area: string; auto: number } {
    const found = queryAll<{ logo_area: string | null; logo_area_auto: number | null }>(
        'SELECT logo_area, logo_area_auto FROM services WHERE id = ?',
        serviceId,
    )[0];
    return {
        area: typeof found?.logo_area === 'string' ? found.logo_area : '',
        auto: found?.logo_area_auto ?? 0,
    };
}

/**
 * 録れたものからコマを抜いて、ロゴの在り処を割り出す。
 * 見つからなければ `null` (今までどおり logoframe に任せる)。
 *
 * 抜くのは**グレースケールの生**です。ロゴの在り処は明るさの並びだけで決まるので、
 * 色は要りません (そのぶん 1/3 で済む)。
 */
export async function detectArea(input: string, signal?: AbortSignal): Promise<string | null> {
    let size: { width: number; height: number };
    let every = EVERY_LEAST;
    try {
        const probed = await probeVideo(input);
        size = { width: probed.width, height: probed.height };
        // 丸ごとの長さに散らす。頭に固まらせない
        if (probed.duration > 0) every = Math.max(EVERY_LEAST, probed.duration / FRAMES);
    } catch {
        return null;
    }
    if (!(size.width > 0) || !(size.height > 0)) return null;

    const { code, stdout } = await run(
        [
            config.ffmpeg,
            '-v',
            'error',
            '-i',
            input,
            '-vf',
            `fps=1/${every.toFixed(3)},format=gray`,
            '-frames:v',
            String(FRAMES),
            '-f',
            'rawvideo',
            'pipe:1',
        ],
        { signal, timeoutMs: TIMEOUT, stdout: true },
    );
    if (code !== 0) return null;

    const each = size.width * size.height;
    const count = Math.floor(stdout.length / each);
    const frames: Frame[] = [];
    for (let n = 0; n < count; n++) {
        frames.push({ ...size, data: stdout.subarray(n * each, (n + 1) * each) });
    }

    const rect = findLogoArea(frames);
    return rect === null ? null : areaText(rect);
}

/**
 * 割り出した枠を覚える。
 *
 * **画面にも出ます** (チューナー画面のロゴの枠)。合っていなければ手で囲い直せば
 * よく、こちらは空のときしか書かないので、教え直したほうが勝ちます
 */
export function remember(serviceId: number, area: string): void {
    database()
        .prepare('UPDATE services SET logo_area = ?, logo_area_auto = ? WHERE id = ?')
        .run(area, AUTO_GUESSED, serviceId);
}
