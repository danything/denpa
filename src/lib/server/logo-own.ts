import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Rect } from '../ts/logo-area';
import {
    addFrame,
    cropOrientation,
    decodeModel,
    emptyOrientation,
    encodeModel,
    findArea,
    formatLogoFrames,
    framer,
    type LogoModel,
    level,
    logoSpans,
    makeTemplate,
    mergeModel,
    type Orientation,
    type Span,
    score,
    texture,
} from '../ts/logo-detect';
import { probeLeadIn, probeVideo } from './cm';
import { config } from './config';
import { run } from './stream';

/**
 * **自前のロゴ判定** (`CM_LOGO=own`)。logoframe と同じ形の「ロゴが写っているコマ」を書く。
 *
 * 覚え方と当て方は [logo-detect.ts](../ts/logo-detect.ts)。ここはコマを抜いて渡すところと、
 * 覚えたものの置き場です。
 *
 * 1. **覚える** — キーフレームだけ散らして抜き (`-skip_frame nokey`。全部を復号しないので速い)、
 *    上下の帯で線の向きを足し合わせて在り処を割り出す。局のぶんを覚えていれば飛ばす
 * 2. **当てる** — ロゴの枠だけを全部のコマで切り出して点を付け、区間にする。
 *    ついでに散らしたコマを足して、覚えたものを育てる
 *
 * 覚えたものは `.lgd` と同じ局ごとの入れ物に置く (`logoRepo`)。位置を教え直したときや
 * 「この絵は違う」で丸ごと捨てると、こちらも一緒に消える。
 */

/** 覚えたものの置き場 (局ごとの入れ物の中) */
export const MODEL_FILE = 'own-logo.bin';

/** 覚えるときに見るキーフレームの数 */
const LEARN_FRAMES = 600;
/** 当てるついでに覚えたものへ足すコマの間隔 (コマ数)。30分で 600 コマほど */
const GROW_EVERY = 90;

export interface OwnResult {
    /** 0 で書けた。それ以外は logoframe が降りたときと同じ扱いにする */
    code: number;
    /** 覚え書き (落ちたときの理由 / 通ったときの要約) */
    stderr: string;
    /** 実測用の内訳 (ms)。覚える・当てる・そのうちロゴの計算そのもの */
    timing: { learn: number; detect: number; compute: number; frames: number };
}

export function load(repo: string): LogoModel | null {
    try {
        return decodeModel(readFileSync(join(repo, MODEL_FILE)));
    } catch {
        return null;
    }
}

/**
 * 覚えたものを書く。**書けなくても検出は落とさない** (次の録画で覚え直せば済む)。
 * 書きかけを読まれないよう隣に書いてから差し替える。隣の名前はジョブごとに変える
 * (2 本ずつ焼くので、同じ局の録画が同時に書きに来ることがある)
 */
export function save(repo: string, model: LogoModel): void {
    const path = join(repo, MODEL_FILE);
    const temp = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
        mkdirSync(repo, { recursive: true });
        writeFileSync(temp, encodeModel(model));
        renameSync(temp, path);
    } catch (error) {
        try {
            rmSync(temp, { force: true });
        } catch {
            // 置き場ごと作れなかった。消すものも無い
        }
        console.warn(`[cm] 覚えたロゴを書けませんでした: ${error}`);
    }
}

