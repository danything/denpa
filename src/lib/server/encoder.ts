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
import { basename, dirname, join } from 'node:path';
import { type Audio, audioTitles, DUAL_MONO } from '$lib/arib';
import { encodeSource } from '../source';
import type { EncodeJob, EncodePhase, Recording, VideoCodec } from '../types';
import {
    type CmDetection,
    chapterMetadata,
    detectCm,
    invertRanges,
    longestRange,
    probeLeadIn,
    probeVideo,
    type Range,
    shiftRanges,
    widenKeep,
} from './cm';
import { config } from './config';
import { database, now, queryOne } from './db';
import { type EncodeProgress, emit } from './events';
import { removeIfExists } from './fsx';
import { encodedPath, libraryFamily, libraryPath } from './library';
import { removeSidecars, sidecarPaths, writeThumbnail } from './metadata';
import { saveRecordedBml } from './recorded-bml';
import { descramble, isScrambled } from './scramble';
import { settings } from './settings';
import { chunks, text } from './stream';
import { buildPgs } from './subtitle';
import { notify } from './webhook';

export function isVideoCodec(value: unknown): value is VideoCodec {
    return value === 'av1' || value === 'h264' || value === 'none';
}

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

/** 1窓の長さ(秒)。3窓測って中央値を採る */
const FPS_WINDOW = 30;
/** 測る窓の位置 (本編のどのあたりか)。端は OP/ED・提供に掛かりやすいので避ける */
const FPS_POINTS = [0.2, 0.5, 0.8];

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
    const median = sorted[Math.floor(sorted.length / 2)];
    return median > threshold;
}

/** 1窓ぶん測る。60p化 → 重複コマ落とし → 残った割合。測れなければ NaN */
async function surviveRatio(input: string, at: number, signal: AbortSignal): Promise<number> {
    const proc = Bun.spawn(
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
        { stdout: 'ignore', stderr: 'pipe' },
    );
    const kill = () => proc.kill();
    signal.addEventListener('abort', kill, { once: true });
    try {
        const stderr = await text(proc.stderr as ReadableStream<Uint8Array>);
        await proc.exited;
        const out = parseOutFrames(stderr);
        // 60p に起こしたので、1窓の期待コマ数は 60000/1001 * 秒
        return out / ((FPS_WINDOW * 60000) / 1001);
    } catch {
        return NaN;
    } finally {
        signal.removeEventListener('abort', kill);
    }
}

/**
 * 30コマか60コマかを、本編から3窓測って決める。
 *
 * 以前はジャンル (国内アニメだけ30コマ) で決めていたが、放送の TS に
 * 「本当のコマ数」は入っていない — EIT も符号化ヘッダも、素材が 24p の
 * アニメでも**全部 1080i/60 と名乗る** (本番の実測)。それでも、**60コマに
 * 起こして同じ絵が続く割合を数えれば**見分けはつく — アニメ (24p/30p 由来) は
 * 同じ絵が2〜3枚ずつ並ぶので重複を落とすとコマが大きく減り、本物の 60i
 * (実写・生放送) は全コマ動くので減らない。実測値の表と、idet (縞の検出) が
 * 使えなかった話は [docs/encode.md](../../../docs/encode.md) に。
 *
 * CM検出があれば**一番長い本編区間**の中で測る (CM は実写 60i なので混ぜると
 * 釣り上がる)。最初の区間で測っていた頃は、アニメのアバン+OPに窓が乗って
 * OPの激しい動きが 57〜74% の生存率になり、30コマの本編 (実測 20〜32%) を
 * 60コマと誤判定していた (本番の実測、2026-08)。一番長い区間は本編そのもの。
 */
