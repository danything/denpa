import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { audioTitles, DUAL_MONO } from '#lib/arib.js';
import { HW_KIND_LABEL, type HwCodec } from '../hw';
import { encodeSource } from '../source';
import type { EncodeJob, EncodePhase, Recording } from '../types';
import {
    type CmDetection,
    type CmReading,
    chapterMetadata,
    invertRanges,
    openCm,
    probeLeadIn,
    probeLiveAudio,
    probeVideo,
    type Range,
    shiftRanges,
} from './cm';
import { chapterArgs, cutArgs, cutList, cutPoints, KEY_SCDET, listKeyframes, planCut } from './cm-cut';
import { type Scan, type ScanReader, scanOutputs, scanReader } from './cm-scan';
import { config } from './config';
import { affected, now, orm } from './db';
import { type EncodeProgress, emit } from './events';
import { usedByOther } from './files';
import { removeIfExists } from './fsx';
import { type HwWay, hwArgs, hwChain } from './hwenc';
import { encodedPath, libraryFamily, libraryPath } from './library';
import { removeSidecars, sidecarPaths, writeThumbnail } from './metadata';
import { saveRecordedBml } from './recorded-bml';
import { recordingSummary } from './recording';
import { encodeJobs, recordings } from './schema';
import { descramble, isScrambled } from './scramble';
import { settings } from './settings';
import { chunks, lines, run } from './stream';
import { buildPgs } from './subtitle';
import { displayTitle } from './title';
import { TS_PROBE } from './ts-probe';
import { notify } from './webhook';

/**
 * インタレ解除の出し方。
 *
 * `bwdif` の既定は `send_field` で、**1フィールドから1コマ作って 59.94p にする**。
 * 放送は 1080i (毎秒60フィールド) なので、実写・スポーツ・報道はこれで
 * 撮られたとおりの動きになる。コマ数が倍なのでエンコードの時間もサイズも
 * およそ倍になる (実測・地上波1分・AV1: 31.8秒 26MB ↔ 16.9秒 15MB)。
 *
 * **国内アニメだけは倍にしない。** 元が毎秒24コマ前後で描かれていて、それを
 * プルダウンして60フィールドに乗せているだけなので、フィールドごとにコマを
 * 起こしても同じ絵が並ぶだけになる。滑らかさは1つも増えず、時間とサイズだけ倍になる。
 */
export function deinterlace(smooth: boolean): string {
    return smooth ? 'bwdif' : 'bwdif=mode=send_frame';
}

/** 1窓の長さ(秒)。5窓測って中央値を採る */
const FPS_WINDOW = 30;
/**
 * 測る窓の位置 (録画のどのあたりか)。**5窓・中央値** — 3窓だと
 * アイキャッチや OP に1窓乗るだけで引きずられ、下位や最小を採ると実写の静止した窓
 * (42%) で 30コマに倒す側の誤判定が出る。実測と閾値 (config.fpsSurvive) の根拠は
 * docs/encode.md「コマ数は本編の映像から測って決める」
 */
const FPS_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];

/** ffmpeg (-f null) の stderr から、書き出したコマ数を読む。最後の frame= を採る */
export function parseOutFrames(stderr: string): number {
    let last = NaN;
    for (const m of stderr.matchAll(/frame=\s*(\d+)/g)) last = Number(m[1]);
    return last;
}

/**
 * 生存率の中央値から 60コマにするか決める。**迷ったら 60コマ。**
 * 本物の 60i を 30コマに落とすと動きが崩れるが、逆は無駄が出るだけで絵は変わらない。
 */
export function pickSmooth(ratios: number[], threshold = config.fpsSurvive): boolean {
    const valid = ratios.filter((r) => Number.isFinite(r) && r > 0);
    if (valid.length === 0) return true;
    const sorted = [...valid].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return median > threshold;
}

/** 1窓ぶん測る。60p化 → 重複コマ落とし → 残った割合。測れなければ NaN */
async function surviveRatio(input: string, at: number, signal: AbortSignal): Promise<number> {
    const result = await run(
        [
            config.ffmpeg,
            '-hide_banner',
            '-nostats',
            '-ss',
            String(Math.max(0, at)),
            '-t',
            String(FPS_WINDOW),
            '-i',
            input,
            // **主映像 (HD) に固定する。** GR には 1seg (H.264 320x180) が混じっていて、
            // -map を付けないとフィルタがそちらに当たる (実測で判明)
            '-map',
            '0:v:0',
            '-vf',
            'bwdif=mode=send_field,mpdecimate',
            '-an',
            '-sn',
            '-fps_mode',
            'passthrough',
            '-f',
            'null',
            '-',
        ],
        { signal, stderr: true },
    );
    const out = parseOutFrames(result.stderr);
    // 60p に起こしたので、1窓の期待コマ数は 60000/1001 * 秒
    return out / ((FPS_WINDOW * 60000) / 1001);
}

/**
 * 30コマか60コマかを、録画から5窓測って決める。
 *
 * 以前はジャンル (国内アニメだけ30コマ) で決めていたが、放送の TS に
 * 「本当のコマ数」は入っていない — EIT も符号化ヘッダも、素材が 24p の
 * アニメでも**全部 1080i/60 と名乗る** (本番の実測)。それでも、**60コマに
 * 起こして同じ絵が続く割合を数えれば**見分けはつく — アニメ (24p/30p 由来) は
 * 同じ絵が2〜3枚ずつ並ぶので重複を落とすとコマが大きく減り、本物の 60i
 * (実写・生放送) は全コマ動くので減らない。実測値の表と、idet (縞の検出) が
 * 使えなかった話は [docs/encode.md](../../../docs/encode.md) に。
 *
 * **窓は録画全体に散らす。** CM (実写 60i) に乗った窓は釣り上がるが、CM は焼きながら探すので
 * (`cm-scan.ts`)、測る時点ではまだ分からない。散らせば CM に乗るのは5窓のうち多くて2つで、
 * 中央値は動かない (本番の録画 117 本の CM 位置で数えて、3つ以上乗るものは無かった)。
 * 最初の本編区間に5窓を固めていた頃は、アバン+OPに窓が乗って OP の激しい動きが
 * 57〜74% の生存率になり、30コマの本編 (実測 20〜32%) を 60コマと誤判定していた (本番の実測、2026-08)。
 */
async function measureSmoothMotion(
    source: string,
    durationSec: number,
    signal: AbortSignal,
): Promise<boolean> {
    const end = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : FPS_WINDOW;
    const span = Math.max(0, end - FPS_WINDOW);

    // 尺が窓より短いと5点が同じ位置に重なる。同じ30秒を測り直さない
    const offsets = [...new Set(FPS_POINTS.map((point) => span * point))];
    const ratios: number[] = [];
    for (const at of offsets) {
        if (signal.aborted) break;
        ratios.push(await surviveRatio(source, at, signal));
    }
    const smooth = pickSmooth(ratios);
    console.log(
        `[fps] 重複コマの実測: 生存率 ${ratios.map((r) => (Number.isFinite(r) ? `${(r * 100).toFixed(0)}%` : '測れず')).join(' / ')} → ${smooth ? '60' : '30'}コマ`,
    );
    return smooth;
}

/**
 * **画素を正方形に直す。**
 *
 * 地上波のHDは 1440x1080 で送られてきて、画素が横長 (SAR 4:3) であることを
 * 別に添えて 16:9 に見せている。ffmpeg はその添え書きをそのまま写すので、
 * 出来上がりも 1440x1080 + SAR 4:3 になる。
 *
 * ところが**添え書きを見ないプレイヤーがある。** 実機で試した Android のプレイヤーは
 * ハードウェア再生のとき画素の数だけを見るので、4:3 に潰れて出る (実機で確認)。
 *
 * **大きさはこちらで測って渡す** (`probeVideo` の width と sar)。
 * `scale=trunc(iw*sar/2)*2` のように ffmpeg の式で書くと、SAR が読めない
 * 素材で `sar` が 0 になり、幅 0 で落ちる。数で渡せばその目はない
 */
function squarePixels(size: { width: number; height: number } | undefined): string | null {
    if (size === undefined) return null;
    return `scale=${size.width}:${size.height},setsar=1`;
}

/** 画面に出す、焼く道の名前。`renderD128 の QSV` / `ソフトウェア` */
function wayName(way: HwWay | undefined): string {
    return way === undefined ? 'ソフトウェア' : `${basename(way.device)} の ${HW_KIND_LABEL[way.kind]}`;
}
/** GPU の口を回す番。ジョブごとに先頭の口を入れ替える (hwenc.hwChain) */
let hwTurn = 0;

/**
 * キーフレームの置き方。CM を切るときだけ使う (`cm-cut.ts`)。
 *
 * - `scene` … 場面の切れ目ごと。まだ境目が分からない1本目 (CM を探しながら焼く)
 * - 時刻の並び … 境目が決まってから焼くもの (2本目のコーデック・焼き直し)。焼くものの時刻 (秒)
 */
export type Keyframes = 'scene' | number[];

/**
 * キーフレームを置かせる引数。どのエンコーダも、印の付いたコマ (`pict_type = I`) を
 * キーフレームにする。**QSV だけは頼まないと IDR にならない** (`-forced_idr`)。IDR でないと
 * 入れ物にキーフレームとして書かれず、そこで切れない
 */
function keyframeArgs(keyframes: Keyframes | undefined, hardware: HwWay | null): string[] {
    if (keyframes === undefined || (Array.isArray(keyframes) && keyframes.length === 0)) return [];
    // 指す時刻は 1ms 手前に。その時刻ちょうどのコマが丸めで次のコマに流れないように
    const at =
        keyframes === 'scene'
            ? 'scd_metadata'
            : keyframes.map((t) => Math.max(0, t - 0.001).toFixed(3)).join(',');
    return ['-force_key_frames:v', at, ...(hardware?.kind === 'qsv' ? ['-forced_idr', '1'] : [])];
}

