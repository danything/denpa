import { LOGO_OK, LOGO_UNUSABLE } from '../format';
import { decideCm, type Range } from '../ts/cm-decide';
import type { CmMode } from '../types';
import { type Scan, scan } from './cm-scan';
import { config } from './config';
import { logoRepo, share } from './logo-data';
import { openLogo } from './logo-own';
import { settings } from './settings';
import { run } from './stream';
import { TS_PROBE } from './ts-probe';

/**
 * CM検出。
 *
 * **1本の ffmpeg で1回だけ復号して材料を取り** (`cm-scan.ts`。無音・場面の切れ目・局ロゴの枠)、
 * 境目は TS で決める (`ts/cm-decide.ts`)。
 *
 * - 既定 (`logo`) は**ロゴの消えている所を CM にする**。境目は近くの「無音 + 切れ目」に寄せる
 * - ロゴが使えない (覚えられない・当たらない・結果がおかしい) ときは、同じ材料から
 *   **CM の尺 (15秒の倍数) だけで**決め直す。もう一度復号はしない
 * - 設定で「無音だけ」(`silence`) にすると、絵を復号せず音だけ読む。速いが本編の「間」を拾うことがある
 *
 * 誤爆したときの被害が大きい(本編が消える)ので、既定は実カットではなく
 * チャプター付与にしてある (`config.cmCutDefault`)。設定の CMの扱いを `cut` にしたときだけ実際に切る。
 */

export type { Range };

/**
 * これ以上がCM判定になったら、その結果は信じない。
 *
 * **ロゴでも尺だけでも同じ値を使う。** どちらも「番組が丸ごとCM」は
 * 検出が効いていない兆候で、本編を削るよりCMが残るほうが被害が小さい。
 */
export const MAX_CM_RATIO = 0.5;

