import { describe, expect, test } from 'bun:test';
import type { Program, Rule } from '../types';
import { compile, coveringRule, likePatterns, matches, prefillFrom } from './rules';

/**
 * ルールの判定。DBには触らない (matches は純粋関数にしてある)。
 *
 * 見るのは主に「キーワードをどこに当てるか」。ここを広げすぎると
 * 番宣で名前が出ただけの番組まで録れてしまい、狭すぎると出演者で拾えない。
 */

function rule(fields: Partial<Rule>): Rule {
    return {
        id: 1,
        name: 'テスト',
        keyword: '',
        ignore_keyword: '',
        search_fields: 'name',
        service_ids: null,
        service_types: null,
        genres: null,
        enabled: true,
        priority: 2,
        dedupe: false,
        source: null,
        created_at: 0,
        ...fields,
    };
}

function program(fields: Partial<Program>): Program {
    return {
        id: 1,
        service_id: 1,
        network_id: 1,
        event_id: 1,
        start_at: 0,
        end_at: 0,
        name: '',
        description: '',
        extended: null,
        genres: null,
        genre_detail: null,
        is_free: true,
        audio_type: null,
        audios: null,
        video_type: null,
        video_resolution: null,
        updated_at: 0,
        ...fields,
    } as Program;
}

const target = program({
    name: '青のオーケストラ',
    description: '第20話「超える」',
    extended: { 出演者: '山田太郎 鈴木花子', 音楽: 'だれか' },
});

describe('キーワードを当てる範囲', () => {
    test('既定は番組名だけ', () => {
        expect(matches(rule({ keyword: '青のオーケストラ' }), target)).toBe(true);
        // 概要にしかない語では当たらない
        expect(matches(rule({ keyword: '超える' }), target)).toBe(false);
        expect(matches(rule({ keyword: '山田太郎' }), target)).toBe(false);
    });

    test('概要まで広げる', () => {
        const r = rule({ keyword: '超える', search_fields: 'name,description' });
        expect(matches(r, target)).toBe(true);
        expect(matches(rule({ ...r, keyword: '山田太郎' }), target)).toBe(false);
    });

    test('詳細まで広げると出演者で拾える', () => {
        const r = rule({ keyword: '山田太郎', search_fields: 'name,description,extended' });
        expect(matches(r, target)).toBe(true);
    });

    test('詳細は見出しも探せる', () => {
        expect(matches(rule({ keyword: '出演者', search_fields: 'extended' }), target)).toBe(true);
    });

    test('範囲が空なら番組名だけに戻す', () => {
        // 全番組に当たってしまうので、指定なしとは解釈しない
        expect(matches(rule({ keyword: '青のオーケストラ', search_fields: '' }), target)).toBe(true);
        expect(matches(rule({ keyword: '超える', search_fields: '' }), target)).toBe(false);
    });

    test('除外キーワードも同じ範囲で見る', () => {
        const wide = rule({ keyword: '青の', ignore_keyword: '山田太郎', search_fields: 'name,extended' });
        expect(matches(wide, target)).toBe(false);
        // 番組名だけなら出演者は見ないので落ちない
        expect(matches(rule({ ...wide, search_fields: 'name' }), target)).toBe(true);
    });

    test('空白区切りは全部含むもの', () => {
        const r = rule({ keyword: '青の 超える', search_fields: 'name,description' });
        expect(matches(r, target)).toBe(true);
        expect(matches(rule({ ...r, keyword: '青の 届かない' }), target)).toBe(false);
    });

    test('外字は昔の書き方のキーワードでも当たる (吉 → 𠮷、[新] → 🈟)', () => {
        const aired = program({ name: '🈟𠮷野家の1日🈑' });
        expect(matches(rule({ keyword: '吉野家' }), aired)).toBe(true);
        expect(matches(rule({ keyword: '[新]' }), aired)).toBe(true);
        expect(matches(rule({ keyword: '[字]' }), aired)).toBe(true);
        expect(
            matches(rule({ keyword: 'アニメ', ignore_keyword: '[新]' }), program({ name: '🈟アニメ' })),
        ).toBe(false);
    });
});

