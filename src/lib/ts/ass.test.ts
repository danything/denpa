import { describe, expect, it } from 'bun:test';
import { assClock, assTime, cleanAss, cleanCues, parseAss, toVtt, vttClock } from './ass';

/** 実機の ffmpeg が出したものをそのまま (本好きの下剋上・冒頭) */
const HEAD = `[Script Info]
ScriptType: v4.00+
PlayResX: 960
PlayResY: 540
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,sans-serif,36,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,4,0,4,2,10,10,10,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

const SAMPLE = `${HEAD}
Dialogue: 0,0:00:10.28,0:00:12.32,Default,,0,0,0,,{\\an7}{\\pos(220,389)}{\\fsp4}{\\bord3}{\\1c&H00ffff&}(きむら)新！｢リセッシュ｣！
Dialogue: 0,0:00:10.28,0:00:12.32,Default,,0,0,0,,{\\an7}{\\pos(220,449)}{\\fsp4}{\\bord3}{\\1c&H00ffff&}ジャケットから 汗のニオイ｡
Dialogue: 0,0:00:12.32,0:00:14.36,Default,,0,0,0,,{\\an7}{\\pos(140,359)}{\\fsp4}{\\bord3}{\\1c&H00ffff&}でも 自分じゃ気づけなくて当たり前｡
Dialogue: 0,0:00:12.32,0:00:14.36,Default,,0,0,0,,{\\an7}{\\pos(160,419)}{\\fs18}{\\fsp2}{\\bord3}{\\1c&H00ff00&}あかぎ
Dialogue: 0,0:00:12.32,0:00:14.36,Default,,0,0,0,,{\\an7}{\\pos(140,449)}{\\fsp4}{\\bord3}{\\1c&H00ff00&}(赤木)ニオう… えっ…｡
Dialogue: 0,0:00:14.36,0:00:16.40,Default,,0,0,0,,
`;

describe('ASS の時刻', () => {
    it('部品ごとに符号が付いていても読める', () => {
        expect(assTime('0:00:10.28')).toBeCloseTo(10.28, 5);
        expect(assTime('1:02:03.50')).toBeCloseTo(3723.5, 5);
        // 引きすぎたとき ffmpeg が書く形。足し合わせれば -9.32 になる
        expect(assTime('0:00:-9.-32')).toBeCloseTo(-9.32, 5);
        expect(assTime('こわれている')).toBeNaN();
    });

    it('書き戻すと同じ形になる', () => {
        expect(assClock(10.28)).toBe('0:00:10.28');
        expect(assClock(3723.5)).toBe('1:02:03.50');
        // 負は 0 に詰める。負を書ける入れ物ではない
        expect(assClock(-9.32)).toBe('0:00:00.00');
    });

    it('WebVTT は 1000分の1秒まで', () => {
        expect(vttClock(10.28)).toBe('00:00:10.280');
        expect(vttClock(3723.5)).toBe('01:02:03.500');
    });
});

describe('ffmpeg の出した ASS を読む', () => {
    it('本文の大きさと画面の高さを拾う', () => {
        const ass = parseAss(SAMPLE);
        expect(ass.fontSize).toBe(36);
        expect(ass.playResY).toBe(540);
        expect(ass.cues).toHaveLength(6);
        expect(ass.cues[0].start).toBeCloseTo(10.28, 5);
        expect(ass.cues[0].text).toContain('リセッシュ');
    });

    it('書いていないときは既定に落ちる', () => {
        const ass = parseAss('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,あ');
        expect(ass.fontSize).toBe(36);
        expect(ass.playResY).toBe(540);
        expect(ass.cues).toHaveLength(1);
    });
});

describe('出しっぱなしにならないように整える', () => {
    it('本文の無いものは落とす。「消す」の指示なので', () => {
        const cues = cleanCues(parseAss(SAMPLE).cues);
        expect(cues).toHaveLength(5);
        expect(cues.every((cue) => cue.text !== '')).toBe(true);
    });

    it('0 より前は 0 に詰め、長さの無くなったものは落とす', () => {
        const cues = cleanCues([
            { start: -2, end: 1.5, layer: '0', fields: 'Default,,0,0,0,', text: 'のこる' },
            { start: -2, end: -1, layer: '0', fields: 'Default,,0,0,0,', text: 'きえる' },
        ]);
        expect(cues).toHaveLength(1);
        expect(cues[0].start).toBe(0);
        expect(cues[0].text).toBe('のこる');
    });

    it('書き戻したものは頭がそのままで、空が消えている', () => {
        const out = cleanAss(parseAss(SAMPLE)) ?? '';
        expect(out.startsWith(HEAD)).toBe(true);
        const dialogues = out.split('\n').filter((line) => line.startsWith('Dialogue:'));
        expect(dialogues).toHaveLength(5);
        expect(dialogues[0]).toBe(
            'Dialogue: 0,0:00:10.28,0:00:12.32,Default,,0,0,0,,{\\an7}{\\pos(220,389)}{\\fsp4}{\\bord3}{\\1c&H00ffff&}(きむら)新！｢リセッシュ｣！',
        );
    });

    /** 字幕の無い番組。全部「消す」だけで来る (実機: 鬼の花嫁は18枚すべてが空) */
    it('1枚も残らなければ null', () => {
        const empty = `${HEAD}
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,
Dialogue: 0,0:00:12.00,0:00:14.00,Default,,0,0,0,,
`;
        expect(cleanAss(parseAss(empty))).toBeNull();
    });
});

describe('WebVTT に直す', () => {
    const vtt = toVtt(parseAss(SAMPLE));

    it('WEBVTT で始まる', () => {
        expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    });

    it('同じ時刻に出るものは1つにまとめる', () => {
        expect(vtt).toContain(
            '00:00:10.280 --> 00:00:12.320\n<c.yellow>(きむら)新！｢リセッシュ｣！</c>\n<c.yellow>ジャケットから 汗のニオイ｡</c>',
        );
    });

    /**
     * 放送はルビを独立した行として送ってくる。そのまま並べると2行に割れるので、
     * 座標から掛かる字を探して本文に畳み込む
     */
    it('ルビは本文に畳み込む', () => {
        expect(vtt).toContain('<c.lime>(<ruby>赤木<rt>あかぎ</rt></ruby>)ニオう… えっ…｡</c>');
        // 独立した行としては出さない
        expect(vtt).not.toContain('\nあかぎ\n');
    });

    /** 空の枚は「そこで消す」の意味なので、終わりの時刻としてだけ残る */
    it('「消す」だけの枚は出さない', () => {
        expect(vtt).not.toContain('00:00:14.360 -->');
        expect(vtt).toContain('--> 00:00:14.360');
    });

    it('上に出ていたものは上に寄せる', () => {
        const upper = `${HEAD}
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}{\\pos(140,60)}うえ
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an7}{\\pos(140,449)}した
`;
        const out = toVtt(parseAss(upper));
        expect(out).toContain('00:00:01.000 --> 00:00:02.000 line:0');
        expect(out).toContain('00:00:03.000 --> 00:00:04.000\n');
        expect(out).not.toContain('00:00:03.000 --> 00:00:04.000 line:0');
    });

    it('印になる文字はそのまま出さない', () => {
        const marks = `${HEAD}
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}<a>&いろは
`;
        expect(toVtt(parseAss(marks))).toContain('&lt;a&gt;&amp;いろは');
    });

    /** 実機で拾ったもの。1行に2つ乗る・半角が混ざる・中央寄せになる、が全部入っている */
    it('1行に2つ乗っても、それぞれの字に付く', () => {
        const two = `${HEAD}
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}{\\pos(120,419)}{\\fs18}{\\fsp2}なかの
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}{\\pos(220,419)}{\\fs18}{\\fsp2}いっぺい
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}{\\pos(100,449)}{\\fsp4}(仲野)一平ちゃんから
`;
        expect(toVtt(parseAss(two))).toContain(
            '(<ruby>仲野<rt>なかの</rt></ruby>)<ruby>一平<rt>いっぺい</rt></ruby>ちゃんから',
        );
    });

    /** ルビのほうが長いと本文より左から始まる。中央寄せなので */
    it('本文より長いルビでも当たる', () => {
        const wide = `${HEAD}
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}{\\pos(80,419)}{\\fs18}{\\fsp2}きゅうきゅうにょりつりょう
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}{\\pos(100,449)}{\\fsp4}急急如律令｡
`;
        expect(toVtt(parseAss(wide))).toContain(
            '<ruby>急急如律令<rt>きゅうきゅうにょりつりょう</rt></ruby>｡',
        );
    });

    /** 外れたところに振り仮名が付くくらいなら、付かないほうがまし */
    it('どの字とも合わないルビは捨てる', () => {
        const stray = `${HEAD}
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}{\\pos(700,419)}{\\fs18}{\\fsp2}さくま
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an7}{\\pos(100,449)}{\\fsp4}(目黒)
`;
        const out = toVtt(parseAss(stray));
        expect(out).toContain('(目黒)');
        expect(out).not.toContain('さくま');
    });

    it('白は包まない。既定の色なので', () => {
        const white = `${HEAD}
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\1c&Hffffff&}しろ
`;
        expect(toVtt(parseAss(white))).toContain('00:00:01.000 --> 00:00:02.000\nしろ');
    });
});
