import { describe, expect, test } from 'bun:test';
import { decodeAribText } from './aribtext';
import { EPG_ONLY, GAIJI } from './aribtext-gaiji';
import { ADDITIONAL } from './b24-tables';

/** 読みやすさのために、バイト列を組み立てる小道具 */
const bytes = (...values: number[]) => Uint8Array.from(values);

describe('ARIB 8単位符号', () => {
    test('初期状態の GL は漢字。区点をそのまま2バイトで読む', () => {
        // 日 = 38区72点 → 0x46,0x7C / 本 = 43区60点 → 0x4B,0x5C
        expect(decodeAribText(bytes(0x46, 0x7c, 0x4b, 0x5c))).toBe('日本');
    });

    test('初期状態の GR はひらがな。最上位が立っているほうを引く', () => {
        // ぁ が 0x21 なので あ は 0x22。GR なので 0x80 を足す
        expect(decodeAribText(bytes(0xa2, 0xa4, 0xa6))).toBe('あいう');
    });

    test('ESC で G0 を英数に差し替えられる', () => {
        expect(decodeAribText(bytes(0x1b, 0x28, 0x4a, 0x41, 0x42, 0x43))).toBe('ABC');
    });

    test('ESC 0x24 は G0 への2バイト集合の指示', () => {
        // いったん英数にしてから漢字へ戻す
        const data = bytes(0x1b, 0x28, 0x4a, 0x41, 0x1b, 0x24, 0x42, 0x46, 0x7c);
        expect(decodeAribText(data)).toBe('A日');
    });

    test('SS2 は1文字だけ G2 を使い、すぐ戻る', () => {
        // 漢字 → (SS2)あ → 漢字
        expect(decodeAribText(bytes(0x46, 0x7c, 0x19, 0x22, 0x4b, 0x5c))).toBe('日あ本');
    });

    test('LS1 は GL を G1 (英数) に切り替えたままにする', () => {
        expect(decodeAribText(bytes(0x0e, 0x41, 0x42, 0x0f, 0x46, 0x7c))).toBe('AB日');
    });

    test('カタカナ集合と半角カナ集合', () => {
        expect(decodeAribText(bytes(0x1b, 0x28, 0x31, 0x21, 0x22, 0x23))).toBe('ァアィ');
        expect(decodeAribText(bytes(0x1b, 0x28, 0x49, 0x21, 0x31))).toBe('｡ｱ');
    });

    test('かなの末尾は句読点。ひらがなとカタカナで共通', () => {
        expect(decodeAribText(bytes(0xfa, 0xfb, 0xfc))).toBe('。「」');
    });

    /**
     * **番組表でいちばん効くところ。** 「🈟」「🈑」が読めないと、
     * 番組名から印だけが黙って消える
     */
    test('外字。90区の記号は規格の字 (囲み文字) にする', () => {
        expect(decodeAribText(bytes(0x7a, 0x56))).toBe('🈑');
        expect(decodeAribText(bytes(0x7a, 0x6b, 0x7a, 0x6a))).toBe('🈟🈞');
    });

    test('追加記号の集合を明示的に指示しても同じ表を引く', () => {
        expect(decodeAribText(bytes(0x1b, 0x24, 0x3b, 0x7a, 0x56))).toBe('🈑');
    });

    /** 市販のテレビと同じく、寄せずにそのまま出す。探すときの寄せは `fold.ts` */
    test('規格の字のまま出す。似た字に寄せない', () => {
        // 85区2点・15点 (つちよし)・39点 (互換漢字の恵)
        expect(decodeAribText(bytes(0x75, 0x22, 0x75, 0x2f))).toBe('𠅘𠮷');
        expect(decodeAribText(bytes(0x75, 0x47))).toBe(String.fromCodePoint(0xfa6b));
        // 93区16点 (野球)・67点 (雪だるま)・70・71点・76・77点
        expect(decodeAribText(bytes(0x7d, 0x30, 0x7d, 0x63))).toBe('⚾⛄');
        expect(decodeAribText(bytes(0x7d, 0x66, 0x7d, 0x67, 0x7d, 0x6c, 0x7d, 0x6d))).toBe('⛉⛊⛋⨀');
        // 93区48点 (2分の1)・94区33点 (括弧の A)
        expect(decodeAribText(bytes(0x7d, 0x50, 0x7e, 0x41))).toBe('½🄐');
    });

    test('私用領域にしかない字 (92区56点〜) だけは文字列に開く', () => {
        expect(decodeAribText(bytes(0x7c, 0x58))).toBe('(vn)');
    });

    /** 外字は字幕と同じ表 (`ADDITIONAL`) から作る。番組表で違えてよいのは、字幕の表が私用領域か空きの点だけ */
    test('外字の表は字幕の表と同じ字。違えるのは私用領域と空きだけ', () => {
        const additional = [...ADDITIONAL];
        const at = (code: number) => additional[((code >> 8) - 0x20 - 85) * 94 + (code & 0xff) - 0x21] ?? '';
        for (const code of EPG_ONLY.keys()) {
            const cp = at(code).codePointAt(0) ?? 0;
            expect([code.toString(16), cp === 0xfffd || (cp >= 0xe000 && cp <= 0xf8ff)]).toEqual([
                code.toString(16),
                true,
            ]);
        }
        for (const [code, text] of GAIJI) {
            if (EPG_ONLY.has(code)) continue;
            expect([code.toString(16), text]).toEqual([code.toString(16), at(code)]);
        }
        // 空きの点は持たない (aribtext.ts が「□」にする)
        expect(GAIJI.has(0x7e7e)).toBe(false);
        expect(decodeAribText(bytes(0x7d, 0x4e, 0x7d, 0x77))).toBe('・　');
    });

    test('改行。CR に続く LF は1回にまとめる', () => {
        expect(decodeAribText(bytes(0x46, 0x7c, 0x0d, 0x0a, 0x4b, 0x5c))).toBe('日\n本');
        expect(decodeAribText(bytes(0x46, 0x7c, 0x0a, 0x4b, 0x5c))).toBe('日\n本');
    });

    test('色や大きさの指定は読み飛ばす。引数の数を間違えると以降が全部ずれる', () => {
        // 0x80 (黒) は引数なし / 0x91 (前景色) は1つ / 0x9d (時刻) は2つ
        const data = bytes(0x80, 0x46, 0x7c, 0x91, 0x40, 0x4b, 0x5c, 0x9d, 0x20, 0x30, 0x46, 0x7c);
        expect(decodeAribText(data)).toBe('日本日');
    });

    test('CSI は終端バイトまで読み飛ばす', () => {
        // CSI 1;2 S (SWF) のあとに文字が続く
        expect(decodeAribText(bytes(0x9b, 0x31, 0x3b, 0x32, 0x53, 0x46, 0x7c))).toBe('日');
    });

    test('空白は半角にする。GR 側の 0xA0 も同じ', () => {
        expect(decodeAribText(bytes(0x20, 0xa0))).toBe('  ');
    });

    /**
     * 電波は落ちる。1つの記述子が読めなくても、読めたところまでは番組表に出したい。
     * ここで例外を投げると、その局の番組が丸ごと消える
     */
    test('途中で切れていても、読めたところまで返す', () => {
        expect(decodeAribText(bytes(0x46, 0x7c, 0x4b))).toBe('日');
        expect(decodeAribText(bytes(0x1b))).toBe('');
        expect(decodeAribText(bytes(0x1b, 0x24))).toBe('');
    });

    test('90・91区の記号は規格の字にする。EUC-JP の IBM 拡張漢字に化けない', () => {
        // 90区1点 (事故)・91区17点 (温泉)・91区43点 (電話)
        expect(decodeAribText(bytes(0x7a, 0x21, 0x7b, 0x31, 0x7b, 0x4b))).toBe('⛌♨☎');
        // 89区は規格で空き。EUC-JP なら「纊」になるところ
        expect(decodeAribText(bytes(0x79, 0x21))).toBe('□');
    });

    test('のちの版で足された外字も読む', () => {
        // 85区47点・86区1点 (漢字)、93区26点 (亀甲括弧の S)、93区39点 (リットル)
        expect(decodeAribText(bytes(0x75, 0x4f, 0x76, 0x21, 0x7d, 0x3a, 0x7d, 0x47))).toBe('鿄鿅🄪ℓ');
    });

    test('JIS互換漢字2面は1面と混ぜない', () => {
        // 85区1点は1面 (外字) なら「㐂」。2面では外字の表を引かず、2面の表も持たないので「□」
        expect(decodeAribText(bytes(0x75, 0x21))).toBe('㐂');
        expect(decodeAribText(bytes(0x1b, 0x24, 0x3a, 0x75, 0x21))).toBe('□');
    });

    test('JIS にも外字にも無い区点は印を残す。黙って消さない', () => {
        // 94区94点。外字表の末尾 (㉛) の1つ先で、JIS にも当たらない
        expect(decodeAribText(bytes(0x7e, 0x7e))).toBe('□');
    });
});