export function isCmMode(value: unknown): value is CmMode {
    return value === 'off' || value === 'chapter' || value === 'cut';
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
 * ロゴを覚えたてのときなど、「頭の2秒だけ本編」のような結果になることがある。
 * 実機では30分アニメ2本が丸ごとCM扱いになっていた (join_logo_scp の頃。CM 2秒〜1802秒)
 */
export function tooMuchCm(cm: Range[], duration: number): boolean {
    return cmRatio(cm, duration) > MAX_CM_RATIO * 100;
}

/**
 * 区間の裏返し。CMを渡して残す区間をもらう (チャプター・実カット)。
 *
 * **渡された区間は並べ替えてから使う。** 同じものを2箇所に置いていた頃は、片方だけが
 * 並べ替えていて、**同じ入力から違う答えが出る**状態になっていた。
 *
 * 0.5秒より短い隙間は作らない (切っても意味が無く、チャプターだけが増える)。
 */
export function invertRanges(ranges: Range[], duration: number): Range[] {
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const out: Range[] = [];
    let cursor = 0;
    for (const block of sorted) {
        if (block.start - cursor > 0.5) out.push({ start: cursor, end: block.start });
        cursor = Math.max(cursor, block.end);
    }
    if (duration - cursor > 0.5) out.push({ start: cursor, end: duration });
    return out;
}

/**
 * 残す区間の**頭を少し前へ戻す**。
 *
 * 切り出しは `-ss` で頭出ししてから `-c copy` するので、**キーフレーム単位**に
 * なる。ffmpeg は指定した時刻の次のキーフレームから書き出すため、本編の頭が
 * 1 GOP ぶん (地上波の MPEG-2 で 0.5 秒ほど) 削れることがある。実機でも
 * 「本編の頭が一瞬欠ける」形で出ていた。
 *
 * 戻したぶんだけ CM の尻が残るが、**本編を削るよりそちらのほうが被害が小さい**
 * (この判断は `MAX_CM_RATIO` と同じ)。
 *
 * 戻した結果 前の区間とくっついたら1つにまとめる (切り出しが1回減る)。
 */
export function widenKeep(keep: Range[], margin: number): Range[] {
    const out: Range[] = [];
    for (const range of [...keep].sort((a, b) => a.start - b.start)) {
        const previous = out.at(-1);
        const start = Math.max(0, range.start - margin, previous?.end ?? 0);
        if (previous !== undefined && start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
            continue;
        }
        out.push({ start, end: range.end });
    }
    return out;
}

/**
 * 区間の時刻を、捨てた頭のぶんだけ前へ詰める。
 *
 * エンコードは頭 (映像が出るまでの音声だけの区間、実機で 0.5〜0.9 秒) を
 * `-ss` で捨てて 0 秒から始める (`encoder.headSkip`)。検出した時刻をそのまま
 * チャプターに書くと**全チャプターがそのぶん遅れて入り**、CMの自動スキップは
 * 毎回そのぶんCMを見せてから跳んで、着地も本編に食い込んでいた
 * (字幕は同じ引き算をしている。`subtitle.rebase`)。
 *
 * 詰めた結果ほとんど残らない区間は落とす (invertRanges の 0.5 秒と同じ判断)。
 */
export function shiftRanges(ranges: Range[], by: number): Range[] {
    if (by <= 0) return ranges;
    return ranges
        .map((r) => ({ start: Math.max(0, r.start - by), end: r.end - by }))
        .filter((r) => r.end - r.start > 0.5);
}

/**
 * 一番長い区間を返す。コマ数の実測 (encoder.measureSmoothMotion) が測る場所を
 * 選ぶのに使う — 最初の本編区間はアバン+OPに当たりやすく、OPの激しい動きが
 * 60コマ判定に化ける (本番の実測)。一番長い区間なら本編そのもの。
 */
export function longestRange(ranges: Range[]): Range | null {
    let longest: Range | null = null;
    for (const r of ranges) {
        if (longest === null || r.end - r.start > longest.end - longest.start) longest = r;
    }
    return longest;
}

/**
 * ffmetadata 形式のチャプター定義。本編とCMを交互のチャプターにして、
 * プレイヤーのチャプター送りでCMを飛ばせるようにする(ファイルは切らない)。
 */
export function chapterMetadata(cm: Range[], duration: number): string {
    const keep = invertRanges(cm, duration);
    const chapters = [
        ...keep.map((r) => ({ ...r, title: '本編' })),
        ...cm.map((r) => ({ ...r, title: 'CM' })),
    ].sort((a, b) => a.start - b.start);

    const lines = [';FFMETADATA1'];
    for (const chapter of chapters) {
        lines.push(
            '[CHAPTER]',
            'TIMEBASE=1/1000',
            `START=${Math.round(chapter.start * 1000)}`,
            `END=${Math.round(chapter.end * 1000)}`,
            `title=${chapter.title}`,
        );
    }
    return `${lines.join('\n')}\n`;
}

/**
 * ffprobe の `key=value` 出力を読む。**位置では読まない。**
 *
 * ここは実機で2回踏んでいる。どちらも「1本のTSに局が何本も乗っている」ことが効く
 * (TOKYO MX は MX1 と MX2 が同じTSにいる):
 *
 * 1. **同じ行が番組の数だけ並ぶ。** `-select_streams v:0` を付けても、ffprobe は
 *    番組ごとに v:0 を1つずつ出す。`avg_frame_rate` だけを取って丸ごと
 *    `split('/')` していた頃は、分母が `1001\n30000` になって NaN に落ち、
 *    分子の **30000** をフレームレートとして採っていた。
 * 2. **`-show_entries` に書いた順では返らない。** `avg_frame_rate,width,height`
 *    と頼んでも `1440,1080,30000/1001` (幅,高さ,fps) の順で来る。位置で受けていた
 *    頃は **1440** をフレームレートとして採り、ついでに高さが `30000/1001` に
 *    なっていた (字幕を焼くときの画面の大きさが壊れる)。
 *
 * どちらも当時の join_logo_scp の `Trim` をコマから秒に直すところに効いて、
 * 30分アニメの本編4万2千コマが 1.4秒 / 29秒 に潰れ、「番組の 100% / 98% がCM」で
 * 毎回捨てられていた。ロゴは合致率79%で正しく当たっていたので、
 * 画面からはロゴが悪いようにしか見えなかった (実機の録画34・35・38)。
 *
 * 鍵で引き、**同じ鍵は最初のものを採る**。
 */
export function fields(out: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of out.split('\n')) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        if (!map.has(key)) map.set(key, line.slice(eq + 1).trim());
    }
    return map;
}

