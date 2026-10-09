import { describe, expect, test } from 'bun:test';
import { displayTitle, markedTitle, parseTitle, sanitizeFileName, toHalfWidth } from './title';

describe('parseTitle', () => {
    test('装飾記号を落としてシリーズ名にする', () => {
        expect(parseTitle('【新】テスト番組').series).toBe('テスト番組');
        expect(parseTitle('テスト番組[字][解]').series).toBe('テスト番組');
    });

    test('鍵括弧をサブタイトルとして切り出す', () => {
        const parsed = parseTitle('推しの番組「はじまりの日」');
        expect(parsed.series).toBe('推しの番組');
        expect(parsed.subtitle).toBe('はじまりの日');
    });

    test('話数はシリーズ名から外し、その後ろをサブタイトルにする', () => {
        const parsed = parseTitle('テストアニメ #12 決戦');
        expect(parsed.series).toBe('テストアニメ');
        expect(parsed.episode).toBe(12);
        expect(parsed.subtitle).toBe('決戦');
    });

    test('第N話 表記も拾う', () => {
        expect(parseTitle('ドラマ 第3話').episode).toBe(3);
        expect(parseTitle('ドラマ 第3話').series).toBe('ドラマ');
    });

    test('全角は半角に寄せる', () => {
        expect(toHalfWidth('ＴＯＫＹＯ　ＭＸ')).toBe('TOKYO MX');
    });

    test('空文字でも落ちない', () => {
        expect(parseTitle('').series).toBe('untitled');
    });

    test('話数もサブタイトルも無ければ番組名がそのままシリーズ名', () => {
        expect(parseTitle('ニュース').series).toBe('ニュース');
        expect(parseTitle('ニュース').subtitle).toBe('');
        expect(parseTitle('ニュース').arc).toBe('');
    });

    test('頭の鍵括弧は作品名。後ろに続くのは編', () => {
        expect(parseTitle('「東京リベンジャーズ」三天戦争編')).toEqual({
            series: '東京リベンジャーズ',
            arc: '三天戦争編',
            subtitle: '',
            episode: null,
        });
        expect(parseTitle('「東京リベンジャーズ」三天戦争編 第52話「Be left behind the times」')).toEqual({
            series: '東京リベンジャーズ',
            arc: '三天戦争編',
            subtitle: 'Be left behind the times',
            episode: 52,
        });
        expect(parseTitle('『東京リベンジャーズ』三天戦争編 #52').series).toBe('東京リベンジャーズ');
        expect(parseTitle('「名探偵コナン」')).toMatchObject({
            series: '名探偵コナン',
            arc: '',
            subtitle: '',
        });
    });

    test('作品名の後ろの鍵括弧は今までどおり副題', () => {
        expect(parseTitle('名探偵コナン「黒の組織」')).toMatchObject({
            series: '名探偵コナン',
            arc: '',
            subtitle: '黒の組織',
        });
        expect(parseTitle('推しの番組『はじまりの日』')).toMatchObject({
            series: '推しの番組',
            subtitle: 'はじまりの日',
        });
    });

    test('話数の後ろの【枠の名前】は副題にしない', () => {
        expect(parseTitle('[新]「東京リベンジャーズ」三天戦争編 第51話【アニメイズム】')).toEqual({
            series: '東京リベンジャーズ',
            arc: '三天戦争編',
            subtitle: '',
            episode: 51,
        });
        // 作品名そのものの【】は残す
        expect(parseTitle('【推しの子】 #1').series).toBe('【推しの子】');
    });

    test('[無] と頭の <枠の名前> は落とす', () => {
        expect(parseTitle('[無][新]東京リベンジャーズ #51 [字]')).toMatchObject({
            series: '東京リベンジャーズ',
            episode: 51,
        });
        expect(parseTitle('<アニメギルド>てつりょー! meet with  鉄道むすめ #1[新]')).toMatchObject({
            series: 'てつりょー! meet with  鉄道むすめ',
            episode: 1,
        });
    });

    test('話数の前の ▼ は区切り', () => {
        expect(parseTitle('東京リベンジャーズ 三天戦争編▼第52話')).toMatchObject({
            series: '東京リベンジャーズ 三天戦争編',
            episode: 52,
        });
    });

    test('第2期 は話数ではなく編', () => {
        expect(parseTitle('テストアニメ 第2期 #3')).toEqual({
            series: 'テストアニメ',
            arc: '第2期',
            subtitle: '',
            episode: 3,
        });
        expect(parseTitle('「テストアニメ」A編 第2期')).toMatchObject({
            series: 'テストアニメ',
            arc: 'A編 第2期',
        });
        // 後ろに名前が続くものは、どこまでが編か分からないので今までどおり
        expect(parseTitle('将棋)第34期 銀河戦').arc).toBe('');
    });
});

/** 入れ物の title に焼き込む番組名。プレイヤーがURLの代わりに出す */
describe('displayTitle', () => {
    test('装飾記号だけ落とし、話数もサブタイトルも残す', () => {
        expect(displayTitle('【新】転生したらスライムだった件 第4期 #88[字][デ]')).toBe(
            '転生したらスライムだった件 第4期 #88',
        );
    });

    test('ARIB の囲み文字は残す', () => {
        expect(displayTitle('🈚転生したらスライムだった件 #88 🈑')).toBe(
            '🈚転生したらスライムだった件 #88 🈑',
        );
    });

    test('全部消えたら元の名前のまま', () => {
        expect(displayTitle('[字]')).toBe('[字]');
    });
});

describe('markedTitle', () => {
    test('[字][デ] は残す (テレビの見出しで字幕・二か国語が分かるように)', () => {
        expect(markedTitle('［新］番組　第１話［字］［デ］')).toBe('[新]番組 第1話[字][デ]');
    });
    test('ARIB の囲み文字は [字] の形に開く (テレビの VLC で豆腐にしない)', () => {
        expect(markedTitle('ニュース\u{1F211}\u{1F213}')).toBe('ニュース[字][デ]');
    });
});

describe('sanitizeFileName', () => {
    test('パス区切りとWindowsの禁止文字を落とす', () => {
        expect(sanitizeFileName('a/b:c*d?e"f<g>h|i')).toBe('a b c d e f g h i');
    });

    test('末尾のドットとスペースを落とす', () => {
        expect(sanitizeFileName('番組名... ')).toBe('番組名');
    });

    test('全部消えたら untitled にする', () => {
        expect(sanitizeFileName('///')).toBe('untitled');
    });

    test('長すぎる名前は切り詰める', () => {
        expect(sanitizeFileName('あ'.repeat(200)).length).toBeLessThanOrEqual(60);
    });
});