async function measureSmoothMotion(
    source: string,
    durationSec: number,
    content: Range | null,
    signal: AbortSignal,
): Promise<boolean> {
    const start = content !== null && Number.isFinite(content.start) ? content.start : 0;
    const end =
        content !== null && Number.isFinite(content.end) && content.end > start
            ? content.end
            : Number.isFinite(durationSec) && durationSec > 0
              ? durationSec
              : start + FPS_WINDOW;
    const span = Math.max(0, end - start - FPS_WINDOW);

    // 尺が窓より短いと3点が同じ位置に重なる。同じ30秒を測り直さない
    const offsets = [...new Set(FPS_POINTS.map((point) => start + span * point))];
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
 * 実際にエンコードに使うコーデック。
 *
 * 録画の行に `none` (エンコードしない) が入っていることがある。あとから
 * 「再エンコード」を押したときは、そのときの設定で焼く — 押した人は
 * 焼きたいのであって、録ったときの設定を再現したいわけではない。
 * 設定まで `none` なら、そもそも焼くものが決まらないので断る (enqueue 側)
 */
function resolveCodec(codec: VideoCodec): 'av1' | 'h264' {
    if (codec === 'av1' || codec === 'h264') return codec;
    const chosen = settings().codec;
    return chosen === 'none' ? 'av1' : chosen;
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

function videoArgs(
    codec: 'av1' | 'h264',
    smooth: boolean,
    scale: string | null,
): { filter: string; encoder: string[] } {
    const steps = [deinterlace(smooth), ...(scale === null ? [] : [scale])];
    if (codec === 'h264') {
        return {
            filter: [...steps, 'format=yuv420p'].join(','),
            /*
             * **crf 24・preset medium。** AV1 の既定 (crf35) と**同じ画質の段**に
             * 揃えた値。実写100秒 (grain の多い映画・59.94p) で測った:
             *
             * | | SSIM | 大きさ |
             * | --- | --- | --- |
             * | AV1 crf35 (既定) | 0.9719 | 22.1 MB |
             * | h264 crf22 (前の既定) | 0.9760 | 77.9 MB |
             * | **h264 crf24** | **0.9729** | **51.4 MB** |
             * | h264 crf25 | 0.9715 | 41.9 MB |
             *
             * crf22 は AV1 より一段上の画質を **3.5倍の容量**で焼いていた。
             * crf24 は AV1 とちょうど同じ画質 (0.9729 ≥ 0.9719) を保ったまま、
             * そこから**容量が3割減る** (78→51MB)。crf25 まで下げると画質が
             * AV1 を下回るので、**AV1 と揃える下限が 24**。
             *
             * **preset は medium。** slow にしても同じ画質で時間だけ 25% 増える
             * (crf22 で slow 0.9757/76MB ↔ medium 0.9760/78MB)。SVT-AV1 と同じで、
             * 遅い方に振る意味がない
             */
            encoder: ['libx264', '-preset', 'medium', '-crf', '24'],
        };
    }
    /*
     * **preset と crf は書いておく。** 値はどちらも SVT-AV1 2.3.0 の既定そのもので、
     * 今までと同じものが出る。
     *
     * 書かずに既定へ任せていたが、**その既定は版で変わる。** 4.2.0 では preset が
     * 10 から 8 になっていて、上げるだけで実測 **28秒 → 37秒 (+32%)・
     * 大きさ +27%** になった (下の実測)。焼く速さと大きさは denpa が決めることで、
     * 上流の都合で黙って変わっていいものではない
     *
     * **8bit で出す。** 10bit で出していたが、根拠が残っていなかったので測った
     * (実写100秒・同じ手):
     *
     * | | 所要 | 大きさ | SSIM |
     * | --- | --- | --- | --- |
     * | 10bit | 39秒 | 21.71 MB | 0.97582 |
     * | 8bit | **34秒** | 22.09 MB | 0.97472 |
     *
     * 10bit のほうが 1.7% 小さくて SSIM +0.0011。**差はあるが 2% で、
     * 15% 遅くなるぶんと引き合わない。** それ以上に、10bit は Main10 を
     * 解ける相手が要る — 元の放送が 8bit なのだから、8bit で出す
     */
    return {
        filter: [...steps, 'format=yuv420p'].join(','),
        encoder: ['libsvtav1', '-preset', '10', '-crf', '35'],
    };
}

/*
 * 「二カ国語」の見分け方は `$lib/arib` に1つだけ置いてある。**録画もライブも同じ** —
 * ライブは選べる音声を組み立てるのに同じ判定を使う (`arib.audioTracks`)
 */
export { DUAL_MONO };

/**
 * 字幕に使うフォント。
 */
const SUBTITLE_FONTS = 'Rounded M+ 1m for ARIB';
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

export interface EncodeOptions {
    /**
     * CM実カット時に残す区間。null なら全部残す。
     * 切るのは buildSegmentArgs 側で、buildArgs はこれを見ない
     */
    keep?: Range[] | null;
    /** チャプター(CM位置)を書き込む ffmetadata ファイル */
    chaptersFile?: string | null;
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
     * 映像が出るまでの音声だけの区間(秒)。**頭から捨てる長さ** (`probeVideo`)。
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
    /** 字幕トラックの名前。放送が名乗っている言語まで入る (`buildPgs`) */
    captionTitle?: string;
}

/**
 * 録画に写してある音声の構成を読む。**壊れていても止まらない。**
 *
 * 写しているのは番組表から取ったものをそのままなので、形が違うことはありうる。
 * 読めなければ何も無いことにする — どの道 `audioTitles` が既定の名前を返す
 */
function storedAudios(recording: Recording): Audio[] {
    try {
        const parsed: unknown = JSON.parse(recording.audios ?? 'null');
        return Array.isArray(parsed) ? (parsed as Audio[]) : [];
    } catch {
        return [];
    }
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
 * ffmpeg の引数。EPGStation 時代の enc.js をそのまま移植したもので、
 * 各フラグの理由はコメントに残してある(ARIB字幕の焼き込み、インタレ解除、デュアルモノ分離)。
 *
 * CM を切る場合でもここは変わらない。**切るのはエンコードの前にTSの段階**で、
 * ここに来る入力は既に切り終えたものになっている (buildSegmentArgs)。
 */
export function buildArgs(
    input: string,
    output: string,
    audioType: number | null,
    seek: number | null,
    codec: VideoCodec = 'av1',
    options: EncodeOptions = {},
): string[] {
    const video = videoArgs(
        resolveCodec(codec),
        options.smoothMotion === true,
        squarePixels(options.displaySize),
    );

    const args = ['-y'];

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
    const skip = (seek ?? 0) + headSkip(options.videoStart);
    if (skip > 0) args.push('-ss', String(skip));
    // チャンネル切り替え直後は前番組のPAT/PMTの残骸が先頭に混ざるため、長めにprobeしてから構成を確定させる
    args.push('-analyzeduration', '15000000', '-probesize', '30000000');
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
    // 字幕。?は .sup が空だった場合でもエンコードを止めないため
    if (pgs >= 0) {
        // 名前は放送が名乗っているものを使う (「字幕 (日本語)」)。無ければ「字幕」
        const title = options.captionTitle ?? '字幕';
        args.push('-map', `${pgs}:s:0?`, '-c:s:0', 'copy', '-metadata:s:s:0', `title=${title}`);
        args.push('-disposition:s:0', 'default');
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
        // 音声ストリームを全て拾う(多言語放送等で複数トラックある場合に備える)
        args.push('-map', '0:a');
    }
    args.push('-c:a', 'libopus', '-b:a', '256k'); // 元放送(AAC 256kbps)と同じビットレート

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

    // 進捗を key=value 形式で標準出力に吐かせる。stderr の人間向けログを目視パースするより確実
    args.push('-progress', 'pipe:1');
    /*
     * 入れ物は名前ではなくここで決める。出力は書いている間だけ別名 (.mkv.encoding) にしており、
     * ffmpeg は拡張子から入れ物を決めるので、付けないと
     * 「Unable to choose an output format」で始まる前に落ちる
     */
    args.push('-f', 'matroska');
    args.push(output);

    return args;
}

/**
 * CM を切り落としたTSを作る。
 *
 * エンコードのフィルタで切っていた頃は、字幕(ARIB字幕)のタイミングを
 * 追従させられず落とすしかなかった。先にTSの段階で切ってしまえば、
 * あとは普通にエンコードするだけで字幕もそのまま残る(消せる字幕のまま)。
 *
 * 残す区間を1つずつ `-c copy` で切り出し、concat デマクサで繋ぐ。
 * 再エンコードしないので速く、字幕もデータ放送も落ちない。
 * キーフレーム単位の切り出しになるが、日本の地上波の MPEG-2 は GOP が
 * 0.5 秒程度なので CM検出の許容誤差 (config.cmTolerance) に収まる。
 */
export function buildSegmentArgs(input: string, output: string, range: Range): string[] {
    return [
        '-y',
        '-analyzeduration',
        '15000000',
        '-probesize',
        '30000000',
        // -ss を -i の前に置くと、キーフレームまで飛んでから読み始めるので速い
        '-ss',
        String(range.start),
        '-to',
        String(range.end),
        '-i',
        input,
        '-ignore_unknown',
        '-c',
        'copy',
        '-f',
        'mpegts',
        output,
    ];
}

export function buildConcatArgs(listFile: string, output: string): string[] {
    return [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-ignore_unknown',
        '-c',
        'copy',
        // 切れ目で時刻が飛ぶので振り直す。振り直さないとエンコード側が長さを誤る
        '-fflags',
        '+genpts',
        '-f',
        'mpegts',
        output,
    ];
}

/** concat デマクサに渡す一覧。パスの ' はエスケープが要る */
export function concatList(parts: string[]): string {
    return parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join('\n');
}

export function enqueue(recordingId: number): number {
    const existing = queryOne<{ id: number }>(
        `SELECT id FROM encode_jobs WHERE recording_id = ? AND state IN ('queued','running')`,
        recordingId,
    );
    if (existing !== undefined) return existing.id;

    const info = database()
        .prepare(`INSERT INTO encode_jobs (recording_id, state, created_at) VALUES (?, 'queued', ?)`)
        .run(recordingId, now());
    return Number(info.lastInsertRowid);
}

export function cancel(jobId: number): void {
    canceled.add(jobId);
    // どの段階に居ても止まるようにする。ffmpeg が回っていない段階もある
    aborts.get(jobId)?.abort();
    procs.get(jobId)?.kill();

    const stopped = database()
        .prepare(
            `UPDATE encode_jobs SET state = 'canceled', finished_at = ? WHERE id = ? AND state = 'queued'`,
        )
        .run(now(), jobId);
    // まだ始まっていなければここで終わり。走っている分は runJob が後始末して知らせる
    if (stopped.changes > 0) emit('recordings');
}

/** 段階を進めて画面にも伝える。押しても反応が無いように見えるのを防ぐ */
function setPhase(jobId: number, phase: EncodePhase, log: string): void {
    database()
        .prepare('UPDATE encode_jobs SET phase = ?, log = ?, percent = 0, eta_ms = NULL WHERE id = ?')
        .run(phase, log, jobId);
    emit('recordings');
}

/**
 * 段階の中で「いま何をしているか」だけ書き換える。
 *
 * CM検出は中で3つの道具を順に回していて、どれも数分かかる。段階の名前
 * (「CM検出中」) だけでは、進んでいるのか止まっているのかが分からなかった。
 */
function setStep(jobId: number, log: string): void {
    database().prepare('UPDATE encode_jobs SET log = ? WHERE id = ?').run(log, jobId);
    emit('recordings');
}

/**
 * 段階の中の進み具合。エンコード以外の段階でも出せるところは出す。
 *
 * 書き戻しはエンコード中と同じ間隔まで。細かく書くと WAL が膨らむだけで、
 * 画面のほうも追いつかない。
 */
function progressReporter(jobId: number): (percent: number) => void {
    const update = database().prepare('UPDATE encode_jobs SET percent = ? WHERE id = ?');
    let lastWrite = 0;
    return (percent) => {
        const at = Date.now();
        if (at - lastWrite < PROGRESS_INTERVAL) return;
        lastWrite = at;
        update.run(Math.min(1, Math.max(0, percent)), jobId);
        emit('recordings');
    };
}

interface Progress {
    percent: number;
    /** 残り時間の見込み(ms)。速さが読めないうちは null */
    etaMs: number | null;
    log: string;
}

/** 残り時間を測る窓。直近の読み速度だけ見る (速度は素材や場面で途中から変わる) */
const ETA_WINDOW_MS = 30_000;
/** これより短い窓からは速度を出さない。起動直後の数点だけで暴れた値を出さないため */
const ETA_MIN_SPAN_MS = 4_000;

/**
 * 進み具合は**入力TSの読み位置**だけから出す (読んだバイト数 / ファイルの大きさ)。
 *
 * 以前は ffmpeg の `-progress` が言う時刻 (`out_time_us`) とコマ数 (`frame=`) を
 * 突き合わせて進んでいるほうを採っていたが、時刻は分かっているだけで3通りの外し方をする。
 *
 * - **`N/A` が続く。** AV1 (libsvtav1) は先読みを溜めてから出し始めるので、
 *   その間ずっと読めない。実機の30分番組では最初の数分がまるごとこれだった
 * - **途中で止まる。** 壊れた副音声が1本混ざっているとそこで止まる。実機の
 *   TOKYO MX の録画は `Packet corrupt (stream = 3)` のあと **8.576 秒のまま**動かず、
 *   30分焼き終わっても 0% のままだった (出来上がりは 30分ぶん正しく入っていた)
 * - **先に飛んで張り付く。** 出てくるのは mux が最後に書いたパケットの時刻なので、
 *   疎な字幕 (.sup の copy) が実映像より先に mux されると先に飛ぶ。実機では
 *   入力を 65% しか読んでいないのに 99.1% に飛び、残り数分ずっと
 *   「あと1秒」のまま止まって見えた
 *
 * コマ数のほうも分母 (尺×出力fps) が見積もりで、単独では信じられなかった。
 *
 * 読み位置はコーデックにもストリーム構成にも依らない。デマルチプレクサは入力を
 * 頭から順に読むので、読んだ割合がそのまま消化した割合になる。放送TSは
 * ビットレートがほぼ一定なので、時間で見た割合ともよく一致する。
 * 残り時間も**同じ出どころ** (直近の読み速度) から出す — 出どころを混ぜると、
 * 止まった時刻を動いている speed で割って「残り20時間」のような値が出る。
 */
export function inputProgress(inputBytes: number) {
    const samples: { at: number; pos: number }[] = [];
    // NaN 汚染を防ぐガードが要る (JSON上 typeof NaN === 'number' で素通りするため)
    const measurable = (value: number) => Number.isFinite(value) && value > 0;

    return (at: number, pos: number, block: Record<string, string>, prev: number): Progress => {
        // 読み位置が取れない間 (/proc が無い・一瞬の読み損ね) は前の値を保ち、当てずっぽうを出さない
        const readable = measurable(inputBytes) && Number.isFinite(pos) && pos >= 0;
        const fraction = readable ? Math.min(1, pos / inputBytes) : prev;
        /*
         * 前の値より下げない (読み損ねからの復帰で巻き戻って見えないように)。
         * **100% は ffmpeg が終わるまで出さない** — 入力を読み切っても、溜めた
         * コマの吐き出しと mux の締めが残っている。読み切った時点で 100.0% と
         * 出すと、そこで止まって見える (失敗して頭からやり直す時は特に、
         * 100% → 0% と動いて二度おかしく見えた)
         */
        const percent = block.progress === 'end' ? 1 : Math.min(Math.max(prev, fraction), 0.99);

        let etaMs: number | null = null;
        if (readable) {
            samples.push({ at, pos });
            while (samples.length > 0 && at - samples[0]!.at > ETA_WINDOW_MS) samples.shift();
            const oldest = samples[0]!;
            const spanMs = at - oldest.at;
            const gained = pos - oldest.pos;
            // 速さが読めないうち (窓がまだ短い・読みが進んでいない) は null のまま
            if (spanMs >= ETA_MIN_SPAN_MS && gained > 0) {
                etaMs = Math.round(((inputBytes - pos) / gained) * spanMs);
            }
        }

        const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
        const sizeMb = (parseInt(block.total_size, 10) / 1024 / 1024).toFixed(1);
        const rateMbps = (parseFloat(block.bitrate) / 1000).toFixed(2);
        return {
            percent,
            etaMs,
            log: `input: ${readable ? `${mb(pos)}/${mb(inputBytes)}MB` : '測れず'}, speed: ${block.speed}, size: ${sizeMb}MB, rate: ${rateMbps}Mbps, drop: ${block.drop_frames}`,
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
    codec: VideoCodec,
    options: EncodeOptions = {},
) {
    const proc = Bun.spawn([config.ffmpeg, ...buildArgs(input, output, audioType, seek, codec, options)], {
        stdout: 'pipe',
        stderr: 'pipe',
    });
    procs.set(job.id, proc);

    /*
     * 進み具合は入力の読み位置から出す (inputProgress)。`-progress` のブロックは
     * 刻み (約0.5秒ごとに来る) と speed などの読み物としてだけ使う。
     * /proc の fd は実体のパスで見えるので、シンボリックリンクはここで解いておく
     */
    let inputPath = input;
    let inputBytes = NaN;
    try {
        inputPath = realpathSync(input);
        inputBytes = statSync(inputPath).size;
    } catch {
        // 測れなければ割合が動かないだけ。焼くほうはそのまま進める
    }
    const progress = inputProgress(inputBytes);
    let inputFd: number | null = null;
    let inputPos = NaN;

    // 出力し終えた時点の位置。CMを切ると入力より短くなるので、出来上がりの長さはこちら
    let outTimeUs = NaN;
    let percent = 0;
    let etaMs: number | null = null;
    let log = '';
    let lastWrite = 0;
    let stderrTail = '';

    const updateProgress = database().prepare(
        'UPDATE encode_jobs SET percent = ?, eta_ms = ?, log = ? WHERE id = ?',
    );

    const readStderr = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of chunks(proc.stderr as ReadableStream<Uint8Array>)) {
            stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-4000);
        }
    })();

    const readStdout = (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        let block: Record<string, string> = {};
        for await (const chunk of chunks(proc.stdout as ReadableStream<Uint8Array>)) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const eq = line.indexOf('=');
                if (eq === -1) continue;
                block[line.slice(0, eq)] = line.slice(eq + 1).trim();
                if (block.progress === undefined) continue;

                const at = Number(block.out_time_us);
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
                block = {};

                const wroteAt = Date.now();
                if (wroteAt - lastWrite >= PROGRESS_INTERVAL) {
                    lastWrite = wroteAt;
                    updateProgress.run(percent, etaMs, log, job.id);
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
            }
        }
    })();

    const [code] = await Promise.all([proc.exited, readStdout, readStderr]);
    procs.delete(job.id);
    updateProgress.run(code === 0 ? 1 : percent, null, log, job.id);
    return { code, stderrTail: failureReason(stderrTail), outTimeUs };
}