/** `30000/1001` の形のフレームレートを数に直す。読めなければ NaN */
export function parseFrameRate(value: string | undefined): number {
    const [num = NaN, den] = (value ?? '').trim().split('/').map(Number);
    const fps = den ? num / den : num;
    return Number.isFinite(fps) && fps > 0 ? fps : NaN;
}

/** ffprobe を1回動かして、標準出力を返す */
async function probe(input: string, args: string[]): Promise<string> {
    const result = await run([config.ffprobe, '-v', 'error', ...args, input], { stdout: true });
    return new TextDecoder().decode(result.stdout).trim();
}

/**
 * 尺とフレームレートを先に取る。
 *
 * ffmpeg の stderr に出る `Duration:` を当てにしていた頃は、TS によっては
 * 拾えず、進み具合が最後まで 0% のままになっていた。先に ffprobe で押さえる。
 *
 * **頭出し (`probeLeadIn`) はここに含めない。** あちらは実際に復号してみる
 * ぶんだけ高くつくのに、要るのは焼く前の1回だけ
 */
export async function probeVideo(input: string): Promise<{
    duration: number;
    fps: number;
    width: number;
    height: number;
    formatStart: number;
    packetStart: number;
    sar: number;
}> {
    const read = (args: string[]) => probe(input, args);

    let duration = NaN;
    let fps = NaN;
    let width = NaN;
    let height = NaN;
    let formatStart = NaN;
    let packetStart = NaN;
    let sar = 1;
    try {
        // `nk=1` (鍵を出さない) にはしない。鍵で引くために必ず `key=value` で受ける
        const format = fields(
            await read(['-show_entries', 'format=duration,start_time', '-of', 'default=nw=1']),
        );
        duration = Number(format.get('duration'));
        formatStart = Number(format.get('start_time'));

        const stream = fields(
            await read([
                '-select_streams',
                'v:0',
                '-show_entries',
                'stream=avg_frame_rate,width,height,start_time,sample_aspect_ratio',
                '-of',
                'default=nw=1',
            ]),
        );
        fps = parseFrameRate(stream.get('avg_frame_rate'));
        width = Number(stream.get('width'));
        height = Number(stream.get('height'));
        sar = parseRatio(stream.get('sample_aspect_ratio'));
        packetStart = Number(stream.get('start_time'));
    } catch {
        // ffprobe が使えない環境。呼ぶ側が NaN を見て諦める
    }
    const positive = (value: number) => (Number.isFinite(value) && value > 0 ? value : NaN);
    return {
        duration: positive(duration),
        fps: positive(fps),
        // 字幕を絵で焼くときの画面の大きさ。libaribcaption は既定で 1440x1080 と
        // みなすので、渡さないと 1920x1080 の録画で字幕だけ横に伸びる
        width: positive(width),
        height: positive(height),
        /**
         * **入れ物そのものの始まり (PTS)。** 頭からの秒数ではなく放送の時刻で、
         * この録画では 6115.51 だった。
         *
         * ffmpeg は入力の時刻からこれを引いて 0 から数え直す。**同じ TS を
         * 別々に ffmpeg へ通すときは、双方が同じものを引いていないと噛み合わない** —
         * 字幕を絵にするとき (`subtitle.ts`) がまさにそれで、あちらは
         * 字幕1枚目を 0 とみなしていたため、出来上がりで字幕だけ 10 秒早く出ていた。
         * 引く数をこちらから渡して揃える
         */
        formatStart: Number.isFinite(formatStart) ? formatStart : NaN,
        /** 映像の最初の**パケット**の時刻 (PTS)。復号できるコマを探せなかったときの代用 */
        packetStart,
        /**
         * 画素の横長さ。1440x1080 の地上波HDは 4:3 で、これを掛けると 1920 になる。
         * 読めなければ 1 (正方形) とみなす
         */
        sar,
    };
}

/**
 * ffprobe の JSON から、**中身のある音声**が音声の何本目かを拾う (`0:a:<n>` の n)。
 *
 * 中身があるかは `channels` で見る。探り (`TS_PROBE`) の間に1パケットも来なかった
 * 音声は復号できておらず、0 のまま出てくる
 */
