import { describe, expect, test } from 'bun:test';
import { DRCS_REPLACE } from './b24-tables';
import { B24CaptionDecoder } from './b24caption';
import { drcsUnit, encodeAribText, management, statement, text, unit } from './synth-caption';

/** CSI の並び。`csi('170;30', 0x5f)` は SDP */
const csi = (params: string, final: number) => [
    0x9b,
    ...[...params].map((c) => c.charCodeAt(0)),
    0x20,
    final,
];
/** APS (行, 桁) */
const aps = (row: number, col: number) => [0x1c, 0x40 | row, 0x40 | col];

/** 放送でよく見る頭。960x540・表示区画 620x480 を (170,30) に・36ドット・字間4・行間24 */
const HEAD = [
    ...csi('7', 0x53), // SWF
    ...csi('620;480', 0x56), // SDF
    ...csi('170;30', 0x5f), // SDP
    ...csi('36;36', 0x57), // SSM
    ...csi('4', 0x58), // SHS
    ...csi('24', 0x59), // SVS
];

function decoder(): B24CaptionDecoder {
    const decoder = new B24CaptionDecoder();
    expect(decoder.decode(management())).toBeNull();
    return decoder;
}

describe('B24CaptionDecoder', () => {
    test('置き場所は libaribcaption と同じ計算 (区画・字の枠・面)', () => {
        const page = decoder().decode(text([...HEAD, ...aps(3, 2), ...encodeAribText('字幕')]));
        expect(page).toEqual({
            v: 1,
            plane: [960, 540],
            duration: null,
            runs: [
                {
                    // 区画 40x60。APS(3行, 2桁) → x = 170 + 2×40、下端 = 30 + 4×60
                    x: 250,
                    y: 210,
                    w: 40,
                    h: 60,
                    fx: 2,
                    fy: 12,
                    size: 36,
                    scaleX: 1,
                    text: '字幕',
                    fg: '#ffffffff',
                    bg: '#00000000',
                },
            ],
        });
    });

    test('中くらい (MSZ): 英数は半角の字にして縮めない、漢字は横を半分に縮める', () => {
        const page = decoder().decode(text([...HEAD, ...aps(0, 0), 0x89, ...encodeAribText('AB字')]));
        expect(page?.runs.map((r) => [r.x, r.w, r.text, r.scaleX])).toEqual([
            [170, 20, 'AB', 1],
            [210, 20, '字', 0.5],
        ]);
    });

    test('色・縁取り・囲み・下線・点滅・ルビは並びを分けて持つ', () => {
        const page = decoder().decode(
            text([
                ...HEAD,
                ...aps(1, 0),
                0x81, // RDF
                0x90,
                0x50 | 0x04, // 背景を青
                ...encodeAribText('赤'),
                0x87, // WHF
                ...csi('1;7', 0x63), // ORN 縁取り 黒 (組0の0)… p2 = 7 → 組0の7 (白)
                0x97,
                0x4f, // HLC 四方
                0x9a, // STL
                0x91,
                0x40, // FLC 点滅
                ...encodeAribText('白'),
                0x88, // SSZ
                ...encodeAribText('る'),
            ]),
        );
        const [red, white, ruby] = page?.runs ?? [];
        expect(red).toMatchObject({ text: '赤', fg: '#ff0000ff', bg: '#0000ffff' });
        expect(red?.stroke).toBeUndefined();
        expect(white).toMatchObject({
            text: '白',
            fg: '#ffffffff',
            stroke: '#ffffffff',
            box: 15,
            underline: true,
            flash: true,
        });
        expect(ruby).toMatchObject({ text: 'る', size: 18, w: 20, h: 30, ruby: true });
    });

    test('CS だけなら「消す」1枚、待ち (TIME) だけなら何も出さない', () => {
        const d = decoder();
        expect(d.decode(text([0x0c]))).toEqual({ v: 1, plane: [960, 540], duration: null, runs: [] });
        expect(d.decode(text([0x9d, 0x20, 0x40 | 30]))).toBeNull();
    });

    test('待ち (TIME) のある字幕は出しておく長さを持つ', () => {
        const page = decoder().decode(
            text([...HEAD, ...aps(0, 0), ...encodeAribText('字'), 0x9d, 0x20, 0x40 | 25]),
        );
        expect(page?.duration).toBe(2500);
    });

    test('APR で次の行の頭へ。束ねるのは同じ行で続いているものだけ', () => {
        const page = decoder().decode(
            text([...HEAD, ...aps(0, 3), ...encodeAribText('一'), 0x0d, ...encodeAribText('二')]),
        );
        expect(page?.runs.map((r) => [r.x, r.y, r.text])).toEqual([
            [290, 30, '一'],
            [170, 90, '二'],
        ]);
    });

    test('置き換えられない外字は絵のまま送る (1画素1ビット)', () => {
        const rows = [
            '#.......',
            '.#......',
            '..#.....',
            '...#....',
            '....#...',
            '.....#..',
            '......#.',
            '.......#',
        ];
        const page = decoder().decode(
            statement([
                ...drcsUnit(0x21, rows),
                ...unit(0x20, [...HEAD, ...aps(0, 0), 0x1b, 0x28, 0x20, 0x41, 0x21]),
            ]),
        );
        expect(page?.runs).toHaveLength(1);
        const run = page?.runs[0];
        expect(run).toMatchObject({ text: '〓', drcs: String((1 << 16) | 0x21) });
        expect(page?.drcs?.[run?.drcs ?? '']).toEqual({
            w: 8,
            h: 8,
            depth: 2,
            bits: 1,
            data: Buffer.from([0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01]).toString('base64'),
        });
    });

    test('外字の置き換え表には denpa で足した分も入っている', () => {
        expect(DRCS_REPLACE.get('dedbee40c06e17b51932431dc8cd8334')).toBe(0x8fc2);
        expect(DRCS_REPLACE.get('c7b93e8e27f686cbeeb88e871c17327c')).toBe(0x300a);
    });

    test('追加記号 (90区〜) は Unicode の字にする', () => {
        // 90区 48点 は「[字]」の囲み文字 (U+1F228 ではなく libaribcaption の表のとおり)
        const page = decoder().decode(text([...HEAD, ...aps(0, 0), 0x1b, 0x24, 0x3b, 0x7a, 0x50]));
        expect(page?.runs[0]?.text.codePointAt(0)).toBeGreaterThan(0x2000);
    });

    test('同じ群の字幕管理データは送り直しとして読まない (書式を巻き戻さない)', () => {
        const d = decoder();
        // 1920x1080 に切り替えたあと、同じ群の管理データが来ても 960x540 に戻さない
        expect(d.decode(text([...csi('5', 0x53), ...aps(0, 0), ...encodeAribText('字')]))?.plane).toEqual([
            1920, 1080,
        ]);
        expect(d.decode(management())).toBeNull();
        expect(d.decode(text([...aps(0, 0), ...encodeAribText('字')]))?.plane).toEqual([1920, 1080]);
        // 群が替われば読み直す
        expect(d.decode(management({ group: 1 }))).toBeNull();
        expect(d.decode(text([...aps(0, 0), ...encodeAribText('字')]))?.plane).toEqual([960, 540]);
    });

    test('壊れた並びでは止まるが、そこまでの字は出す', () => {
        // 0xFF は図形でも制御でもない
        const page = decoder().decode(
            text([...HEAD, ...aps(0, 0), ...encodeAribText('字'), 0xff, ...encodeAribText('幕')]),
        );
        expect(page?.runs.map((r) => r.text)).toEqual(['字']);
    });

    test('字幕ではない PES (データ識別が違う) は読まない', () => {
        const data = text(encodeAribText('字'));
        data[0] = 0x81;
        expect(decoder().decode(data)).toBeNull();
    });
});
