import { describe, expect, test } from 'bun:test';
import type { Recording } from '../types';
import { movieNfo, sidecarPaths } from './metadata';

function recording(over: Partial<Recording> = {}): Recording {
    return {
        id: 42,
        reservation_id: 1,
        program_id: 1,
        service_id: 1,
        service_name: 'TOKYO MX',
        name: 'テストアニメ #12 決戦',
        series: 'テストアニメ',
        subtitle: '決戦',
        description: '主人公が敵と対決する',
        extended: null,
        // 2026-08-01 21:30 JST 開始・30分 (テストは TZ=Asia/Tokyo 前提)
        start_at: new Date('2026-08-01T21:30:00+09:00').getTime(),
        end_at: new Date('2026-08-01T22:00:00+09:00').getTime(),
        audio_type: 1,
        ts_path: null,
        ts_size: 0,
        library_path: null,
        state: 'available',
        error: null,
        cm_ranges: null,
        deleted_at: null,
        created_at: 0,
        updated_at: 0,
        ...over,
    } as Recording;
}

describe('sidecarPaths', () => {
    test('拡張子を差し替えたパスになる (サムネは -poster.jpg)', () => {
        const paths = sidecarPaths('/library/番組/番組 - 2026-08-01 - 2130.mkv');
        expect(paths.nfo).toBe('/library/番組/番組 - 2026-08-01 - 2130.nfo');
        expect(paths.thumbnail).toBe('/library/番組/番組 - 2026-08-01 - 2130-poster.jpg');
        expect(paths.dataBroadcast).toBe('/library/番組/番組 - 2026-08-01 - 2130.bml.jsonl');
    });
});

describe('movieNfo', () => {
    test('放送日・年・放送局・概要が入る (<movie> 型)', () => {
        const nfo = movieNfo(recording());
        expect(nfo).toContain('<movie>');
        expect(nfo).toContain('<premiered>2026-08-01</premiered>');
        expect(nfo).toContain('<year>2026</year>');
        expect(nfo).toContain('<studio>TOKYO MX</studio>');
        expect(nfo).toContain('<plot>主人公が敵と対決する</plot>');
    });

    test('タイトルはシリーズ名＋副題 (カードだけで番組が分かるように)', () => {
        expect(movieNfo(recording())).toContain('<title>テストアニメ 決戦</title>');
    });

    test('副題が無ければシリーズ名だけ (映画・単発)', () => {
        const nfo = movieNfo(recording({ subtitle: '', series: 'ニュース', name: 'ニュース' }));
        expect(nfo).toContain('<title>ニュース</title>');
    });

    test('XMLで意味を持つ文字をエスケープする', () => {
        const nfo = movieNfo(recording({ description: 'A&B <特番> "生放送"' }));
        expect(nfo).toContain('<plot>A&amp;B &lt;特番&gt; &quot;生放送&quot;</plot>');
        // エスケープ漏れがあると、NFO を読むプレイヤーがファイルごと読み飛ばす
        expect(nfo).not.toContain('<特番>');
    });

    test('再スキャンで別物にならないよう録画IDを持たせる', () => {
        expect(movieNfo(recording())).toContain('>42</uniqueid>');
    });

    test('詳細(拡張形式)を概要に続けて plot に入れる', () => {
        const extended = JSON.stringify({ 番組内容: '最終決戦の幕が上がる', 出演者: '声の出演 …' });
        const nfo = movieNfo(recording({ extended }));
        expect(nfo).toContain('主人公が敵と対決する');
        expect(nfo).toContain('番組内容');
        expect(nfo).toContain('最終決戦の幕が上がる');
        expect(nfo).toContain('出演者');
    });

    test('壊れた拡張形式は概要だけにフォールバックする', () => {
        const nfo = movieNfo(recording({ extended: '{壊れ' }));
        expect(nfo).toContain('<plot>主人公が敵と対決する</plot>');
    });

    test('posterName を渡すと <thumb> にポスターのファイル名が入る', () => {
        const nfo = movieNfo(recording(), '番組 - 2026-08-01 - 2130-poster.jpg');
        expect(nfo).toContain('<thumb>番組 - 2026-08-01 - 2130-poster.jpg</thumb>');
    });

    test('posterName が無ければ <thumb> は出さない', () => {
        expect(movieNfo(recording())).not.toContain('<thumb>');
    });
});
