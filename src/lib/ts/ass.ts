/**
 * 文字で取り出した ARIB字幕 (ASS) を読み、整えて、WebVTT に直す。**DOM を触らない。**
 *
 * 焼いたものに入れる字幕は PGS (絵) のままです ([encode.md](../../../docs/encode.md))。
 * ここが作るのは**その隣に置く文字の付き添い**で、行き先は2つ:
 *
 * - `<動画名>.ja.ass` … 保存先に置く。WebDAV 越しの Kodi が拾う
 * - WebVTT … ブラウザの `<track>` に渡す (`api/recordings/<id>/subtitle.vtt`)
 *
 * ## ffmpeg の出したものをそのままは使えない
 *
 * `-sub_type ass` が吐く ASS には手直しが要ります。
 *
 * - **「消す」が空の Dialogue で来る。** ARIB字幕は「出す」と「消す」の指示で
 *   出来ていて、libaribcaption は消す指示を**本文の空な Dialogue** にする。
 *   ASS の Dialogue は互いに独立なので、そのまま置くと消えずに残る
 *   (実測: 本好き617枚のうち58枚、鬼の花嫁に至っては18枚すべてが空 = 字幕の無い番組)
 * - **時刻が 0 より前に来ることがある。** 焼き上がりの 0 秒に合わせるため
 *   `-output_ts_offset` で引かせるので、頭の字幕が負に回ることがある。ffmpeg は
 *   それを `0:00:-9.-32` と書く (部品ごとに符号が付く) ので、足し合わせて読む
 * - **ルビが別の行として出てくる。** 放送では文字の上に小さく乗るものが、
 *   ASS では位置指定つきの独立した Dialogue になる。ASS のまま (Kodi) なら
 *   位置どおりに乗るので良いが、**WebVTT には座標が無い**ので、そのままだと
 *   「あかぎ」「(赤木)ニオう…」と2行に割れる。文字の大きさで見分けて
 *   (実測: 本文 36 に対してルビ 18)、**本文に畳み込む** (`attachRuby`)
 */

/** ふりがなと見なす大きさの境目。本文の何割より小さければルビか */
const RUBY = 0.75;

/** 出し始めの時刻でまとめる。同じ時刻の Dialogue は**画面に同時に出る別々の行** */
export interface Cue {
    /** 秒 */
    start: number;
    end: number;
    /** `Dialogue:` の Layer。書き戻すときにそのまま使う */
    layer: string;
    /** Style から Effect まで。同じく、そのまま書き戻す */
    fields: string;
    /** 本文。`{\pos(…)}` などの指定を含んだまま持つ */
    text: string;
}

export interface Ass {
    /** 最初の `Dialogue:` より前。書き戻すときにそのまま使う */
    head: string;
    /** 本文の文字の大きさ (Style の Fontsize)。ルビの見分けに使う */
    fontSize: number;
    /** 字幕の画面の高さ。上下どちらに出すかの判断に使う */
    playResY: number;
    cues: Cue[];
}

/** 既定値。読めなかったときに使う (libaribcaption は 960x540 / 36 を書いてくる) */
const DEFAULT_FONT_SIZE = 36;
const DEFAULT_PLAY_RES_Y = 540;

/**
 * ASS の時刻を秒にする。**部品ごとに足す。**
 *
 * `0:00:10.28` のような形だが、引きすぎたときの ffmpeg は `0:00:-9.-32` と書く。
 * 部品ごとに符号を付けてくるので、そのまま足せば -9.32 になる
 */
export function assTime(text: string): number {
    const parts = text.trim().split(':');
    if (parts.length !== 3) return Number.NaN;
    const [h, m, rest] = parts;
    // 秒は小数点の前後も別々に符号を持つ (`-9.-32`)。`Number('-9.-32')` は読めない
    const [whole, fraction = '0'] = rest.split('.');
    const values = [Number(h), Number(m), Number(whole), Number(fraction)];
    if (values.some((value) => !Number.isFinite(value))) return Number.NaN;
    // 桁数は符号を除いて数える (`-32` は2桁)
    const digits = fraction.replace('-', '').length;
    return values[0] * 3600 + values[1] * 60 + values[2] + values[3] / 10 ** digits;
}

