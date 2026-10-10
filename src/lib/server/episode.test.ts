import { describe, expect, test } from 'bun:test';
import { type Airing, captioned, episodeOf, firstAirings, sameEpisode } from './episode';

/**
 * 同じ回は1度だけ録る (ルールの「同じ回は最初の放送だけ録る」)。
 * DB には触らない純粋な計算なので、選び方の順をここで固定する
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let next = 1;
function airing(name: string, at: number, fields: Partial<Airing> = {}): Airing {
    const id = next++;
    return {
        id,
        name,
        description: '',
        extended: null,
        start_at: at,
        end_at: at + HOUR / 2,
        service_id: 1000 + id,
        type: 'GR',
        ...fields,
    };
}

/** 題名 (と概要) だけで同じ回か */
function same(a: string, b: string, descriptions: [string, string] = ['', '']): boolean {
    const one = episodeOf({ name: a, description: descriptions[0], extended: null });
    const two = episodeOf({ name: b, description: descriptions[1], extended: null });
    return one !== null && two !== null && sameEpisode(one, two);
}

/** 録る放送の id */
function kept(airings: Airing[]): number[] {
    const skips = firstAirings(airings);
    return airings.filter((a) => !skips.has(a.id)).map((a) => a.id);
}

describe('同じ回の見分け', () => {
    test('局によって話数の書き方が違っても同じ回', () => {
        expect(same('[新]テストアニメ #1「はじまり」', 'テストアニメ 第1話「はじまり」[字]')).toBe(true);
    });

    test('全角と半角、空白の有無は揃える', () => {
        expect(same('テストアニメ　＃３', 'テストアニメ #3')).toBe(true);
    });

    test('話数が違えば別の回', () => {
        expect(same('テストアニメ #1', 'テストアニメ #2')).toBe(false);
    });

    test('シリーズが違えば別の回', () => {
        expect(same('テストアニメ #1', '別のアニメ #1')).toBe(false);
    });

    test('「第2期 #1」のように話数が2つ読めても、各話は潰れない', () => {
        // 「第2期」は編。後ろの #1 / #2 が話数
        expect(same('テストアニメ 第2期 #1', 'テストアニメ 第2期 #2')).toBe(false);
        expect(same('テストアニメ 第2期 #1', 'テストアニメ 第2話')).toBe(false);
    });

    test('副題だけでも回が分かる', () => {
        expect(same('ドキュメント「港町の朝」', 'ドキュメント 「港町の朝」[再]')).toBe(true);
    });

    test('話数も副題も無ければ回は分からない', () => {
        expect(episodeOf({ name: 'ニュース', description: '', extended: null })).toBeNull();
        expect(
            episodeOf({
                name: 'ニュース',
                description: '今日の出来事を伝えます',
                extended: { 出演者: '山田' },
            }),
        ).toBeNull();
    });

    test('題名に話数が無ければ概要から読む。局ごとの飾りは違っていてよい', () => {
        expect(
            same('薬屋のひとりごと FRIDAY ANIME NIGHT[字][デ]', 'アニメ 薬屋のひとりごと', [
                '第18話「月下の花」 猫猫は壬氏に連れられて…',
                '#18「月下の花」',
            ]),
        ).toBe(true);
        expect(
            same('＜アニメイズム＞薬屋のひとりごと', '【アニメ】薬屋のひとりごと', [
                '#18「月下の花」',
                '#18「月下の花」',
            ]),
        ).toBe(true);
    });

    test('概要の漢数字の話数も読む', () => {
        expect(
            same('薬屋のひとりごと', 'アニメ 薬屋のひとりごと', ['第十八話「月下の花」', '#18「月下の花」']),
        ).toBe(true);
    });

    test('概要から読んでも、話数や副題が違えば別の回', () => {
        expect(
            same('薬屋のひとりごと FRIDAY ANIME NIGHT', 'アニメ 薬屋のひとりごと', [
                '#18「月下の花」',
                '#19「蝉の声」',
            ]),
        ).toBe(false);
    });

    test('概要の「前回」「次回」の話数は読まない', () => {
        const episode = episodeOf({
            name: '薬屋のひとりごと',
            description: '前回の#17「街歩き」に続き… #18「月下の花」',
            extended: null,
        });
        expect(episode).toMatchObject({ number: 18 });
    });

    test('前回の話数は、間に語が挟まっても読まない', () => {
        const episode = episodeOf({
            name: '薬屋のひとりごと',
            description: '前回のあらすじ #17「街歩き」。#18「月下の花」',
            extended: null,
        });
        expect(episode).toMatchObject({ number: 18 });
    });

    test('副題の無い話数は行の頭のものだけ。地の文の話数は読まない', () => {
        const prose = (description: string) =>
            episodeOf({ name: 'テストドラマ', description, extended: null });
        expect(prose('第3話から登場した刑事が再び現れる')).toBeNull();
        expect(prose('#1ヒットを生んだ歌手が出演')).toBeNull();
        expect(prose('#18 猫猫は壬氏に連れられて…')).toMatchObject({ number: 18, subtitle: '' });
    });

    test('概要に無ければ詳細から読む', () => {
        const episode = episodeOf({
            name: '薬屋のひとりごと',
            description: '',
            extended: { 番組内容: '第18話「月下の花」\n猫猫は…' },
        });
        expect(episode).toMatchObject({ number: 18 });
    });

    test('飾りの違いを許すのは副題まで揃うときだけ。話数だけなら名前がぴったり同じもの', () => {
        // 1期の再放送と2期が同じ時期に流れても、副題の無い #1 どうしはくっつけない
        expect(same('テストアニメ', 'テストアニメ 2', ['#1', '#1'])).toBe(false);
        expect(same('テストアニメ', 'テストアニメ', ['#1', '#1'])).toBe(true);
    });

    test('芯が2文字以下なら、副題が揃っても名前の違うシリーズとはくっつけない', () => {
        expect(same('銀魂 #1「最終回」', '金銀魂 #1「最終回」')).toBe(false);
        expect(same('銀魂 #1「最終回」', '銀魂 #1「最終回」[再]')).toBe(true);
    });

    test('題名が「第2期」だけなら、全話を1つの回にしない', () => {
        // 「第2期」は編で話数ではない。毎回同じなので回にはならない
        expect(episodeOf({ name: 'テストアニメ 第2期', description: '', extended: null })).toBeNull();
        expect(same('テストアニメ 第2期', 'テストアニメ 第2期', ['#1「はじまり」', '#2「つづき」'])).toBe(
            false,
        );
    });

    test('副題を出さない局とも、シリーズ名が同じなら同じ回', () => {
        expect(
            same(
                '「東京リベンジャーズ」三天戦争編 第52話「Be left behind the times」',
                '東京リベンジャーズ 三天戦争編▼第52話',
            ),
        ).toBe(true);
        expect(
            same(
                '[新]てつりょー!meet with 鉄道むすめ #1「どんなところに、行こうかな?」',
                '<アニメギルド>てつりょー! meet with  鉄道むすめ #1[新]',
            ),
        ).toBe(true);
        // 副題が無いほうの名前が違えば別の回 (飾りの違いを許すのは副題が揃うときだけ)
        expect(same('テストアニメ #1「はじまり」', 'アニメ テストアニメ #1')).toBe(false);
    });

    test('編を書かない局とも、作品名が同じなら同じ回。編が違えば別の回', () => {
        expect(
            same(
                '[新]「東京リベンジャーズ」三天戦争編 第51話【アニメイズム】',
                '[無][新]東京リベンジャーズ #51 [字]',
            ),
        ).toBe(true);
        expect(same('「テストアニメ」A編 #1', '「テストアニメ」B編 #1')).toBe(false);
        // 副題が揃っても、編が違えば別の回 (芯の一致で緩めない)
        expect(same('時代劇・第36部 #9 ◆主演', '時代劇・第37部 #9 ◆主演')).toBe(false);
    });

    /** TBS と BS日テレ。飾りも話数の書き方も違い、副題は概要にしか無い */
    const TBS = '追放された転生重騎士はゲーム知識で無双する#15◆スーパーアニメイズムTURBO[字][デ]';
    const NTV = '[字]アニメ 追放された転生重騎士はゲーム知識で無双する Chapter 15';

    test('題名に話数だけなら、副題は概要から足す (Chapter 15「…」 / Chapter 15 …)', () => {
        expect(
            same(TBS, NTV, ['Chapter 15「百足坑道の主」▼レベルアップし…', 'Chapter 15 百足坑道の主']),
        ).toBe(true);
        expect(same(TBS, NTV, ['Chapter 15「百足坑道の主」▼レベルアップし…', 'Chapter 16 次の話'])).toBe(
            false,
        );
        // 副題が揃わなければ、飾りの違うシリーズとはくっつけない
        expect(same(TBS, NTV)).toBe(false);
    });

    test('概要の話数が題名と違えば副題は足さない', () => {
        const episode = episodeOf({ name: 'テストアニメ #3', description: '#2「前の話」', extended: null });
        expect(episode).toMatchObject({ number: 3, subtitle: '' });
    });

    test('概要の英語の話数も読む', () => {
        const read = (description: string) =>
            episodeOf({ name: 'テストアニメ', description, extended: null });
        expect(read('Chapter.2「少女・ミミ」')).toMatchObject({ number: 2, subtitle: '少女・ミミ' });
        expect(read('Episode 7 はじまりの街')).toMatchObject({ number: 7, subtitle: 'はじまりの街' });
        // 括弧の無い副題は、文になっているものは読まない
        expect(read('#18 猫猫は壬氏に連れられて…')).toMatchObject({ number: 18, subtitle: '' });
        expect(read('Chapter 3 二人は街へ向かう。そこで…')).toMatchObject({ number: 3, subtitle: '' });
        // 地の文の Season / Step は話数ではない
        expect(read('Season 2 が始まる')).toBeNull();
        expect(read('Step12 の練習')).toBeNull();
        // 話数の後ろの区切り (`#18: …`) は副題に入れない
        expect(read('#18: 春の訪れ')).toMatchObject({ number: 18, subtitle: '春の訪れ' });
    });

    test('概要から足した副題が題名の副題と食い違っても、別の回にはしない', () => {
        // 局によって書き方が違う (`奈良県` と `奈良`)。足していない頃と同じく、シリーズ名で見る
        expect(same('私の幸福時間 #1138 奈良県/鹿の写真', '私の幸福時間', ['', '#1138 奈良/鹿の写真'])).toBe(
            true,
        );
        // 題名どうしの副題が食い違えば今までどおり別の回
        expect(same('テストアニメ #1「はじまり」', 'テストアニメ #1「別の話」')).toBe(false);
    });

    test('題名の話数の後ろの印 (◆★▼) は副題とは限らない', () => {
        // 印の後ろは枠の名前や出演者。概要に副題があればそちらで比べる
        expect(
            same('テストアニメ#5◆アニメ枠', 'アニメ テストアニメ #5', ['#5「はじまり」', '#5「はじまり」']),
        ).toBe(true);
        expect(same('テストドラマ 第2話★主演A', 'テストドラマ 第2話★主演A ドラマ特')).toBe(true);
    });

    test('頭の「アニメA・」「ドラマ・」は枠の名前', () => {
        // テレ朝は副題を出さず枠の名前 (【ヌマニメーション】)、BS朝日は頭に「アニメA・」
        expect(
            same(
                '貸した魔力は【リボ払い】で強制徴収 #2【ヌマニメーション】[字]',
                '[字]アニメA・貸した魔力は【リボ払い】で強制徴収 #2「契約」',
            ),
        ).toBe(true);
        expect(same('ドラマ・テストドラマ #3', 'テストドラマ #3')).toBe(true);
        // ほかの「・」は作品名のうち
        expect(same('新・テスト番組 #3', 'テスト番組 #3')).toBe(false);
        expect(same('続・テストドラマ #3', 'テストドラマ #3')).toBe(false);
    });

    test('話数と概要がぴったり同じなら、題名の飾りが違っても同じ回', () => {
        const summary =
            '「釣りの裾野を広げる!」をモットーに、様々な釣りをご紹介!第42話 マダイ釣りならまかせろ!';
        const [one, sp] = ['テスト釣り番組 #42', '【釣りの日SP】テスト釣り番組 #42'];
        expect(same(one, sp, [summary, summary])).toBe(true);
        expect(same(one, sp)).toBe(false);
        // 短い概要は決め手にしない
        expect(same(one, sp, ['マダイ釣り', 'マダイ釣り'])).toBe(false);
        // 話数が違えば別の回
        expect(same(one, '【釣りの日SP】テスト釣り番組 #43', [summary, summary])).toBe(false);
    });

    test('概要が同じでも、名前の芯しか重ならない枠・数字の違うシリーズ・食い違う副題は別の回', () => {
        const blurb = '芸人たちの動画チャンネルから、毎日更新し続ける厳選動画を芸人たちが紹介する番組です。';
        expect(same('テスト大賞 Monday #4', 'テスト大賞 Tuesday #4', [blurb, blurb])).toBe(false);
        const series =
            'エピソード6\n汚職特捜班が、不正に手を染めた汚職警官に立ち向かう、英国のクライムドラマ!';
        expect(same('テスト特捜班 5 #6', 'テスト特捜班 6 #6', [series, series])).toBe(false);
        expect(same('テストアニメ #1「はじまり」', 'テストアニメ #1「別の話」', [blurb, blurb])).toBe(false);
    });
});

