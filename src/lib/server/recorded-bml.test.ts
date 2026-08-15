import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    BML_TS,
    bmlHead,
    ddbSection,
    diiSection,
    multipartModule,
    packetize,
    patSection,
    programMap,
    stream,
    tdtPacket as tdt,
} from '$lib/ts/synth';
import type { Recording } from '../types';

// DB は一時ファイルへ (番組の名乗りを組むのに services を引く。files.test.ts と同じ手)
const { config } = await import('./config');
config.dbPath = join(mkdtempSync(join(tmpdir(), 'denpa-bml-db-')), 'denpa.db');
const { database } = await import('./db');
const { loadRecordedBml, saveRecordedBml, withProgramInfo } = await import('./recorded-bml');

/*
 * 録画のデータ放送。**TS から取り出してサイドカーに置き、再生時に読み直す。**
 * 解き方は ts/data-timeline.ts が持つので、ここはファイルの出し入れだけを確かめる。
 */

/** モジュール1つぶんの multipart (ファイル1枚の形) */
const multipart = (body: string) => multipartModule([['/startup.bml', 'text/X-arib-bml', body]]);

/** PAT・PMT・TDT・カルーセルを1本の TS バイト列にする */
function tsBytes(unixMs: number, body: string): Uint8Array {
    const module = multipart(body);
    const spec = { moduleId: 1, moduleSize: module.length, moduleVersion: 1, contentType: 'multipart/mixed' };
    return stream(
        ...bmlHead(),
        tdt(unixMs),
        packetize(BML_TS.bmlPid, diiSection(BML_TS.downloadId, 4066, spec, 1)),
        packetize(BML_TS.bmlPid, ddbSection(BML_TS.downloadId, 1, 1, 0, module)),
    );
}

const dir = mkdtempSync(join(tmpdir(), 'denpa-bml-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T = Date.UTC(2026, 7, 12, 0, 0, 30);

/** 録画の行の要るところだけ。局は services に 1 つ入れておく (network 4, service 1024) */
function recording(startAt: number): Recording {
    database().exec('DELETE FROM services');
    database()
        .prepare(
            `INSERT INTO services (id, service_id, network_id, name, type, channel, updated_at)
             VALUES (7, 1024, 4, 'テスト局', 'GR', 'T27', 0)`,
        )
        .run();
    return {
        id: 1,
        service_id: 7,
        program_id: 999,
        name: '録画のテスト',
        start_at: startAt,
        end_at: startAt + 60_000,
    } as unknown as Recording;
}

describe('saveRecordedBml / loadRecordedBml', () => {
    test('TS から取り出して書き、読み直すと同じ変化が並ぶ', () => {
        const ts = join(dir, 'rec.ts');
        const sidecar = join(dir, 'rec.bml.jsonl');
        writeFileSync(ts, tsBytes(T, '<bml>録画のデータ放送</bml>'));

        // 基準を放送時刻の 10 秒前に置く → モジュールは再生位置 10000ms になる
        const changes = saveRecordedBml(ts, sidecar, recording(T - 10_000), null);
        expect(changes).toBeGreaterThan(0);

        const loaded = loadRecordedBml(sidecar);
        const done = loaded.find((item) => item.message.type === 'moduleDownloaded');
        if (done?.message.type !== 'moduleDownloaded') throw new Error('moduleDownloaded が無い');
        expect(done.at).toBe(10_000);
        expect(Buffer.from(done.message.files[0].dataBase64, 'base64').toString()).toContain(
            '録画のデータ放送',
        );
        // **番組の名乗りが頭に入っている。** 描く側はこれが来るまで入口を開かない
        const info = loaded[0].message;
        if (info.type !== 'programInfo') throw new Error('programInfo が頭に無い');
        expect(info.serviceId).toBe(1024);
        expect(info.eventName).toBe('録画のテスト');
        // 読む側でも足すが、既に在れば重ねない
        expect(
            withProgramInfo(loaded, recording(T)).filter((i) => i.message.type === 'programInfo'),
        ).toHaveLength(1);
    });

    test('名乗りを書いていなかった頃のサイドカーには、読むときに足す', () => {
        const old = [{ at: 0, message: { type: 'pmt' as const, components: [] } }];
        const fixed = withProgramInfo(old, recording(T));
        expect(fixed[0].message.type).toBe('programInfo');
        expect(fixed).toHaveLength(2);
        // 空 (データ放送を持たない録画) には足さない — 「出せない」のままにする
        expect(withProgramInfo([], recording(T))).toEqual([]);
    });

    test('データ放送を持たない TS では書かない・読めば空', () => {
        const ts = join(dir, 'plain.ts');
        const sidecar = join(dir, 'plain.bml.jsonl');
        // BML の ES が無い PMT (映像だけ)
        const { service, pmtPid, videoPid } = BML_TS;
        writeFileSync(
            ts,
            stream(
                packetize(0x0000, patSection([[service, pmtPid]])),
                packetize(pmtPid, programMap(service, videoPid, [[0x02, videoPid, [0x52, 0x01, 0x00]]])),
            ),
        );

        expect(saveRecordedBml(ts, sidecar, recording(T), null)).toBe(0);
        expect(loadRecordedBml(sidecar)).toEqual([]);
    });
});
