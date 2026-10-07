import { describe, expect, test } from 'bun:test';
import { mediaInfo, remuxArgs } from './remux';

describe('詰め替えの引数 (remuxArgs)', () => {
    test('映像は写し、選んだ音声を AAC に。位置はファイルの時刻のまま出す', () => {
        const args = remuxArgs('/media/encoded/a.mkv', 612.5, 1);
        const joined = args.join(' ');
        // -ss は -i の前 (入口で跳ぶ)。時刻は運ぶ
        expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
        expect(args[args.indexOf('-ss') + 1]).toBe('612.500');
        expect(args).toContain('-copyts');
        expect(joined).toContain('-map 0:v:0 -map 0:a:1?');
        expect(joined).toContain('-c:v copy -c:a aac');
        expect(joined).toContain('-avoid_negative_ts make_non_negative');
        expect(joined).toContain('-movflags +empty_moov+default_base_moof+frag_discont+negative_cts_offsets');
        expect(args.at(-1)).toBe('pipe:1');
    });

    test('頭からなら跳ばない', () => {
        expect(remuxArgs('/a.mkv', 0, 0)).not.toContain('-ss');
    });
});

describe('ffprobe の読み (mediaInfo)', () => {
    const probe = (streams: unknown[], duration = '1800.5') =>
        JSON.stringify({ streams, format: { duration } });

    test('H.264 High / Level 4.0 と Opus 2本', () => {
        const json = probe([
            { codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40 },
            { codec_type: 'audio', codec_name: 'opus', tags: { title: '主音声' } },
            { codec_type: 'audio', codec_name: 'opus' },
            { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
        ]);
        expect(mediaInfo('encoded', json)).toEqual({
            source: 'encoded',
            video: 'avc1.640028',
            audio: 'opus',
            audios: ['主音声', ''],
            duration: 1800.5,
        });
    });

    test('AV1 Main / Level 4.0 (8)、10bit も読む', () => {
        const av1 = (pix_fmt: string) =>
            mediaInfo(
                'alt',
                probe([{ codec_type: 'video', codec_name: 'av1', profile: 'Main', level: 8, pix_fmt }]),
            ).video;
        expect(av1('yuv420p')).toBe('av01.0.08M.08');
        expect(av1('yuv420p10le')).toBe('av01.0.08M.10');
    });

    test('知らない形・読めない出力は null (判断に使わない)', () => {
        expect(
            mediaInfo('encoded', probe([{ codec_type: 'video', codec_name: 'mpeg2video' }])).video,
        ).toBeNull();
        expect(mediaInfo('encoded', '')).toEqual({
            source: 'encoded',
            video: null,
            audio: null,
            audios: [],
            duration: null,
        });
    });
});
