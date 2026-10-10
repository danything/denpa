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
import type { ScanLogo } from './cm-scan';
import { config } from './config';
import { run } from './stream';

/**
 * **局ロゴの判定。** どのコマにロゴが出ているかを拾う。
 *
 * 覚え方と当て方は [logo-detect.ts](../ts/logo-detect.ts)。ここはコマを抜いて渡すところと、
 * 覚えたものの置き場です。
 *
 * 1. **覚える** — キーフレームだけ散らして抜き (`-skip_frame nokey`。全部を復号しないので速い)、
 *    上下の帯で線の向きを足し合わせて在り処を割り出す。局のぶんを覚えていれば飛ばす
 * 2. **当てる** — ロゴの枠を CM 検出の1回の復号 (`cm-scan.ts`) で全部のコマから切り出してもらい、
 *    点を付けて区間にする。ついでに散らしたコマを足して、覚えたものを育てる
 *
 * 覚えたものは局ごとの入れ物に、コマの大きさごとに置く (`logo-data.logoRepo`・`modelFile`)。
 * 「この絵は違う」で入れ物ごと捨てると、次の録画で一から覚える。
 */

/**
 * 覚えたものの置き場 (局ごとの入れ物の中)。**コマの大きさごとに分ける** — 同じ局で SD と HD の録画が
 * 交互に来ると、1つの名前では毎回入れ替わって育たない
 */
export const modelFile = (width: number, height: number) => `own-logo-${width}x${height}.bin`;

/** 覚えるときに見るキーフレームの数 */
const LEARN_FRAMES = 600;
/** 当てるついでに覚えたものへ足すコマの間隔 (コマ数)。30分で 600 コマほど */
const GROW_EVERY = 90;

export function load(repo: string, width: number, height: number): LogoModel | null {
    try {
        const model = decodeModel(readFileSync(join(repo, modelFile(width, height))));
        return model?.frameWidth === width && model.frameHeight === height ? model : null;
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
    const path = join(repo, modelFile(model.frameWidth, model.frameHeight));
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

/** 録画の絵の大きさと尺 (`cm.probeVideo`) */
export interface Video {
    width: number;
    height: number;
    duration: number;
}

/**
 * 枠を切り出す ffmpeg のフィルタ。**座標はコマの大きさに対する比で渡す。**
 *
 * 途中で大きさの変わる録画 (SD の CM が挟まる) で、決め打ちの枠がはみ出すと ffmpeg ごと落ちる。
 * 先にコマ全体を元の大きさへ scale すると、大きさが同じでも毎コマ変換が走って
 * 切り出しの CPU が倍になった (実測 30分で 112 → 211 秒)。比で切ってから小さい枠だけ
 * 戻せば、同じ大きさのときの scale は何もしない
 */
function cropTo(rect: Rect, video: Video): string {
    const { width: w, height: h } = video;
    return (
        `crop=iw*${rect.width}/${w}:ih*${rect.height}/${h}:iw*${rect.x}/${w}:ih*${rect.y}/${h}:exact=1,` +
        `scale=${rect.width}:${rect.height}`
    );
}

/** 止める合図と、全体の締め切り (ms の時刻) */
interface Limits {
    signal?: AbortSignal | undefined;
    deadline: number;
}

/** キーフレームを散らして抜き、上下の帯で向きを足し合わせて在り処を割り出す */
async function learn(input: string, video: Video, limits: Limits): Promise<LogoModel | string> {
    const { width, height, duration } = video;
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
            input,
            '-an',
            '-sn',
            '-dn',
            '-vf',
            // 上の帯と下の帯を縦に並べる。境目の行は addFrame が外周として飛ばす
            `fps=1/${every.toFixed(3)},split[a][b];` +
                `[a]${cropTo({ x: 0, y: 0, width, height: band }, video)}[t];` +
                `[b]${cropTo({ x: 0, y: height - band, width, height: band }, video)}[u];` +
                `[t][u]vstack,format=gray`,
            '-frames:v',
            String(LEARN_FRAMES),
            '-f',
            'rawvideo',
            'pipe:1',
        ],
        {
            signal: limits.signal,
            timeoutMs: Math.max(0, limits.deadline - Date.now()),
            stderr: true,
            onStdout: framer(width * band * 2, (bytes) => {
                addFrame(top, bytes, 0, width);
                addFrame(bottom, bytes, width * band, width);
            }),
        },
    );
    if (result.code !== 0) return `覚えるためのコマが抜けませんでした (code ${result.code})`;

    const rect = findArea({ top, bottom }, width, height);
    if (rect === null) return 'ロゴの在り処が割り出せませんでした';
    const inTop = rect.y + rect.height <= band;
    const orientation = cropOrientation(inTop ? top : bottom, {
        ...rect,
        y: inTop ? rect.y : rect.y - (height - band),
    });
    return { frameWidth: width, frameHeight: height, rect, orientation };
}

/** 当てる段。CM 検出の復号に枠を渡し、届いたコマに点を付ける */
interface Tracker {
    scan: ScanLogo;
    /** 届いたコマから区間を出す (コマ番号) */
    spans(fps: number): Span[];
    /** コマごとの点 */
    scores(): Float32Array;
    frames(): number;
    grow: Orientation;
    points: number;
}

