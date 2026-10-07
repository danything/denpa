import { describe, expect, test } from 'bun:test';
import { type Airing, captioned, episodeKey, firstAirings } from './episode';

/**
 * 同じ回は1度だけ録る (ルールの「同じ回は最初の放送だけ録る」)。
 * DB には触らない純粋な計算なので、選び方の順をここで固定する
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let next = 1;
function airing(name: string, at: number, fields: Partial<Airing> = {}): Airing {
    const id = next++;
    return { id, name, start_at: at, end_at: at + HOUR / 2, service_id: 1000 + id, type: 'GR', ...fields };
}

/** 録る放送の id */
function kept(airings: Airing[]): number[] {
    const skips = firstAirings(airings);
    return airings.filter((a) => !skips.has(a.id)).map((a) => a.id);
}

describe('episodeKey', () => {
    test('局によって話数の書き方が違っても同じ回', () => {
        expect(episodeKey('[新]テストアニメ #1「はじまり」')).toBe(
            episodeKey('テストアニメ 第1話「はじまり」[字]'),
        );
    });

    test('全角と半角、空白の有無は揃える', () => {
        expect(episodeKey('テストアニメ　＃３')).toBe(episodeKey('テストアニメ #3'));
    });

    test('話数が違えば別の回', () => {
        expect(episodeKey('テストアニメ #1')).not.toBe(episodeKey('テストアニメ #2'));
    });

    test('シリーズが違えば別の回', () => {
        expect(episodeKey('テストアニメ #1')).not.toBe(episodeKey('別のアニメ #1'));
    });

    test('「第2期 #1」のように話数が2つ読めても、各話は潰れない', () => {
        // parseTitle は「第2」を話数に読むので、後ろの #1 / #2 は副題に残る
        expect(episodeKey('テストアニメ 第2期 #1')).not.toBe(episodeKey('テストアニメ 第2期 #2'));
    });

    test('副題だけでも回が分かる', () => {
        expect(episodeKey('ドキュメント「港町の朝」')).toBe(episodeKey('ドキュメント 「港町の朝」[再]'));
    });

    test('話数も副題も無ければ回は分からない', () => {
        expect(episodeKey('ニュース')).toBeNull();
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
        const key = episodeKey(later.name)!;
        const taken = new Map([[key, { start_at: base - DAY, service_name: 'TOKYO MX' }]]);
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
});
