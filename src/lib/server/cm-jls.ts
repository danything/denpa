import { readFileSync } from 'node:fs';
import { type CmOptions, invertRanges, MAX_CM_RATIO, type Range } from './cm';
import { config } from './config';
import { removeByPrefix } from './fsx';
import { logoRepo, share } from './logo-data';
import { ownLogoFrames } from './logo-own';
import { settings } from './settings';
import { run as runProcess } from './stream';

/**
 * join_logo_scp (JLS) による CM 検出。
 *
 * Amatsukaze が高精度なのは、無音・シーンチェンジ(chapter_exe)に加えて
 * 「局ロゴが出ているか」を併用し、その2つを join_logo_scp で突き合わせて
 * 本編/CMを判定しているため。Amatsukaze 本体は Windows + AviSynth+ 前提で
 * Linux の Pod には載らないが、この検出核には Linux 移植がある。
 * ロゴの出ているコマは自前で拾う (`logo-own.ts`。join_logo_scp が読む logoframe の形で書く)。
 *
 * ここではその成果物である「Trim(開始フレーム,終了フレーム) の並んだ avs」だけを受け取り、
 * 秒の区間に直して silence 検出と同じ形で返す。エンコード自体は AviSynth を通さず
 * ffmpeg のままにしておきたいので、依存を検出フェーズだけに閉じ込める。
 *
 * コマンドは**ここから直接起動する**。以前はシェルスクリプトに逃がして
 * `sh -c` で呼んでいたが、番組名にも局名にも空白と引用符が入るので、
 * コマンド文字列を組み立てる限りどこかで引数が割れる。どの段階で落ちたのかも
 * 混ざった標準エラーから読み取るしかなかった。ffmpeg と同じように
 * 引数の配列で渡し、段階ごとに結果を見る。
 */

const TRIM = /Trim\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;

/** avs の Trim(開始,終了) はフレーム番号かつ終端を含む。秒の半開区間に直す */
export function parseTrimRanges(avs: string, fps: number): Range[] {
    const ranges: Range[] = [];
    for (const match of avs.matchAll(TRIM)) {
        const from = Number(match[1]);
        const to = Number(match[2]);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
        ranges.push({ start: from / fps, end: (to + 1) / fps });
    }
    return ranges;
}

/**
 * 「ロゴの写っているコマ」の一覧 (logoframe の `-oa` の形。`logo-detect.formatLogoFrames`) を、
 * 秒の区間に直す。
 *
 * ```
 *    284 S 0 ALL    280    290      ← ここからロゴが出る
 *   3280 E 0 ALL   3280   3280      ← ここで消える
 * ```
 *
 * S と E が交互に並ぶ。**join_logo_scp が区切れなかったときの受け皿。**
 * あちらは無音・シーンチェンジと突き合わせて番組の構成を推測するので、
 * 推測に失敗すると何も返ってこない。ロゴの在り処そのものは分かっているので、
 * それだけでも本編とCMには分けられる (実機の TOKYO MX で 20% がCMという妥当な答えになった)。
 */
export function parseLogoFrames(text: string, fps: number): Range[] {
    const ranges: Range[] = [];
    let start: number | null = null;
    for (const line of text.split('\n')) {
        const match = /^\s*(\d+)\s+([SE])\b/.exec(line);
        if (match === null) continue;
        const frame = Number(match[1]);
        if (match[2] === 'S') {
            start = frame;
        } else if (start !== null) {
            ranges.push({ start: start / fps, end: (frame + 1) / fps });
            start = null;
        }
    }
    return ranges;
}

/** CM判定が占める割合 (%) */
export function cmRatio(cm: Range[], duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    const total = cm.reduce((sum, range) => sum + (range.end - range.start), 0);
    return Math.round((total / duration) * 100);
}

/**
 * CM判定が多すぎないか。
 *
 * ロゴを覚えたてのときなど、join_logo_scp が「頭の2秒だけ本編」のような結果を
 * 返すことがある。実機では30分アニメ2本が丸ごとCM扱いになっていた
 * (`Trim(0,59)` の1つだけ = CM 2秒〜1802秒)。
 * 無音検出と同じ判断にそろえてある。本編を削るよりCMが残るほうが被害が小さい
 */
export function tooMuchCm(cm: Range[], duration: number): boolean {
    return cmRatio(cm, duration) > MAX_CM_RATIO * 100;
}

interface Step {
    code: number;
    stderr: string;
}

/**
 * 1段階ぶん回す。
 *
 * どれも録画の実時間の数分の一かかる。中止を押されたら止め、
 * 全体の上限 (config.cmDetectTimeout) を超えたときも止める。
 */