describe('captioned', () => {
    test('[字] と ARIB の囲み文字 🈑 を字幕付きと読む', () => {
        expect(captioned('テストアニメ #1[字]')).toBe(true);
        expect(captioned('テストアニメ #1 🈑')).toBe(true);
        expect(captioned('テストアニメ #1')).toBe(false);
    });
});

describe('firstAirings', () => {
    const base = Date.UTC(2026, 9, 1, 14);

    test('同じ回はいちばん早い放送だけ録り、後のものは理由つきで外す', () => {
        const mx = airing('テストアニメ #1', base);
        const bs = airing('テストアニメ #1', base + 2 * DAY, { type: 'BS' });
        const local = airing('テストアニメ #1', base + 5 * DAY);
        const skips = firstAirings([local, bs, mx]);
        expect(skips.has(mx.id)).toBe(false);
        expect(skips.get(bs.id)).toEqual({ kind: 'repeat', first: mx });
        expect(skips.get(local.id)).toEqual({ kind: 'repeat', first: mx });
    });

    test('別の回はどちらも録る', () => {
        const one = airing('テストアニメ #1', base);
        const two = airing('テストアニメ #2', base + 7 * DAY);
        expect(kept([one, two])).toEqual([one.id, two.id]);
    });

    test('同じ時刻に流れているなら字幕のあるほう', () => {
        const plain = airing('テストアニメ #1', base, { type: 'BS' });
        const subtitled = airing('テストアニメ #1[字]', base);
        expect(kept([plain, subtitled])).toEqual([subtitled.id]);
    });

    test('字幕が同じなら衛星のほう', () => {
        const gr = airing('テストアニメ #1', base);
        const bs = airing('テストアニメ #1', base, { type: 'BS' });
        expect(kept([gr, bs])).toEqual([bs.id]);
    });

    test('少しずれて重なっているのも同時放送として選ぶ', () => {
        const gr = airing('テストアニメ #1', base);
        const bs = airing('テストアニメ #1[字]', base + 10 * 60 * 1000, { type: 'BS' });
        expect(kept([gr, bs])).toEqual([bs.id]);
    });

    test('重ならないなら字幕や衛星より早さ', () => {
        const gr = airing('テストアニメ #1', base);
        const bs = airing('テストアニメ #1[字]', base + DAY, { type: 'BS' });
        expect(kept([gr, bs])).toEqual([gr.id]);
    });

    test('選んだ放送がチューナー不足で弾かれていたら、次の放送も録る', () => {
        const first = airing('テストアニメ #1', base);
        const second = airing('テストアニメ #1', base + DAY);
        const third = airing('テストアニメ #1', base + 2 * DAY);
        const skips = firstAirings([first, second, third], new Set([first.id]));
        expect(skips.has(first.id)).toBe(false);
        expect(skips.has(second.id)).toBe(false);
        // 外したものには、実際に録るほうを添える
        expect(skips.get(third.id)).toEqual({ kind: 'repeat', first: second });
    });

    test('もう録ってある回はどれも録らない', () => {
        const later = airing('テストアニメ #1', base + DAY);
        const episode = episodeOf(later)!;
        const taken = [{ episode, start_at: base - DAY, service_name: 'TOKYO MX' }];
        expect(firstAirings([later], new Set(), taken).get(later.id)).toEqual({
            kind: 'recorded',
            start_at: base - DAY,
            service_name: 'TOKYO MX',
        });
    });

    test('回の分からない番組は、別の時刻なら同じ題名でも全部録る (毎日のニュース)', () => {
        const days = [0, 1, 2].map((d) => airing('ニュース', base + d * DAY));
        expect(kept(days)).toEqual(days.map((a) => a.id));
    });

    test('回の分からない番組でも、同じ時刻の同時放送は1本にする', () => {
        const gr = airing('ニュース[字]', base);
        const bs = airing('ニュース', base, { type: 'BS' });
        const tomorrow = airing('ニュース', base + DAY);
        expect(kept([gr, bs, tomorrow])).toEqual([gr.id, tomorrow.id]);
    });

    test('題名に話数の無い再放送も、概要の話数で同じ回とみる', () => {
        const ntv = airing('薬屋のひとりごと FRIDAY ANIME NIGHT[字][デ]', base, {
            description: '第18話「月下の花」 猫猫は壬氏に連れられて…',
        });
        const bs = airing('アニメ 薬屋のひとりごと', base + DAY, {
            type: 'BS',
            description: '#18「月下の花」',
        });
        const next = airing('アニメ 薬屋のひとりごと', base + 8 * DAY, {
            type: 'BS',
            description: '#19「蝉の声」',
        });
        const skips = firstAirings([bs, next, ntv]);
        expect(skips.get(bs.id)).toEqual({ kind: 'repeat', first: ntv });
        expect(skips.has(ntv.id)).toBe(false);
        expect(skips.has(next.id)).toBe(false);
    });

    test('副題を出す局と出さない局の同じ回は、早いほうだけ録る', () => {
        const tbs = airing('「東京リベンジャーズ」三天戦争編 第52話「Be left behind the times」', base);
        const bs = airing('東京リベンジャーズ 三天戦争編▼第52話', base + HOUR, { type: 'BS' });
        expect(firstAirings([bs, tbs]).get(bs.id)).toEqual({ kind: 'repeat', first: tbs });
    });

    test('同時放送で片方に副題が無くても1本にする', () => {
        const mx = airing('[新]てつりょー!meet with 鉄道むすめ #1「どんなところに、行こうかな?」', base);
        const bs = airing('<アニメギルド>てつりょー! meet with  鉄道むすめ #1[新]', base, { type: 'BS' });
        expect(kept([mx, bs])).toEqual([bs.id]);
    });

    test('副題の無い放送は、相手が1つに決まるときだけ束ねる', () => {
        // 副題の違う2つの回のどちらとも読めるなら、どちらにも寄せない (取り違えて録り逃さない)
        const one = airing('テストアニメ #1「はじまり」', base);
        const other = airing('テストアニメ #1「別の話」', base + DAY);
        const bare = airing('テストアニメ #1', base + 2 * DAY);
        expect(kept([one, other, bare])).toEqual([one.id, other.id, bare.id]);
        // 編を書かない局の放送も同じ。どちらの編か決まらなければ束ねない
        const a = airing('「テストアニメ」A編 #1', base);
        const b = airing('「テストアニメ」B編 #1', base + DAY);
        const plain = airing('テストアニメ #1', base + 2 * DAY);
        expect(kept([a, b, plain])).toEqual([a.id, b.id, plain.id]);
    });

    test('編を書かない局の再放送も、録画済みの回として外す', () => {
        const recorded = episodeOf({
            name: '[新]「東京リベンジャーズ」三天戦争編 第51話【アニメイズム】',
            description: '',
            extended: null,
        })!;
        const taken = [{ episode: recorded, start_at: base - 7 * DAY, service_name: 'TBS1' }];
        const atx = airing('[無][新]東京リベンジャーズ #51 [字]', base, { type: 'CS' });
        expect(firstAirings([atx], new Set(), taken).get(atx.id)).toEqual({
            kind: 'recorded',
            start_at: base - 7 * DAY,
            service_name: 'TBS1',
        });
    });

    test('概要の話数で、録画済みの回も見つける', () => {
        const recorded = episodeOf({
            name: '薬屋のひとりごと FRIDAY ANIME NIGHT[字][デ]',
            description: '第18話「月下の花」',
            extended: null,
        })!;
        const taken = [{ episode: recorded, start_at: base - DAY, service_name: '日テレ1' }];
        const bs = airing('アニメ 薬屋のひとりごと', base, { type: 'BS', description: '#18「月下の花」' });
        const other = airing('アニメ 薬屋のひとりごと', base + 7 * DAY, {
            type: 'BS',
            description: '#19「蝉の声」',
        });
        const skips = firstAirings([bs, other], new Set(), taken);
        expect(skips.get(bs.id)).toEqual({ kind: 'recorded', start_at: base - DAY, service_name: '日テレ1' });
        expect(skips.has(other.id)).toBe(false);
    });

    test('TBS の #15 を録ってあれば、BS日テレの Chapter 15 は録らない', () => {
        const recorded = episodeOf({
            name: '追放された転生重騎士はゲーム知識で無双する#15◆スーパーアニメイズムTURBO[字][デ]',
            description: 'Chapter 15「百足坑道の主」▼レベルアップし新たなスキルを取得した…',
            extended: null,
        })!;
        const taken = [{ episode: recorded, start_at: base - DAY, service_name: 'TBS1' }];
        const ntv = airing('[字]アニメ 追放された転生重騎士はゲーム知識で無双する Chapter 15', base, {
            type: 'BS',
            description: 'Chapter 15 百足坑道の主',
        });
        // 概要がまだ空の回は分からないので録る
        const later = airing('[字]アニメ 追放された転生重騎士はゲーム知識で無双する', base + 7 * DAY, {
            type: 'BS',
        });
        const skips = firstAirings([ntv, later], new Set(), taken);
        expect(skips.get(ntv.id)).toEqual({ kind: 'recorded', start_at: base - DAY, service_name: 'TBS1' });
        expect(skips.has(later.id)).toBe(false);
    });

    test('飾りの違う局どうしを束ねたあとも、副題の無い局をその束に寄せる', () => {
        // TBS と BS日テレは副題で束ねる。AT-X は副題が無く、名前が同じ TBS とだけ読める
        const tbs = airing('追放された転生重騎士はゲーム知識で無双する#15◆スーパーアニメイズムTURBO', base, {
            description: 'Chapter 15「百足坑道の主」',
        });
        const ntv = airing('[字]アニメ 追放された転生重騎士はゲーム知識で無双する Chapter 15', base + DAY, {
            type: 'BS',
            description: 'Chapter 15 百足坑道の主',
        });
        const atx = airing('追放された転生重騎士はゲーム知識で無双する #15 [字]', base + 2 * DAY, {
            type: 'CS',
        });
        expect(kept([tbs, ntv, atx])).toEqual([tbs.id]);
        // 束のどれか1つと読めても、読める束が2つあればどちらにも寄せない
        const one = airing('テストアニメ #1「はじまり」', base);
        const decorated = airing('アニメ テストアニメ #1', base + HOUR, { description: '#1「はじまり」' });
        const other = airing('テストアニメ #1「別の話」', base + DAY);
        const bare = airing('テストアニメ #1', base + 2 * DAY);
        expect(kept([one, decorated, other, bare])).toEqual([one.id, other.id, bare.id]);
    });

    test('テレ朝と BS朝日 (アニメA・) の同じ回は早いほうだけ。録画済みの回も外す', () => {
        const description =
            'ギフト妖精エムピーの導きで、レントはガイたちにスキル【強制徴収】を発動。笑顔の裏に…“魔力リボ払い"で…。';
        const ex = airing('貸した魔力は【リボ払い】で強制徴収 #2【ヌマニメーション】[字]', base, {
            description,
        });
        const bs = airing('[字]アニメA・貸した魔力は【リボ払い】で強制徴収 #2「契約」', base + DAY, {
            type: 'BS',
            description,
        });
        expect(kept([ex, bs])).toEqual([ex.id]);
        const recorded = episodeOf({
            name: '[新]貸した魔力は【リボ払い】で強制徴収 #1【ヌマニメーション】[字]',
            description: '',
            extended: null,
        })!;
        const first = airing('[字][新]アニメA・貸した魔力は【リボ払い】で強制徴収 #1「追放」', base, {
            type: 'BS',
        });
        const taken = [{ episode: recorded, start_at: base - DAY, service_name: 'テレビ朝日' }];
        expect(firstAirings([first], new Set(), taken).get(first.id)?.kind).toBe('recorded');
    });

    test('毎週同じ番組紹介は概要が揃っても決め手にしない', () => {
        const blurb =
            '「釣りの裾野を広げる!」をモットーに、様々な釣りをご紹介!毎週いろいろな釣りに挑戦します。';
        const one = airing('テスト釣り番組 #5', base, { description: blurb });
        const sp = airing('【SP】テスト釣り番組 #5', base + DAY, { description: blurb });
        expect(kept([one, sp])).toEqual([one.id]);
        // 別の回 (#6) にも同じ概要が出てくれば、番組紹介とみる
        const next = airing('テスト釣り番組 #6', base + 7 * DAY, { description: blurb });
        expect(kept([one, sp, next])).toEqual([one.id, sp.id, next.id]);
        // 話数だけ差し替えた概要 (「エピソード5」「エピソード6」) も同じ
        const numbered = (n: number, at: number, name: string) =>
            airing(name, at, { description: `エピソード${n}\n${blurb}` });
        const five = numbered(5, base, 'テスト釣り番組 #5');
        const fiveSp = numbered(5, base + DAY, '【SP】テスト釣り番組 #5');
        const six = numbered(6, base + 7 * DAY, 'テスト釣り番組 #6');
        expect(kept([five, fiveSp, six])).toEqual([five.id, fiveSp.id, six.id]);
        // 録画済みの回に出てきた概要も数える
        const recorded = episodeOf({ name: 'テスト釣り番組 #4', description: blurb, extended: null })!;
        const taken = [{ episode: recorded, start_at: base - 7 * DAY, service_name: 'MONDO TV' }];
        expect(firstAirings([one, sp], new Set(), taken).size).toBe(0);
    });
});