export function liveAudioIndexes(json: string): number[] {
    const parsed = JSON.parse(json) as { streams?: { channels?: number }[] };
    const out: number[] = [];
    (parsed.streams ?? []).forEach((stream, index) => {
        if ((stream.channels ?? 0) > 0) out.push(index);
    });
    return out;
}

/**
 * 焼くときに拾う音声 (音声の何本目か)。**頭に中身の無い音声は拾わない。**
 *
 * 録画の尻には次の番組の頭が少し入る。次の番組が副音声つきだと、その音声の PID が
 * 最後の十数秒だけ現れ、`-map 0:a` はそれも1本の音声として拾っていた。出来上がりに
 * **末尾13秒にしか中身の無い音声トラック**が入り、テレビの VLC (Android) はその録画で
 * 字幕 (PGS) を出さなくなった (実機。同じ日の、音声が1本の録画では出る)。
 *
 * **探りの長さは焼くほうと揃える** (`TS_PROBE`)。何本目かで名指しするので、
 * 見えている音声の並びが食い違うと別の音声を指してしまう。
 *
 * 分からなければ空を返す — 呼ぶ側は今までどおり全部拾う
 */
export async function probeLiveAudio(input: string): Promise<number[]> {
    try {
        return liveAudioIndexes(
            await probe(input, [
                ...TS_PROBE,
                '-select_streams',
                'a',
                '-show_entries',
                'stream=channels',
                '-of',
                'json',
            ]),
        );
    } catch {
        return [];
    }
}

/**
 * **映像が出るまでの、音声だけの区間 (秒)。焼くときに頭から捨てる長さ。**
 *
 * TS は音声のほうが先に始まっているのがふつうで、実機では 0.930 秒あった。
 * 残したまま焼くと出来上がりも音声だけの区間から始まり、**1コマ目を 0 秒として
 * 数えるプレイヤー**ではそのぶん字幕が早く出る。ずらす (`-output_ts_offset`) のでは
 * 直らないので捨てる (`encoder.buildArgs` の `-ss`)。
 *
 * **測るのは「実際に復号できた1コマ目」。** stream の `start_time` は最初の
 * **パケット**の時刻で、そこから何コマかは参照先が録れておらず捨てられる。
 * 実機ではその差が 0.567 秒 (17コマ = 半GOP) あった。
 *
 *     start_time 6115.872 / 実際に出た1コマ目 6116.439 (I)
 *
 * `probeVideo` とは別にしてある (理由はあちら)。`formatStart` はあちらで取ったものを渡す
 */
export async function probeLeadIn(input: string, formatStart: number, packetStart = NaN): Promise<number> {
    let first = NaN;
    try {
        first = firstFrameTime(
            // 上限 (MAX_LEAD_IN) より先まで読んでも使わないので、そのぶんだけ見る
            await probe(input, [
                '-select_streams',
                'v:0',
                '-show_frames',
                '-read_intervals',
                `%+${MAX_LEAD_IN + 1}`,
                '-show_entries',
                'frame=best_effort_timestamp_time',
                '-of',
                'default=nw=1',
            ]),
        );
    } catch {
        // ffprobe が使えない環境。パケットの時刻で代用する
    }
    return leadIn(Number.isFinite(first) ? first : packetStart, formatStart);
}

/**
 * 頭出しとして認める上限(秒)。**入れ物の始まりから数える。**
 *
 * TS の時刻は**放送の時刻そのもの** (PTS) で、頭からの秒数ではない。実機では
 * 62170 のような値が入る。引き算を忘れるとその値がそのまま頭捨ての長さになり、
 * **17時間ぶん読み飛ばして中身の無いものが焼き上がる**。
 *
 * ずれが数秒を超えたら 0 にする。読み違えているほうが疑わしく、
 * 大きく捨てると壊れ方が派手になる
 */
const MAX_LEAD_IN = 5;

/**
 * `ffprobe -show_frames` の吐き出しから、**最初に復号できたコマの時刻**を読む。
 *
 * 頭のほうは参照先が録れていないコマが混ざるので、ffprobe も ffmpeg も
 * 最初の I フレームまで捨てる。ここで返るのは捨て終わったあとの1コマ目。
 * 1件も無ければ NaN (呼ぶ側がパケットの時刻で代用する)
 */