/** 秒を ASS の時刻にする。100分の1秒まで */
export function assClock(seconds: number): string {
    const total = Math.max(0, Math.round(seconds * 100));
    const cs = total % 100;
    const s = Math.floor(total / 100) % 60;
    const m = Math.floor(total / 6000) % 60;
    const h = Math.floor(total / 360_000);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** 秒を WebVTT の時刻にする。1000分の1秒まで */
export function vttClock(seconds: number): string {
    const total = Math.max(0, Math.round(seconds * 1000));
    const ms = total % 1000;
    const s = Math.floor(total / 1000) % 60;
    const m = Math.floor(total / 60_000) % 60;
    const h = Math.floor(total / 3_600_000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** `Dialogue: 0,開始,終了,Style,Name,L,R,V,Effect,本文` の、本文までの区切り数 */
const FIELDS = 9;

/** 指定 (`{\pos(…)}`) を落として本文だけにする */
function plain(text: string): string {
    return text
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\[Nnh]/g, ' ')
        .trim();
}

/**
 * ffmpeg が出した ASS を読む。
 *
 * 中身の検分はしない — 空も負の時刻もそのまま持ってきて、`cleanAss` で整える
 */
export function parseAss(content: string): Ass {
    const lines = content.split(/\r?\n/);
    const head: string[] = [];
    const cues: Cue[] = [];
    let fontSize = DEFAULT_FONT_SIZE;
    let playResY = DEFAULT_PLAY_RES_Y;
    let started = false;

    for (const line of lines) {
        if (line.startsWith('Dialogue:')) {
            started = true;
            const parts = line.slice('Dialogue:'.length).split(',');
            if (parts.length < FIELDS + 1) continue;
            const start = assTime(parts[1]);
            const end = assTime(parts[2]);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            cues.push({
                start,
                end,
                // 時刻だけ差し替えて書き戻せるように、前後をそのまま持っておく
                layer: parts[0].trim(),
                fields: parts.slice(3, FIELDS).join(','),
                text: parts.slice(FIELDS).join(','),
            });
            continue;
        }
        if (!started) head.push(line);

        const size = /^Style:\s*[^,]*,[^,]*,\s*(\d+(?:\.\d+)?)/.exec(line);
        if (size !== null) fontSize = Number(size[1]);
        const res = /^PlayResY:\s*(\d+)/.exec(line);
        if (res !== null) playResY = Number(res[1]);
    }

    return { head: head.join('\n').replace(/\n+$/, ''), fontSize, playResY, cues };
}

/**
 * 出しっぱなしにならないように整える。
 *
 * - 0 より前は 0 に詰める (負の時刻を書ける入れ物ではない)
 * - **本文の無いものは落とす。** 「消す」の指示なので、そこまでで前の1枚は
 *   終わっている (`-fix_sub_duration` が終わりの時刻を入れてくれている)
 * - 長さの無くなったものも落とす。出しても見えない
 */
export function cleanCues(cues: Cue[]): Cue[] {
    return cues
        .map((cue) => ({ ...cue, start: Math.max(0, cue.start), end: Math.max(0, cue.end) }))
        .filter((cue) => cue.end > cue.start && plain(cue.text) !== '');
}

/** 整えた ASS を書き戻す。字幕が1枚も残らなければ null (字幕の無い番組) */
export function cleanAss(ass: Ass): string | null {
    const cues = cleanCues(ass.cues);
    if (cues.length === 0) return null;
    const body = cues.map(
        (cue) =>
            `Dialogue: ${cue.layer},${assClock(cue.start)},${assClock(cue.end)},${cue.fields},${cue.text}`,
    );
    return `${ass.head}\n${body.join('\n')}\n`;
}

/**
 * ARIB の8色 → WebVTT が元から持っている色の名前。
 *
 * ASS の色は `&HBBGGRR&` で、放送で使うのは8色だけ。WebVTT には同じ8色が
 * `<c.yellow>` の形で最初から入っているので、そのまま渡せば**話者ごとの色分けが残る**
 */
const COLORS = new Map<string, string>([
    ['ffffff', 'white'],
    ['00ffff', 'yellow'],
    ['00ff00', 'lime'],
    ['ffff00', 'cyan'],
    ['0000ff', 'red'],
    ['ff00ff', 'magenta'],
    ['ff0000', 'blue'],
    ['000000', 'black'],
]);

function escapeVtt(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 画面に出る1行。指定を読み解いたもの */
interface Line {
    /** 左端と上端。位置指定が無ければ左端 0・下端 (`lineOf`) */
    x: number;
    y: number;
    /** 文字の大きさ。書いていなければ Style の既定 */
    size: number;
    /** 字と字の間 (`\fsp`) */
    spacing: number;
    color: string | null;
    /** 指定を落とした本文 */
    body: string;
}

/**
 * 本文に書いてある指定を読む。
 *
 * **位置が書いていなければ下端**とみなす。字幕の定位置はそこで、
 * 上に寄せるかどうかの判断 (`toVtt`) が「書いていない = 上」に転ばないようにする
 */
function lineOf(text: string, ass: Ass): Line {
    const color = /\\1c&H([0-9a-fA-F]{6})&/.exec(text);
    const size = /\\fs(\d+(?:\.\d+)?)/.exec(text);
    const spacing = /\\fsp(\d+(?:\.\d+)?)/.exec(text);
    const pos = /\\pos\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(text);
    return {
        x: pos === null ? 0 : Number(pos[1]),
        y: pos === null ? ass.playResY : Number(pos[2]),
        size: size === null ? ass.fontSize : Number(size[1]),
        spacing: spacing === null ? 0 : Number(spacing[1]),
        color: color === null ? null : color[1].toLowerCase(),
        body: plain(text),
    };
}

/**
 * 半分の幅で置かれる文字。ASCII と半角カナ。
 *
 * 放送は同じ字を全角でも半角でも出せて (MSZ)、libaribcaption は半角のほうを
 * **半角の文字そのもの**に直して寄越す (`replace_msz_ascii`)。つまり
 * **字を見れば幅が分かる**
 */
const HALF_WIDTH = /[ -~｡-ﾟ]/;

/** 漢字。ルビが乗るのはここ */
const HAN = /\p{Script=Han}/u;

/** ルビの左端がここまでずれていても同じものとみなす。半文字ぶん */
const SNAP = 0.5;

/** 1文字ぶんの送り */
function advance(char: string, step: number): number {
    return HALF_WIDTH.test(char) ? step / 2 : step;
}

/** 本文の中の漢字の並び。ルビの行き先の候補 */
interface Run {
    /** 何文字目から何文字目まで */
    from: number;
    to: number;
    /** 画面での左端と幅 */
    left: number;
    width: number;
}

function kanjiRuns(line: Line): Run[] {
    const step = line.size + line.spacing;
    const out: Run[] = [];
    let at = line.x;
    let run: Run | null = null;
    for (const [index, char] of [...line.body].entries()) {
        const width = advance(char, step);
        if (HAN.test(char)) {
            if (run === null) run = { from: index, to: index, left: at, width: 0 };
            run.width += width;
            run.to = index + 1;
        } else if (run !== null) {
            out.push(run);
            run = null;
        }
        at += width;
    }
    if (run !== null) out.push(run);
    return out;
}

/** 本文のどこに、どのルビを乗せるか */
interface Mark extends Run {
    text: string;
}

/**
 * ルビを本文に結び付ける。**漢字の並びの上に中央寄せで置かれている**とみて、
 * いちばん近い並びを選ぶ。
 *
 * 放送はルビを「本文の上の行に、その字の上に来るよう置いた独立した行」として
 * 送ってくる。どの字に掛かるかは**座標にしか書いていない**ので、こちらで
 * 突き合わせるほかない。実機の4本で 86個中81個が半文字ぶんの誤差に収まった。
 *
 * **当たらなかったものは捨てます。** 外れたところに振り仮名が付くくらいなら、
 * 付かないほうがまし
 */
function attachRuby(bases: Line[], rubies: Line[]): Map<Line, Mark[]> {
    const marks = new Map<Line, Mark[]>();
    for (const ruby of rubies) {
        const width = [...ruby.body].length * (ruby.size + ruby.spacing);
        let best: { gap: number; base: Line; run: Run } | null = null;
        for (const base of bases) {
            // 掛かるのは**下の行**。ルビは本文の上に置かれる
            if (base.y <= ruby.y) continue;
            for (const run of kanjiRuns(base)) {
                const gap = Math.abs(run.left + (run.width - width) / 2 - ruby.x);
                if (best === null || gap < best.gap) best = { gap, base, run };
            }
        }
        if (best === null || best.gap > (best.base.size + best.base.spacing) * SNAP) continue;
        const list = marks.get(best.base) ?? [];
        list.push({ ...best.run, text: ruby.body });
        marks.set(best.base, list);
    }
    return marks;
}

/** 本文を組み立てる。ルビの掛かるところは `<ruby>` で包む */
function render(line: Line, marks: Mark[]): string {
    const chars = [...line.body];
    let out = '';
    let at = 0;
    for (const mark of [...marks].sort((a, b) => a.from - b.from)) {
        // 重なったら後のほうは捨てる (同じ字に2つは乗らない)
        if (mark.from < at) continue;
        out += escapeVtt(chars.slice(at, mark.from).join(''));
        const base = escapeVtt(chars.slice(mark.from, mark.to).join(''));
        out += `<ruby>${base}<rt>${escapeVtt(mark.text)}</rt></ruby>`;
        at = mark.to;
    }
    return out + escapeVtt(chars.slice(at).join(''));
}

/**
 * WebVTT に直す。
 *
 * **ルビは本文に畳み込みます** (`<ruby>`)。放送は別の行として送ってくるが、
 * そのまま並べると「あかぎ」「(赤木)ニオう…」と2行に割れる。どの字に掛かるかは
 * 座標にしか書いていないので、こちらで突き合わせる (`attachRuby`)。
 *
 * **捨てるのは位置です。上下だけ残す** — 放送の字幕は画面の文字を隠さないよう
 * 上に逃げることがあるので、そこだけ `line:0` で伝える。左右と細かい座標は
 * 捨てる (ブラウザの字幕は行として並ぶもので、座標で置くものではない)
 */
export function toVtt(ass: Ass): string {
    /** 同じ時刻に出るものは1つにまとめる。画面に同時に出る別々の行なので */
    const groups: { start: number; end: number; lines: Line[] }[] = [];
    for (const cue of cleanCues(ass.cues)) {
        const line = lineOf(cue.text, ass);
        const last = groups.at(-1);
        if (last !== undefined && last.start === cue.start && last.end === cue.end) {
            last.lines.push(line);
            continue;
        }
        groups.push({ start: cue.start, end: cue.end, lines: [line] });
    }

    const out = ['WEBVTT', ''];
    for (const group of groups) {
        // 小さい字はルビ。本文と分けてから結び直す
        const rubies = group.lines.filter((line) => line.size < ass.fontSize * RUBY);
        const bases = group.lines.filter((line) => line.size >= ass.fontSize * RUBY);
        if (bases.length === 0) continue;
        const marks = attachRuby(bases, rubies);

        // 上に出ていた行が1つでもあれば上に寄せる。画面の文字を隠さないための位置なので
        const top = bases.some((line) => line.y < ass.playResY / 2);
        const lines = [...bases]
            .sort((a, b) => a.y - b.y)
            .map((line) => {
                const body = render(line, marks.get(line) ?? []);
                const name = line.color === null ? undefined : COLORS.get(line.color);
                // 白はそのまま。既定の色なので包む意味が無い
                return name === undefined || name === 'white' ? body : `<c.${name}>${body}</c>`;
            });
        out.push(`${vttClock(group.start)} --> ${vttClock(group.end)}${top ? ' line:0' : ''}`, ...lines, '');
    }
    return out.join('\n');
}
