import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-settings-')), 'denpa.db');

const { normalizePostalCode, parseCodecs, saveSettings, settings } = await import('./settings');

/*
 * **コーデックは複数選べる。** 両方選ぶと1本の録画を AV1 と H.264 でエンコードする
 * (`server/encoder.ts`)。カンマ区切りで持ち、1つだけの古い値も読める。
 */
describe('コーデックの選択', () => {
    test('両方選べる。AV1 を先頭に寄せる', () => {
        // 主 (`library_path`) を AV1 にするので、書いた順に関わらず AV1 が先
        expect(parseCodecs('av1,h264')).toEqual(['av1', 'h264']);
        expect(parseCodecs('h264,av1')).toEqual(['av1', 'h264']);
    });

    test('1つだけの古い値もそのまま読める', () => {
        expect(parseCodecs('av1')).toEqual(['av1']);
        expect(parseCodecs('h264')).toEqual(['h264']);
    });

    test('none や空は「エンコードしない」= 空の一覧', () => {
        expect(parseCodecs('none')).toEqual([]);
        expect(parseCodecs('')).toEqual([]);
    });

    test('知らない値は捨てる', () => {
        expect(parseCodecs('av1,vp9')).toEqual(['av1']);
    });
});

/*
 * **郵便番号は、7桁揃っていなければ入れないほうがよい。**
 *
 * 放送のアプリはこれを読んで天気や地域のニュースの場所を決める
 * (`nvram://receiverinfo/zipcode`)。途中まで入った番号を渡すと
 * 「入っているが違う場所」として扱われるので、**空のほうがまだ分かる**。
 */
describe('郵便番号', () => {
    test('数字7桁はそのまま', () => {
        expect(normalizePostalCode('1000001')).toBe('1000001');
    });

    test('ハイフン付きでも同じに読む', () => {
        expect(normalizePostalCode('100-0001')).toBe('1000001');
        // 全角や空白を混ぜても、数字だけ拾えば同じ
        expect(normalizePostalCode(' 100 - 0001 ')).toBe('1000001');
    });

    test('7桁でなければ空にする', () => {
        expect(normalizePostalCode('100')).toBe('');
        expect(normalizePostalCode('10000012')).toBe('');
        expect(normalizePostalCode('')).toBe('');
        // 数字が1つも無いものも同じ
        expect(normalizePostalCode('とうきょう')).toBe('');
    });
});

/*
 * **都道府県は郵便番号と同じくサーバに置く。** 番号は ARIB の県域 (`#lib/prefecture.js`)。
 * 入れるまでは 255 (未設定) で、放送のアプリには「設定されていない」と見える。
 */
describe('都道府県の保存', () => {
    test('入れるまでは未設定 (255)', () => {
        expect(settings().prefecture).toBe(255);
    });

    test('保存した番号を読み返す。未設定にも戻せる', () => {
        expect(saveSettings({ prefecture: 14 }).prefecture).toBe(14);
        expect(settings().prefecture).toBe(14);
        expect(saveSettings({ prefecture: 255 }).prefecture).toBe(255);
    });

    test('置き場に表に無い値があっても未設定として読む', () => {
        saveSettings({ prefecture: 99 });
        expect(settings().prefecture).toBe(255);
    });
});