function videoArgs(
    codec: HwCodec,
    smooth: boolean,
    scale: string | null,
    hardware: HwWay | null,
    keyframes?: Keyframes,
): { filter: string; encoder: string[]; device: string[] } {
    const steps = [
        /*
         * 場面の切れ目に印を付ける。**CM 検出と同じコマ (インタレ解除の前) で測る** — 同じ点になるので、
         * 検出が境目に選んだコマにそのままキーフレームが乗る。インタレ解除の後で測っていた頃は、
         * 境目の半分ほどで前後1コマずれた (実測)。60コマで出すときは印が両方のフィールドのコマに
         * 写るので、キーフレームが2枚続く
         */
        ...(keyframes === 'scene' ? [KEY_SCDET] : []),
        deinterlace(smooth),
        ...(scale === null ? [] : [scale]),
    ];
    const keys = keyframeArgs(keyframes, hardware);
    if (hardware !== null) {
        /*
         * **GPU (Intel QSV / VA-API)。** インタレ解除も引き伸ばしも CPU のフィルタで
         * 済ませ、焼くところだけ GPU に渡す。引数と画質の決め方は hwenc.hwArgs。
         * 使うかどうかは `hwChain` (起動時の試し焼きと設定)。**落ちたら次の道か
         * ソフトウェアで焼き直す** (runJob) ので、ここで保険はかけない
         */
        const hw = hwArgs(hardware, codec);
        return {
            filter: [...steps, ...hw.filter].join(','),
            encoder: [...hw.encoder, ...keys],
            device: hw.device,
        };
    }
    if (codec === 'h264') {
        return {
            filter: [...steps, 'format=yuv420p'].join(','),
            device: [],
            // crf 23 は AV1 の既定 (crf35) と同じ画質に揃えた値、medium は slow に
            // しても時間が増えるだけ。実測の表は docs/encode.md「H.264 は crf 23」
            encoder: ['libx264', '-preset', 'medium', '-crf', '23', ...keys],
        };
    }
    /*
     * **preset と crf は書いておく** — SVT-AV1 の既定は版で変わる (preset は
     * 2.3.0 が 10、4.2.0 が 8)。焼く速さと大きさは denpa が決める。
     *
     * **10 に戻さない。** 4.x の M10 以上は「機械にかけるための段」で、焼くたびに
     * visual artifacts が出ると警告される。実際に出るのは**シーンの変わり目の
     * ブロックノイズ**で、カット直後だけ大きく崩れる (最低 29.74dB → 9 なら 37.77dB)。
     * 9 は 10 より小さくなって時間が 18% 増えるだけ。8 まで落としても崩れはこれ以上
     * 直らない。実測は docs/encode.md「preset は 9・crf 35 (値は書いておく)」
     *
     * **8bit で出す** (10bit は 2% 小さいだけで 15% 遅く、Main10 を解ける相手が要る)。
     * 実測は docs/encode.md「10bit では出しません」
     */
    return {
        filter: [...steps, 'format=yuv420p'].join(','),
        device: [],
        encoder: ['libsvtav1', '-preset', '9', '-crf', '35', ...keys],
    };
}

/** 進捗をDBに書き戻す間隔。1フレームごとに書くとWAL肥大とUIのちらつきの原因になる */
const PROGRESS_INTERVAL = 2000;

/** 同時実行数を数えるための実行中ジョブID。ffmpeg の起動前から入る */
const runningJobs = new Set<number>();
/** kill 用。ffmpeg が起動している間だけ入る */
const procs = new Map<number, Bun.Subprocess>();
/**
 * 中止の合図。ジョブが走っている間ずっとある。
 *
 * ffmpeg を kill するだけでは足りない。スクランブル解除は向こうの
 * コンテナへの HTTP、CM検出は別の ffmpeg で、どちらも数十分かかることがある。
 * 「中止を押したのに何も起きない」を無くすため、段階ごとにこれを渡す
 */
const aborts = new Map<number, AbortController>();
/** ユーザーが止めたジョブ。失敗と区別して再試行しないため */
const canceled = new Set<number>();

interface EncodeOptions {
    /** チャプター(CM位置)を書き込む ffmetadata ファイル */
    chaptersFile?: string | null;
    /** キーフレームを置く所 (CM を切るとき。`Keyframes`) */
    keyframes?: Keyframes;
    /**
     * CM 検出の材料を取る出口 (`cm-scan.scanOutputs`)。焼く出口のあとに足して、**同じ復号から**
     * 読ませる。ロゴの枠は標準出力に来るので、進み具合は標準エラーで受ける (`-progress pipe:2`)
     */
    analysis?: string[];
    /** 60コマ/秒で出す。滑らかになる代わりに時間もサイズも約2倍 (measureSmoothMotion で決める) */
    smoothMotion?: boolean;
    /**
     * 字幕を絵にするときの画面の大きさ ("1920x1080")。無ければ 1440x1080 とみなされる。
     * 使うのは .sup を作る側 (buildPgs) で、buildArgs はこれを見ない
     */
    canvasSize?: string;
    /**
     * 放送どおりに描いた字幕を入れた PGS (.sup)。
     * denpa が別に作って渡す (src/lib/server/subtitle.ts)。無ければ字幕は入らない
     */
    pgsFile?: string | null;
    /**
     * 映像が出るまでの音声だけの区間(秒)。**頭から捨てる長さ** (`probeLeadIn`)。
     *
     * 捨てると映像・音声・字幕が同じ瞬間から始まるので、時刻を読むプレイヤーでも
     * 1コマ目から数えるプレイヤーでも同じ絵になる。捨てるのは映像がまだ無い
     * ところなので、見えるものは減らない
     */
    videoStart?: number;
    /**
     * 正方形の画素で出したときの大きさ。**渡されたときだけ引き伸ばす。**
     * 1440x1080 (SAR 4:3) なら 1920x1080。もともと正方形の素材では渡さない
     */
    displaySize?: { width: number; height: number };
    /**
     * 音声トラックの名前。**番組表と同じ言い方** (`arib.audioTitles`)。
     *
     * 入れていなかった頃は、プレイヤーの切り替えに「Audio 1」「Audio 2」しか
     * 出なかった — 二カ国語や解説放送でどちらがどちらか分からない
     */
    audioTitles?: string[];
    /**
     * 拾う音声 (音声の何本目か。`cm.probeLiveAudio`)。**頭に中身の無い音声を外すため。**
     * 無い・空なら全部拾う。デュアルモノでは使わない (1本を左右に割るだけ)
     */
    audioStreams?: number[];
    /** 字幕トラックの名前。放送が名乗っている言語まで入る (`buildPgs`) */
    captionTitle?: string;
    /**
     * 入れ物 (mkv) の title に焼き込む番組名 (`title.displayTitle`)。テレビの VLC の
     * 履歴・通知に出る名前 (再生画面の見出しは URL の尻 — share.ts の shareUrls)
     */
    mediaTitle?: string;
    /**
     * GPU で焼く道 (どの口を `qsv` / `vaapi` のどちらで)。使えるかどうかは
     * `hwenc.hwChain` が決めていて、runJob がその順に渡す。落ちたら次、
     * 最後はソフトウェア (undefined)
     */
    hardware?: HwWay | undefined;
    /**
     * 焼く前に測った入力の尺と毎秒コマ数 (`probeVideo`)。
     * **進み具合の分母**をここから出す (`expectedFrames`)。
     * 測れなければ入力の読み位置に落ちるだけで、焼き上がりには影響しない
     */
    probed?: { duration: number; fps: number };
}

/** これ以下は捨てない。1コマにも満たないずれのために seek を掛けても得るものが無い */
const MIN_SKIP = 0.05;

/**
 * 頭から捨てる長さ。**焼くほうと字幕を作るほうで同じ値を使う。**
 *
 * ここが食い違うと、捨てたぶんだけ字幕がずれる。片方だけ「短いから捨てない」と
 * 判断することがないよう、判断そのものをここ1箇所に置く
 */
export function headSkip(videoStart: number | undefined): number {
    const start = videoStart ?? 0;
    return Number.isFinite(start) && start > MIN_SKIP ? start : 0;
}

/**
 * `-ss` に渡す長さ。**焼くほうと進み具合の分母で同じ値を使う。**
 *
 * 2つの理由が足し算になる (内訳は buildArgs のコメント)。ここが食い違うと、
 * 捨てた量と分母から引いた量がずれて、進み具合が最後まで届かない (または
 * 先に振り切れる)。片方だけ変えられないよう、足し算そのものをここ1箇所に置く
 */
export function inputSkip(seek: number | null, videoStart: number | undefined): number {
    return (seek ?? 0) + headSkip(videoStart);
}

/**
 * 字幕トラックの渡し方 (`input` は .sup の入力の番号)。字幕の作り方は `prepareCaptions` と2つで1組
 */
function captionArgs(input: number, title = '字幕'): string[] {
    return [
        // 名前は放送が名乗っているものを使う (「字幕 (日本語)」)。無ければ「字幕」
        '-map',
        `${input}:s:0?`,
        '-c:s:0',
        'copy',
        '-metadata:s:s:0',
        `title=${title}`,
        /*
         * 言語も付ける。default の印だけだと、プレイヤーの字幕自動選択
         * (「端末の言語に合う字幕を出す」設定) が言語不明の札を跳ばすことがある。
         * 放送の字幕 (ARIB) は日本語しか来ない
         */
        '-metadata:s:s:0',
        'language=jpn',
        '-disposition:s:0',
        'default',
    ];
}

/**
 * ffmpeg の引数。元は EPGStation 時代の enc.js で、各フラグの理由はコメントに
 * 残してある (インタレ解除、デュアルモノ分離)。字幕は焼き込まず、別に作った PGS を入れる。
 *
 * CM を切るときは場面の切れ目にキーフレームを置いて焼き (`keyframes`)、焼いたものを
 * キーフレームの所で切る (`cm-cut.ts`)。CM 検出の材料は同じ ffmpeg に取らせる (`analysis`)。
 */