async function run(argv: string[], signal: AbortSignal | undefined, deadline: number): Promise<Step> {
    const left = deadline - Date.now();
    if (left <= 0) return { code: 124, stderr: '時間切れ' };

    // 一式が入っていないイメージもある (code 127 で返る)。無音検出に落ちれば録画は続く
    return runProcess(argv, { signal, timeoutMs: left, stderr: true });
}

/**
 * 途中で作るファイル。入力の隣に置く (TSと同じ場所なら容量の心配が要らない)。
 * 頭は全部 `<入力>.jls` — 後始末はこの頭で拾って消す (`cleanup`)
 */
function workFiles(input: string) {
    const base = `${input}.jls`;
    return {
        /** chapter_exe が出す無音・シーンチェンジの一覧 */
        scenes: `${base}.chapterexe.txt`,
        /** 自前のロゴ判定が書く「ロゴが写っているコマ」の一覧 */
        frames: `${base}.logo.txt`,
        /** join_logo_scp が出す「残す区間」の avs。これだけ読む */
        cut: `${base}.cut.avs`,
        /** join_logo_scp が出すシーン一覧。使わない */
        scpout: `${base}.jlscp.txt`,
    };
}

/** 無音ベース (cm.ts) と同じ材料に、コマ数だけ足したもの */
interface JlsOptions extends Omit<CmOptions, 'onProgress'> {
    /**
     * 動画のフレームレート。join_logo_scp が返す Trim はコマ番号なので、これで秒に直す。
     *
     * **呼ぶ側が測ったものをもらう。** ここでも ffprobe を叩いていた頃は、
     * 尺を測るのと合わせて同じTSを2回読んでいたうえ、読み方が2箇所に分かれていて
     * 片方だけ直っていない状態を作った (cm.fields の覚え書き)
     */
    fps?: number;
}

export async function detectWithJls(
    input: string,
    duration: number,
    options: JlsOptions,
): Promise<{ cm: Range[]; note: string }> {
    const { signal, serviceId, onStep } = options;
    // 測れなかったときだけ既定に落とす (地上波・BS はどちらも 30000/1001)
    const fps =
        options.fps !== undefined && Number.isFinite(options.fps) && options.fps > 0
            ? options.fps
            : config.cmJlsFallbackFps;
    const deadline = Date.now() + config.cmDetectTimeout;
    const step = onStep ?? (() => {});
    const work = workFiles(input);
    const bin = (name: string) => `${config.jlsBin}/${name}`;

    try {
        /*
         * 1. 局ロゴが写っているコマを拾う。**無音・シーンチェンジより先に回す。**
         * 逆にしていた頃は、chapter_exe が落ちた録画ではロゴを当てられたかどうかが
         * 分からないまま無音検出に落ちていて、一覧に「ロゴを当てられませんでした」が
         * 出なかった (実機で2本)。ロゴの当たり外れは局ごとに決まる話なので、先に確かめて必ず伝える
         */
        step('局ロゴが写っているコマを探しています');
        const own = await ownLogoFrames(input, work.frames, {
            repo: logoRepo(serviceId),
            signal,
            timeoutMs: deadline - Date.now(),
        });
        if (own.code !== 0) return { cm: [], note: `ロゴ判定が失敗 (code ${own.code}): ${own.stderr}` };
        console.log(`[cm] ロゴ判定: ${own.stderr}`);
        /*
         * **覚えたものを、同じ絵を映している局にも配る** (`logo-data.share`)。
         * サブチャンネルの枠で録れた番組が一から覚え直さないように
         */
        if (own.learned) share(serviceId);

        // 2. 無音とシーンチェンジを拾う
        step('無音とシーンの切れ目を探しています');
        const scenes = await run(
            [bin('chapter_exe'), '-v', input, '-s', '8', '-e', '4', '-o', work.scenes],
            signal,
            deadline,
        );
        if (scenes.code !== 0) {
            return { cm: [], note: failure('chapter_exe', scenes) };
        }

        // 3. その2つを突き合わせて本編とCMに分ける
        step('本編とCMに分けています');
        const joined = await run(
            [
                bin('join_logo_scp'),
                '-inlogo',
                work.frames,
                '-inscp',
                work.scenes,
                '-incmd',
                config.jlsRule,
                /*
                 * **ロゴをどれだけ当てにするか** (1:使わない 〜 8:最優先)。
                 *
                 * 規則ファイルの中では `Default logo_level 6` と書いてあり、
                 * `Default` は**未定義のときだけ**効くので、ここで先に決めれば勝つ。
                 *
                 * 書き換えた写しを渡していた頃は、規則が JL フォルダの外へ出て
                 * 隣のファイルを見失っていた (`warning: not found setup-file`)。
                 * 規則は置いたまま、変えたい1つだけを外から渡す
                 */
                '-set',
                'logo_level',
                String(settings().logoLevel),
                '-o',
                work.cut,
                '-oscp',
                work.scpout,
            ],
            signal,
            deadline,
        );
        if (joined.code !== 0) {
            return { cm: [], note: failure('join_logo_scp', joined) };
        }

        let avs: string;
        try {
            avs = readFileSync(work.cut, 'utf8');
        } catch {
            return { cm: [], note: `${work.cut} が作られませんでした` };
        }

        /*
         * ここから先はロゴが当たったのに区切れない状態。区切れなければロゴの在り処だけで
         * 分け直す (`byLogoAlone`)。画面に「ロゴで判定できなかった」と出すかは覚え書きから決まる
         * (`format.logoUnusable`)
         */
        const keep = parseTrimRanges(avs, fps);
        if (keep.length === 0) {
            return byLogoAlone(work.frames, fps, duration, 'join_logo_scp が区切りを返さなかった');
        }

        const cm = invertRanges(keep, duration);
        /*
         * **区切りが1つも出なかった。** 残す区間が丸ごと1本になっている状態。
         * join_logo_scp は無音・シーンチェンジとロゴを突き合わせて番組の構成を
         * 推測するので、推測に失敗するとこうなる
         */
        if (cm.length === 0) {
            return byLogoAlone(work.frames, fps, duration, 'join_logo_scp が本編とCMに分けられなかった');
        }
        // 番組の半分以上がCMになったら、その結果は捨てて無音検出に落とす (tooMuchCm)
        if (tooMuchCm(cm, duration)) {
            return {
                cm: [],
                note: `番組の ${cmRatio(cm, duration)}% がCMという結果だったので捨てました`,
            };
        }
        return { cm, note: 'join_logo_scp' };
    } finally {
        // 中身は使い終わっている。録画の隣に置いているので残すと生TSの置き場を圧迫する
        cleanup(input);
    }
}

