import { describe, expect, test } from 'bun:test';
import { DEFAULT_CLUT, readClut } from './clut';
import { parseStylesheet, parseUrl } from './css';
import { BmlDocument } from './document';
import { videoRect } from './render';
import { parseXml } from './xml';

function load(source: string, css = ''): BmlDocument {
    const xml = parseXml(source);
    if (xml === null) throw new Error('読めない');
    const doc = new BmlDocument(xml);
    doc.applyRules(parseStylesheet(css));
    return doc;
}

describe('XML', () => {
    test('寛容に読む: 閉じ忘れ・実体参照・CDATA・DOCTYPE・前置き', () => {
        const xml = parseXml(
            '<?xml version="1.0" encoding="EUC-JP"?><!DOCTYPE bml PUBLIC "x" "y"><bml><body><bml:p a="&quot;q&quot;" b=raw>A &amp; B &unknown;<![CDATA[<raw>]]></bml:p><div></body></bml>',
        );
        expect(xml?.name).toBe('bml');
        const body = xml?.children[0];
        expect(body?.kind === 'element' && body.name).toBe('body');
        const p = body?.kind === 'element' ? body.children[0] : undefined;
        expect(p?.kind === 'element' && p.name).toBe('p');
        if (p?.kind !== 'element') throw new Error();
        expect(p.attrs.get('a')).toBe('"q"');
        expect(p.attrs.get('b')).toBe('raw');
        expect(p.children.map((c) => (c.kind === 'text' ? c.text : ''))).toEqual([
            'A & B &unknown;',
            '<raw>',
        ]);
    });

    test('script の中の < はタグにしない', () => {
        const xml = parseXml('<bml><head><script>if (a < b) x();</script></head></bml>');
        const script = xml?.children[0]?.kind === 'element' ? xml.children[0].children[0] : undefined;
        expect(
            script?.kind === 'element' && script.children[0]?.kind === 'text' && script.children[0].text,
        ).toBe('if (a < b) x();');
    });
});

describe('文字の空白 (付属2 5.3.2)', () => {
    test('頭と尻と、2 バイト文字どうしのあいだの改行は消える', () => {
        const doc = load('<bml><body><p id="p">\n  天気\n  予報  \n</p></body></bml>');
        const p = doc.getElementById('p');
        expect(p?.children[0]?.kind === 'text' && p.children[0].data).toBe('天気予報');
    });

    test('span の前後は空白 1 つに', () => {
        const doc = load('<bml><body><p id="p">A\n<span>B</span>\nC</p></body></bml>');
        const texts = doc
            .getElementById('p')!
            .children.map((c) => (c.kind === 'text' ? c.data : `[${c.tag}]`));
        expect(texts).toEqual(['A ', '[span]', ' C']);
    });

    test('空の p・span・a も文字を 1 つ持つ (スクリプトが firstChild.data に書く先)', () => {
        const doc = load(
            '<bml><body><p id="empty"></p><p id="blank">\n   \n</p><p id="cdata"><![CDATA[]]></p><p id="self"/><p id="wrap"><span id="s"></span></p><a id="a" href="x.bml"></a><div id="d"></div></body></bml>',
        );
        for (const id of ['empty', 'blank', 'cdata', 'self', 's', 'a']) {
            const children = doc.getElementById(id)!.children;
            expect(children.length).toBe(1);
            expect(children[0]?.kind === 'text' && children[0].data).toBe('');
        }
        // 中に要素があれば足さない (firstChild は span のまま)。div は字を持たない
        expect(doc.getElementById('wrap')!.children.map((c) => c.kind)).toEqual(['element']);
        expect(doc.getElementById('d')!.children).toEqual([]);
    });

    test('実体参照で書いた空白は詰めない', () => {
        const doc = load('<bml><body><p id="p">&#x20;</p><p id="q">\n&#32;&#x3000;\n</p></body></bml>');
        const text = (id: string) => {
            const first = doc.getElementById(id)!.children[0];
            return first?.kind === 'text' ? first.data : null;
        };
        expect(text('p')).toBe(' ');
        expect(text('q')).toBe(' 　');
    });
});