export function buildArgs(
    input: string,
    output: string,
    audioType: number | null,
    seek: number | null,
    codec: HwCodec = 'av1',
    options: EncodeOptions = {},
): string[] {
    const hardware = options.hardware ?? null;
    const video = videoArgs(
        codec,
        options.smoothMotion === true,
        squarePixels(options.displaySize),
        hardware,
        options.keyframes,
    );

    const args = ['-y'];
    // GPU の口。入力より前に開いておくと、エンコーダ (とフィルタ) がこれを掴む
    args.push(...video.device);

    /*
     * **頭を捨てる。** 2つの理由が足し算になる。
     *
     * - `videoStart` … 映像が出るまでの音声だけの区間 (実機で 0.930 秒)。
     *   ここを残すと、1コマ目を 0 秒として数えるプレイヤーで字幕がそのぶん早く出る。
     *   **ずらす (`-output_ts_offset`) のでは直らない** — Matroska は負の時刻を
     *   持てないので muxer が全トラックまとめて押し戻す (実測: 0.363 渡して
     *   動いたのは 0.022 だけ)。捨てれば映像も音声も 0.000 から始まる
     * - `seek` … 録画開始直後の1秒未満だけ、多重化されたもう一方の映像ストリームの
     *   PAT/PMT が確定しておらず、エンコーダの初期化 (fps/解像度確定) 自体が
     *   失敗することがある。最初の失敗を検知した後だけ渡す
     *   (常時捨てると本編側が削れるため)
     *
     * 字幕 (`.sup`) は捨てたぶんを引いた時刻で作ってある (subtitle.rebase)。
     */
    const skip = inputSkip(seek, options.videoStart);
    if (skip > 0) args.push('-ss', String(skip));
    args.push(...TS_PROBE);
    args.push('-i', input);

    /*
     * 字幕は**PGS 1本だけ**。denpa が別に作った .sup をそのまま copy する
     * (作り方は subtitle.ts、なぜ PGS だけかは docs/encode.md)。
     * 作れなかったとき (字幕の無い番組・sub2video が落ちた場合) は字幕トラックが入らない
     */
    let next = 1;
    let pgs = -1;
    if (options.pgsFile != null) {
        pgs = next++;
        args.push('-i', options.pgsFile);
    }
    if (options.chaptersFile != null) {
        // CM位置をチャプターとして持たせる。ファイルは切らないので誤検出しても本編は失われない
        args.push('-i', options.chaptersFile, '-map_chapters', String(next++));
    }
    // mapで解決できない(型が不明な)ストリームは黙ってスキップする。エンコード自体を止めないため
    args.push('-ignore_unknown');
    // 入れ物の title に番組名を入れる (プレイヤーの履歴・通知用)
    if (options.mediaTitle !== undefined && options.mediaTitle !== '') {
        args.push('-metadata', `title=${options.mediaTitle}`);
    }
    // インタレ解除 (bwdif は yadif よりコーミング残りが少ない)。
    // なめらかさの指定でコマ数が変わる (videoArgs)
    args.push('-vf', video.filter);
    // ビデオストリーム設定(?はラジオ相当の映像なし録画でも失敗しないようにするため)
    args.push('-map', '0:v?', '-c:v', ...video.encoder);

    if (audioType === DUAL_MONO) {
        // 副音声は2ヶ国語放送(外国語)の場合と解説放送(日本語の音声ガイド)の場合があり判別できないため言語はundにする。
        // channelsplitの出力はFL/FRという位置情報付き1chレイアウトのままだとlibopusが受け付けないため、aformatでmonoに付け替える
        args.push(
            '-filter_complex',
            'channelsplit[FL][FR];[FL]aformat=channel_layouts=mono[FLm];[FR]aformat=channel_layouts=mono[FRm]',
            '-map',
            '[FLm]',
            '-map',
            '[FRm]',
            '-metadata:s:a:0',
            'language=jpn',
            '-metadata:s:a:1',
            'language=und',
        );
    } else {
        // 音声ストリームを全て拾う(多言語放送等で複数トラックある場合に備える)。
        // ただし頭に中身の無いもの (次の番組の副音声) は外す — `audioStreams`
        const streams = options.audioStreams ?? [];
        if (streams.length === 0) args.push('-map', '0:a');
        for (const index of streams) args.push('-map', `0:a:${index}`);
    }
    args.push('-c:a', 'libopus', '-b:a', '256k'); // 元放送(AAC 256kbps)と同じビットレート

    /*
     * 字幕は**映像・音声のあと**に map する (= 出来上がりの最後のトラック)。
     * ?は .sup が空だった場合でもエンコードを止めないため。
     * 以前は最初に map していてトラック0が字幕になっていた — 慣習 (映像が先頭)
     * から外れると、テレビ組み込みのデマルチプレクサが弱いことがある
     * (実機のテレビ VLC で、字幕を選ぶと固まる症状の切り分けとして直した)。
     * 指定は `s:0` (字幕の0番) 型なので、並べ替えてもここは変わらない
     */
    if (pgs >= 0) args.push(...captionArgs(pgs, options.captionTitle));

    /*
     * **音声にも名前を付ける** (`arib.audioTitles`)。番組表と同じ言い方にするので、
     * 「主音声」「解説」がそのままプレイヤーの切り替えに出る。
     *
     * **多すぎても困らない。** 番組表が言っている本数と実際に入っている本数は
     * 食い違いうるが、ffmpeg は在りもしないトラックへの指定を黙って読み飛ばす
     * (実機で確認)。言語はデュアルモノのところで別に付けてある
     */
    (options.audioTitles ?? []).forEach((title, index) => {
        if (title === '') return;
        args.push(`-metadata:s:a:${index}`, `title=${title}`);
    });

    // トラックのdefaultフラグを明示(未設定だとプレイヤーが自動選択せず音声が出ないことがある。
    // 字幕は上で入れたときだけ立てる)
    args.push('-disposition:v:0', 'default', '-disposition:a:0', 'default');

    /*
     * 進捗を key=value 形式で吐かせる。stderr の人間向けログを目視パースするより確実。
     *
     * **出口は fd 3 (専用のパイプ)。** 標準出力は CM 検出のロゴの枠が使い (`analysis`)、標準エラーは
     * CM 検出の材料 (`scdet` のコマごとの行) が使う。標準エラーへ出すと、ログ (av_log。行の頭の
     * `[scdet@cm @ …] ` と中身を別々に書く) の間に進み具合 (別のスレッドがまとめて書く) が割り込み、
     * 行が千切れる — 30分の録画で 54695 行のうち 2 行を読み落とし、ロゴを使えなくなった (実測)。
     * 人間向けの進み具合の行 (`frame= …`) も止める
     */
    args.push('-nostats', '-progress', 'pipe:3');
    /*
     * 入れ物は名前ではなくここで決める。出力は書いている間だけ別名 (.mkv.encoding) にしており、
     * ffmpeg は拡張子から入れ物を決めるので、付けないと
     * 「Unable to choose an output format」で始まる前に落ちる
     */
    args.push('-f', 'matroska');
    args.push(output);
    // CM 検出の出口は焼く出口のあと。`-map` は出口ごとなので、焼くほうの指定は効かない
    if (options.analysis !== undefined) args.push(...options.analysis);

    return args;
}

/** その録画で今生きているジョブ (待ち・実行中) の id。無ければ undefined */
export function activeEncodeJob(recordingId: number): number | undefined {
    return orm()
        .select({ id: encodeJobs.id })
        .from(encodeJobs)
        .where(
            and(eq(encodeJobs.recording_id, recordingId), inArray(encodeJobs.state, ['queued', 'running'])),
        )
        .get()?.id;
}

export function enqueue(recordingId: number): number {
    const existing = activeEncodeJob(recordingId);
    if (existing !== undefined) return existing;

    return orm()
        .insert(encodeJobs)
        .values({ recording_id: recordingId, state: 'queued', created_at: now() })
        .returning({ id: encodeJobs.id })
        .get()!.id;
}

/**
 * 中止を頼んだジョブが畳み終わるのを待っている人たち。
 * 畳み終わり (`pump` の finally) で呼ばれる
 */
const stopping = new Map<number, (() => void)[]>();

/**
 * 中止を待つ上限。**押した人を待たせすぎない。**
 *
 * ffmpeg は SIGTERM から 1秒ほどで終わる (実測 923ms / 1078ms)。この待ちは
 * その1秒を待って**畳んだ結果を返す**ためのもので、間に合わなければ諦めて
 * 返す — あとは畳み終わりの知らせ (SSE) が追いつく
 */
const CANCEL_WAIT_MS = 5_000;

/** 畳み終わるまで待つ。上限を超えたら諦める (待つのをやめるだけで、中止は続く) */
function settled(jobId: number): Promise<void> {
    if (!runningJobs.has(jobId)) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            const waiting = (stopping.get(jobId) ?? []).filter((fn) => fn !== done);
            if (waiting.length === 0) stopping.delete(jobId);
            else stopping.set(jobId, waiting);
            resolve();
        };
        const timer = setTimeout(done, CANCEL_WAIT_MS);
        stopping.set(jobId, [...(stopping.get(jobId) ?? []), done]);
    });
}

/** 畳み終わったことを、待っている人たちに伝える */
function wakeStopping(jobId: number): void {
    for (const done of stopping.get(jobId) ?? []) done();
    stopping.delete(jobId);
}

/**
 * エンコードを中止する。**畳み終わってから返す。**
 *
 * 頼むだけで返していた頃は、**押しても画面が何も変わらなかった** — 押した直後の
 * 読み直しは ffmpeg がまだ死ぬ前に届くので、同じ「エンコード中 60.9%」が
 * そのまま出る。行が変わるのは畳み終わりの知らせ (SSE) が来たときで、その繋ぎが
 * 切れている端末では**リロードするまで永久に変わらなかった**。
 *
 * ffmpeg は SIGTERM から1秒ほどで終わるので、待ってから返せば押した人の画面は
 * その場で「録画済み」に変わる。**上限つき** (`CANCEL_WAIT_MS`) で、間に合わ
 * なければ諦めて返す — 待たせ続けるよりは、知らせに任せるほうがまし
 */
