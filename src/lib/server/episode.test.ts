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
        // parseTitle は「第2」を話数に読むので、後ろの #1 / #2 は副題に残る
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

    test('題名が「第2期」だけなら、全話を1つの回にしない', () => {
        // parseTitle は「第2」を話数に読むが、毎回同じなので回にはならない
        expect(episodeOf({ name: 'テストアニメ 第2期', description: '', extended: null })).toBeNull();
        expect(same('テストアニメ 第2期', 'テストアニメ 第2期', ['#1「はじまり」', '#2「つづき」'])).toBe(
            false,
        );
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
});
