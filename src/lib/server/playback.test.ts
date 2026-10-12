import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { CLOCK, WRAP } from '#lib/ts/pes.js';
import { ORIGIN_HEADER } from '#lib/ts/playback.js';
import { PACKET, SYNC } from '#lib/ts/psi.js';
import { sinceHead } from '#lib/ts/seek.js';
import { AUDIO_TICKS, FRAME_TICKS, packetizePes, pes } from '#lib/ts/synth-av.js';

/**
 * **録画の観方を決めて流す** (`server/playback.ts`)。ffprobe は偽物 (ファイル名で中身を答える)、
 * 元の TS は合成したもの。DB は一時ファイルへ (ほかの試験と同じプロセスで走るので、変えた設定は戻す)
 */
const dir = mkdtempSync(join(tmpdir(), 'denpa-playback-'));
const { config } = await import('./config');
const before = { db: config.dbPath, ffprobe: config.ffprobe, ffmpeg: config.ffmpeg };
config.dbPath = join(dir, 'denpa.db');
afterAll(() => {
    config.dbPath = before.db;
    config.ffprobe = before.ffprobe;
    config.ffmpeg = before.ffmpeg;
    rmSync(dir, { recursive: true, force: true });
});

/** 偽 ffprobe。ファイル名に h264 / av1 があればその中身を、無ければ読めない (1 で降りる) */
const PROBE = join(dir, 'ffprobe');
writeFileSync(
    PROBE,
    [
        '#!/bin/sh',
        'for last; do :; done',
        'case "$last" in',
        `  *h264*) echo '{"streams":[{"codec_type":"video","codec_name":"h264","profile":"High","level":40},{"codec_type":"audio","codec_name":"opus","tags":{"title":"主音声"}},{"codec_type":"audio","codec_name":"opus","tags":{"title":"副音声"}}],"format":{"duration":"1790.5"}}' ;;`,
        `  *av1*) echo '{"streams":[{"codec_type":"video","codec_name":"av1","profile":"Main","level":8,"pix_fmt":"yuv420p"},{"codec_type":"audio","codec_name":"opus","tags":{"title":"主音声"}}],"format":{"duration":"1790.5"}}' ;;`,
        '  *) exit 1 ;;',
        'esac',
    ].join('\n'),
);
chmodSync(PROBE, 0o755);
config.ffprobe = PROBE;

const { orm } = await import('./db');
const { recordings } = await import('./schema');
const { saveSettings } = await import('./settings');
const { holdTranscode, transcodesInUse } = await import('./transcode');
const {
    copyArgs,
    fileTranscodeArgs,
    mediaInfo,
    playbackPlan,
    presented,
    streamResponse,
    transcodeBody,
    tsOffset,
    tsChapters,
    tsTranscodeArgs,
} = await import('./playback');

const media = join(dir, 'media');
mkdirSync(media);
const h264 = join(media, 'a-h264.mkv');
const av1 = join(media, 'a-av1.mkv');
const unknown = join(media, 'a-unknown.mkv');
for (const path of [h264, av1, unknown]) writeFileSync(path, 'mkv');