export async function cancel(jobId: number): Promise<void> {
    canceled.add(jobId);
    // どの段階に居ても止まるようにする。ffmpeg が回っていない段階もある
    aborts.get(jobId)?.abort();
    procs.get(jobId)?.kill();

    const stopped = orm()
        .update(encodeJobs)
        .set({ state: 'canceled', finished_at: now() })
        .where(and(eq(encodeJobs.id, jobId), eq(encodeJobs.state, 'queued')))
        .returning({ id: encodeJobs.id })
        .get();
    // まだ始まっていなければここで終わり
    if (stopped !== undefined) {
        emit('recordings');
        return;
    }

    /*
     * 走っている分。**段階の名前を先に書き換えてから待つ** — 上限に間に合わな
     * かったときでも、押した直後の読み直しが「中止しています」を拾える
     * (割合を出している段階では出ないが、CM検出のように数分かかる段階で効く)
     */
    if (runningJobs.has(jobId)) writeStep(jobId, '中止しています');
    await settled(jobId);
}

/**
 * 中止を頼まれて、まだ畳み終わっていないか。
 *
 * 一覧の行に添えて、中止のボタンを**畳み終わるまで回したままにする**ための
 * もの。押した返事 (`cancel`) は上限で切り上げることがあるので、返事だけで
 * ボタンを戻すと「回るのが止まったのにまだエンコード中」になる
 */
export function isCanceling(jobId: number): boolean {
    return canceled.has(jobId);
}

/** 段階を進めて画面にも伝える。押しても反応が無いように見えるのを防ぐ */
function setPhase(jobId: number, phase: EncodePhase, log: string): void {
    // 中止を頼まれた後は「中止しています」を残す (下の setStep と同じ)
    if (canceled.has(jobId)) return;
    orm()
        .update(encodeJobs)
        .set({ phase, log, percent: 0, eta_ms: null })
        .where(eq(encodeJobs.id, jobId))
        .run();
    emit('recordings');
}

/**
 * 段階の中で「いま何をしているか」だけ書き換える。
 *
 * CM検出は中で3つの道具を順に回していて、どれも数分かかる。段階の名前
 * (「CM検出中」) だけでは、進んでいるのか止まっているのかが分からなかった。
 *
 * **中止を頼まれた後は書き換えない。** `cancel` が書いた「中止しています」を、
 * 畳むまでの間に通る段階 (無音検出に落ちる・字幕を絵にする) が上書きして、
 * 押したのに「CMを探しています」に戻って見えていた
 */
function setStep(jobId: number, log: string): void {
    if (canceled.has(jobId)) return;
    writeStep(jobId, log);
}

function writeStep(jobId: number, log: string): void {
    orm().update(encodeJobs).set({ log }).where(eq(encodeJobs.id, jobId)).run();
    emit('recordings');
}

interface Progress {
    percent: number;
    /** 残り時間の見込み(ms)。速さが読めないうちは null */
    etaMs: number | null;
    log: string;
}

/** 残り時間を測る窓。直近の進み方だけ見る (速度は素材や場面で途中から変わる) */
const ETA_WINDOW_MS = 30_000;
/** これより短い窓からは速度を出さない。起動直後の数点だけで暴れた値を出さないため */
const ETA_MIN_SPAN_MS = 4_000;

/**
 * 焼き上がりのコマ数。進み具合の分母。測れなければ NaN。
 *
 * **入力のコマ数から出す** (尺 × 入力の毎秒コマ数)。出力の毎秒コマ数を
 * 決め打ちにはしない — インタレ解除 (`deinterlace`) は入力1コマから
 * 60コマ指定なら2コマ・30コマ指定なら1コマ作るので、入力が 29.97 でも
 * 59.94 (720p の局) でも、この掛け算なら同じ式で当たる。
 *
 * 頭を捨てるぶん (`-ss`) はもう焼かないので引く
 */
export function expectedFrames(
    probed: { duration: number; fps: number } | undefined,
    skipSec: number,
    smooth: boolean,
): number {
    if (probed === undefined) return NaN;
    const seconds = probed.duration - (Number.isFinite(skipSec) ? skipSec : 0);
    if (!(Number.isFinite(seconds) && seconds > 0)) return NaN;
    if (!(Number.isFinite(probed.fps) && probed.fps > 0)) return NaN;
    return seconds * probed.fps * (smooth ? 2 : 1);
}

/**
 * 進み具合は**焼けたコマ数**から出す (`-progress` の `frame=` ÷ `expectedFrames`)。
 * 残り時間も同じ出どころ (直近30秒で何コマ焼けたか)。
 *
 * **エンコーダが今どこに居るかを直に数えている**のがこの物差しの取り柄で、
 * 前に使っていた2つはどちらも「エンコーダの居場所ではないもの」を見ていた:
 *
 * - `out_time_us` は**出力の mux が最後に書いたパケットの時刻**。疎な字幕が
 *   先に mux されると先に飛び、壊れたストリームが混ざるとそこで止まる
 * - 入力TSの**読み位置** (`/proc/<pid>/fdinfo`) は**デマクサの居場所**。
 *   読むほうだけ先に走ることがあり、実機では焼き上がり半分で読み切って
 *   (RSS 4.9GB ぶん抱えたまま) 99% に貼り付き、残り時間も出なくなった
 *
 * 読み位置は**分母 (尺) が測れなかったときの控え**として残してある。経緯と
 * 実例は docs/encode.md「進み具合は焼けたコマ数から出す」
 */
export function encodeProgress(totalFrames: number, inputBytes: number) {
    const samples: { at: number; done: number }[] = [];
    // NaN 汚染を防ぐガードが要る (JSON上 typeof NaN === 'number' で素通りするため)
    const measurable = (value: number) => Number.isFinite(value) && value > 0;

    return (at: number, pos: number, block: Record<string, string>, prev: number): Progress => {
        const frames = Number(block['frame']);
        const counted = measurable(totalFrames) && Number.isFinite(frames) && frames >= 0;
        // 読み位置が取れない間 (/proc が無い・一瞬の読み損ね) もある
        const readable = measurable(inputBytes) && Number.isFinite(pos) && pos >= 0;
        // どちらも取れなければ前の値を保ち、当てずっぽうを出さない
        const done = counted
            ? Math.min(1, frames / totalFrames)
            : readable
              ? Math.min(1, pos / inputBytes)
              : NaN;
        /*
         * 前の値より下げない (読み損ねからの復帰で巻き戻って見えないように)。
         * **100% は ffmpeg が終わるまで出さない** — 最後のコマを焼いても、
         * 溜めたぶんの吐き出しと mux の締めが残っている。焼き切った時点で
         * 100.0% と出すと、そこで止まって見える (失敗して頭からやり直す時は
         * 特に、100% → 0% と動いて二度おかしく見えた)
         */
        const fraction = Number.isFinite(done) ? done : prev;
        const percent = block['progress'] === 'end' ? 1 : Math.min(Math.max(prev, fraction), 0.99);

        let etaMs: number | null = null;
        if (Number.isFinite(done)) {
            samples.push({ at, done });
            while (samples.length > 0 && at - samples[0]!.at > ETA_WINDOW_MS) samples.shift();
            const oldest = samples[0]!;
            const spanMs = at - oldest.at;
            const gained = done - oldest.done;
            // 速さが読めないうち (窓がまだ短い・進んでいない) は null のまま
            if (spanMs >= ETA_MIN_SPAN_MS && gained > 0) {
                etaMs = Math.round(((1 - done) / gained) * spanMs);
            }
        }

        const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
        const sizeMb = (parseInt(block['total_size'] ?? '', 10) / 1024 / 1024).toFixed(1);
        const rateMbps = (parseFloat(block['bitrate'] ?? '') / 1000).toFixed(2);
        // 読み位置も残す。**割合には使っていないが、詰まった時の見立てに要る**
        // (デマクサだけ先に走っているのか、本当に遅いのかがこの2つ並びで分かる)
        return {
            percent,
            etaMs,
            log: `frame: ${counted ? `${frames}/${Math.round(totalFrames)}` : '数えられず'}, input: ${readable ? `${mb(pos)}/${mb(inputBytes)}MB` : '測れず'}, speed: ${block['speed']}, size: ${sizeMb}MB, rate: ${rateMbps}Mbps, drop: ${block['drop_frames']}`,
        };
    };
}

/**
 * ffmpeg が入力ファイルをどこまで読んだかを /proc から覗く。
 *
 * 子プロセスとは同じ名前空間に居るので、/proc/<pid>/fd から入力ファイルを
 * 指している fd を探せば、/proc/<pid>/fdinfo/<fd> の pos がそのまま読み位置。
 * Linux 専用だが、本番はコンテナでしか動かさない。読めない環境では
 * 割合が動かなくなるだけで、焼き上がりには影響しない。
 */
export function findInputFd(pid: number, path: string): number | null {
    try {
        for (const name of readdirSync(`/proc/${pid}/fd`)) {
            try {
                if (readlinkSync(`/proc/${pid}/fd/${name}`) === path) return Number(name);
            } catch {
                // 覗いている間に閉じられた fd。次を見る
            }
        }
    } catch {
        // プロセスがもう居ないか、/proc の無い環境
    }
    return null;
}

/** 読み位置(バイト)。fd が閉じられているなど、読めなければ NaN */
export function readInputPos(pid: number, fd: number): number {
    try {
        const m = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^pos:\s*(\d+)/);
        return m === null ? NaN : Number(m[1]);
    } catch {
        return NaN;
    }
}

/**
 * 失敗の理由を stderr から拾う。
 *
 * 末尾をそのまま切り出すと、ARIB字幕まわりの「オプションが使われなかった」といった
 * 警告ばかりが残って肝心の理由が見えない。エラーらしい行を優先して残す。
 */
export function failureReason(stderr: string): string {
    const lines = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const errors = lines.filter((line) =>
        /error|invalid|failed|no such file|permission denied|not supported|unable to|conversion failed/i.test(
            line,
        ),
    );
    const picked = errors.length > 0 ? errors : lines;
    return picked.slice(-8).join('\n').slice(-2000);
}