describe('CSS', () => {
    test('使える単純セレクタだけ読み、子孫と @ 規則は読み飛ばす', () => {
        const rules = parseStylesheet(
            '@charset "EUC-JP"; /* x */ p.a { color-index: 3 } div p { left: 9px } #b, * { top: 1px } a:focus { color-index: 5 }',
        );
        expect(
            rules.map((r) => [r.selector.tag, r.selector.id, r.selector.classes, r.selector.pseudo]),
        ).toEqual([
            ['p', null, ['a'], null],
            [null, 'b', [], null],
            [null, null, [], null],
            ['a', null, [], 'focus'],
        ]);
    });

    test('行の頭の div:focus・p:focus は規則として読む (BS日テレの書き方)', () => {
        const rules = parseStylesheet(
            'p { color-index: 1 }\ndiv:focus { color-index: 2 }\np:focus{color-index:3}\n',
        );
        expect(rules.map((r) => [r.selector.tag, r.selector.pseudo, r.declarations])).toEqual([
            ['p', null, [['color-index', '1', false]]],
            ['div', 'focus', [['color-index', '2', false]]],
            ['p', 'focus', [['color-index', '3', false]]],
        ]);
    });

    test('閉じ忘れ・閉じすぎは壊れた所だけ捨て、後ろの規則は読む', () => {
        // a の } が抜けている: a は区切りまで読み、div:focus から読み直す。余った } の後ろの p も読む
        const rules = parseStylesheet(
            'a { color-index: 1;\ndiv:focus { color-index: 2 } } p { left: 3px }\nspan{top:4px}',
        );
        expect(rules.map((r) => [r.selector.tag, r.selector.pseudo, r.declarations])).toEqual([
            ['a', null, [['color-index', '1', false]]],
            ['div', 'focus', [['color-index', '2', false]]],
            ['p', null, [['left', '3px', false]]],
            ['span', null, [['top', '4px', false]]],
        ]);
        // 区切りが無いまま次の { が来たら、壊れた所 (a の中身と b) だけ捨てる
        const broken = parseStylesheet('a { color-index: 1 b { left: 2px } p { top: 3px }');
        expect(broken.map((r) => [r.selector.tag, r.declarations.length])).toEqual([
            ['a', 0],
            ['p', 1],
        ]);
        // @ 規則の入れ子は今までどおり丸ごと読み飛ばす
        expect(
            parseStylesheet('@media tv { p { left: 1px } } div { top: 2px }').map((r) => r.selector.tag),
        ).toEqual(['div']);
    });

    test('url() を解く', () => {
        expect(parseUrl('url("/40/0001/a.clt")')).toBe('/40/0001/a.clt');
        expect(parseUrl('url( b.png )')).toBe('b.png');
        expect(parseUrl('none')).toBeNull();
    });

    test('重ね合わせ: 詳細度・順番・style 属性・継承・inherit・!important', () => {
        const doc = load(
            '<bml><body><div id="d" class="c" style="left: 30px; top: 7"><p id="p" class="k" style="font-size: inherit">x<span id="s">y</span></p></div></body></bml>',
            '#d { left: 10px !important; width: 100px; color-index: 4 } .c { left: 20px; width: 50px } div { width: 70px } p.k { font-size: 30px } div { font-size: 20px; grayscale-color-index: 1\t 2 }',
        );
        const d = doc.getElementById('d')!.style();
        expect([d.left, d.top, d.width]).toEqual([10, 7, 100]);
        const p = doc.getElementById('p')!.style();
        expect(p.colorIndex).toBe(4);
        expect(p.fontSize).toBe(20);
        // p は既定の 30 15 を持つので継がない。div はタブと空白 2 つで区切っても読む
        expect(p.grayscale).toEqual([30, 15]);
        expect(d.grayscale).toEqual([1, 2]);
        expect(doc.getElementById('s')!.style().colorIndex).toBe(4);
    });

    test('フォーカス中は :focus と focusStyle が重なる', () => {
        const doc = load(
            '<bml><body><p id="p">x</p></body></bml>',
            'p { color-index: 1 } p:focus { color-index: 2 }',
        );
        const p = doc.getElementById('p')!;
        expect(p.style().colorIndex).toBe(1);
        p.setState('focus');
        expect(p.style().colorIndex).toBe(2);
        p.inline.focus.set('color-index', '3');
        p.document.touch();
        expect(p.style().colorIndex).toBe(3);
        expect(p.styleIn('normal').colorIndex).toBe(1);
    });

    test('値は確かめる: 数でないもの・範囲の外は既定に', () => {
        const doc = load(
            '<bml><body><div id="d" style="left: 1em; color-index: 300; nav-index: 506"></div></body></bml>',
        );
        const d = doc.getElementById('d')!.style();
        expect(d.left).toBe(0);
        expect(d.colorIndex).toBe(7);
        expect(d.navIndex).toBe(506);
    });
});