describe('下見の SQL 前絞り (likePatterns)', () => {
    const compiledOf = (keyword: string, search_fields = 'name') => compile(rule({ keyword, search_fields }));

    test('空白区切りの語ごとに %語% を作る (半角・小文字に揃えたあと)', () => {
        expect(likePatterns(compiledOf('名探偵 ＮＨＫ'))).toEqual(['%名探偵%', '%nhk%']);
    });

    test('% _ \\ は字そのものとして当てる', () => {
        expect(likePatterns(compiledOf('名%前'))).toEqual(['%名\\%前%']);
        expect(likePatterns(compiledOf('名_前'))).toEqual(['%名\\_前%']);
    });

    test('大文字小文字を持つ非 ASCII の語は使わない (LIKE が揃えられない)', () => {
        expect(likePatterns(compiledOf('名探偵 Привет'))).toEqual(['%名探偵%']);
        expect(likePatterns(compiledOf('Привет'))).toBeNull();
    });

    test('詳細説明まで検索するときは SQL では当てない', () => {
        expect(likePatterns(compiledOf('名探偵', 'name,description,extended'))).toBeNull();
        expect(likePatterns(compiledOf('名探偵', 'name,description'))).toEqual(['%名探偵%']);
    });

    test('語が無ければ null', () => {
        expect(likePatterns(compiledOf(''))).toBeNull();
    });

    test('外字に寄せた字が絡む所は抜く (DB には 𠮷 🈟 のまま入っている)', () => {
        expect(likePatterns(compiledOf('吉野家'))).toEqual(['%野家%']);
        expect(likePatterns(compiledOf('[新]アニメ'))).toEqual(['%アニメ%']);
        expect(likePatterns(compiledOf('[新]'))).toBeNull();
    });
});

/** 録画から作るルールの下書きと、このシリーズを既に録っているルール */
describe('録画からルールを作る', () => {
    const recording = {
        name: '[新]テストアニメ #1「はじまり」[字]',
        service_id: 211,
        genre_detail: [{ lv1: 7, lv2: 0 }],
    };

    test('キーワードはシリーズ名、ジャンルは大分類だけ', () => {
        expect(prefillFrom(recording)).toEqual({ keyword: 'テストアニメ', genres: ['7'] });
    });

    test('ジャンルの無い録画はキーワードだけ', () => {
        expect(prefillFrom({ ...recording, genre_detail: null })).toEqual({
            keyword: 'テストアニメ',
            genres: null,
        });
    });

    test('鍵括弧の作品名に編が続く題名は、作品名だけをキーワードにする', () => {
        expect(
            prefillFrom({ ...recording, name: '[新]「東京リベンジャーズ」三天戦争編 第51話【アニメイズム】' })
                ?.keyword,
        ).toBe('東京リベンジャーズ');
    });

    test('番組名が空なら下書きは作らない (ジャンルだけのルールになる)', () => {
        expect(prefillFrom({ ...recording, name: '' })).toBeNull();
    });

    test('シリーズ名に当たるルールがあればそれを返す。無効のものより有効のものを先に', () => {
        const off = rule({ id: 1, keyword: 'テストアニメ', enabled: false });
        const on = rule({ id: 2, keyword: 'テスト アニメ' });
        expect(coveringRule([off, on], recording)?.id).toBe(2);
        expect(coveringRule([off], recording)?.id).toBe(1);
    });

    test('録れた回の題名にしか当たらないルール ([新]) は、シリーズを録っているとは言わない', () => {
        expect(coveringRule([rule({ keyword: '[新]' })], recording)).toBeUndefined();
    });

    test('ジャンルや局で外れるルールは当たらない', () => {
        expect(coveringRule([rule({ keyword: 'テストアニメ', genres: ['1'] })], recording)).toBeUndefined();
        expect(
            coveringRule([rule({ keyword: 'テストアニメ', service_ids: [999] })], recording),
        ).toBeUndefined();
    });
});

/** 番組表・予約の詳細から。番組はシリーズ名を持たないので、題名から切り出す */
describe('番組からルールを作る', () => {
    const program = {
        name: '[新]テストアニメ #1「はじまり」[字]',
        service_id: 211,
        genre_detail: [{ lv1: 7, lv2: 0 }],
    };

    test('キーワードは題名から切り出したシリーズ名、ジャンルは大分類だけ', () => {
        expect(prefillFrom(program)).toEqual({ keyword: 'テストアニメ', genres: ['7'] });
    });

    test('ジャンルの無い番組 (予約の行から読んだとき) はキーワードだけ', () => {
        expect(prefillFrom({ ...program, genre_detail: null })).toEqual({
            keyword: 'テストアニメ',
            genres: null,
        });
    });

    test('このシリーズを録っているルールを返す。[新] だけのルールは当たらない', () => {
        expect(coveringRule([rule({ id: 3, keyword: 'テストアニメ' })], program)?.id).toBe(3);
        expect(coveringRule([rule({ keyword: '[新]' })], program)).toBeUndefined();
    });
});