async function runFfmpeg(
    job: EncodeJob,
    input: string,
    output: string,
    audioType: number | null,
    seek: number | null,
    codec: HwCodec,
    options: EncodeOptions = {},
    /** CM 検出を相乗りさせるときの読み手 (`options.analysis` と組で渡す) */
    reader?: ScanReader,
) {
    // fd 3 は進み具合 (`-progress pipe:3`)。標準出力は CM 検出のロゴの枠 (読まないなら捨てる)
    const proc = Bun.spawn([config.ffmpeg, ...buildArgs(input, output, audioType, seek, codec, options)], {
        stdio: ['ignore', reader?.onStdout !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    procs.set(job.id, proc);

    /*
     * 進み具合は焼けたコマ数から出す (encodeProgress)。分母は焼く前に測った尺、
     * 分子は `-progress` の `frame=`。入力の読み位置は分母が測れなかったときの
     * 控えと、詰まった時の見立て用に読み続ける。
     * /proc の fd は実体のパスで見えるので、シンボリックリンクはここで解いておく
     */
    let inputPath = input;
    let inputBytes = NaN;
    try {
        inputPath = realpathSync(input);
        inputBytes = statSync(inputPath).size;
    } catch {
        // 測れなければ控えが1つ減るだけ。焼くほうはそのまま進める
    }
    const total = expectedFrames(
        options.probed,
        inputSkip(seek, options.videoStart),
        options.smoothMotion === true,
    );
    const progress = encodeProgress(total, inputBytes);
    let inputFd: number | null = null;
    let inputPos = NaN;

    // 出力し終えた時点の位置。CMを切ると入力より短くなるので、出来上がりの長さはこちら
    let outTimeUs = NaN;
    let percent = 0;
    let etaMs: number | null = null;
    let log = '';
    let lastWrite = 0;
    /** 落ちた理由を読むための末尾。進み具合と CM 検出の材料 (1コマ1行) は入れない */
    const tail: string[] = [];

    const updateProgress = (percent: number, etaMs: number | null, log: string) =>
        orm().update(encodeJobs).set({ percent, eta_ms: etaMs, log }).where(eq(encodeJobs.id, job.id)).run();

    const onProgress = (block: Record<string, string>) => {
        const at = Number(block['out_time_us']);
        if (Number.isFinite(at) && at > 0) outTimeUs = at;

        if (inputFd === null) inputFd = findInputFd(proc.pid, inputPath);
        if (inputFd !== null) {
            const pos = readInputPos(proc.pid, inputFd);
            // 読み終えると ffmpeg は fd を閉じる。最後に見えた位置 (≒末尾) を
            // 保ったまま、念のため次の刻みから探し直す
            if (Number.isFinite(pos)) inputPos = pos;
            else inputFd = null;
        }
        const p = progress(Date.now(), inputPos, block, percent);
        percent = p.percent;
        etaMs = p.etaMs;
        log = p.log;

        const wroteAt = Date.now();
        if (wroteAt - lastWrite >= PROGRESS_INTERVAL) {
            lastWrite = wroteAt;
            updateProgress(percent, etaMs, log);
            /*
             * 進み具合は**中身ごと**流す (`encode` イベント)。`recordings` で
             * 流していた頃は、数秒おきに一覧がページ全体を読み直していて、
             * 遅い回線では読み直しの往復ぶん数字が遅れた。中身が届けば
             * 画面は該当行の数字を書き換えるだけで済む
             */
            emit('encode', {
                recordingId: job.recording_id,
                percent,
                etaMs,
                log,
            } satisfies EncodeProgress);
        }
    };

    const readProgress = (async () => {
        let block: Record<string, string> = {};
        const fd = proc.stdio[3] as number;
        for await (const line of lines(Bun.file(fd).stream())) {
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            block[line.slice(0, eq)] = line.slice(eq + 1).trim();
            if (block['progress'] === undefined) continue;
            onProgress(block);
            block = {};
        }
    })();

    const readStderr = (async () => {
        for await (const line of lines(proc.stderr as ReadableStream<Uint8Array>)) {
            if (reader?.line(line) === true) continue;
            // キーフレームを置くための切れ目 (`scdet@key`) も来る
            if (line === '' || line.includes('lavfi.scd.')) continue;
            tail.push(line);
            if (tail.length > 40) tail.shift();
        }
    })();

    const onStdout = reader?.onStdout;
    const readStdout = (async () => {
        if (onStdout === undefined) return;
        let broken = false;
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            if (broken) continue;
            try {
                onStdout(chunk);
            } catch (error) {
                /*
                 * ロゴの点付けが壊れても**焼くほうは止めない**。読み捨てて続けると、届いた枠の数が
                 * コマの数と合わなくなり、ロゴを使わずに決める (`cm.openCm`)
                 */
                broken = true;
                console.error(`[cm] ロゴの枠を読めなくなりました: ${error}`);
            }
        }
    })();

    const [code] = await Promise.all([proc.exited, readStdout, readStderr, readProgress]);
    procs.delete(job.id);
    updateProgress(code === 0 ? 1 : percent, null, log);
    return { code, stderrTail: failureReason(tail.join('\n')), outTimeUs };
}

/**
 * 焼きながら読んだ材料から CM を決める。**入れ物の頭からの秒で返す** (焼いたものの時刻に
 * `skip` を足す)。焼くたびに捨てる頭の長さが変わっても、ここを物差しにして引き直す (`own`)。
 * 読めなかった・決められなかったときは CM 無しで、理由を覚え書きに残す (焼いたものは捨てない)
 */
async function decide(reading: CmReading, found: Scan | null, skip: number): Promise<CmDetection> {
    if (found === null) return { cm: [], duration: Number.NaN, note: 'CM検出の読み込みが失敗しました' };
    try {
        // ロゴを覚え直して枠だけ読み直すときも、焼いたときと同じだけ頭を捨てる (コマの並びを揃える)
        const before = [...(skip > 0 ? ['-ss', String(skip)] : []), ...TS_PROBE];
        const decided = await reading.decide(found, { skip, before });
        return {
            ...decided,
            cm: decided.cm.map((range) => ({ start: range.start + skip, end: range.end + skip })),
            duration: decided.duration + skip,
        };
    } catch (error) {
        console.error(`[cm] 検出に失敗しました: ${error}`);
        return { cm: [], duration: Number.NaN, note: `CM検出に失敗しました: ${error}` };
    }
}

/**
 * ジョブの生TSから派生する中間ファイルを消す。
 *
 * `descramble` の `.decoded.m2ts` は、正常終了や失敗なら finally / cleanup で消えるが、
 * **プロセスごと落ちたときは取り残される**。しかも TS の拡張子で終わるので、掃除機は
 * 動画と見なして消さない (`files.ts` の VIDEO)。生TSと同じ大きさのものが丸ごと居座る。
 * (拡張子は `.m2ts` に揃えてある — 録画そのものと同じで、`.ts` は TypeScript と紛れる。
 * `.ts` で作っていた頃の取り残しも一緒に消す)
 *
 * 走らせ直せば作り直すものなので、ジョブを(再)実行する直前と、諦めて failed にするときに
 * 消しておく。自分の入力に紐づくものだけ触るので、他の走っているエンコードには当たらない。
 * (焼いたものの隣に作る作業ファイル — `.encoding` とその切り貼り — は動画の拡張子ではないので、
 * 取り残されても掃除機が片付ける)
 */
function clearScratch(input: string): void {
    for (const ext of ['m2ts', 'ts']) removeIfExists(`${input}.decoded.${ext}`);
}

/** ジョブを失敗にする (行を書くだけ。知らせも画面の更新もしない) */
function markFailed(jobId: number, reason: string): void {
    orm()
        .update(encodeJobs)
        .set({ state: 'failed', error: reason, finished_at: now() })
        .where(eq(encodeJobs.id, jobId))
        .run();
}

/**
 * エンコードの失敗を記録して知らせる。
 *
 * **録画の行には何も書かない。** 落ちたのは焼き直しのほうで、元の録画は無事なので、
 * 録画そのものを「失敗」にすると観られるはずのものが観られなくなる (実際にそうなっていた)。
 * 理由はジョブが持ち、一覧は最新のジョブを見て出す
 */
function fail(jobId: number, recording: Recording, reason: string): void {
    markFailed(jobId, reason);
    emit('recordings');
    notify({
        event: 'encode.failed',
        text: `エンコードに失敗しました: ${recording.name} (${recording.service_name})`,
        recording: recordingSummary(recording),
        error: reason,
    });
}

/**
 * 中止で終わったときの後始末。
 *
 * 出来かけの作業ファイルだけ捨てて、元の録画には触らない。
 * どの段階で止めても同じ形で畳めるように1か所にまとめてある。
 */
function finishCanceled(jobId: number, working: string | null): void {
    removeIfExists(working);
    orm()
        .update(encodeJobs)
        .set({ state: 'canceled', finished_at: now() })
        .where(eq(encodeJobs.id, jobId))
        .run();
    // 録画の行は触らない。ジョブが消えれば「録画済み」に戻って見える
    emit('recordings');
}

/**
 * **字幕トラックを用意する。** 字幕の作り方はここと `captionArgs` (焼く ffmpeg への渡し方) の2つに寄せてある。
 *
 * いまは放送どおりに描いた字幕を PGS にして (`subtitle.buildPgs`)、焼くときに copy で入れる。
 * ffmpeg には PGS の符号器が無いので denpa が書く。焼くほうを dvdsub だけにしていた頃は1枚4色までで、
 * 実測230色の字幕から縁のなめらかさと色分けが落ちていた。作れなければ黙って諦める (字幕トラックが
 * 1本減るだけ)。CM を切るときも CM ごと作り、焼いたものと一緒に切る (`cm-cut.ts`)
 */
async function prepareCaptions(
    jobId: number,
    source: string,
    options: EncodeOptions,
    formatStart: number,
    signal: AbortSignal,
): Promise<void> {
    setPhase(jobId, 'encode', '字幕を画像にしています');
    /*
     * 字幕の 0 秒を**焼き上がりの 0 秒に合わせる。** 焼くほうは入れ物の始まりから
     * 数え直したうえで、映像が出るまで (`headSkip`) を捨てる。同じところを引く
     */
    const startAt = formatStart + headSkip(options.videoStart);
    const pgs = await buildPgs(source, options.canvasSize, startAt, signal);
    if (pgs === null) return;
    options.pgsFile = pgs.path;
    // 名前も放送が名乗っているものにする (「字幕 (日本語)」)
    options.captionTitle = pgs.label;
    orm()
        .update(encodeJobs)
        .set({ log: `字幕 ${pgs.captions} 枚を PGS にしました` })
        .where(eq(encodeJobs.id, jobId))
        .run();
}

async function runJob(jobId: number): Promise<void> {
    const controller = new AbortController();
    aborts.set(jobId, controller);
    const signal = controller.signal;

    const job = orm().select().from(encodeJobs).where(eq(encodeJobs.id, jobId)).get()!;
    const recording = orm().select().from(recordings).where(eq(recordings.id, job.recording_id)).get();
    const input = recording === undefined ? null : encodeSource(recording);

    if (recording === undefined || input === null) {
        markFailed(jobId, '元にできる生TSがありません');
        return;
    }

    // 前の回が落ちて取り残した中間ファイルを片付けてから始める (この生TSぶんだけ)
    clearScratch(input);

    /*
     * 「エンコード中」は録画の行には書かない。動いているジョブがあることが
     * そのまま「エンコード中」なので、一覧はそれを見て出す (format.encodeLabel)。
     * 前の失敗の理由もジョブ側にあり、いちばん新しいジョブだけを見ているので消して回る必要もない
     */
    emit('recordings');

    /*
     * **置き場所は出来上がってから決める** (下の `renameSync` の直前)。
     * ここで決めた名前を最後まで使うと、**同じ番組を2本同時に焼いたときに
     * 両方が同じ名前を選ぶ** — どちらもまだ書き終えていないので、
     * `libraryPath` の「空いているか」がどちらにも空いて見える。
     * いま要るのは置き場所ではなく**フォルダ**だけ
     */
    mkdirSync(dirname(libraryPath(recording, '.mkv')), { recursive: true });

    // スクランブルが掛かったまま録れていたら、ここで解く (scramble.ts)
    /** 後始末で消す作業ファイル。生TSを置き換えたときは残す側になるので null のまま */
    let decoded: string | null = null;
    let sourceTs = input;
    if (isScrambled(input)) {
        setPhase(jobId, 'descramble', 'スクランブルを解いています');
        const target = `${input}.decoded.m2ts`;
        const result = await descramble(input, target, signal);
        if (!result.ok) {
            removeIfExists(target);
            // 中止で切ったときは失敗にしない。下の後始末で canceled として畳む
            if (canceled.has(jobId)) return finishCanceled(jobId, target);
            fail(jobId, recording, `スクランブルを解除できませんでした: ${result.error}`);
            return;
        }
        // 生TSを残すかは録画ごとではなく全体設定 (settings.keepOriginal)
        if (settings().keepOriginal) {
            // 生TSを残す設定なら、残すのは解けたほうだけにする。
            // 掛かったままのTSを取っておいても、あとから解ける保証は無い
            renameSync(target, input);
        } else {
            decoded = target;
            sourceTs = target;
        }
    }

    const encodeOptions: EncodeOptions = {
        // コマ数の既定は 60。設定が入っていれば、焼く前に本編映像から実測して決め直す (measureSmoothMotion)
        smoothMotion: true,
        /*
         * **音声トラックに番組表と同じ名前を入れる。**
         *
         * 番組表の行は24時間で消えるので、写しておいたものから引く
         * (`recordings.audios`。ジャンルと同じ扱い)。古い録画には写しが無いので、
         * そのときは `audioTitles` の既定 (「音声」/「主音声」「副音声」) に落ちる
         * (壊れた行を空にするのは列の読み手。`schema.ts`)
         */
        audioTitles: audioTitles(recording.audios ?? [], recording.audio_type === DUAL_MONO),
        mediaTitle: displayTitle(recording.name),
    };

    /*
     * **CM は焼きながら探す。** 1本目のコーデックを焼く ffmpeg に CM 検出の出口を足して、
     * TS を1回だけ復号する (`cm-scan.scanOutputs`)。ここでは支度だけ — 尺を測り、局ロゴを開く
     * (覚えていなければキーフレームだけ読んで覚える)
     */
    const mode = settings().cmCut;
    let reading: CmReading | null = null;
    if (mode !== 'off') {
        setPhase(jobId, 'cm', '局ロゴを確かめています');
        try {
            reading = await openCm(sourceTs, {
                signal,
                serviceId: recording.service_id,
                // 録画の頭と尻に入った前後の番組を見分ける (cm-decide.withinProgram)
                programLength: (recording.end_at - recording.start_at) / 1000,
                programStart:
                    (recording.start_at -
                        (recording.record_from ?? recording.start_at - config.startMargin)) /
                    1000,
                onStep: (label) => setStep(jobId, label),
            });
        } catch (error) {
            console.error(`[cm] 検出の支度に失敗したためCM処理をスキップします: ${error}`);
        }
    }
    /** 途中でやめるときに、ここまでの作業ファイル (チャプター・字幕) を片付ける */
    const discardWork = (): void => {
        removeIfExists(encodeOptions.chaptersFile);
        removeIfExists(encodeOptions.pgsFile);
    };
    if (canceled.has(jobId)) return finishCanceled(jobId, decoded);

    /*
     * コマ数を本編映像から実測する (measureSmoothMotion)。設定で切ってあれば測らず、全部 60コマで出す。
     * CM はまだ分からないので、録画全体に窓を散らす
     */
    if (settings().fpsDetect) {
        setStep(jobId, 'フレームレートを確かめています');
        encodeOptions.smoothMotion = await measureSmoothMotion(
            sourceTs,
            (recording.end_at - recording.start_at) / 1000,
            signal,
        );
    }
    // ここから先の下調べ (ffprobe) は合図を受け取らない。測っている間に押されていたら、その前で降りる
    if (canceled.has(jobId)) {
        discardWork();
        return finishCanceled(jobId, decoded);
    }

    setPhase(jobId, 'encode', '');

    // 画面の大きさ・画素の縦横比・頭の音声だけの区間を焼く前に測っておく。
    // 尺と毎秒コマ数は進み具合の分母にもなる (encodeProgress。下で probed に渡す)
    const measured = await probeVideo(sourceTs);
    encodeOptions.probed = { duration: measured.duration, fps: measured.fps };
    // 字幕を絵で焼くときの画面の大きさ。渡さないと 1440x1080 とみなされ、
    // 1920x1080 の録画では字幕だけ横に伸びる
    if (Number.isFinite(measured.width) && Number.isFinite(measured.height)) {
        encodeOptions.canvasSize = `${measured.width}x${measured.height}`;
    }
    encodeOptions.audioStreams = await probeLiveAudio(sourceTs);
    // 映像が出るまでの音声だけの区間。頭から捨てて 0 秒から始める
    encodeOptions.videoStart = await probeLeadIn(sourceTs, measured.formatStart, measured.packetStart);

    /*
     * 画素が横長なら、正方形に直した大きさで焼く (地上波HDは 1440x1080 の SAR 4:3)。
     * **もともと正方形なら渡さない** — 同じ大きさへの scale は仕事が増えるだけ
     */
    if (Number.isFinite(measured.width) && Number.isFinite(measured.height) && measured.sar !== 1) {
        const width = Math.round((measured.width * measured.sar) / 2) * 2;
        if (width > 0 && width !== measured.width) {
            encodeOptions.displaySize = { width, height: measured.height };
        }
    }

    // 字幕トラックを用意する (作り方は `prepareCaptions` に寄せてある)
    await prepareCaptions(jobId, sourceTs, encodeOptions, measured.formatStart, signal);

    if (canceled.has(jobId)) {
        discardWork();
        return finishCanceled(jobId, decoded);
    }

    /*
     * **焼き直す前に、いま置いてあるものを消す。**
     *
     * 出来上がるまで別名 (`.encoding`) に書くので、消さないと同じ番組の mkv が
     * 焼いている間ずっと2本ぶん場所を取る。**画面に出ている大きさより実際の
     * 使用量が多い**のは、外から見て分からない。
     *
     * **消しても焼き直せる。** 元は生TS (`encodeSource`) で、これとは別のファイル。
     * 引き換えに、失敗したり途中でやめたりするとその間は再生できるものが
     * 無くなるが、生TSは残っているのでもう一度押せば戻る。
     *
     * **DBの `library_path` も一緒に空ける。** 残したままだと実体との照合が
     * 「保存先から消えていました」と読んで、**録画ごと削除済みに倒す**
     * (そのとき生TSまで消える)。空けておけば照合の対象から外れ、
     * 画面でも「まだ保存先に無い」と正しく出る
     */
    /*
     * **DBが指す2本だけでなく、この録画が取りうる名前の“はぐれファイル”も消す。**
     * 命名規則が `[録画ID]` 付きに変わる前の素名 AV1 などは library_path/alt_path に
     * 載っていないので、これまで永久に残り、置き場所を毎回「衝突」と読ませて
     * `[録画ID]` を剥がれなくしていた (library.ts の libraryFamily 参照)。
     * **他の録画が現に使っている置き場所は消さない** — DBで確認して、はぐれ
     * (誰も使っていないファイル) だけ片付ける
     */
    const stalePaths = new Set<string>();
    if (recording.library_path !== null) stalePaths.add(recording.library_path);
    if (recording.alt_path !== null) stalePaths.add(recording.alt_path);
    for (const candidate of libraryFamily(recording)) {
        if (stalePaths.has(candidate) || !existsSync(candidate)) continue;
        if (!usedByOther(candidate, recording.id)) stalePaths.add(candidate);
    }
    if (stalePaths.size > 0) {
        for (const stalePath of stalePaths) {
            removeIfExists(stalePath);
            removeSidecars(stalePath);
        }
        orm()
            .update(recordings)
            .set({ library_path: null, alt_path: null, updated_at: now() })
            .where(eq(recordings.id, recording.id))
            .run();
        emit('recordings');
    }

    /*
     * **選ばれたコーデックごとに焼く。** 両方選べば AV1 と H.264 の2本を作る (`settings().codecs`)。
     * CM は1本目を焼きながら探し、2本目は決まった境目で焼く (チャプターを入れる・境目に
     * キーフレームを置く)。字幕の絵起こしは上でひとまとめに済ませてある。
     *
     * どれか1つでも失敗すれば、そのジョブごと失敗にする (途中まで置いたものは消す)。
     */
    const codecs = settings().codecs.length > 0 ? settings().codecs : (['av1'] as const);
    const placed: { codec: HwCodec; path: string }[] = [];
    // 測れなかったときの尺の当て。ffmpeg が言ってきた値 (下の duration_ms)
    let lastOutTimeUs = 0;
    /** CM 検出の結果 (入れ物の頭からの秒)。1本目を焼き終えたら決まる */
    let detection: CmDetection | null = null;
    /** 1本目で読んだ最初のコマの時刻 (入れ物の頭から)。切るとき、焼いたものの時刻と突き合わせる */
    let firstFrame = Number.NaN;
    /** 実際に切って残した区間 (入れ物の頭からの秒)。データ放送の時刻を詰めるのに使う */
    let kept: Range[] | null = null;
    /** 本編の最初の区間 (焼いたものの時刻)。CM を残したときのサムネ */
    let contentStart: Range | null = null;
    const frameRate = Number.isFinite(measured.fps) ? measured.fps : config.cmFallbackFps;

    /**
     * CM の区間を、頭を `skip` 秒捨てて焼いたものの時刻に直す (字幕と同じ引き算。`subtitle.rebase`)。
     * 焼き直し (`encodeRetrySeek`) で捨てる長さが変わるので、焼くたびに引き直す
     */
    const own = (skip: number) => {
        const found = detection ?? { cm: [], duration: Number.NaN };
        const duration = found.duration - skip;
        const cm = shiftRanges(found.cm, skip);
        return { cm, duration, keep: invertRanges(cm, duration) };
    };
    /** チャプターを、焼くものの 0 秒に合わせて書く */
    const writeChapters = (skip: number): void => {
        if (encodeOptions.chaptersFile == null) return;
        const { cm, duration } = own(skip);
        writeFileSync(encodeOptions.chaptersFile, chapterMetadata(cm, duration));
    };

    /** 途中でやめる/失敗するときに、置きかけを全部片付ける */
    const cleanup = (working: string | null): void => {
        if (working !== null)
            for (const suffix of ['', '.post', '.ffconcat']) removeIfExists(`${working}${suffix}`);
        for (const p of placed) removeIfExists(p.path);
        discardWork();
        removeIfExists(decoded);
    };

    /**
     * 1本焼く。**試す順。** まず頭からそのまま。落ちたら頭を少し捨てて (`-ss`) もう一度 —
     * 録画開始直後の数百msだけ壊れているケースをここで拾う (buildArgs のコメント)。
     * 別の理由での失敗もここに来るが、もう一度同じ理由で落ちるだけなので無害。
     *
     * **GPU で焼くときは、その2回が駄目なら次の道 (QSV → VA-API → ソフトウェア) で
     * 同じ2回をやり直す。** 起動時の試し焼きは通っても、素材しだいで落ちることは
     * ありうる (ドライバの対応していない大きさなど)。GPU が駄目なだけで録画が
     * 失敗になるのは避けたい。GPU の失敗は初期化で落ちるので、やり直しは速い
     *
     * `analysis` なら CM 検出を相乗りさせる。**全部落ちたら、探さずにもう1度だけ焼く** —
     * 検出の出口が焼くほうを道連れにしたのかもしれない。焼けたものは残し、CM は無しにする
     */
    const encodeWays = async (
        codec: HwCodec,
        working: string,
        extra: {
            analysis: boolean;
            keyframes?: (skip: number) => Keyframes | undefined;
            /** GPU を使わない (境目を指して焼き直すとき。GPU は頼みを聞かないことがある) */
            software?: boolean;
        },
    ) => {
        const ways: (HwWay | undefined)[] = extra.software
            ? [undefined]
            : [...hwChain(codec, settings().hwAllow, hwTurn++), undefined];
        const attempts = ways.flatMap((hardware) => [
            { seek: null, hardware },
            { seek: config.encodeRetrySeek, hardware },
        ]);
        let result = { code: -1, stderrTail: '', outTimeUs: 0 };
        let found: Scan | null = null;
        let skip = 0;
        for (const [i, attempt] of attempts.entries()) {
            if (i > 0) {
                if (canceled.has(jobId)) break;
                // 数えるのは頭を捨てる再試行だけ (毒ジョブの見立て `encodeMaxAttempts` の物差し)。
                // GPU から降りるのは、その素材ではその道が使えないというだけで、毒ではない
                if (attempt.seek !== null) {
                    orm()
                        .update(encodeJobs)
                        .set({ attempts: sql`${encodeJobs.attempts} + 1` })
                        .where(eq(encodeJobs.id, jobId))
                        .run();
                }
                const before = attempts[i - 1]!.hardware;
                if (attempt.hardware !== before) {
                    setStep(
                        jobId,
                        `${wayName(before)} でエンコードできなかったため、${wayName(attempt.hardware)} でやり直します (${codec})`,
                    );
                }
            }
            skip = inputSkip(attempt.seek, encodeOptions.videoStart);
            writeChapters(skip);
            // ロゴの点は読むたびに一から数える (落ちた回の途中までを持ち越さない)
            const want = extra.analysis ? reading?.want() : undefined;
            const reader = want === undefined ? undefined : scanReader(want.logo);
            const keyframes = extra.keyframes?.(skip);
            result = await runFfmpeg(
                job,
                sourceTs,
                working,
                recording.audio_type,
                attempt.seek,
                codec,
                {
                    ...encodeOptions,
                    hardware: attempt.hardware,
                    ...(keyframes === undefined ? {} : { keyframes }),
                    ...(want === undefined ? {} : { analysis: scanOutputs(want) }),
                },
                reader,
            );
            if (result.code === 0) {
                if (reader !== undefined) found = reader.result(0, '', measured.duration - skip);
                break;
            }
        }
        if (result.code !== 0 && extra.analysis && reading !== null && !canceled.has(jobId)) {
            setStep(jobId, `CMを探さずにエンコードし直します (${codec})`);
            skip = inputSkip(null, encodeOptions.videoStart);
            result = await runFfmpeg(
                job,
                sourceTs,
                working,
                recording.audio_type,
                null,
                codec,
                encodeOptions,
            );
        }
        return { result, found, skip };
    };

    /** 焼き直さずに書き直す (チャプターを足す・CM を切る)。出来たら作業ファイルと差し替える */
    const rewrite = async (working: string, args: (output: string) => string[]): Promise<boolean> => {
        const output = `${working}.post`;
        const code = (await run(args(output), { signal })).code;
        if (code !== 0 || !existsSync(output)) {
            removeIfExists(output);
            return false;
        }
        renameSync(output, working);
        return true;
    };

    /**
     * 焼いたものから CM を切る (`cm-cut.ts`)。残した区間を入れ物の頭からの秒で返す。
     * 境目にキーフレームが無い・切れなかったら null
     */
    const cutWorking = async (working: string, skip: number): Promise<Range[] | null> => {
        const found = await listKeyframes(working);
        if (found === null) return null;
        const { keep, duration } = own(skip);
        // 焼いたものの時刻と、検出の時刻 (どちらも同じ1コマ目から) のずれ。muxer が数ミリ秒ずらす
        const offset =
            Number.isFinite(firstFrame) && Number.isFinite(found.first)
                ? found.first - (firstFrame - skip)
                : 0;
        const plan = planCut(keep, found.keys, {
            offset,
            tolerance: 1.5 / frameRate,
            margin: config.cmCutMargin,
            duration,
        });
        if (plan === null) return null;
        console.log(
            `[cm] 切った所のずれ (コマ): ${plan.errors.map((e) => (e * frameRate).toFixed(1)).join(' / ') || 'なし'}`,
        );
        const list = `${working}.ffconcat`;
        writeFileSync(list, cutList(working, plan.pieces));
        const ok = await rewrite(working, (output) => cutArgs(list, output));
        removeIfExists(list);
        if (!ok) return null;
        return plan.pieces.map((piece) => ({
            start: piece.start - offset + skip,
            end: (piece.end === null ? duration : piece.end - offset) + skip,
        }));
    };

    for (const [index, codec] of codecs.entries()) {
        /*
         * 別名に書いてから置き換える (入力と出力が同じ場所でも元を壊さない。失敗しても元が残る)。
         * 名前はジョブとコーデックで分ける — 番組名だけだと同じ番組の2本が1つの作業ファイルに
         * 同時に書いて壊した (実機)
         */
        const working = `${encodedPath(recording, codec)}.${jobId}.${codec}.encoding`;
        const first = index === 0;
        // 切るのは CM を探せるときだけ (支度で転んだら CM 無しで焼く)
        const cutting = mode === 'cut' && reading !== null;

        const done = await encodeWays(codec, working, {
            analysis: first && reading !== null,
            // 1本目は境目がまだ分からないので場面の切れ目ごとに。2本目からは境目そのものに
            ...(cutting
                ? {
                      keyframes: (skip: number) =>
                          first ? 'scene' : cutPoints(own(skip).keep, own(skip).duration),
                  }
                : {}),
        });

        // 出来かけを捨てるだけ。元のファイルには触らない
        if (canceled.has(jobId)) {
            cleanup(working);
            return finishCanceled(jobId, null);
        }
        if (done.result.code !== 0) {
            cleanup(working);
            fail(jobId, recording, done.result.stderrTail);
            return;
        }
        lastOutTimeUs = done.result.outTimeUs;

        if (first && reading !== null) {
            setPhase(jobId, 'cm', 'CMの境目を決めています');
            detection = await decide(reading, done.found, done.skip);
            firstFrame = (done.found?.times[0] ?? Number.NaN) + done.skip;
            orm()
                .update(recordings)
                .set({ cm_ranges: detection.cm, cm_note: detection.note, updated_at: now() })
                .where(eq(recordings.id, recording.id))
                .run();
            setStep(jobId, `CM ${detection.cm.length} 箇所 (${detection.note})`);
            if (detection.cm.length > 0 && mode === 'chapter') {
                /*
                 * 1本目にはチャプターを書き足す (焼き直さない。中身はそのまま写すだけ)。
                 * 2本目からは焼くときに入れる (`buildArgs` の `chaptersFile`)
                 */
                encodeOptions.chaptersFile = `${sourceTs}.chapters.txt`;
                writeChapters(done.skip);
                const file = encodeOptions.chaptersFile;
                if (!(await rewrite(working, (output) => chapterArgs(working, file, output))))
                    console.error('[cm] チャプターを書き足せませんでした。チャプター無しで置きます');
                // CM が残るので、サムネを本編の最初の区間から取る
                contentStart = own(done.skip).keep[0] ?? null;
            }
            if (canceled.has(jobId)) {
                cleanup(working);
                return finishCanceled(jobId, null);
            }
        }

        if (cutting && detection !== null && detection.cm.length > 0) {
            setPhase(jobId, 'cut', 'CMを切っています');
            let cut = await cutWorking(working, done.skip);
            if (cut === null && !canceled.has(jobId)) {
                /*
                 * 境目にキーフレームが無かった (無音の真ん中に置いた境目・GPU が頼みを聞かなかった)。
                 * 境目を指して焼き直してから切る
                 */
                setPhase(jobId, 'encode', `CMの境目にキーフレームを置いて焼き直します (${codec})`);
                const again = await encodeWays(codec, working, {
                    analysis: false,
                    keyframes: (skip) => cutPoints(own(skip).keep, own(skip).duration),
                    software: true,
                });
                if (canceled.has(jobId)) {
                    cleanup(working);
                    return finishCanceled(jobId, null);
                }
                if (again.result.code !== 0) {
                    cleanup(working);
                    fail(jobId, recording, again.result.stderrTail);
                    return;
                }
                lastOutTimeUs = again.result.outTimeUs;
                setPhase(jobId, 'cut', 'CMを切っています');
                cut = await cutWorking(working, again.skip);
            }
            // 切れなければ CM ごと置く。録れているものを捨てない
            if (cut === null) console.error(`[cm] CMを切れませんでした。CMを残したまま置きます (${codec})`);
            else if (first) kept = cut;
            if (canceled.has(jobId)) {
                cleanup(working);
                return finishCanceled(jobId, null);
            }
        }

        /*
         * **ここで初めて置き場所を決める。**
         *
         * 同じ番組の別の録画が先に置き終えていれば、`encodedPath` がそれを見て
         * `[録画ID]` を足した名前を返す。決めてから `renameSync` までの間に
         * `await` を挟まないので、2本が同じ名前を掴むことはない (同じプロセスの中)
         */
        const output = encodedPath(recording, codec);
        renameSync(working, output);
        /*
         * **字幕は動画の隣に置きません。** 入れ物の中に入っているので、要るときに抜く
         * (`api/recordings/<id>/captions.sup`)。消すほうだけ残してある — 文字の
         * 写しを置いていた頃 (`.ja.ass`) のものが残っていると、CMを切ったぶんだけ
         * ずれた字幕が付いたままになる
         */
        removeIfExists(sidecarPaths(output).subtitle);
        placed.push({ codec, path: output });
    }

    // 主は AV1 (小さいので既定の再生に向く)。無ければ焼いたほう
    const primary = placed.find((p) => p.codec === 'av1') ?? placed[0];
    // 上のループは焼けなければ return しているので、ここに来れば1本はある
    if (primary === undefined) throw new Error('焼いたものが1本も無いのに置きに来ました');
    const alt = placed.find((p) => p.path !== primary.path)?.path ?? null;
    const output = primary.path;

    /*
     * **decoded を消す前に、生TSからデータ放送を取り出してサイドカーに置く。**
     * 録画でも d ボタンで出せるように、再生位置つきの変化ログを残す
     * (server/recorded-bml.ts)。転んでもエンコードは落とさない — 付け足しなので
     */
    try {
        const changes = await saveRecordedBml(
            sourceTs,
            sidecarPaths(output).dataBroadcast,
            recording,
            // 時刻を詰めるのは CM を実際に切れたときだけ。切れずに CM ごと焼いたなら映像の時刻のまま
            kept,
        );
        if (changes > 0) {
            console.log(`[bml] 録画のデータ放送を保存しました: ${changes} 変化 (録画 ${recording.id})`);
        }
    } catch (error) {
        console.error(`[bml] データ放送の取り出しに失敗しました (録画 ${recording.id}): ${error}`);
    }

    removeIfExists(encodeOptions.chaptersFile);
    // 解除したTSは作業用。元のTSは残したままなので、やり直せる
    removeIfExists(decoded);

    // 番組名が変わって置き場所が動いたぶんは、焼き直す前の掃除
    // (上の stalePaths) が library_path/alt_path ごと消してあるので、ここでは要らない

    let size = 0;
    try {
        size = statSync(output).size;
    } catch {
        // 取れなくても致命的ではない
    }

    /*
     * 出来上がりの長さで上書きする。CMを切っていれば元のTSより短い。
     *
     * **出来上がったものを測る。** ffmpeg が言ってきた `out_time` を書いていた頃は、
     * 壊れた副音声が1本混ざっている録画で **8.576 秒**と入っていた
     * (中身は 30分ぶん正しく入っていた)。理由は `out_time` が当てにならないのと同じ
     * (`encodeProgress` のコメント参照)。測れなかったときだけ、これまでどおり ffmpeg の値に落ちる
     */
    const made = (await probeVideo(output)).duration;
    const length = Number.isFinite(made) ? made * 1000 : lastOutTimeUs / 1000;
    if (Number.isFinite(length) && length > 0) {
        orm()
            .update(recordings)
            .set({ duration_ms: Math.round(length) })
            .where(eq(recordings.id, recording.id))
            .run();
    }

    // サムネイルを動画の隣に書く。動画を置いた直後に作る。
    // CMを切っていない録画は、本編の最初の区間からサムネを取る (CMの絵を避ける)
    await writeThumbnail(output, (recording.end_at - recording.start_at) / 1000, contentStart ?? undefined);
    /*
     * **もう一方 (H.264) の隣にもポスターを複製しておく** (同じ絵。ffmpeg を
     * もう一度は回さない)。主 (AV1) を消すと残ったほうが主に繰り上がるので、
     * そのときも画面のサムネが途切れない
     */
    if (alt !== null) {
        const primaryPoster = sidecarPaths(output).thumbnail;
        if (existsSync(primaryPoster)) copyFileSync(primaryPoster, sidecarPaths(alt).thumbnail);
    }

    orm()
        .update(encodeJobs)
        .set({ state: 'done', percent: 1, finished_at: now() })
        .where(eq(encodeJobs.id, jobId))
        .run();
    emit('recordings');
    notify({
        event: 'encode.finished',
        text: `エンコードが終わりました: ${recording.name} (${recording.service_name})`,
        recording: recordingSummary(recording),
    });

    // 保存先が入った時点で「視聴可能」になる (recordings.state は生成列)。
    // 主は AV1 (`output`)、もう一方は `alt` (両方焼いたときだけ)。
    // コマ数 (実測か既定の60) も一緒に書く — 番組詳細の札はここからしか出せない
    const fps = encodeOptions.smoothMotion === true ? 60 : 30;
    const finished = { library_path: output, alt_path: alt, ts_size: size, fps, updated_at: now() };
    if (settings().keepOriginal) {
        orm().update(recordings).set(finished).where(eq(recordings.id, recording.id)).run();
    } else {
        removeIfExists(recording.ts_path);
        orm()
            .update(recordings)
            .set({ ...finished, ts_path: null })
            .where(eq(recordings.id, recording.id))
            .run();
    }
}

/** 同時実行数の空きぶんだけキューを消化する。録画完了時と定期tickの両方から呼ばれる */
export function pump(): void {
    while (runningJobs.size < config.encodeConcurrency) {
        const next = orm()
            .select({ id: encodeJobs.id, attempts: encodeJobs.attempts })
            .from(encodeJobs)
            .where(eq(encodeJobs.state, 'queued'))
            .orderBy(encodeJobs.id)
            .limit(1)
            .get();
        if (next === undefined) return;

        // **試し過ぎたジョブは諦める。** プロセスごと落とす毒ジョブは running→queued
        // へ戻り続け、id順・同時実行1だと毎回ここで先頭に来る。上限を超えたら failed に
        // して後ろを進める。failed の確定は runJob を呼ぶ前なので、直後にまた落ちても
        // 同じジョブを掴み直すことはない
        if (next.attempts >= config.encodeMaxAttempts) {
            const recording = orm()
                .select(getTableColumns(recordings))
                .from(recordings)
                .innerJoin(encodeJobs, eq(encodeJobs.recording_id, recordings.id))
                .where(eq(encodeJobs.id, next.id))
                .get();
            const reason = `エンコードを ${next.attempts} 回試しましたが、完了しませんでした`;
            if (recording === undefined) {
                markFailed(next.id, reason);
                emit('recordings');
            } else {
                // もう走らせないので、この生TSの中間ファイルもここで片付ける
                const input = encodeSource(recording);
                if (input !== null) clearScratch(input);
                fail(next.id, recording, reason);
            }
            continue;
        }

        // 実際に走り出す前に状態を進めておく。次のループが同じジョブを拾わないため
        const claimed = orm()
            .update(encodeJobs)
            .set({ state: 'running', started_at: now(), attempts: sql`${encodeJobs.attempts} + 1` })
            .where(and(eq(encodeJobs.id, next.id), eq(encodeJobs.state, 'queued')))
            .returning({ id: encodeJobs.id })
            .get();
        if (claimed === undefined) return;

        const jobId = next.id;
        runningJobs.add(jobId);
        // 待機中が走り出したことも伝える。押した直後に何も変わらないと止まって見える
        emit('recordings');
        void runJob(jobId)
            .catch((error) => markFailed(jobId, String(error)))
            .finally(() => {
                runningJobs.delete(jobId);
                procs.delete(jobId);
                aborts.delete(jobId);
                canceled.delete(jobId);
                // 中止を押して待っている人に、畳み終わったことを伝える
                wakeStopping(jobId);
                emit('recordings');
                // 空いた枠に次のジョブを入れる
                pump();
            });
    }
}

/**
 * 落ちた時点で running だったジョブを queued に戻す。
 * ffmpeg は親と一緒に死んでいるので、出力を捨てて頭からやり直す。
 */
export function requeueOrphanedJobs(): number {
    return affected(
        orm()
            .update(encodeJobs)
            .set({ state: 'queued', phase: 'encode', percent: 0, eta_ms: null, started_at: null })
            .where(eq(encodeJobs.state, 'running')),
    );
}