/**
 * join_logo_scp が区切れなかったときの受け皿。**ロゴの在り処だけで分ける** —
 * 「どのコマにロゴが出ているか」を裏返せば CM になる (日本の地上波・BS は
 * CM の間だけロゴを消す)。番組の構成までは読めないが、無音検出に落ちるよりは確か
 * (実機の TOKYO MX の例は docs/encode.md「検出方法は2つ」)。
 * ここでも多すぎれば捨てる (`tooMuchCm`) ので、ロゴがロゴでなかったときは無音検出へ落ちる。
 */
function byLogoAlone(
    frames: string,
    fps: number,
    duration: number,
    /** 落ちてきた理由。「〜なかった」と言い切りで渡す (下で文をつなげるため) */
    cause: string,
): { cm: Range[]; note: string } {
    let text: string;
    try {
        text = readFileSync(frames, 'utf8');
    } catch {
        return { cm: [], note: `${cause}うえ、ロゴの出ているコマの一覧も読めませんでした` };
    }

    const lit = parseLogoFrames(text, fps);
    if (lit.length === 0) {
        return { cm: [], note: `${cause}うえ、ロゴの写っているコマもありませんでした` };
    }

    const cm = invertRanges(lit, duration);
    if (cm.length === 0) {
        return { cm: [], note: `${cause}うえ、ロゴは最初から最後まで写っていました` };
    }
    if (tooMuchCm(cm, duration)) {
        return {
            cm: [],
            note: `${cause}ので、ロゴの位置だけで分け直しましたが、${cmRatio(cm, duration)}% がCMになりました`,
        };
    }
    return { cm, note: `${cause}ので、ロゴの位置だけで分けました` };
}

/**
 * 途中で作ったものを片付ける。
 *
 * 名前を並べて消すのではなく**頭で拾う**。こちらが知らない名前を道具が足して
 * 作っても取りこぼさない。
 *
 * **`.dtvi` も拾う。** chapter_exe は TS を直接読むのに
 * dtvindex の索引を作り、それを `<入力>.dtvi` に置く — こちらが渡した
 * 名前 (`<入力>.jls…`) の外なので、`.jls` の頭だけで拾っていた頃は
 * **1本あたり3MBずつ残り続けていた** (実機の生TSの置き場に9本 22MB)。
 * 生TSを残さない設定だと、TS が消えたあとも索引だけが居座る。
 */
const LEAVINGS = ['.jls', '.dtvi'];

function cleanup(input: string): void {
    removeByPrefix(input, LEAVINGS);
}

/**
 * 落ちた段階が分かるようにする。詳細に出して原因を追えるように。
 * 標準エラーは末尾だけ。TSの読み込み警告が延々と並ぶので、全部載せると読めない
 */
function failure(step: string, result: Step): string {
    return `${step} が失敗 (code ${result.code}): ${result.stderr.trim().split('\n').at(-1) ?? ''}`;
}