function tracker(model: LogoModel, video: Video): Tracker | string {
    const template = makeTemplate(model);
    if (template === null) return 'ロゴの縁が少なすぎて型にできませんでした';
    const { crop } = template;
    const { rect } = model;
    const grow = emptyOrientation(rect.width, rect.height);
    const growAt = (rect.y - crop.y) * crop.width + (rect.x - crop.x);
    const scores: number[] = [];
    const levels: number[] = [];
    const textures: number[] = [];
    return {
        scan: {
            filter: cropTo(crop, video),
            size: crop.width * crop.height,
            onFrame: (bytes) => {
                scores.push(score(template, bytes));
                levels.push(level(template, bytes));
                textures.push(texture(template, bytes));
                if (scores.length % GROW_EVERY === 0) addFrame(grow, bytes, growAt, crop.width);
            },
        },
        spans: (fps) =>
            logoSpans(
                {
                    scores: Float32Array.from(scores),
                    levels: Uint8Array.from(levels),
                    textures: Uint8Array.from(textures),
                },
                fps,
            ),
        scores: () => Float32Array.from(scores),
        frames: () => scores.length,
        grow,
        points: template.points.length,
    };
}

export interface LogoResult {
    /** 0 で当たった。それ以外はロゴを使わずに決める */
    code: number;
    /** ロゴの出ていた区間 (コマ番号。CM 検出の復号の `times` と同じ並び) */
    spans: Span[];
    /** コマごとの点 (同じ並び)。境目でロゴが替わったかを見る (`cm-decide`) */
    scores: Float32Array;
    /**
     * この回に覚えて持ち帰ったもの (同じ絵の局へ配る合図。`logo-data.share`)。
     * `again` は覚えていたものが当たらず覚え直した (局がロゴを替えた) とき
     */
    learned: { file: string; again: boolean } | null;
    /** 覚え書き (落ちたときの理由 / 通ったときの要約) */
    note: string;
}

/**
 * ロゴの判定を始める。覚えていれば読み、無ければこの録画から覚える。
 * 返った `scan` を CM 検出の復号に渡し、読み終えたら `finish` を呼ぶ
 */
export async function openLogo(
    input: string,
    video: Video,
    options: Limits & { repo: string },
): Promise<
    | string
    | {
          scan: ScanLogo;
          /**
           * 区間を出し、覚えたものを書く。**覚えていたもので1コマも当たらなければ覚え直す** (局がロゴを
           * 替えたとき)。覚え直したら枠だけもう一度切り出す (`rescan`。無音と切れ目は取り直さない)
           */
          finish(fps: number, rescan: (logo: ScanLogo) => Promise<number>): Promise<LogoResult>;
      }
> {
    const { repo } = options;
    // 覚えていれば使う。コマの大きさが違うもの (SD と HD) には当てない
    const loaded = load(repo, video.width, video.height);
    let learnedNow = loaded === null;
    let model: LogoModel;
    if (loaded === null) {
        const learned = await learn(input, video, options);
        if (typeof learned === 'string') return learned;
        model = learned;
    } else {
        model = loaded;
    }
    const first = tracker(model, video);
    if (typeof first === 'string') return first;

    return {
        scan: first.scan,
        async finish(fps, rescan) {
            const fail = (note: string, code = 1): LogoResult => ({
                code,
                spans: [],
                scores: new Float32Array(),
                learned: null,
                note,
            });
            let current = first;
            let spans = current.spans(fps);
            /** 覚えていたものが当たらず、この録画から覚え直した */
            let relearned = false;
            /** 覚えたものを持ち帰るか。前のロゴと違う所で覚えたなら、この回だけ使って持ち帰らない */
            let keep = true;
            if (!learnedNow && spans.length === 0 && current.frames() > 0) {
                if (options.signal?.aborted === true) return fail('中止されました', 143);
                console.warn('[cm] 覚えていたロゴが当たらないので、この録画から覚え直します');
                const learned = await learn(input, video, options);
                if (typeof learned === 'string') return fail(learned);
                /*
                 * **在り処が前と重ならなければ、この回だけ使って持ち帰らない。** ロゴを替えた局は
                 * たいてい同じ所に出すが、ロゴの無い特番では別の動かない縁 (番組の透かし) を
                 * 覚えてしまう。それで局の型を上書きすると、次の録画から外れる
                 */
                keep = overlaps(model.rect, learned.rect);
                model = learned;
                learnedNow = true;
                relearned = true;
                const next = tracker(model, video);
                if (typeof next === 'string') return fail(next);
                const code = await rescan(next.scan);
                if (code !== 0) return fail(`コマが抜けませんでした (code ${code})`, code);
                current = next;
                spans = current.spans(fps);
            }
            if (spans.length === 0) return fail('ロゴの写っているコマがありませんでした');

            // 写っていたなら育てる。この回に覚えたものは、覚えるときに足したぶんで足りている
            if (keep) save(repo, learnedNow ? model : mergeModel(model, current.grow));

            const { rect } = model;
            const lit = spans.reduce((sum, span) => sum + span.end - span.start + 1, 0);
            const share = Math.round((lit / Math.max(1, current.frames())) * 100);
            return {
                code: 0,
                spans,
                scores: current.scores(),
                learned:
                    learnedNow && keep
                        ? { file: modelFile(model.frameWidth, model.frameHeight), again: relearned }
                        : null,
                note: `枠 ${rect.x},${rect.y},${rect.width},${rect.height} 型 ${current.points} 画素 / ロゴ ${share}%${learnedNow ? (keep ? ' (この録画で覚えた)' : ' (この録画だけで覚えた。前の型は残す)') : ''}`,
            };
        },
    };
}
