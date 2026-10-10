import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNEL } from '#lib/live.js';
import { captionMkv, encodeAribText, management, text } from '#lib/ts/synth-caption.js';

/**
 * アプリ向けの字幕の口 (`liveCaptions` / `recordingCaptions`)。
 *
 * ffmpeg は偽物に差し替える — 入口の見出しを標準エラーへ書き、標準入力を読み切ってから、
 * 字幕を写した Matroska (`S_ARIBSUB`。ffmpeg が `-c:s copy` で書くのと同じ骨組み) を字幕の口 (fd 3) へ流す。
 * DB は一時ファイルへ (encoder-pump.test.ts と同じ理由で、設定そのものを書き換える)
 */
const dir = mkdtempSync(join(tmpdir(), 'denpa-appcap-'));

const { config } = await import('./config');
config.dbPath = join(dir, 'denpa.db');
/* **ほかの試験と同じプロセスで走る。** ffmpeg の差し替えは終わったら戻す */
const realFfmpeg = config.ffmpeg;
const realAgent = config.agentUrl;
/*
 * 偽のエージェント。選局には 200 を返して、何も流さないまま繋いでおく (セッションが生きたままになる)。
 * ライブの字幕の口は、いま流しているセッションに乗るだけなので、乗る先を作るのに要る
 */
const agent = Bun.serve({
    port: 0,
    fetch: () => new Response(new ReadableStream({ start() {} })),
});
config.agentUrl = `http://127.0.0.1:${agent.port}`;
afterAll(() => {
    config.ffmpeg = realFfmpeg;
    config.agentUrl = realAgent;
    void agent.stop(true);
    rmSync(dir, { recursive: true, force: true });
});
const SERVICE = 990_007;
const RECORDING = 990_001;
/** 録っている最中の録画 (書き足しを待ち続けるので、字幕の ffmpeg が降りない) */
const RECORDING_NOW = 990_002;

const MKV = join(dir, 'captions.mkv');
writeFileSync(
    MKV,
    captionMkv([
        [0, management()],
        [40, text(encodeAribText('字幕'))],
        [3000, text([0x0c])],
    ]),
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
const { CAPTION_PER_RECORDING, liveCaptions, liveStream, recordingCaptions } = await import('./live');

const TS = join(dir, 'rec.ts');
// 188 バイトの塊が 100 個 (中身は見ない)
writeFileSync(TS, new Uint8Array(188 * 100).fill(0x47));
orm().delete(recordings).where(eq(recordings.id, RECORDING)).run();
orm().delete(recordings).where(eq(recordings.id, RECORDING_NOW)).run();
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
orm()
    .insert(recordings)
    .values({
        id: RECORDING_NOW,
        service_id: SERVICE,
        name: '録画中',
        start_at: now - 60_000,
        end_at: now + 60_000,
        created_at: now - 60_000,
        updated_at: now,
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
    test('選べる字幕を知らせ、字幕 (文字の配置) を放送の時刻のまま流して、読み切ったら閉じる', async () => {
        const stream = recordingCaptions(RECORDING, 0);
        expect(stream).not.toBeNull();
        const got = await frames(stream!);

        const notices = got.filter((f) => f.kind === CHANNEL.control);
        expect(notices.map((f) => JSON.parse(new TextDecoder().decode(f.payload)))).toContainEqual({
            type: 'captions',
            tracks: [{ index: 0, lang: 'jpn', label: '字幕 (日本語)' }],
            track: 0,
        });

        const pages = got.filter((f) => f.kind === CHANNEL.captionText);
        // 時刻は 90kHz (器の 40ms = 3600)。中身は文字の配置の JSON。消す1枚 (runs が空) も来る
        expect(pages.map((f) => f.pts)).toEqual([3600n, 270_000n]);
        const runs = pages.map((f) =>
            JSON.parse(new TextDecoder().decode(f.payload))
                .runs.map((r: { text: string }) => r.text)
                .join(''),
        );
        expect(runs).toEqual(['字幕', '']);

        // 録り終えた録画は尻まで流し込んで終わる (頭から頼んだので全部)
        expect(Bun.file(FED).size).toBe(188 * 100);
    });

    /*
     * シークのたびに頼み直すので、前の繋ぎが切れたと分かるのが遅れると並ぶ。古いものから畳む
     * (録っている最中の録画は書き足しを待ち続けるので、畳まない限り閉じない)
     */
    test('1本の録画に起こす ffmpeg は上限まで。超えたら古いものを畳む', async () => {
        const streams = Array.from(
            { length: CAPTION_PER_RECORDING + 1 },
            () => recordingCaptions(RECORDING_NOW, 0)!,
        );
        // いちばん古いものは閉じる (読み切れる)
        await new Response(streams[0]).arrayBuffer();
        for (const stream of streams.slice(1)) await stream.cancel();
    });

    test('無い録画は null', () => {
        expect(recordingCaptions(RECORDING + 100, 0)).toBeNull();
    });
});

describe('ライブの字幕 (liveCaptions)', () => {
    // 乗る先 (生のセッション) が無ければ自分では起こさない。チューナーを字幕のためだけに掴まない
    test('生で流していない局には乗らない', () => {
        expect(liveCaptions(SERVICE)).toBeNull();
        expect(liveCaptions(SERVICE + 1)).toBeNull();
    });

    // 脇の字幕の口は畳む判断に数えない。字幕のためだけにチューナーを掴み続けない
    test('字幕の口が抜けても映像は続き、映像が抜けたら字幕の口も閉じる', async () => {
        const media = liveStream(SERVICE, 'raw')!;
        const first = liveCaptions(SERVICE);
        expect(first).not.toBeNull();
        await first!.cancel();
        // 映像はまだ流れている (同じセッションにもう一度乗れる)
        const second = liveCaptions(SERVICE);
        expect(second).not.toBeNull();
        // 映像が抜けたら畳まれて、字幕の口も閉じる (読み切れる)
        await media.cancel();
        await new Response(second!).arrayBuffer();
        expect(liveCaptions(SERVICE)).toBeNull();
    });
});