/** prepareCm が持ち帰るCMまわりの一式 (EncodeOptions に足して runJob が使う) */
interface CmPrep {
    chaptersFile: string | null;
    contentStart: Range | null;
    /**
     * コマ数の実測に使う区間 = **一番長い本編区間**。サムネ (contentStart) とは
     * わざと別 — サムネは頭に近いほうが番組の顔になるが、コマ数は最初の区間だと
     * アバン+OPに当たり、OPの動きで60コマに誤判定する (measureSmoothMotion)
     */
    fpsBlock: Range | null;
    /**
     * チャプター時刻の元 (検出そのままの区間)。頭をどれだけ捨てるかは焼く直前まで
     * 決まらないので、`rebaseChapters` がここから引き直して chaptersFile を書き直す
     */
    chapterSource: { cm: Range[]; duration: number } | null;
}

/**
 * エンコード前のCM検出。cm_cut の設定に応じて、実カット用の残す区間か
 * チャプター用の ffmetadata を用意する。検出できなかった場合は素通し。
 */
async function prepareCm(
    jobId: number,
    recording: Recording,
    input: string,
    signal: AbortSignal,
): Promise<EncodeOptions & CmPrep> {
    const none = {
        keep: null,
        chaptersFile: null,
        contentStart: null,
        fpsBlock: null,
        chapterSource: null,
    };
    /*
     * **CMの扱いは焼くときの設定に従う。** 録画の行にも写してあるが、それは
     * 録り始めた時点の値で、設定を変えても直らない (`keepOriginal` は前から
     * 設定を見ている。ここだけ食い違っていた)
     */
    if (settings().cmCut === 'off') return none;

    setPhase(jobId, 'cm', 'CMを探しています');

    let detection: CmDetection;
    try {
        /*
         * ロゴの位置を手で入れてもらっていれば渡す。自動で見つからない局
         * (薄い・動くロゴ) はこれが無いとロゴ無しの判定に落ちる
         */
        const service = queryOne<{ logo_area: string | null }>(
            'SELECT logo_area FROM services WHERE id = ?',
            recording.service_id,
        );
        detection = await detectCm(input, {
            signal,
            channel: recording.service_name,
            serviceId: recording.service_id,
            area: service?.logo_area ?? '',
            onProgress: progressReporter(jobId),
            onStep: (label) => setStep(jobId, label),
        });
    } catch (error) {
        console.error(`[cm] 検出に失敗したためCM処理をスキップします: ${error}`);
        return none;
    }

    /*
     * ロゴを使えたかどうかは覚え書きに書いてある (cm.detectCm)。別の列では持たない。
     * 持っていた頃は、後から「位置を教える口を出す条件」を広げても、既に録ってある
     * 分には効かなかった
     */
    database()
        .prepare('UPDATE recordings SET cm_ranges = ?, cm_note = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(detection.cm), detection.note, now(), recording.id);
    database()
        .prepare('UPDATE encode_jobs SET log = ? WHERE id = ?')
        .run(`CM ${detection.cm.length} 箇所 (${detection.note})`, jobId);
    if (detection.cm.length === 0) return none;

    if (settings().cmCut === 'cut') {
        /*
         * **頭を少し戻してから切る。** 切り出しはキーフレーム単位なので、
         * 判定どおりの位置から始めると本編の頭が1 GOP ぶん削れる (widenKeep)。
         * チャプターにするほうは戻さない — あちらは切らないので、位置は
         * 判定どおりのほうが正しい
         */
        return {
            keep: widenKeep(invertRanges(detection.cm, detection.duration), config.cmCutMargin),
            chaptersFile: null,
            // 切ってしまうので出来上がりは既にCMが無い。サムネは頭からの固定でよい
            contentStart: null,
            fpsBlock: null,
            chapterSource: null,
        };
    }

    /*
     * ファイルの中身はこの時点では仮 (検出そのままの時刻)。頭をどれだけ捨てるか
     * (`headSkip`) はまだ分からないので、焼く直前に `rebaseChapters` が
     * 捨てるぶんを引いて書き直す。元の区間はそのために持ち帰る
     */
    const chaptersFile = `${input}.chapters.txt`;
    writeFileSync(chaptersFile, chapterMetadata(detection.cm, detection.duration));
    // 切らないぶん出来上がりにCMが残る。サムネを本編の最初の区間から取るために渡す
    const content = invertRanges(detection.cm, detection.duration);
    return {
        keep: null,
        chaptersFile,
        contentStart: content[0] ?? null,
        fpsBlock: longestRange(content),
        chapterSource: { cm: detection.cm, duration: detection.duration },
    };
}

/** ffmpeg を1回動かす。戻り値は終了コード */
async function runOnce(args: string[], signal: AbortSignal): Promise<number> {
    const proc = Bun.spawn([config.ffmpeg, ...args], { stdout: 'ignore', stderr: 'pipe' });
    const kill = () => proc.kill();
    signal.addEventListener('abort', kill, { once: true });
    try {
        return await proc.exited;
    } finally {
        signal.removeEventListener('abort', kill);
    }
}

/**
 * CM を切り落としたTSを作って、そのパスを返す。作れなければ null。
 * 元のTSはそのまま残す(切り方を間違えても録画は失われない)。
 */
async function trimCm(
    jobId: number,
    input: string,
    keep: Range[],
    signal: AbortSignal,
): Promise<string | null> {
    setPhase(jobId, 'cut', 'CMを切っています');
    // 切るのは区間ごとなので、消化した本数がそのまま進み具合になる
    const report = progressReporter(jobId);

    const parts: string[] = [];
    try {
        for (const [i, range] of keep.entries()) {
            if (signal.aborted) throw new Error('中止されました');
            report(i / (keep.length + 1));
            const part = `${input}.part${i}.ts`;
            const code = await runOnce(buildSegmentArgs(input, part, range), signal);
            if (code !== 0 || !existsSync(part)) throw new Error(`区間 ${i} の切り出しに失敗しました`);
            parts.push(part);
        }

        const listFile = `${input}.concat.txt`;
        const trimmed = `${input}.cut.ts`;
        writeFileSync(listFile, concatList(parts));
        const code = await runOnce(buildConcatArgs(listFile, trimmed), signal);
        rmSync(listFile, { force: true });
        if (code !== 0 || !existsSync(trimmed)) throw new Error('繋ぎ直しに失敗しました');
        return trimmed;
    } catch (error) {
        // 切れなかったらCMを残したままエンコードする。録れているものを捨てない
        console.error(`[cm] ${error}。CMを残したままエンコードします`);
        return null;
    } finally {
        for (const part of parts) rmSync(part, { force: true });
    }
}

/**
 * ジョブの生TSから派生する中間ファイルを消す。
 *
 * `descramble` の `.decoded.ts` や CM切りの `.cut.ts` / `.partN.ts` は、
 * 正常終了や失敗なら finally / cleanup で消えるが、**プロセスごと落ちたときは
 * 取り残される**。しかもどれも `.ts` で終わるので、掃除機は動画と見なして消さない
 * (`files.ts` の VIDEO)。生TSと同じ大きさの `.decoded.ts` が丸ごと居座る。
 *
 * これらは走らせ直せば作り直すものなので、ジョブを(再)実行する直前と、
 * 諦めて failed にするときに、その生TSから派生するぶんをまとめて消しておく。
 * 自分の入力に紐づくものだけ触るので、他の走っているエンコードには当たらない。
 */
function clearScratch(input: string): void {
    removeIfExists(`${input}.decoded.ts`);
    removeIfExists(`${input}.cut.ts`);
    removeIfExists(`${input}.concat.txt`);
    // CMの区間ファイルは本数ぶんある (`.part0.ts`, `.part1.ts`, …)
    const prefix = `${basename(input)}.part`;
    try {
        for (const name of readdirSync(dirname(input))) {
            if (name.startsWith(prefix) && /\.part\d+\.ts$/i.test(name)) {
                removeIfExists(join(dirname(input), name));
            }
        }
    } catch {
        // 置き場ごと無ければ、片付けるものも無い
    }
}

/**
 * 生TSを残すか。
 *
 * 録画ごとの指定ではなく全体設定に従う。録り直すたびに「あのときどうしたか」を
 * 思い出す必要が無いようにするため。
 */
function keepOriginal(): boolean {
    return settings().keepOriginal;
}

/**
 * エンコードの失敗を記録して知らせる。
 *
 * **録画の行には何も書かない。** 落ちたのは焼き直しのほうで、元の録画は無事なので、
 * 録画そのものを「失敗」にすると観られるはずのものが観られなくなる (実際にそうなっていた)。
 * 理由はジョブが持ち、一覧は最新のジョブを見て出す
 */
function fail(jobId: number, recording: Recording, reason: string): void {
    database()
        .prepare(`UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`)
        .run(reason, now(), jobId);
    emit('recordings');
    notify({
        event: 'encode.failed',
        text: `エンコードに失敗しました: ${recording.name} (${recording.service_name})`,
        recording: {
            id: recording.id,
            name: recording.name,
            service: recording.service_name,
            startAt: recording.start_at,
            endAt: recording.end_at,
        },
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
    database()
        .prepare(`UPDATE encode_jobs SET state = 'canceled', finished_at = ? WHERE id = ?`)
        .run(now(), jobId);
    // 録画の行は触らない。ジョブが消えれば「録画済み」に戻って見える
    emit('recordings');
}

async function runJob(jobId: number): Promise<void> {
    const controller = new AbortController();
    aborts.set(jobId, controller);
    const signal = controller.signal;

    const job = queryOne<EncodeJob>('SELECT * FROM encode_jobs WHERE id = ?', jobId)!;
    const recording = queryOne<Recording>('SELECT * FROM recordings WHERE id = ?', job.recording_id);
    const input = recording === undefined ? null : encodeSource(recording);

    if (recording === undefined || input === null) {
        database()
            .prepare(`UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`)
            .run('元にできる生TSがありません', now(), jobId);
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

    /*
     * 焼くときは別名 (`.<jobId>.<codec>.encoding`) に書いてから置き換える
     * (下の焼くループ)。同じ番組を録り直すと入力と出力が同じ場所になることが
     * あり、そのまま書くと元を壊す。失敗したときに元が消えないのも同じ理由。
     * **ジョブとコーデックで別の名前にする** — 番組名だけで決めていた頃は、
     * 同じ番組の2本が1つの作業ファイルに同時に書き込んで壊していた (実機)。
     */

    // スクランブルが掛かったまま録れていたら、ここで解く (scramble.ts)
    /** 後始末で消す作業ファイル。生TSを置き換えたときは残す側になるので null のまま */
    let decoded: string | null = null;
    let sourceTs = input;
    if (isScrambled(input)) {
        setPhase(jobId, 'descramble', 'スクランブルを解いています');
        const target = `${input}.decoded.ts`;
        const result = await descramble(input, target, signal);
        if (!result.ok) {
            removeIfExists(target);
            // 中止で切ったときは失敗にしない。下の後始末で canceled として畳む
            if (canceled.has(jobId)) return finishCanceled(jobId, target);
            fail(jobId, recording, `スクランブルを解除できませんでした: ${result.error}`);
            return;
        }
        if (keepOriginal()) {
            // 生TSを残す設定なら、残すのは解けたほうだけにする。
            // 掛かったままのTSを取っておいても、あとから解ける保証は無い
            renameSync(target, input);
        } else {
            decoded = target;
            sourceTs = target;
        }
    }

    const encodeOptions: EncodeOptions & CmPrep = {
        ...(await prepareCm(jobId, recording, sourceTs, signal)),
        // コマ数の既定は 60。設定が入っていれば、source が決まったあとで
        // 本編映像から実測して決め直す (measureSmoothMotion)
        smoothMotion: true,
        /*
         * **音声トラックに番組表と同じ名前を入れる。**
         *
         * 番組表の行は24時間で消えるので、写しておいたものから引く
         * (`recordings.audios`。ジャンルと同じ扱い)。古い録画には写しが無いので、
         * そのときは `audioTitles` の既定 (「音声」/「主音声」「副音声」) に落ちる
         */
        audioTitles: audioTitles(storedAudios(recording), recording.audio_type === DUAL_MONO),
    };
    if (canceled.has(jobId)) return finishCanceled(jobId, decoded);

    // CMを実際に切る場合は、エンコードの前にTSの段階で切っておく。
    // エンコードのフィルタで切ると字幕のタイミングを追従させられず落とすことになる
    let source = sourceTs;
    let trimmed: string | null = null;
    const keep = encodeOptions.keep ?? null;
    if (keep !== null && keep.length > 0) {
        trimmed = await trimCm(jobId, sourceTs, keep, signal);
        if (trimmed !== null) source = trimmed;
        // 切れなかったら CM 入りのまま進む。コマ数の実測とサムネイルが CM を
        // 掴まないように、本編の区間 (keep) を教えておく
        else {
            encodeOptions.contentStart = keep[0] ?? null;
            encodeOptions.fpsBlock = longestRange(keep);
        }
    }
    if (canceled.has(jobId)) {
        removeIfExists(trimmed);
        removeIfExists(encodeOptions.chaptersFile);
        removeIfExists(encodeOptions.pgsFile ?? null);
        return finishCanceled(jobId, decoded);
    }

    /*
     * コマ数を本編映像から実測する (measureSmoothMotion)。切るなら切った後で
     * 測る — CM は実写 60i なので、混ぜると生存率が釣り上がる。
     * 設定で切ってあれば測らず、全部 60コマで出す
     */
    if (settings().fpsDetect) {
        setStep(jobId, 'コマ数を確かめています');
        // CM を切れたなら source は短くなっている。残した区間の合計が実際の尺。
        // 切り出しに失敗したときは元のままなので、録画の予定尺で見る
        const keepTotal =
            trimmed === null ? 0 : (keep ?? []).reduce((sum, range) => sum + (range.end - range.start), 0);
        const predicted = keepTotal > 0 ? keepTotal : (recording.end_at - recording.start_at) / 1000;
        encodeOptions.smoothMotion = await measureSmoothMotion(
            source,
            predicted,
            encodeOptions.fpsBlock,
            signal,
        );
    }

    setPhase(jobId, 'encode', '');

    // 画面の大きさ・画素の縦横比・頭の音声だけの区間を焼く前に測っておく。
    // 進み具合はここの値を使わない (入力の読み位置から出す。inputProgress 参照)
    const measured = await probeVideo(source);
    // 字幕を絵で焼くときの画面の大きさ。渡さないと 1440x1080 とみなされ、
    // 1920x1080 の録画では字幕だけ横に伸びる
    if (Number.isFinite(measured.width) && Number.isFinite(measured.height)) {
        encodeOptions.canvasSize = `${measured.width}x${measured.height}`;
    }
    // 映像が出るまでの音声だけの区間。頭から捨てて 0 秒から始める
    encodeOptions.videoStart = await probeLeadIn(source, measured.formatStart, measured.packetStart);

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

    /*
     * 放送どおりに描いた字幕を PGS にしておく。
     *
     * ffmpeg には PGS の符号器が無いので denpa が書く。焼くほうを dvdsub だけに
     * していた頃は1枚4色までで、実測230色の字幕から縁のなめらかさと色分けが落ちていた。
     * 作れなければ黙って諦める (字幕トラックが1本減るだけ)
     */
    setPhase(jobId, 'encode', '字幕を絵にしています');
    /*
     * 字幕の 0 秒を**焼き上がりの 0 秒に合わせる。** 焼くほうは入れ物の始まりから
     * 数え直したうえで、映像が出るまで (`headSkip`) を捨てる。同じところを引く
     */
    const startAt = measured.formatStart + headSkip(encodeOptions.videoStart);
    const pgs = await buildPgs(source, encodeOptions.canvasSize, SUBTITLE_FONTS, startAt, signal);
    if (pgs !== null) {
        encodeOptions.pgsFile = pgs.path;
        // 名前も放送が名乗っているものにする (「字幕 (日本語)」)
        encodeOptions.captionTitle = pgs.label;
    }

    if (pgs !== null) {
        database()
            .prepare('UPDATE encode_jobs SET log = ? WHERE id = ?')
            .run(`字幕 ${pgs.captions} 枚を PGS にしました`, jobId);
    }

    if (canceled.has(jobId)) {
        removeIfExists(pgs?.path ?? null);
        removeIfExists(trimmed);
        removeIfExists(encodeOptions.chaptersFile);
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
        const claimed = queryOne<{ id: number }>(
            'SELECT id FROM recordings WHERE (library_path = ? OR alt_path = ?) AND id != ?',
            candidate,
            candidate,
            recording.id,
        );
        if (claimed === undefined) stalePaths.add(candidate);
    }
    if (stalePaths.size > 0) {
        for (const stalePath of stalePaths) {
            removeIfExists(stalePath);
            removeSidecars(stalePath);
        }
        database()
            .prepare(
                'UPDATE recordings SET library_path = NULL, alt_path = NULL, updated_at = ? WHERE id = ?',
            )
            .run(now(), recording.id);
        emit('recordings');
    }

    /*
     * **選ばれたコーデックごとに焼く。** 両方選べば AV1 と H.264 の2本を作る
     * (`settings().codecs`)。CM検出も字幕の絵起こしも上でひとまとめに済ませて
     * あるので、ここは焼いて置くだけ — 二度手間にはならない。
     *
     * どれか1つでも失敗すれば、そのジョブごと失敗にする (途中まで置いたものは消す)。
     */
    const codecs = settings().codecs.length > 0 ? settings().codecs : (['av1'] as const);
    const placed: { codec: 'av1' | 'h264'; path: string }[] = [];
    // 測れなかったときの尺の当て。ffmpeg が言ってきた値 (下の duration_ms)
    let lastOutTimeUs = 0;

    /**
     * チャプターを、頭を捨てるぶん (`-ss` と同じ量) だけ前へ詰めて書き直す。
     * 検出そのままの時刻で焼くと全チャプターが捨てたぶん遅れて入り、CMの
     * 自動スキップが毎回そのぶんCMを見せてから跳んでいた (字幕は引いてある)。
     * 捨てる量は attempt で変わる (`encodeRetrySeek`) ので、焼く直前に毎回引き直す
     */
    const rebaseChapters = (seek: number | null): void => {
        const src = encodeOptions.chapterSource;
        if (src === null || encodeOptions.chaptersFile === null) return;
        const skip = (seek ?? 0) + headSkip(encodeOptions.videoStart);
        writeFileSync(
            encodeOptions.chaptersFile,
            chapterMetadata(shiftRanges(src.cm, skip), src.duration - skip),
        );
    };

    /** 途中でやめる/失敗するときに、置きかけを全部片付ける */
    const cleanup = (working: string | null): void => {
        removeIfExists(working);
        for (const p of placed) removeIfExists(p.path);
        removeIfExists(encodeOptions.chaptersFile);
        removeIfExists(trimmed);
        removeIfExists(decoded);
    };

    for (const codec of codecs) {
        const working = `${encodedPath(recording, codec)}.${jobId}.${codec}.encoding`;

        rebaseChapters(null);
        let result = await runFfmpeg(job, source, working, recording.audio_type, null, codec, encodeOptions);
        if (result.code !== 0 && !canceled.has(jobId)) {
            // 録画開始直後の頭数百msだけ壊れているケースをここで拾う(詳細は buildArgs のコメント参照)。
            // 別の理由での失敗もここに来るが、-ss を付けても同じ理由でもう一度失敗するだけなので無害
            database().prepare('UPDATE encode_jobs SET attempts = attempts + 1 WHERE id = ?').run(jobId);
            rebaseChapters(config.encodeRetrySeek);
            result = await runFfmpeg(
                job,
                source,
                working,
                recording.audio_type,
                config.encodeRetrySeek,
                codec,
                encodeOptions,
            );
        }

        // 出来かけを捨てるだけ。元のファイルには触らない
        if (canceled.has(jobId)) {
            cleanup(working);
            return finishCanceled(jobId, null);
        }
        if (result.code !== 0) {
            cleanup(working);
            fail(jobId, recording, result.stderrTail);
            return;
        }

        /*
         * **ここで初めて置き場所を決める。**
         *
         * 同じ番組の別の録画が先に置き終えていれば、`encodedPath` がそれを見て
         * `[録画ID]` を足した名前を返す。決めてから `renameSync` までの間に
         * `await` を挟まないので、2本が同じ名前を掴むことはない (同じプロセスの中)
         */
        lastOutTimeUs = result.outTimeUs;
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
    const alt = placed.find((p) => p.path !== primary.path)?.path ?? null;
    const output = primary.path;

    /*
     * **decoded を消す前に、生TSからデータ放送を取り出してサイドカーに置く。**
     * 録画でも d ボタンで出せるように、再生位置つきの変化ログを残す
     * (server/recorded-bml.ts)。転んでもエンコードは落とさない — 付け足しなので
     */
    try {
        const changes = saveRecordedBml(
            sourceTs,
            sidecarPaths(output).dataBroadcast,
            recording.start_at,
            encodeOptions.keep ?? null,
        );
        if (changes > 0) {
            console.log(`[bml] 録画のデータ放送を保存しました: ${changes} 変化 (録画 ${recording.id})`);
        }
    } catch (error) {
        console.error(`[bml] データ放送の取り出しに失敗しました (録画 ${recording.id}): ${error}`);
    }

    removeIfExists(encodeOptions.chaptersFile);
    // CMを切ったTSも解除したTSも作業用。元のTSは残したままなので、やり直せる
    removeIfExists(trimmed);
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
     * (`inputProgress` のコメント参照)。測れなかったときだけ、これまでどおり ffmpeg の値に落ちる
     */
    const made = (await probeVideo(output)).duration;
    const length = Number.isFinite(made) ? made * 1000 : lastOutTimeUs / 1000;
    if (Number.isFinite(length) && length > 0) {
        database()
            .prepare('UPDATE recordings SET duration_ms = ? WHERE id = ?')
            .run(Math.round(length), recording.id);
    }

    // サムネイルを動画の隣に書く。動画を置いた直後に作る。
    // CMを切っていない録画は、本編の最初の区間からサムネを取る (CMの絵を避ける)
    await writeThumbnail(
        output,
        (recording.end_at - recording.start_at) / 1000,
        encodeOptions.contentStart ?? undefined,
    );
    /*
     * **もう一方 (H.264) の隣にもポスターを複製しておく** (同じ絵。ffmpeg を
     * もう一度は回さない)。主 (AV1) を消すと残ったほうが主に繰り上がるので、
     * そのときも画面のサムネが途切れない
     */
    if (alt !== null) {
        const primaryPoster = sidecarPaths(output).thumbnail;
        if (existsSync(primaryPoster)) copyFileSync(primaryPoster, sidecarPaths(alt).thumbnail);
    }

    database()
        .prepare(`UPDATE encode_jobs SET state = 'done', percent = 1, finished_at = ? WHERE id = ?`)
        .run(now(), jobId);
    emit('recordings');
    notify({
        event: 'encode.finished',
        text: `エンコードが終わりました: ${recording.name} (${recording.service_name})`,
        recording: {
            id: recording.id,
            name: recording.name,
            service: recording.service_name,
            startAt: recording.start_at,
            endAt: recording.end_at,
        },
    });

    // 保存先が入った時点で「視聴可能」になる (recordings.state は生成列)。
    // 主は AV1 (`output`)、もう一方は `alt` (両方焼いたときだけ)。
    // コマ数 (実測か既定の60) も一緒に書く — 番組詳細の札はここからしか出せない
    const fps = encodeOptions.smoothMotion === true ? 60 : 30;
    if (keepOriginal()) {
        database()
            .prepare(
                `UPDATE recordings SET library_path = ?, alt_path = ?, ts_size = ?, fps = ?, updated_at = ? WHERE id = ?`,
            )
            .run(output, alt, size, fps, now(), recording.id);
    } else {
        removeIfExists(recording.ts_path);
        database()
            .prepare(
                `UPDATE recordings SET library_path = ?, alt_path = ?, ts_path = NULL, ts_size = ?, fps = ?, updated_at = ? WHERE id = ?`,
            )
            .run(output, alt, size, fps, now(), recording.id);
    }
}

/** 同時実行数の空きぶんだけキューを消化する。録画完了時と定期tickの両方から呼ばれる */
export function pump(): void {
    while (runningJobs.size < config.encodeConcurrency) {
        const next = queryOne<{ id: number; attempts: number }>(
            `SELECT id, attempts FROM encode_jobs WHERE state = 'queued' ORDER BY id LIMIT 1`,
        );
        if (next === undefined) return;

        // **試し過ぎたジョブは諦める。** プロセスごと落とす毒ジョブは running→queued
        // へ戻り続け、id順・同時実行1だと毎回ここで先頭に来る。上限を超えたら failed に
        // して後ろを進める。failed の確定は runJob を呼ぶ前なので、直後にまた落ちても
        // 同じジョブを掴み直すことはない
        if (next.attempts >= config.encodeMaxAttempts) {
            const recording = queryOne<Recording>(
                'SELECT r.* FROM recordings r JOIN encode_jobs j ON j.recording_id = r.id WHERE j.id = ?',
                next.id,
            );
            const reason = `エンコードを ${next.attempts} 回試して完了しませんでした`;
            if (recording === undefined) {
                database()
                    .prepare(
                        `UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`,
                    )
                    .run(reason, now(), next.id);
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
        const claimed = database()
            .prepare(
                `UPDATE encode_jobs SET state = 'running', started_at = ?, attempts = attempts + 1
                 WHERE id = ? AND state = 'queued'`,
            )
            .run(now(), next.id);
        if (claimed.changes === 0) return;

        const jobId = next.id;
        runningJobs.add(jobId);
        // 待機中が走り出したことも伝える。押した直後に何も変わらないと止まって見える
        emit('recordings');
        void runJob(jobId)
            .catch((error) => {
                database()
                    .prepare(
                        `UPDATE encode_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`,
                    )
                    .run(String(error), now(), jobId);
            })
            .finally(() => {
                runningJobs.delete(jobId);
                procs.delete(jobId);
                aborts.delete(jobId);
                canceled.delete(jobId);
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
    return database()
        .prepare(
            `UPDATE encode_jobs SET state = 'queued', phase = 'encode', percent = 0, eta_ms = NULL,
                    started_at = NULL WHERE state = 'running'`,
        )
        .run().changes;
}