export function firstFrameTime(output: string): number {
    for (const line of output.split('\n')) {
        const match = /^best_effort_timestamp_time=(-?[\d.]+)/.exec(line.trim());
        if (match !== null) {
            const at = Number(match[1]);
            if (Number.isFinite(at)) return at;
        }
    }
    return NaN;
}

export function leadIn(streamStart: number, formatStart: number): number {
    if (!Number.isFinite(streamStart)) return 0;
    const from = Number.isFinite(formatStart) ? formatStart : 0;
    const lead = streamStart - from;
    return lead > 0 && lead <= MAX_LEAD_IN ? lead : 0;
}

/** `4:3` のような比を数にする。読めなければ 1 */
export function parseRatio(value: string | undefined): number {
    const match = /^(\d+)[:/](\d+)$/.exec((value ?? '').trim());
    if (match === null) return 1;
    const [, a, b] = match;
    const ratio = Number(a) / Number(b);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export interface CmDetection {
    cm: Range[];
    duration: number;
    note: string;
}

export interface CmOptions {
    signal?: AbortSignal;
    /** 局のID。覚えたロゴの置き場を局ごとに分けるのに使う */
    serviceId: number;
    /** 番組の尺 (秒。番組表)。録画の頭と尻に入った前後の番組を見分けるのに使う */
    programLength?: number;
    /** 番組表どおりなら番組が始まる秒 (録画の前のマージン) */
    programStart?: number;
    /** 読み込みの進み具合 (0〜1) */
    onProgress?: (percent: number) => void;
    /** いま何をしているか。段階の名前だけでは進み具合が分からない */
    onStep?: (label: string) => void;
}

/**
 * 設定された検出のしかたでCM区間を求める。
 *
 * **返す秒は ffmpeg の時刻** (入れ物の頭から)。焼くときは頭を捨てる `-ss` と同じだけ詰める
 * (`encoder.rebaseChapters`)。TS を切るとき (`-ss`) はそのまま使える
 */
export async function detectCm(input: string, options: CmOptions): Promise<CmDetection> {
    const { signal, onProgress, serviceId } = options;
    const step = options.onStep ?? (() => {});
    /*
     * 尺は先に測る。進み具合の分母と、ロゴを覚えるときにキーフレームを散らす間隔に要る。
     * フレームレートはロゴの区間をならす窓の幅に使う
     */
    const probed = await probeVideo(input);
    const { duration: measured } = probed;
    const fps = Number.isFinite(probed.fps) ? probed.fps : config.cmFallbackFps;
    const deadline = Date.now() + config.cmDetectTimeout;
    const left = () => Math.max(0, deadline - Date.now());
    // 検出のしかたは設定画面で決める (ロゴまで見るのは確かだが、絵を全部復号する)
    const useLogo = settings().cmDetector === 'logo';
    /** ロゴが使えなかった理由。尺だけで決めたときの覚え書きに足す */
    let why = '';

    /*
     * 1. ロゴを覚えていれば読み、無ければこの録画から覚える (キーフレームだけ読むので速い)。
     *    **覚えられなくても読み込みは続ける** — 無音と切れ目だけで決め直せる
     */
    let logo: Exclude<Awaited<ReturnType<typeof openLogo>>, string> | null = null;
    if (useLogo) {
        step('局ロゴを確かめています');
        const opened =
            probed.width > 0 && probed.height > 0
                ? await openLogo(input, probed, { repo: logoRepo(serviceId), signal, deadline })
                : '大きさが測れませんでした';
        if (typeof opened === 'string') why = `ロゴ判定が失敗: ${opened}`;
        else logo = opened;
    }

    // 2. 1回だけ復号して、無音・切れ目・ロゴの枠をまとめて読む
    step(useLogo ? '無音と場面の切れ目とロゴを読んでいます' : '無音を探しています');
    const read = (video: boolean) =>
        scan(input, {
            signal,
            timeoutMs: left(),
            video,
            audio: true,
            logo: video ? (logo?.scan ?? null) : null,
            ...(onProgress ? { onProgress } : {}),
            duration: measured,
        });
    const failed = (scan: Scan) =>
        `${left() <= 0 ? '時間切れ' : '失敗'} (code ${scan.code}): ${scan.stderr.trim().split('\n').at(-1) ?? ''}`;
    const stopped = () => signal?.aborted === true;
    let found = await read(useLogo);
    if (stopped()) throw new Error('中止されました');
    // 絵のほうで落ちたなら (壊れた絵・フィルタ)、音だけ読み直して尺だけで決める
    if (found.code !== 0 && useLogo && left() > 0) {
        why = `絵の読み込みが${failed(found)}`;
        logo = null;
        found = await read(false);
        if (stopped()) throw new Error('中止されました');
    }
    if (found.code !== 0) return { cm: [], duration: measured, note: `CM検出の読み込みが${failed(found)}` };

    /*
     * 秒は ffmpeg の時刻 (入れ物の頭から) のまま決める。焼くときに `-ss` と同じだけ詰める。
     * 尺が ffprobe で測れなかったら、ffmpeg が言ってきた尺、それも無ければ読めた最後のコマで代える
     */
    const duration = Number.isFinite(measured)
        ? measured
        : Number.isFinite(found.duration)
          ? found.duration
          : (found.times.at(-1) ?? Number.NaN);
    if (!Number.isFinite(duration)) return { cm: [], duration: measured, note: '尺が測れませんでした' };
    const at = (frame: number) => (frame < found.times.length ? found.times[frame]! : duration);
    const material = {
        duration,
        silences: found.silences,
        times: found.times,
        cuts: found.cuts,
        ...(options.programLength !== undefined ? { programLength: options.programLength } : {}),
        ...(options.programStart !== undefined ? { programStart: options.programStart } : {}),
    };

    // ロゴの枠とコマの時刻は順番で突き合わせる。数が合わなければ読み落としがあるので使わない
    if (logo && found.logoFrames !== found.times.length) {
        why = `ロゴの枠の数 (${found.logoFrames}) とコマの数 (${found.times.length}) が合いません`;
        logo = null;
    }

    // 3. ロゴの区間を出す (覚えていたものが当たらなければ、覚え直して枠だけ読み直す)
    if (logo) {
        step('本編とCMに分けています');
        const result = await logo.finish(
            fps,
            async (again) =>
                (await scan(input, { signal, timeoutMs: left(), video: true, audio: false, logo: again }))
                    .code,
        );
        if (result.code === 0) {
            console.log(`[cm] ロゴ判定: ${result.note}`);
            /*
             * **覚えたものを、同じ絵を映している局にも配る** (`logo-data.share`)。
             * サブチャンネルの枠で録れた番組が一から覚え直さないように
             */
            if (result.learned !== null) share(serviceId, result.learned.file, result.learned.again);
            const cm = decideCm({
                ...material,
                logo: result.spans.map((s) => ({ start: at(s.start), end: at(s.end + 1) })),
                logoScores: result.scores,
            });
            if (cm.length === 0) why = 'ロゴの消えている所がありませんでした';
            // 番組の半分以上がCMになったら、その結果は捨てて尺だけで決め直す (tooMuchCm)
            else if (tooMuchCm(cm, duration))
                why = `番組の ${cmRatio(cm, duration)}% がCMという結果だったので捨てました`;
            else return { cm, duration, note: LOGO_OK };
        } else {
            why = `ロゴ判定が失敗: ${result.note}`;
        }
    }

    // 4. ロゴを使わずに、CM の尺 (15秒の倍数) だけで決める
    const cm = decideCm(material);
    /*
     * 落ちた理由まで書く。「無音 8 箇所」とだけ出していた頃は、ロゴを選んで
     * いるのになぜ無音検出になったのかが画面から分からなかった。
     *
     * **この文言から「ロゴで判定できなかった」と画面に出すかを決める** (format.logoUnusable)。
     * 別の列で持っていた頃は、後から条件を広げても既に録ってある分に効かなかった
     */
    const note = `無音 ${material.silences.length} 箇所`;
    return {
        cm: tooMuchCm(cm, duration) ? [] : cm,
        duration,
        note: useLogo ? `${note} (${LOGO_UNUSABLE}: ${why})` : note,
    };
}
