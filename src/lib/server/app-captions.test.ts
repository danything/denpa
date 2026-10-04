import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL } from '#lib/live.js';

/**
 * アプリ向けの字幕の口 (`liveCaptions` / `recordingCaptions`)。
 *
 * ffmpeg は偽物に差し替える — 入口の見出しを標準エラーへ書き、標準入力を読み切ってから、
 * 本物の ffmpeg が吐いた Matroska (mkv.test.ts と同じ 4 コマ) を字幕の口 (fd 3) へ流す。
 * DB は一時ファイルへ (encoder-pump.test.ts と同じ理由で、設定そのものを書き換える)
 */
const dir = mkdtempSync(join(tmpdir(), 'denpa-appcap-'));

const { config } = await import('./config');
config.dbPath = join(dir, 'denpa.db');
/*
 * **ほかの試験と同じプロセスで走る。** DB は先に開かれていればそちらに相乗りする (番号はほかと被らない
 * ものを使い、先に消す)。ffmpeg の差し替えは終わったら戻す
 */
const realFfmpeg = config.ffmpeg;
afterAll(() => {
    config.ffmpeg = realFfmpeg;
    rmSync(dir, { recursive: true, force: true });
});
const SERVICE = 990_007;
const RECORDING = 990_001;

const MKV = join(dir, 'captions.mkv');
writeFileSync(
    MKV,
    Buffer.from(
        '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',
        'base64',
    ),
);
const FED = join(dir, 'fed.bin');
const FAKE = join(dir, 'ffmpeg');
writeFileSync(
    FAKE,
    [
        '#!/bin/sh',
        'echo "  Program 1024" >&2',
        'echo "  Stream #0:1[0x130](jpn): Subtitle: arib_caption" >&2',
        `cat > "${FED}"`,
        `cat "${MKV}" >&3`,
        '',
    ].join('\n'),
);
chmodSync(FAKE, 0o755);
config.ffmpeg = FAKE;

const { eq } = await import('drizzle-orm');
const { orm } = await import('./db');
const { recordings, services } = await import('./schema');
const { liveCaptions, recordingCaptions } = await import('./live');

const TS = join(dir, 'rec.ts');
// 188 バイトの塊が 100 個 (中身は見ない)
writeFileSync(TS, new Uint8Array(188 * 100).fill(0x47));
orm().delete(recordings).where(eq(recordings.id, RECORDING)).run();
orm().delete(services).where(eq(services.id, SERVICE)).run();
orm()
    .insert(services)
    .values({
        id: SERVICE,
        service_id: 1024,
        network_id: 4,
        name: 'テスト局',
        type: 'GR',
        channel: 'T27',
        updated_at: 0,
    })
    .run();
const now = Date.now();
orm()
    .insert(recordings)
    .values({
        id: RECORDING,
        service_id: SERVICE,
        name: '番組',
        start_at: now - 60_000,
        end_at: now,
        created_at: now - 60_000,
        updated_at: now,
        finished_at: now,
        duration_ms: 60_000,
        ts_path: TS,
    })
    .run();

/** アプリと同じ読み方: [4:長さ][1:種別][8:時刻][中身] を並べて読む */
async function frames(stream: ReadableStream<Uint8Array>) {
    const body = new Uint8Array(await new Response(stream).arrayBuffer());
    const view = new DataView(body.buffer);
    const out: { kind: number; pts: bigint; payload: Uint8Array }[] = [];
    for (let at = 0; at < body.length; ) {
        const length = view.getUint32(at);
        out.push({
            kind: view.getUint8(at + 4),
            pts: view.getBigUint64(at + 5),
            payload: body.subarray(at + 13, at + 4 + length),
        });
        at += 4 + length;
    }
    return out;
}

describe('録画の字幕 (recordingCaptions)', () => {
    test('選べる字幕を知らせ、字幕の絵を放送の時刻のまま流して、読み切ったら閉じる', async () => {
        const stream = recordingCaptions(RECORDING, 0);
        expect(stream).not.toBeNull();
        const got = await frames(stream!);

        const notices = got.filter((f) => f.kind === CHANNEL.control);
        expect(notices.map((f) => JSON.parse(new TextDecoder().decode(f.payload)))).toContainEqual({
            type: 'captions',
            tracks: [{ index: 0, lang: 'jpn', label: '字幕 (日本語)' }],
            track: 0,
        });

        const pictures = got.filter((f) => f.kind === CHANNEL.subtitle);
        expect(pictures.length).toBeGreaterThan(0);
        // 時刻は 90kHz (器の 40ms = 3600)。中身は置き場所 (画面まるごと) と PNG
        expect(pictures.map((f) => f.pts)).toContain(3600n);
        for (const picture of pictures) {
            const view = new DataView(picture.payload.buffer, picture.payload.byteOffset);
            expect([view.getUint16(4), view.getUint16(6)]).toEqual([1920, 1080]);
            expect([...picture.payload.subarray(8, 12)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        }

        // 録り終えた録画は尻まで流し込んで終わる (頭から頼んだので全部)
        expect(Bun.file(FED).size).toBe(188 * 100);
    });

    test('無い録画は null', () => {
        expect(recordingCaptions(RECORDING + 1, 0)).toBeNull();
    });
});

describe('ライブの字幕 (liveCaptions)', () => {
    // 乗る先 (生のセッション) が無ければ自分では起こさない。チューナーを字幕のためだけに掴まない
    test('生で流していない局には乗らない', () => {
        expect(liveCaptions(SERVICE)).toBeNull();
        expect(liveCaptions(SERVICE + 1)).toBeNull();
    });
});