describe('映像の場所', () => {
    test('祖先の位置と枠を足し、親のはみ出しで切る', () => {
        const doc = load(
            '<bml><body><div style="left:100px;top:50px;width:200px;height:100px;border-width:2px;border-style:solid"><object type="video/X-arib-mpeg2" style="left:10px;top:20px;width:300px;height:60px"/></div></body></bml>',
        );
        expect(videoRect(doc)?.rect).toEqual({ left: 112, top: 72, width: 190, height: 60 });
    });

    test('隠れていれば無い', () => {
        const doc = load(
            '<bml><body><object type="video/X-arib-mpeg2" style="left:0px;top:0px;width:10px;height:10px;visibility:hidden"/></body></bml>',
        );
        expect(videoRect(doc)).toBeNull();
    });
});

describe('CLUT', () => {
    test('既定の表 (規則で作る)', () => {
        expect(DEFAULT_CLUT[1]).toEqual([255, 0, 0, 255]);
        expect(DEFAULT_CLUT[8]).toEqual([0, 0, 0, 0]);
        expect(DEFAULT_CLUT[15]).toEqual([0xaa, 0xaa, 0xaa, 255]);
        expect(DEFAULT_CLUT[16]).toEqual([0, 0, 0x55, 255]);
        expect(DEFAULT_CLUT[64]).toEqual([0xff, 0xff, 0xaa, 255]);
        expect(DEFAULT_CLUT[65]).toEqual([0, 0, 0, 0x80]);
        expect(DEFAULT_CLUT[73]).toEqual([0xaa, 0, 0, 0x80]);
        expect(DEFAULT_CLUT[127]).toEqual([0xff, 0xff, 0x55, 0x80]);
    });

    test('CLUT のファイルで 17 番から差し替える (YCbCr)', () => {
        // type=0 depth=1 region=0 start_end=1、17〜17 を Y=235 Cb=128 Cr=128 (白) A=255
        const table = readClut(Uint8Array.of(0x28, 17, 17, 235, 128, 128, 255));
        expect(table[17]).toEqual([254, 254, 254, 255]);
        expect(table[16]).toEqual(DEFAULT_CLUT[16]!);
    });
});

describe('見直しで足したもの', () => {
    test('閉じない br は後ろを飲み込まない。script の CDATA は幾つあってもつなぐ', () => {
        const doc = load(
            '<bml><head><script><![CDATA[a();]]><!-- x --><![CDATA[b();]]></script></head><body><p id="p">A<br>B</p></body></bml>',
        );
        expect(doc.getElementById('p')!.children.map((c) => (c.kind === 'text' ? c.data : c.tag))).toEqual([
            'A',
            'br',
            'B',
        ]);
        expect(doc.elements('script')[0]!.text).toBe('a();b();');
    });

    test(':focus の規則も詳細度で重ねる (#id は p:focus に勝つ)', () => {
        const doc = load(
            '<bml><body><p id="a">x</p></body></bml>',
            '#a { color-index: 2 } p:focus { color-index: 1; font-size: 30px }',
        );
        const p = doc.getElementById('a')!;
        p.setState('focus');
        expect([p.style().colorIndex, p.style().fontSize]).toEqual([2, 30]);
    });

    test('div と object の padding は 0、継がない特性の inherit は親の値、枠の線は列挙だけ', () => {
        const doc = load(
            '<bml><body><div id="d" style="padding:9px;background-color-index:4"><div id="c" style="background-color-index:inherit;border-style:solid;color:red"></div><p id="p" style="border-style:x;url(y)"></p></div></body></bml>',
        );
        expect(doc.getElementById('d')!.style().padding).toEqual([0, 0, 0, 0]);
        expect(doc.getElementById('c')!.style().backgroundColorIndex).toBe(4);
        expect(doc.getElementById('c')!.style().borderStyle).toBe('solid');
        expect(doc.getElementById('p')!.style().borderStyle).toBe('none');
    });
});