/** 2つの枠が重なるか */
function overlaps(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** `x,y,w,h` を枠に。読めなければ `null` */
function parseArea(text: string | undefined): Rect | null {
    const m = /^(\d+),(\d+),(\d+),(\d+)$/.exec(text ?? '');
    if (m === null) return null;
    const [x, y, width, height] = m.slice(1).map(Number) as [number, number, number, number];
    return width > 0 && height > 0 ? { x, y, width, height } : null;
}

type Probed = Awaited<ReturnType<typeof probeVideo>>;

/** 1回ぶんの材料 */
interface Job {
    input: string;
    probed: Probed;
    fps: number;
    area: string | undefined;
    signal: AbortSignal | undefined;
    deadline: number;
    timing: OwnResult['timing'];
}

/**
 * 枠を切り出す ffmpeg のフィルタ。**座標はコマの大きさに対する比で渡す。**
 *
 * 途中で大きさの変わる録画 (SD の CM が挟まる) で、決め打ちの枠がはみ出すと ffmpeg ごと落ちる。
 * 先にコマ全体を元の大きさへ scale すると、大きさが同じでも毎コマ変換が走って
 * 切り出しの CPU が倍になった (実測 30分で 112 → 211 秒)。比で切ってから小さい枠だけ
 * 戻せば、同じ大きさのときの scale は何もしない
 */
function cropTo(rect: Rect, probed: Probed): string {
    const { width: w, height: h } = probed;
    return (
        `crop=iw*${rect.width}/${w}:ih*${rect.height}/${h}:iw*${rect.x}/${w}:ih*${rect.y}/${h}:exact=1,` +
        `scale=${rect.width}:${rect.height}`
    );
}

/** キーフレームを散らして抜き、上下の帯で向きを足し合わせて在り処を割り出す */
async function learn(job: Job): Promise<LogoModel | string> {
    const { width, height, duration } = job.probed;
    const started = performance.now();
    // 隅は上下の 1/5 (logo-area の REGION_H)。帯の境目が縦の真ん中で揃うよう偶数に
    const band = Math.round(height / 5) & ~1;
    const top = emptyOrientation(width, band);
    const bottom = emptyOrientation(width, band);
    const every = Math.max(0.5, (Number.isFinite(duration) ? duration : 0) / LEARN_FRAMES);
    const result = await run(
        [
            config.ffmpeg,
            '-v',
            'error',
            // キーフレームしか復号しない。散らして見るだけなので全部は要らない
            '-skip_frame',
            'nokey',
            '-i',
            job.input,
            '-an',
            '-sn',
            '-dn',
            '-vf',
            // 上の帯と下の帯を縦に並べる。境目の行は addFrame が外周として飛ばす
            `fps=1/${every.toFixed(3)},split[a][b];` +
                `[a]${cropTo({ x: 0, y: 0, width, height: band }, job.probed)}[t];` +
                `[b]${cropTo({ x: 0, y: height - band, width, height: band }, job.probed)}[u];` +
                `[t][u]vstack,format=gray`,
            '-frames:v',
            String(LEARN_FRAMES),
            '-f',
            'rawvideo',
            'pipe:1',
        ],
        {
            signal: job.signal,
            timeoutMs: Math.max(0, job.deadline - Date.now()),
            stderr: true,
            onStdout: framer(width * band * 2, (frame) => {
                addFrame(top, frame, 0, width);
                addFrame(bottom, frame, width * band, width);
            }),
        },
    );
    job.timing.learn += performance.now() - started;
    if (result.code !== 0) return `覚えるためのコマが抜けませんでした (code ${result.code})`;

    let rect = findArea({ top, bottom }, width, height);
    if (rect === null) {
        // 割り出せなければ、画面で教わった枠を使う (帯の中にあるときだけ)
        const taught = parseArea(job.area);
        const inBand = (t: Rect) =>
            t.x + t.width <= width &&
            (t.y + t.height <= band || (t.y >= height - band && t.y + t.height <= height));
        if (taught !== null && inBand(taught)) rect = taught;
    }
    if (rect === null) return 'ロゴの在り処が割り出せませんでした';
    const inTop = rect.y + rect.height <= band;
    const orientation = cropOrientation(inTop ? top : bottom, {
        ...rect,
        y: inTop ? rect.y : rect.y - (height - band),
    });
    return { frameWidth: width, frameHeight: height, rect, orientation };
}

/** ロゴの枠だけを全部のコマで切り出して点を付ける。ついでに散らしたコマで向きを足す */
async function detect(
    job: Job,
    model: LogoModel,
): Promise<{ spans: Span[]; frames: number; grow: Orientation; points: number } | string> {
    const template = makeTemplate(model);
    if (template === null) return 'ロゴの縁が少なすぎて型にできませんでした';
    const started = performance.now();
    const { crop } = template;
    const { rect } = model;
    const grow = emptyOrientation(rect.width, rect.height);
    const growAt = (rect.y - crop.y) * crop.width + (rect.x - crop.x);
    const scores: number[] = [];
    const levels: number[] = [];
    const textures: number[] = [];
    const result = await run(
        [
            config.ffmpeg,
            '-v',
            'error',
            '-i',
            job.input,
            '-an',
            '-sn',
            '-dn',
            // コマ番号を数えるので、間引かない・増やさない
            '-fps_mode',
            'passthrough',
            '-vf',
            `${cropTo(crop, job.probed)},format=gray`,
            '-f',
            'rawvideo',
            'pipe:1',
        ],
        {
            signal: job.signal,
            timeoutMs: Math.max(0, job.deadline - Date.now()),
            stderr: true,
            onStdout: framer(crop.width * crop.height, (frame) => {
                const t = performance.now();
                scores.push(score(template, frame));
                levels.push(level(template, frame));
                textures.push(texture(template, frame));
                if (scores.length % GROW_EVERY === 0) addFrame(grow, frame, growAt, crop.width);
                job.timing.compute += performance.now() - t;
            }),
        },
    );
    job.timing.detect += performance.now() - started;
    job.timing.frames = scores.length;
    if (result.code !== 0) return `コマが抜けませんでした (code ${result.code})`;
    const spans = logoSpans(
        {
            scores: Float32Array.from(scores),
            levels: Uint8Array.from(levels),
            textures: Uint8Array.from(textures),
        },
        job.fps,
    );
    return { spans, frames: scores.length, grow, points: template.points.length };
}

/**
 * 録画からロゴを覚え、写っているコマを logoframe の `-oa` と同じ形で `out` に書く。
 *
 * `repo` は局ごとの入れ物、`area` は画面から教わった枠 (自分で割り出せなかったときだけ使う)
 */
export async function ownLogoFrames(
    input: string,
    out: string,
    options: { repo: string; area?: string; signal?: AbortSignal | undefined; timeoutMs: number },
): Promise<OwnResult> {
    const { repo } = options;
    const timing = { learn: 0, detect: 0, compute: 0, frames: 0 };
    const fail = (stderr: string, code = 1): OwnResult => ({ code, stderr, timing });

    let probed: Probed;
    try {
        probed = await probeVideo(input);
    } catch {
        return fail('尺と大きさが測れませんでした');
    }
    if (!(probed.width > 0) || !(probed.height > 0)) return fail('大きさが測れませんでした');
    const job: Job = {
        input,
        probed,
        // 測れなかったときだけ既定に落とす (cm-jls と同じ)
        fps: Number.isFinite(probed.fps) && probed.fps > 0 ? probed.fps : config.cmJlsFallbackFps,
        area: options.area,
        signal: options.signal,
        deadline: Date.now() + options.timeoutMs,
        timing,
    };

    // 覚えていれば使う。コマの大きさが違うもの (SD と HD) には当てない
    const stored = load(repo);
    let model = stored?.frameWidth === probed.width && stored.frameHeight === probed.height ? stored : null;
    let learnedNow = false;
    /** 覚え直したものを持ち帰るか。前のロゴと違う所で覚えたなら、この回だけ使って持ち帰らない */
    let keep = true;
    if (model === null) {
        const learned = await learn(job);
        if (typeof learned === 'string') return fail(learned);
        model = learned;
        learnedNow = true;
    }
    let found = await detect(job, model);
    /*
     * **覚えていたもので1コマも当たらなければ、覚え直す。** 局がロゴを替えたとき、
     * 前のロゴの型のまま「写っていない」を出し続けないように
     */
    // 抜けなかった (ffmpeg の失敗・時間切れ) ときは覚え直さない。理由はそのまま返す
    if (!learnedNow && typeof found !== 'string' && found.spans.length === 0) {
        if (options.signal?.aborted === true) return fail('中止されました', 143);
        console.warn('[cm] 覚えていたロゴが当たらないので、この録画から覚え直します');
        const learned = await learn(job);
        if (typeof learned === 'string') return fail(learned);
        /*
         * **在り処が前と重ならなければ、この回だけ使って持ち帰らない。** ロゴを替えた局は
         * たいてい同じ所に出すが、ロゴの無い特番では別の動かない縁 (番組の透かし) を
         * 覚えてしまう。それで局の型を上書きすると、次の録画から外れる
         */
        keep = overlaps(model.rect, learned.rect);
        model = learned;
        learnedNow = true;
        found = await detect(job, model);
    }
    if (typeof found === 'string') return fail(found);
    if (found.spans.length === 0) return fail('ロゴの写っているコマがありませんでした');

    // 番号を chapter_exe (dtvindex) の数え方にそろえる (頭の復号できないコマのぶん)
    const { dropped } = await probeLeadIn(input, probed.formatStart, probed.packetStart, job.fps);
    writeFileSync(out, formatLogoFrames(found.spans, Math.round(dropped * job.fps)));

    // 写っていたなら育てる。この回に覚えたものは、覚えるときに足したぶんで足りている
    if (keep) save(repo, learnedNow ? model : mergeModel(model, found.grow));

    const { rect } = model;
    const lit = found.spans.reduce((sum, span) => sum + span.end - span.start + 1, 0);
    const share = Math.round((lit / found.frames) * 100);
    return {
        code: 0,
        stderr: `枠 ${rect.x},${rect.y},${rect.width},${rect.height} 型 ${found.points} 画素 / ロゴ ${share}%${learnedNow ? (keep ? ' (この録画で覚えた)' : ' (この録画だけで覚えた。前の型は残す)') : ''}`,
        timing,
    };
}
