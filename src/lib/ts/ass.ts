/**
 * 文字で取り出した ARIB字幕 (ASS) を読んで整える。**DOM を触らない。**
 *
 * 焼いたものに入れる字幕は PGS (絵) のままです ([encode.md](../../../docs/encode.md))。
 * ここが作るのは**その隣に置く文字の付き添い** (`<動画名>.ja.ass`) で、
 * 行き先は WebDAV 越しの Kodi です。
 *
 * **ブラウザには文字を渡しません。** 一度は WebVTT に直して `<track>` へ渡す道も
 * 通しましたが、放送どおりには出ませんでした — 左右の位置も、背景の箱も、
 * 外字も落ちる。いまは絵 (PGS) をそのまま渡して denpa 自身が解いています
 * ([pgs.ts](../pgs.ts) の `readSup`)。**ルビもそちらには最初から入っています。**
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
 * ルビは**位置指定つきの独立した Dialogue**として出てきます。Kodi は座標どおりに
 * 乗せるので、こちらは触りません
 */

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