/** 合成した元の TS。映像と音声の PES に空のパケットを挟む (`ts/seek.test.ts` と同じ作り) */
function synthTs(start: number, seconds: number): Uint8Array {
    const filler = new Uint8Array(PACKET).fill(0xff);
    filler.set([SYNC, 0x1f, 0xff, 0x10]);
    const parts: Uint8Array[] = [];
    let audio = 0;
    for (let frame = 0; frame * FRAME_TICKS < seconds * CLOCK; frame++) {
        const at = frame * FRAME_TICKS;
        while (audio * AUDIO_TICKS <= at) {
            parts.push(
                packetizePes(0x111, pes(0xc0, start + audio * AUDIO_TICKS, new Uint8Array(7)), audio).packets,
            );
            audio++;
        }
        parts.push(packetizePes(0x100, pes(0xe0, start + at, new Uint8Array(200)), frame).packets);
        for (let i = 0; i < 20; i++) parts.push(filler);
    }
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
const TS_START = 5_000_000;
const ts = join(media, 'a.m2ts');
writeFileSync(ts, synthTs(TS_START, 60));

const now = Date.now();
let nextId = 1;
/** 録画の行を作って読み戻す */
function seed(values: Partial<typeof recordings.$inferInsert>) {
    const id = nextId++;
    orm()
        .insert(recordings)
        .values({
            id,
            service_id: 1,
            name: '番組',
            start_at: now,
            end_at: now + 60_000,
            finished_at: now + 60_000,
            created_at: now,
            updated_at: now,
            ...values,
        })
        .run();
    return orm().select().from(recordings).where(eq(recordings.id, id)).get()!;
}

describe('何を出せるか (playbackPlan)', () => {
    test('H.264 だけ焼いた録画: ファイル・詰め替え・AV1 への変換。物差しはエンコード済み', async () => {
        const plan = await playbackPlan(seed({ library_path: h264 }));
        expect(plan?.info).toEqual({
            duration: 1790.5,
            axis: 'encoded',
            audios: [
                { id: '0', label: '主音声' },
                { id: '1', label: '副音声' },
            ],
            offers: [
                { codec: 'h264', way: 'file', source: 'encoded', codecs: 'avc1.640028,opus' },
                { codec: 'h264', way: 'stream', codecs: 'avc1.640028,mp4a.40.2' },
                { codec: 'av1', way: 'stream', codecs: 'av01.0.08M.08,opus' },
            ],
        });
    });

    test('両方焼いて元の TS も残した録画: どちらも詰め替え、MPEG-2 もそのまま出す', async () => {
        const plan = await playbackPlan(
            seed({ library_path: av1, alt_path: h264, ts_path: ts, encode_skip: 0.5 }),
        );
        expect(plan?.info.offers).toEqual([
            { codec: 'av1', way: 'file', source: 'encoded', codecs: 'av01.0.08M.08,opus' },
            { codec: 'h264', way: 'file', source: 'alt', codecs: 'avc1.640028,opus' },
            { codec: 'h264', way: 'stream', codecs: 'avc1.640028,mp4a.40.2' },
            { codec: 'av1', way: 'stream', codecs: 'av01.0.08M.08,opus' },
            { codec: 'mpeg2', way: 'raw' },
        ]);
        expect(plan?.skip).toBe(0.5);
    });

    test('CM を切った録画・捨てた頭を覚えていない録画では MPEG-2 を出さない', async () => {
        const cut = await playbackPlan(
            seed({ library_path: h264, ts_path: ts, encode_skip: 0.5, cm_kept: [{ start: 0, end: 10 }] }),
        );
        expect(cut?.info.offers.some((offer) => offer.codec === 'mpeg2')).toBe(false);
        const old = await playbackPlan(seed({ library_path: h264, ts_path: ts }));
        expect(old?.info.offers.some((offer) => offer.codec === 'mpeg2')).toBe(false);
    });

    test('元の TS だけ: TS から変換と MPEG-2。物差しは TS の頭、尺は尻の映像まで', async () => {
        const plan = await playbackPlan(seed({ ts_path: ts }));
        expect(plan?.info.axis).toBe('ts');
        expect(plan?.info.offers).toEqual([
            { codec: 'h264', way: 'stream', codecs: 'avc1.640029,mp4a.40.2' },
            { codec: 'av1', way: 'stream', codecs: 'av01.0.08M.08,opus' },
            { codec: 'mpeg2', way: 'raw' },
        ]);
        expect(plan?.info.duration).toBeCloseTo(
            (Math.ceil((60 * CLOCK) / FRAME_TICKS) - 1) * (FRAME_TICKS / CLOCK),
            3,
        );
        // 番組表の音声が無ければ「音声」1 つ (`arib.audioTracks`)
        expect(plan?.info.audios).toHaveLength(1);
        expect(plan?.ts?.head).toBe(TS_START);
    });

    test('録っている最中の TS は出さない (追っかけ再生の受け持ち)。何も無ければ null', async () => {
        expect(await playbackPlan(seed({ ts_path: ts, finished_at: null }))).toBeNull();
    });

    test('中身を読めないエンコード済みは、いまの設定のコーデックとみなしてファイルだけ', async () => {
        saveSettings({ codec: 'av1' });
        const plan = await playbackPlan(seed({ library_path: unknown }));
        expect(plan?.info.offers).toEqual([{ codec: 'av1', way: 'file', source: 'encoded' }]);
    });
});

describe('エンコード済みが無い録画のチャプター (tsChapters)', () => {
    test('検出した CM の区間 (元の TS の頭からの秒) から、本編と CM を交互に並べる', async () => {
        saveSettings({ cmCut: 'chapter' });
        const rec = seed({ ts_path: ts, cm_ranges: [{ start: 10, end: 25 }] });
        const chapters = await tsChapters(rec);
        expect(chapters.map((chapter) => [chapter.start, chapter.title])).toEqual([
            [0, '本編'],
            [10, 'CM'],
            [25, '本編'],
        ]);
        expect(chapters.at(-1)?.end).toBeCloseTo(60, 0);
    });

    test('CM の扱いが「何もしない」なら出さない。検出していなければ空', async () => {
        expect(await tsChapters(seed({ ts_path: ts }))).toEqual([]);
        saveSettings({ cmCut: 'off' });
        expect(await tsChapters(seed({ ts_path: ts, cm_ranges: [{ start: 10, end: 25 }] }))).toEqual([]);
        saveSettings({ cmCut: 'chapter' });
    });
});

describe('ffmpeg の引数', () => {
    test('詰め替え: 映像は写し、時刻はファイルのまま。AV1 の音声は Opus', () => {
        const args = copyArgs('/m/a.mkv', 612.5, 1, 'av1');
        const joined = args.join(' ');
        expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
        expect(args[args.indexOf('-ss') + 1]).toBe('612.500');
        expect(joined).toContain('-copyts -i /m/a.mkv -map 0:v:0 -map 0:a:1? -c:v copy -c:a libopus');
        expect(joined).toContain('-movflags +empty_moov+default_base_moof+frag_discont+negative_cts_offsets');
        expect(args.at(-1)).toBe('pipe:1');
        expect(copyArgs('/m/a.mkv', 0, 0, 'h264')).not.toContain('-ss');
    });

    test('エンコード済みの変換: インタレ解除を挟まない', () => {
        const args = fileTranscodeArgs('/m/a.mkv', 30, 0, 'h264', null);
        expect(args).not.toContain('-vf');
        expect(args.join(' ')).toContain('-ss 30.000 -copyts -i /m/a.mkv');
        expect(args.join(' ')).toContain('-c:v libx264');
    });

    test('TS の変換: 標準入力から、局を名指しして、出口の時刻をずらす', () => {
        const track = { id: '0:sub', stream: 0, side: 'sub' as const, label: '副音声' };
        const args = tsTranscodeArgs(1024, track, 'h264', null, -12345.5);
        const joined = args.join(' ');
        expect(joined).toContain('-copyts -f mpegts -i pipe:0 -map 0:p:1024:v:0 -map 0:p:1024:a:0?');
        expect(joined).toContain('-vf bwdif');
        expect(joined).toContain('-fps_mode passthrough');
        expect(joined).toContain('-af pan=stereo|c0=c1|c1=c1');
        expect(args[args.indexOf('-output_ts_offset') + 1]).toBe('-12345.500000');
    });

    test('一周の手前 60 秒に入った PTS は、ffmpeg が負にする', () => {
        expect(presented(90_000 * 100)).toBe(100);
        expect(presented(WRAP - 120 * CLOCK)).toBe((WRAP - 120 * CLOCK) / CLOCK);
        expect(presented(WRAP - 30 * CLOCK)).toBe(-30);
        // ずらした先が物差しの時刻になる
        expect(presented(WRAP - 30 * CLOCK) + tsOffset(WRAP - 30 * CLOCK, 600)).toBe(600);
    });
});

describe('流す (streamResponse)', () => {
    test('MPEG-2: 飛び先の映像の PES から流し、物差しの 0 の PTS をヘッダで渡す', async () => {
        const rec = seed({ library_path: h264, ts_path: ts, encode_skip: 0.5 });
        const res = await streamResponse(rec, new URLSearchParams({ codec: 'mpeg2', from: '20' }));
        expect(res.headers.get('Content-Type')).toBe('video/mp2t');
        const origin = Number(res.headers.get(ORIGIN_HEADER));
        expect(origin).toBe(TS_START + 0.5 * CLOCK);
        const head = new Uint8Array(await res.arrayBuffer()).subarray(0, 32);
        expect(head[0]).toBe(SYNC);
        // 頭のパケットは映像の PES の頭。物差しで 20 秒の 1 秒手前 (`LEAD`) あたり
        const pts =
            ((head[13]! >> 1) & 0x07) * 2 ** 30 +
            (head[14]! << 22) +
            ((head[15]! >> 1) << 15) +
            (head[16]! << 7) +
            (head[17]! >> 1);
        expect(head[7]).toBe(0xe0);
        expect(sinceHead(pts, origin)).toBeCloseTo(19, 1);
    });

    test('出せない形は 404', async () => {
        const rec = seed({ library_path: h264 });
        await expect(streamResponse(rec, new URLSearchParams({ codec: 'mpeg2' }))).rejects.toMatchObject({
            status: 404,
        });
    });

    test('変換は枠を使い、埋まっていれば 503。詰め替えは数えない', async () => {
        saveSettings({ transcodeLimit: 1 });
        const held = holdTranscode();
        expect(held).not.toBeNull();
        const rec = seed({ ts_path: ts });
        await expect(streamResponse(rec, new URLSearchParams({ codec: 'h264' }))).rejects.toMatchObject({
            status: 503,
        });
        // 詰め替えは埋まっていても通る (ffmpeg は起こすだけ。すぐ閉じる)
        config.ffmpeg = 'true';
        const copy = await streamResponse(
            seed({ library_path: h264 }),
            new URLSearchParams({ codec: 'h264' }),
        );
        await copy.body?.cancel();
        held?.();
        expect(transcodesInUse()).toBe(0);
        saveSettings({ transcodeLimit: null });
    });
});

describe('ffmpeg の出口を本文にする (transcodeBody)', () => {
    test('1 バイトも出さずに降りたら次の手で起こし直し、次で出せたら前のせいだったと覚える', async () => {
        let blamed = 0;
        let done = 0;
        const body = transcodeBody(
            [
                { argv: ['sh', '-c', 'echo gpu >&2; exit 1'] },
                { argv: ['sh', '-c', 'printf ok'], blame: () => blamed++ },
            ],
            '[試験]',
            () => done++,
        );
        expect(await new Response(body).text()).toBe('ok');
        expect(blamed).toBe(1);
        expect(done).toBe(1);
    });

    test('標準入力へ流し込む', async () => {
        const body = transcodeBody(
            [{ argv: ['cat'], input: () => new Blob(['流し込んだもの']).stream() }],
            '[試験]',
            () => undefined,
        );
        expect(await new Response(body).text()).toBe('流し込んだもの');
    });

    test('読まれないまま置かれたら畳む', async () => {
        let done = 0;
        const body = transcodeBody([{ argv: ['sh', '-c', 'yes'] }], '[試験]', () => done++, {
            limit: 50,
            every: 10,
        });
        const reader = body.getReader();
        await reader.read();
        await Bun.sleep(200);
        expect(done).toBe(1);
        await expect(
            (async () => {
                for (;;) if ((await reader.read()).done) return;
            })(),
        ).rejects.toThrow();
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
            { codec_type: 'subtitle', codec_name: 'arib_caption' },
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
